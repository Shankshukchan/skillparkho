import { supabaseAdmin, TABLE_ALLOWED_USERS } from '../config/supabase.js';
import { normalizePhoneNumber } from '../utils/phoneNormalizer.js';
import { validateAllowedUser } from '../utils/validator.js';
import { stringify } from 'csv-stringify/sync';

const TABLE_ALLOWED_UPLOADS = 'allowed_user_uploads';

// GET /api/allowed-users  (admin)
export async function listAllowedUsers(req, res) {
  try {
    const { search = '', page = 1, limit = 20, is_active = '', sortBy = 'created_at', sortOrder = 'desc' } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let query = supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*', { count: 'exact' });

    if (search.trim()) {
      const q = search.trim();
      const normSearch = normalizePhoneNumber(q);
      if (/^\d{3,}$/.test(normSearch)) {
        query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone_number.ilike.%${q}%,normalized_phone_number.ilike.%${normSearch}%`);
      } else {
        query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone_number.ilike.%${q}%`);
      }
    }
    if (is_active !== '') query = query.eq('is_active', is_active === 'true');
    const allowedSort = ['created_at', 'updated_at', 'full_name', 'email', 'phone_number'];
    const sortField = allowedSort.includes(sortBy) ? sortBy : 'created_at';
    query = query.order(sortField, { ascending: sortOrder === 'asc' }).range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    const [totalRes, activeRes] = await Promise.all([
      supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*', { count: 'exact', head: true }),
      supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*', { count: 'exact', head: true }).eq('is_active', true),
    ]);

    res.json({ success: true, data, pagination: { page: pageNum, limit: limitNum, total: count, totalPages: Math.ceil((count || 0) / limitNum), totalCount: totalRes.count || 0, activeCount: activeRes.count || 0 } });
  } catch (err) {
    console.error('listAllowedUsers', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function getAllowedUser(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*').eq('id', id).single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ success: false, error: 'User not found' });
      throw error;
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function createAllowedUser(req, res) {
  try {
    const { error: valError, value } = validateAllowedUser(req.body);
    if (valError) return res.status(400).json({ success: false, error: valError.details.map(d => d.message).join(', '), details: valError.details });
    const normalized = normalizePhoneNumber(value.phone_number);
    const { data: existing } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).select('id').eq('normalized_phone_number', normalized).maybeSingle();
    if (existing) return res.status(409).json({ success: false, error: `Phone ${value.phone_number} already exists` });
    // optional email uniqueness check - allow same email for multiple phones? enforce unique for now lax
    const payload = {
      phone_number: value.phone_number.trim(),
      normalized_phone_number: normalized,
      email: value.email.trim().toLowerCase(),
      full_name: (value.full_name || '').trim(),
      is_active: value.is_active ?? true,
      created_by: req.admin?.email || 'admin',
    };
    const { data, error } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).insert(payload).select().single();
    if (error) throw error;
    res.status(201).json({ success: true, data, message: 'Allowed user created' });
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ success: false, error: 'Duplicate phone number' });
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function updateAllowedUser(req, res) {
  try {
    const { id } = req.params;
    const { error: valError, value } = validateAllowedUser(req.body);
    if (valError) return res.status(400).json({ success: false, error: valError.details.map(d => d.message).join(', ') });
    const normalized = normalizePhoneNumber(value.phone_number);
    const { data: dup } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).select('id').eq('normalized_phone_number', normalized).neq('id', id).maybeSingle();
    if (dup) return res.status(409).json({ success: false, error: 'Another user already uses this phone' });
    const payload = {
      phone_number: value.phone_number.trim(),
      normalized_phone_number: normalized,
      email: value.email.trim().toLowerCase(),
      full_name: (value.full_name || '').trim(),
      is_active: value.is_active ?? true,
    };
    const { data, error } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).update(payload).eq('id', id).select().single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ success: false, error: 'User not found' });
      throw error;
    }
    res.json({ success: true, data, message: 'User updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function deleteAllowedUser(req, res) {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true, message: 'User deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function bulkCreateAllowedUsers(req, res) {
  try {
    const { contacts, users } = req.body;
    const arr = users || contacts;
    if (!Array.isArray(arr) || arr.length === 0) return res.status(400).json({ success: false, error: 'users array required (1-1000 items)' });
    if (arr.length > 1000) return res.status(400).json({ success: false, error: 'Max 1000 per bulk' });

    // Step 1: Validate all items
    const validItems = [];
    const errors = [];
    let failedCount = 0;
    for (let i = 0; i < arr.length; i++) {
      const raw = arr[i];
      const mapped = {
        phone_number: raw.phone_number || raw.phone || raw.mobile || raw.mobile_number || '',
        email: raw.email || raw.Email || '',
        full_name: raw.full_name || raw.name || raw.fullName || '',
        is_active: raw.is_active ?? true,
      };
      const { error: valErr, value } = validateAllowedUser(mapped);
      if (valErr) { failedCount++; errors.push({ index: i, phone: mapped.phone_number, error: valErr.details.map(d => d.message).join(', ') }); continue; }
      validItems.push({ index: i, value });
    }

    // Step 2: Batch dedup check
    const allPhones = validItems.map(v => normalizePhoneNumber(v.value.phone_number));
    const { data: existingRows } = await supabaseAdmin
      .from(TABLE_ALLOWED_USERS)
      .select('normalized_phone_number')
      .in('normalized_phone_number', allPhones);
    const existingSet = new Set((existingRows || []).map(r => r.normalized_phone_number));

    // Step 3: Build payloads
    const toInsert = [];
    let duplicateCount = 0;
    for (const { index, value } of validItems) {
      const normalized = normalizePhoneNumber(value.phone_number);
      if (existingSet.has(normalized)) {
        duplicateCount++;
        errors.push({ index, phone: value.phone_number, error: 'Duplicate phone' });
        continue;
      }
      existingSet.add(normalized);
      toInsert.push({
        phone_number: value.phone_number.trim(),
        normalized_phone_number: normalized,
        email: value.email.trim().toLowerCase(),
        full_name: (value.full_name || '').trim(),
        is_active: value.is_active ?? true,
        created_by: req.admin?.email || 'admin',
      });
    }

    // Step 4: Batch insert
    let successCount = 0;
    const inserted = [];
    const BATCH_SIZE = 100;
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).insert(batch).select();
      if (error) {
        for (const row of batch) {
          const { data: single, error: singleErr } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).insert(row).select().single();
          if (singleErr) { failedCount++; errors.push({ index: i, phone: row.phone_number, error: singleErr.message }); }
          else { successCount++; inserted.push(single); }
        }
      } else {
        successCount += (data || []).length;
        inserted.push(...(data || []));
      }
    }

    try {
      await supabaseAdmin.from(TABLE_ALLOWED_UPLOADS).insert({
        filename: req.body.filename || 'bulk_json_upload',
        total_rows: arr.length, success_count: successCount, failed_count: failedCount, duplicate_count: duplicateCount, uploaded_by: req.admin?.email || 'admin'
      });
    } catch {}
    res.status(successCount > 0 ? 201 : 400).json({ success: successCount > 0, summary: { total: arr.length, successCount, failedCount, duplicateCount }, inserted, errors: errors.slice(0, 50) });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function importAllowedUsersFile(req, res) {
  try {
    if (!req.file) return res.status(400).json({ success: false, error: 'No file uploaded. Field name must be "file"' });
    const buffer = req.file.buffer;
    const originalName = req.file.originalname;
    const ext = originalName.split('.').pop()?.toLowerCase();
    let rows = [];
    if (ext === 'csv') {
      const { parse } = await import('csv-parse/sync');
      rows = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
    } else if (ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const wb = XLSX.read(buffer, { type: 'buffer' });
      const sheet = wb.Sheets[wb.SheetNames[0]];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } else if (ext === 'json') {
      const text = buffer.toString('utf-8');
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : parsed.users || parsed.contacts || [];
    } else return res.status(400).json({ success: false, error: 'Unsupported file type. Use .csv, .xlsx, .xls, .json' });

    if (!rows.length) return res.status(400).json({ success: false, error: 'File contains no data rows' });

    const mapped = rows.map(r => {
      const get = (...keys) => {
        for (const k of keys) {
          if (r[k] !== undefined && r[k] !== '') return r[k];
          const found = Object.keys(r).find(k2 => k2.toLowerCase().trim() === k.toLowerCase().trim());
          if (found && r[found] !== '') return r[found];
        }
        return '';
      };
      return {
        phone_number: String(get('phone_number', 'phone', 'mobile', 'mobile_number', 'contact', 'Phone') || '').trim(),
        email: String(get('email', 'Email') || '').trim(),
        full_name: String(get('full_name', 'name', 'fullName', 'Full Name', 'Name') || '').trim(),
      };
    });

    // Step 1: Validate all rows
    const validItems = [];
    const errors = [];
    let failedCount = 0;
    for (let i = 0; i < mapped.length; i++) {
      const raw = mapped[i];
      if (!raw.phone_number || !raw.email) { failedCount++; errors.push({ row: i + 2, phone: raw.phone_number || 'N/A', error: 'Missing phone_number or email' }); continue; }
      const { error: valErr, value } = validateAllowedUser(raw);
      if (valErr) { failedCount++; errors.push({ row: i + 2, phone: raw.phone_number, error: valErr.details.map(d => d.message).join(', ') }); continue; }
      validItems.push({ index: i, value });
    }

    // Step 2: Batch dedup check
    const allPhones = validItems.map(v => normalizePhoneNumber(v.value.phone_number));
    const { data: existingRows } = await supabaseAdmin
      .from(TABLE_ALLOWED_USERS)
      .select('normalized_phone_number')
      .in('normalized_phone_number', allPhones);
    const existingSet = new Set((existingRows || []).map(r => r.normalized_phone_number));

    // Step 3: Build payloads
    const toInsert = [];
    let duplicateCount = 0;
    for (const { index, value } of validItems) {
      const normalized = normalizePhoneNumber(value.phone_number);
      if (existingSet.has(normalized)) {
        duplicateCount++;
        errors.push({ row: index + 2, phone: value.phone_number, error: 'Duplicate' });
        continue;
      }
      existingSet.add(normalized);
      toInsert.push({
        phone_number: value.phone_number.trim(),
        normalized_phone_number: normalized,
        email: value.email.trim().toLowerCase(),
        full_name: (value.full_name || '').trim(),
        is_active: true,
        created_by: req.admin?.email || 'admin',
      });
    }

    // Step 4: Batch insert
    let successCount = 0;
    const BATCH_SIZE = 100;
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).insert(batch).select();
      if (error) {
        for (const row of batch) {
          const { data: single, error: singleErr } = await supabaseAdmin.from(TABLE_ALLOWED_USERS).insert(row).select().single();
          if (singleErr) { failedCount++; errors.push({ row: i + 2, phone: row.phone_number, error: singleErr.message }); }
          else { successCount++; }
        }
      } else {
        successCount += (data || []).length;
      }
    }

    try {
      await supabaseAdmin.from(TABLE_ALLOWED_UPLOADS).insert({
        filename: originalName, total_rows: rows.length, success_count: successCount, failed_count: failedCount, duplicate_count: duplicateCount, uploaded_by: req.admin?.email || 'admin'
      });
    } catch {}
    res.json({ success: successCount > 0, summary: { total: rows.length, successCount, failedCount, duplicateCount }, errors: errors.slice(0, 100) });
  } catch (err) {
    console.error('importAllowedUsersFile', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

export async function exportAllowedUsersCsv(req, res) {
  try {
    const { search = '' } = req.query;
    let query = supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*').order('created_at', { ascending: false }).limit(5000);
    if (search.trim()) {
      const q = search.trim();
      query = query.or(`full_name.ilike.%${q}%,email.ilike.%${q}%,phone_number.ilike.%${q}%`);
    }
    const { data, error } = await query;
    if (error) throw error;
    const csv = stringify(data.map(r => ({
      phone_number: r.phone_number,
      normalized_phone_number: r.normalized_phone_number,
      email: r.email,
      full_name: r.full_name,
      is_active: r.is_active,
      created_at: r.created_at,
    })), { header: true });
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="allowed_users_export.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// Optimized: single RPC call instead of 5 separate queries
export async function getAllowedUsersStats(req, res) {
  try {
    const { data: statsRow, error: statsErr } = await supabaseAdmin.rpc('get_allowed_users_stats');
    let total = 0, active = 0, inactive = 0, last7 = 0;

    if (statsErr || !statsRow) {
      // Fallback: parallel count queries
      const [totalRes, activeRes, inactiveRes, last7Res] = await Promise.all([
        supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*', { count: 'exact', head: true }),
        supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*', { count: 'exact', head: true }).eq('is_active', true),
        supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*', { count: 'exact', head: true }).eq('is_active', false),
        supabaseAdmin.from(TABLE_ALLOWED_USERS).select('*', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      ]);
      total = totalRes.count || 0;
      active = activeRes.count || 0;
      inactive = inactiveRes.count || 0;
      last7 = last7Res.count || 0;
    } else {
      const s = Array.isArray(statsRow) ? statsRow[0] : statsRow;
      total = s.total || 0;
      active = s.active_count || 0;
      inactive = s.inactive_count || 0;
      last7 = s.added_last_7_days || 0;
    }

    const { data: recent } = await supabaseAdmin
      .from(TABLE_ALLOWED_USERS)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    res.json({ success: true, stats: { total, active, inactive, addedLast7Days: last7, recent } });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
