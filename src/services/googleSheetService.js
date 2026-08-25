import { normalizePhoneNumber } from '../utils/phoneNormalizer.js';

let cache = null;
let cacheAt = 0;
const TTL_MS = 2 * 60 * 1000; // 2 min cache to avoid rate limits

function isCacheValid() {
  return cache && (Date.now() - cacheAt) < TTL_MS;
}

// Expected headers (case-insensitive, flexible):
// phone_number | phone | mobile | mobile_number
// full_name | name
// email | Email
// course | Course | course_name
// batch_name | batch | Batch
// is_active | active | status
// approved_status | approved | status_approved
const HEADER_ALIASES = {
  phone: ['phone_number', 'phone', 'mobile', 'mobile_number', 'contact', 'Phone Number', 'Phone', 'Mobile Number', 'Mobile', 'Number', 'number', 'PHONENUMBER'],
  full_name: ['full_name', 'name', 'fullName', 'Full Name', 'Name', 'student_name', 'Student Name', 'NAME'],
  email: ['email', 'Email', 'email_address', 'Email Address', 'EMAIL'],
  course: ['course', 'Course', 'course_name', 'Course Name', 'COURSE'],
  batch_name: ['batch_name', 'batch', 'Batch', 'batchName', 'Batch Name', 'BATCH'],
  is_active: ['is_active', 'active', 'isActive', 'status', 'Active', 'ACTIVE', 'is active'],
  approved_status: ['approved_status', 'approved', 'approval', 'Approved', 'status_approved', 'Approved Status', 'APPROVED'],
};

function getField(row, aliases) {
  for (const key of aliases) {
    if (row[key] !== undefined && String(row[key]).trim() !== '') return String(row[key]).trim();
    // case-insensitive fallback
    const found = Object.keys(row).find(k => k.toLowerCase().trim() === key.toLowerCase().trim());
    if (found && String(row[found]).trim() !== '') return String(row[found]).trim();
  }
  return '';
}

function normalizeRow(raw) {
  const phoneRaw = getField(raw, HEADER_ALIASES.phone);
  const fullName = getField(raw, HEADER_ALIASES.full_name);
  const email = getField(raw, HEADER_ALIASES.email);
  const course = getField(raw, HEADER_ALIASES.course);
  const batch = getField(raw, HEADER_ALIASES.batch_name);
  const activeRaw = getField(raw, HEADER_ALIASES.is_active);
  const approvedRaw = getField(raw, HEADER_ALIASES.approved_status);

  // Determine is_active: TRUE/FALSE, 1/0, active/inactive, yes/no
  let isActive = true;
  if (activeRaw) {
    const v = activeRaw.toLowerCase();
    if (['false', '0', 'inactive', 'no', 'n', 'disabled'].includes(v)) isActive = false;
    else if (['true', '1', 'active', 'yes', 'y', 'enabled'].includes(v)) isActive = true;
  }

  // approved_status: approved vs pending/rejected
  let approvedStatus = approvedRaw ? approvedRaw.toLowerCase() : 'approved';
  // if empty, treat as approved for backward compat (but log)
  if (!approvedRaw) approvedStatus = 'approved';

  return {
    phone_number: phoneRaw,
    normalized_phone_number: normalizePhoneNumber(phoneRaw),
    full_name: fullName,
    email: email,
    course: course,
    batch_name: batch || course || 'SkillParkho Student',
    is_active: isActive,
    approved_status: approvedStatus,
    raw,
  };
}

async function fetchViaServiceAccount() {
  const jsonStr = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  const sheetId = process.env.GOOGLE_SHEET_ID || '1djvPugtfUfC6ELT_OSxWcwqi9ofJ1Tj-4YilpB4Cogk';
  const range = process.env.GOOGLE_SHEET_RANGE || 'Sheet1!A1:H1000';
  if (!jsonStr) return null;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8000); // 8s timeout

  try {
    const { google } = await import('googleapis');
    const credentials = JSON.parse(jsonStr);
    const auth = new google.auth.GoogleAuth({
      credentials,
      scopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    });
    const client = await auth.getClient();
    const sheets = google.sheets({ version: 'v4', auth: client });
    const res = await sheets.spreadsheets.values.get({ spreadsheetId: sheetId, range });
    clearTimeout(timer);
    const values = res.data.values || [];
    if (values.length < 2) return [];
    const headers = values[0];
    const rows = values.slice(1).map(vals => {
      const obj = {};
      headers.forEach((h, i) => { obj[h] = vals[i] || ''; });
      return obj;
    });
    console.log(`✅ Sheet fetched via Service Account: ${rows.length} rows`);
    return rows;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') {
      console.warn('⚠️ Service Account fetch timed out');
    } else {
      console.warn('⚠️ Service Account fetch failed:', e.message);
    }
    return null;
  }
}

async function fetchViaCsv() {
  const sheetId = process.env.GOOGLE_SHEET_ID || '1djvPugtfUfC6ELT_OSxWcwqi9ofJ1Tj-4YilpB4Cogk';
  const gid = process.env.GOOGLE_SHEET_GID || '0';
  // Try multiple CSV URLs
  const urls = [
    process.env.GOOGLE_SHEET_CSV_URL,
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/gviz/tq?tqx=out:csv&gid=${gid}`,
    `https://docs.google.com/spreadsheets/d/${sheetId}/export?format=csv`,
  ].filter(Boolean);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000); // 5s total timeout

  try {
    for (const url of urls) {
      try {
        const resp = await fetch(url, { signal: controller.signal });
        if (!resp.ok) {
          console.warn(`⚠️ CSV fetch ${url} -> ${resp.status}`);
          continue;
        }
        const text = await resp.text();
        if (!text || text.includes('<HTML') || text.includes('<!DOCTYPE')) {
          console.warn(`⚠️ CSV fetch returned HTML, likely auth required: ${url}`);
          continue;
        }
        clearTimeout(timer);
        const { parse } = await import('csv-parse/sync');
        const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });
        console.log(`✅ Sheet fetched via CSV: ${url} -> ${records.length} rows`);
        return records;
      } catch (e) {
        if (e.name === 'AbortError') {
          console.warn(`⚠️ CSV fetch timed out: ${url}`);
          break; // Don't try more URLs if we've timed out
        }
        console.warn(`⚠️ CSV fetch failed ${url}:`, e.message);
      }
    }
  } finally {
    clearTimeout(timer);
  }
  return null;
}

export async function getSheetRows({ forceRefresh = false } = {}) {
  if (!forceRefresh && isCacheValid()) return cache;

  let rows = null;

  // 1. Try Service Account
  rows = await fetchViaServiceAccount();

  // 2. Try CSV
  if (!rows) rows = await fetchViaCsv();

  // 3. No seed/mock - strict Sheet-only: if not accessible, return empty (verification will fail correctly)
  if (!rows) {
    console.error('❌ Sheet not accessible (private & no service account). No mock fallback - verification will FAIL until you publish sheet: File -> Share -> Anyone with link Viewer OR Publish to web CSV. Sheet ID:', process.env.GOOGLE_SHEET_ID || '1djvPugtfUfC6ELT_OSxWcwqi9ofJ1Tj-4YilpB4Cogk');
    rows = []; // strict: no fallback data
  }

  // Normalize and filter empty
  const normalized = rows.map(normalizeRow).filter(r => r.phone_number && r.normalized_phone_number.length === 10);
  cache = normalized;
  cacheAt = Date.now();
  console.log(`📊 Sheet cache updated: ${normalized.length} valid rows (of ${rows.length} raw)`);
  return normalized;
}

export async function findInSheet(rawPhone) {
  const norm = normalizePhoneNumber(rawPhone);
  const rows = await getSheetRows();
  const found = rows.find(r => r.normalized_phone_number === norm);
  if (!found) return null;
  // Check is_active and approved_status
  if (!found.is_active) return { ...found, _blockedReason: 'inactive' };
  if (found.approved_status && found.approved_status !== 'approved') return { ...found, _blockedReason: 'not_approved', _status: found.approved_status };
  return found;
}

export async function getSheetStats() {
  const rows = await getSheetRows();
  return {
    total: rows.length,
    active: rows.filter(r => r.is_active).length,
    approved: rows.filter(r => r.approved_status === 'approved').length,
    approvedAndActive: rows.filter(r => r.is_active && r.approved_status === 'approved').length,
    lastFetched: new Date(cacheAt).toISOString(),
    isMock: cacheAt && rows.length <= 4 && rows[0]?.phone_number === '9876543210' && !process.env.GOOGLE_SERVICE_ACCOUNT_JSON && !process.env.GOOGLE_SHEET_CSV_URL,
  };
}

export function clearCache() {
  cache = null;
  cacheAt = 0;
}
