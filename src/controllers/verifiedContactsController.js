import { supabaseAdmin } from '../config/supabase.js';
import { normalizePhoneNumber } from '../utils/phoneNormalizer.js';
import { validateVerifiedContact } from '../utils/validator.js';
import { stringify } from 'csv-stringify/sync';

const TABLE_VERIFIED = 'verified_hr_contacts';
const TABLE_UPLOADS  = 'verified_contact_uploads';

// GET /api/verified-contacts
export async function listVerifiedContacts(req, res) {
  try {
    const {
      search = '',
      page = 1,
      limit = 20,
      company = '',
      verified = '',
      verification_status = '',
      sortBy = 'created_at',
      sortOrder = 'desc'
    } = req.query;

    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(100, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let query = supabaseAdmin
      .from(TABLE_VERIFIED)
      .select('*', { count: 'exact' });

    // Search across multiple fields
    if (search.trim()) {
      const q = search.trim();
      // Normalize phone search too
      const normSearch = normalizePhoneNumber(q);
      if (/^\d{3,}$/.test(normSearch)) {
        query = query.or(`hr_name.ilike.%${q}%,company_name.ilike.%${q}%,phone_number.ilike.%${q}%,normalized_phone_number.ilike.%${normSearch}%,location.ilike.%${q}%,hr_designation.ilike.%${q}%`);
      } else {
        query = query.or(`hr_name.ilike.%${q}%,company_name.ilike.%${q}%,phone_number.ilike.%${q}%,location.ilike.%${q}%,hr_designation.ilike.%${q}%`);
      }
    }

    if (company.trim()) {
      query = query.ilike('company_name', `%${company.trim()}%`);
    }
    if (verified !== '') {
      query = query.eq('verified', verified === 'true');
    }
    if (verification_status.trim()) {
      query = query.eq('verification_status', verification_status.trim());
    }

    // Sorting
    const allowedSort = ['created_at', 'updated_at', 'hr_name', 'company_name', 'phone_number'];
    const sortField = allowedSort.includes(sortBy) ? sortBy : 'created_at';
    const order = sortOrder === 'asc' ? true : false;
    query = query.order(sortField, { ascending: order });

    query = query.range(offset, offset + limitNum - 1);

    const { data, error, count } = await query;
    if (error) throw error;

    // Stats in parallel (don't block the main query result)
    const [totalRes, verifiedRes] = await Promise.all([
      supabaseAdmin.from(TABLE_VERIFIED).select('*', { count: 'exact', head: true }),
      supabaseAdmin.from(TABLE_VERIFIED).select('*', { count: 'exact', head: true }).eq('verified', true),
    ]);

    res.json({
      success: true,
      data,
      pagination: {
        page: pageNum,
        limit: limitNum,
        total: count,
        totalPages: Math.ceil((count || 0) / limitNum),
        totalCount: totalRes.count || 0,
        verifiedCount: verifiedRes.count || 0,
      }
    });
  } catch (err) {
    console.error('listVerifiedContacts error', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/verified-contacts/:id
export async function getVerifiedContact(req, res) {
  try {
    const { id } = req.params;
    const { data, error } = await supabaseAdmin.from(TABLE_VERIFIED).select('*').eq('id', id).single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ success: false, error: 'Contact not found' });
      throw error;
    }
    res.json({ success: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/verified-contacts
export async function createVerifiedContact(req, res) {
  try {
    const { error: valError, value } = validateVerifiedContact(req.body);
    if (valError) {
      return res.status(400).json({ success: false, error: valError.details.map(d => d.message).join(', '), details: valError.details });
    }

    const normalized = normalizePhoneNumber(value.phone_number);

    // Check duplicate
    const { data: existing } = await supabaseAdmin.from(TABLE_VERIFIED).select('id').eq('normalized_phone_number', normalized).maybeSingle();
    if (existing) {
      return res.status(409).json({ success: false, error: `Phone number ${value.phone_number} already exists as verified contact` });
    }

    const payload = {
      phone_number: value.phone_number.trim(),
      normalized_phone_number: normalized,
      hr_name: value.hr_name.trim(),
      company_name: value.company_name.trim(),
      location: value.location?.trim() || '',
      hr_designation: value.hr_designation?.trim() || '',
      job_position_called_for: value.job_position_called_for?.trim() || 'Other',
      email: value.email || null,
      verified: value.verified,
      verification_status: value.verification_status,
      source: value.source,
      notes: value.notes || null,
      created_by: req.admin?.email || 'admin',
    };

    const { data, error } = await supabaseAdmin.from(TABLE_VERIFIED).insert(payload).select().single();
    if (error) throw error;

    res.status(201).json({ success: true, data, message: 'Verified contact created' });
  } catch (err) {
    console.error('createVerifiedContact', err);
    if (err.code === '23505') {
      return res.status(409).json({ success: false, error: 'Duplicate phone number' });
    }
    res.status(500).json({ success: false, error: err.message });
  }
}

// PUT /api/verified-contacts/:id
export async function updateVerifiedContact(req, res) {
  try {
    const { id } = req.params;
    const { error: valError, value } = validateVerifiedContact(req.body);
    if (valError) {
      return res.status(400).json({ success: false, error: valError.details.map(d => d.message).join(', ') });
    }

    const normalized = normalizePhoneNumber(value.phone_number);

    // Check duplicate excluding self
    const { data: dup } = await supabaseAdmin.from(TABLE_VERIFIED).select('id').eq('normalized_phone_number', normalized).neq('id', id).maybeSingle();
    if (dup) {
      return res.status(409).json({ success: false, error: 'Another contact already uses this phone number' });
    }

    const payload = {
      phone_number: value.phone_number.trim(),
      normalized_phone_number: normalized,
      hr_name: value.hr_name.trim(),
      company_name: value.company_name.trim(),
      location: value.location?.trim() || '',
      hr_designation: value.hr_designation?.trim() || '',
      job_position_called_for: value.job_position_called_for?.trim() || 'Other',
      email: value.email || null,
      verified: value.verified,
      verification_status: value.verification_status,
      source: value.source,
      notes: value.notes || null,
    };

    const { data, error } = await supabaseAdmin.from(TABLE_VERIFIED).update(payload).eq('id', id).select().single();
    if (error) {
      if (error.code === 'PGRST116') return res.status(404).json({ success: false, error: 'Contact not found' });
      throw error;
    }

    res.json({ success: true, data, message: 'Contact updated' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// DELETE /api/verified-contacts/:id
export async function deleteVerifiedContact(req, res) {
  try {
    const { id } = req.params;
    const { error } = await supabaseAdmin.from(TABLE_VERIFIED).delete().eq('id', id);
    if (error) throw error;
    res.json({ success: true, message: 'Contact deleted' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/verified-contacts/bulk  - JSON array bulk (batched for 1000+ users)
export async function bulkCreateVerifiedContacts(req, res) {
  try {
    const { contacts } = req.body;
    if (!Array.isArray(contacts) || contacts.length === 0) {
      return res.status(400).json({ success: false, error: 'contacts array required (1-1000 items)' });
    }
    if (contacts.length > 1000) {
      return res.status(400).json({ success: false, error: 'Max 1000 contacts per bulk upload' });
    }

    // Step 1: Validate all items (no DB calls)
    const validItems = [];
    const errors = [];
    let failedCount = 0;

    for (let i = 0; i < contacts.length; i++) {
      const raw = contacts[i];
      const { error: valErr, value } = validateVerifiedContact(raw);
      if (valErr) {
        failedCount++;
        errors.push({ index: i, phone: raw.phone_number, error: valErr.details.map(d => d.message).join(', ') });
        continue;
      }
      validItems.push({ index: i, value });
    }

    // Step 2: Batch dedup check — fetch all existing normalized phones in one query
    const allPhones = validItems.map(v => normalizePhoneNumber(v.value.phone_number));
    const { data: existingRows } = await supabaseAdmin
      .from(TABLE_VERIFIED)
      .select('normalized_phone_number')
      .in('normalized_phone_number', allPhones);
    const existingSet = new Set((existingRows || []).map(r => r.normalized_phone_number));

    // Step 3: Filter out duplicates, build payloads
    const toInsert = [];
    let duplicateCount = 0;
    for (const { index, value } of validItems) {
      const normalized = normalizePhoneNumber(value.phone_number);
      if (existingSet.has(normalized)) {
        duplicateCount++;
        errors.push({ index, phone: value.phone_number, error: 'Duplicate phone number already exists' });
        continue;
      }
      existingSet.add(normalized); // prevent intra-batch dupes
      toInsert.push({
        phone_number: value.phone_number.trim(),
        normalized_phone_number: normalized,
        hr_name: value.hr_name.trim(),
        company_name: value.company_name.trim(),
        location: value.location?.trim() || '',
        hr_designation: value.hr_designation?.trim() || '',
        job_position_called_for: value.job_position_called_for?.trim() || 'Other',
        email: value.email || null,
        verified: value.verified ?? true,
        verification_status: value.verification_status || 'verified',
        source: 'bulk_import',
        notes: value.notes || null,
        created_by: req.admin?.email || 'admin',
      });
    }

    // Step 4: Batch insert (Supabase supports multi-row insert)
    let successCount = 0;
    const inserted = [];
    const BATCH_SIZE = 100;
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabaseAdmin.from(TABLE_VERIFIED).insert(batch).select();
      if (error) {
        // Batch failed — retry individually to salvage partial success
        for (const row of batch) {
          const { data: single, error: singleErr } = await supabaseAdmin.from(TABLE_VERIFIED).insert(row).select().single();
          if (singleErr) {
            failedCount++;
            errors.push({ index: i, phone: row.phone_number, error: singleErr.message });
          } else {
            successCount++;
            inserted.push(single);
          }
        }
      } else {
        successCount += (data || []).length;
        inserted.push(...(data || []));
      }
    }

    // Log upload
    try {
      await supabaseAdmin.from(TABLE_UPLOADS).insert({
        filename: req.body.filename || 'bulk_json_upload',
        total_rows: contacts.length,
        success_count: successCount,
        failed_count: failedCount,
        duplicate_count: duplicateCount,
        uploaded_by: req.admin?.email || 'admin'
      });
    } catch {}

    res.status(successCount > 0 ? 201 : 400).json({
      success: successCount > 0,
      summary: { total: contacts.length, successCount, failedCount, duplicateCount },
      inserted,
      errors: errors.slice(0, 50),
    });
  } catch (err) {
    console.error('bulkCreate', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// POST /api/verified-contacts/import  - file upload (csv/xlsx)
export async function importFile(req, res) {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, error: 'No file uploaded. Field name must be "file"' });
    }
    const buffer = req.file.buffer;
    const originalName = req.file.originalname;
    const ext = originalName.split('.').pop()?.toLowerCase();

    let rows = [];

    if (ext === 'csv') {
      const { parse } = await import('csv-parse/sync');
      const records = parse(buffer, { columns: true, skip_empty_lines: true, trim: true });
      rows = records;
    } else if (ext === 'xlsx' || ext === 'xls') {
      const XLSX = await import('xlsx');
      const workbook = XLSX.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      rows = XLSX.utils.sheet_to_json(sheet, { defval: '' });
    } else if (ext === 'json') {
      const text = buffer.toString('utf-8');
      const parsed = JSON.parse(text);
      rows = Array.isArray(parsed) ? parsed : parsed.contacts || [];
    } else {
      return res.status(400).json({ success: false, error: 'Unsupported file type. Use .csv, .xlsx, .xls, .json' });
    }

    if (!rows.length) {
      return res.status(400).json({ success: false, error: 'File contains no data rows' });
    }

    // Map flexible column names to schema
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
        phone_number: String(get('phone_number', 'phone', 'mobile', 'mobile_number', 'contact', 'Phone Number', 'Phone') || '').trim(),
        hr_name: String(get('hr_name', 'name', 'hrName', 'HR Name', 'Name') || '').trim(),
        company_name: String(get('company_name', 'company', 'organisation', 'organization', 'Company', 'Company Name') || '').trim(),
        location: String(get('location', 'city', 'Location') || '').trim(),
        hr_designation: String(get('hr_designation', 'designation', 'title', 'Designation') || '').trim(),
        job_position_called_for: String(get('job_position_called_for', 'position', 'job_position', 'Job Position', 'Role') || 'Other').trim() || 'Other',
        email: String(get('email', 'Email') || '').trim() || null,
      };
    });

    // Step 1: Validate all rows
    const validItems = [];
    const errors = [];
    let failedCount = 0;
    for (let i = 0; i < mapped.length; i++) {
      const raw = mapped[i];
      if (!raw.phone_number || !raw.hr_name || !raw.company_name) {
        failedCount++;
        errors.push({ row: i + 2, phone: raw.phone_number || 'N/A', error: 'Missing required: phone_number, hr_name, company_name' });
        continue;
      }
      const { error: valErr, value } = validateVerifiedContact(raw);
      if (valErr) {
        failedCount++;
        errors.push({ row: i + 2, phone: raw.phone_number, error: valErr.details.map(d => d.message).join(', ') });
        continue;
      }
      validItems.push({ index: i, value });
    }

    // Step 2: Batch dedup check
    const allPhones = validItems.map(v => normalizePhoneNumber(v.value.phone_number));
    const { data: existingRows } = await supabaseAdmin
      .from(TABLE_VERIFIED)
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
        hr_name: value.hr_name.trim(),
        company_name: value.company_name.trim(),
        location: value.location?.trim() || '',
        hr_designation: value.hr_designation?.trim() || '',
        job_position_called_for: value.job_position_called_for?.trim() || 'Other',
        email: value.email || null,
        verified: true,
        verification_status: 'verified',
        source: 'bulk_import',
        created_by: req.admin?.email || 'admin',
      });
    }

    // Step 4: Batch insert
    let successCount = 0;
    const inserted = [];
    const BATCH_SIZE = 100;
    for (let i = 0; i < toInsert.length; i += BATCH_SIZE) {
      const batch = toInsert.slice(i, i + BATCH_SIZE);
      const { data, error } = await supabaseAdmin.from(TABLE_VERIFIED).insert(batch).select();
      if (error) {
        for (const row of batch) {
          const { data: single, error: singleErr } = await supabaseAdmin.from(TABLE_VERIFIED).insert(row).select().single();
          if (singleErr) { failedCount++; errors.push({ row: i + 2, phone: row.phone_number, error: singleErr.message }); }
          else { successCount++; inserted.push(single); }
        }
      } else {
        successCount += (data || []).length;
        inserted.push(...(data || []));
      }
    }

    try {
      await supabaseAdmin.from(TABLE_UPLOADS).insert({
        filename: originalName,
        total_rows: rows.length,
        success_count: successCount,
        failed_count: failedCount,
        duplicate_count: duplicateCount,
        uploaded_by: req.admin?.email || 'admin'
      });
    } catch {}

    res.json({
      success: successCount > 0,
      summary: { total: rows.length, successCount, failedCount, duplicateCount },
      errors: errors.slice(0, 100),
      insertedCount: inserted.length,
    });
  } catch (err) {
    console.error('importFile', err);
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/verified-contacts/export/csv
export async function exportCsv(req, res) {
  try {
    const { search = '', company = '' } = req.query;
    let query = supabaseAdmin.from(TABLE_VERIFIED).select('*').order('created_at', { ascending: false }).limit(5000);
    if (search.trim()) {
      const q = search.trim();
      query = query.or(`hr_name.ilike.%${q}%,company_name.ilike.%${q}%,phone_number.ilike.%${q}%`);
    }
    if (company.trim()) query = query.ilike('company_name', `%${company.trim()}%`);

    const { data, error } = await query;
    if (error) throw error;

    const csv = stringify(data.map(r => ({
      phone_number: r.phone_number,
      normalized_phone_number: r.normalized_phone_number,
      hr_name: r.hr_name,
      company_name: r.company_name,
      location: r.location,
      hr_designation: r.hr_designation,
      job_position_called_for: r.job_position_called_for,
      verified: r.verified,
      verification_status: r.verification_status,
      created_at: r.created_at,
    })), { header: true });

    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename="verified_contacts_export.csv"');
    res.send(csv);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/public/verified-contacts  - for Flutter app (public, no auth required)
export async function publicListVerifiedContacts(req, res) {
  try {
    const { search = '', phone = '', page = 1, limit = 20 } = req.query;
    const pageNum = Math.max(1, parseInt(page, 10) || 1);
    const limitNum = Math.min(50, Math.max(1, parseInt(limit, 10) || 20));
    const offset = (pageNum - 1) * limitNum;

    let query = supabaseAdmin.from(TABLE_VERIFIED).select('*', { count: 'exact' }).eq('verified', true).eq('verification_status', 'verified');

    if (phone.trim()) {
      const norm = normalizePhoneNumber(phone.trim());
      query = query.eq('normalized_phone_number', norm);
    } else if (search.trim()) {
      const q = search.trim();
      const normSearch = normalizePhoneNumber(q);
      if (/^\d{3,}$/.test(normSearch)) {
        query = query.or(`hr_name.ilike.%${q}%,company_name.ilike.%${q}%,normalized_phone_number.ilike.%${normSearch}%`);
      } else {
        query = query.or(`hr_name.ilike.%${q}%,company_name.ilike.%${q}%`);
      }
    }

    query = query.order('created_at', { ascending: false }).range(offset, offset + limitNum - 1);
    const { data, error, count } = await query;
    if (error) throw error;

    res.json({
      success: true,
      data,
      pagination: { page: pageNum, limit: limitNum, total: count, totalPages: Math.ceil((count || 0) / limitNum) }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/public/verified-contacts/check/:phone  - check if single phone is verified
export async function checkPhoneVerified(req, res) {
  try {
    const { phone } = req.params;
    const norm = normalizePhoneNumber(phone);
    if (!/^\d{10}$/.test(norm)) {
      return res.status(400).json({ success: false, error: 'Invalid phone number, must be 10 digits' });
    }
    const { data, error } = await supabaseAdmin.from(TABLE_VERIFIED).select('*').eq('normalized_phone_number', norm).eq('verified', true).maybeSingle();
    if (error) throw error;
    if (!data) {
      return res.json({ success: true, isVerified: false, data: null });
    }
    res.json({ success: true, isVerified: true, data });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// GET /api/verified-contacts/stats/summary
// Optimized: 2 queries instead of 7
export async function getStats(req, res) {
  try {
    // Query 1: Get all stats in one pass (single SELECT with aggregates)
    const { data: statsRow, error: statsErr } = await supabaseAdmin.rpc('get_verified_contacts_stats');
    let total = 0, verifiedCount = 0, pending = 0, uniqueCompanies = 0, last7 = 0;

    if (statsErr || !statsRow) {
      // Fallback: parallel count queries (still better than serial)
      const [totalRes, verifiedRes, pendingRes, last7Res] = await Promise.all([
        supabaseAdmin.from(TABLE_VERIFIED).select('*', { count: 'exact', head: true }),
        supabaseAdmin.from(TABLE_VERIFIED).select('*', { count: 'exact', head: true }).eq('verified', true),
        supabaseAdmin.from(TABLE_VERIFIED).select('*', { count: 'exact', head: true }).eq('verification_status', 'pending'),
        supabaseAdmin.from(TABLE_VERIFIED).select('*', { count: 'exact', head: true }).gte('created_at', new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString()),
      ]);
      total = totalRes.count || 0;
      verifiedCount = verifiedRes.count || 0;
      pending = pendingRes.count || 0;
      last7 = last7Res.count || 0;
      // Unique companies from a separate lightweight query
      const { data: companies } = await supabaseAdmin.from(TABLE_VERIFIED).select('company_name');
      uniqueCompanies = new Set((companies || []).map(r => r.company_name)).size;
    } else {
      const s = Array.isArray(statsRow) ? statsRow[0] : statsRow;
      total = s.total || 0;
      verifiedCount = s.verified_count || 0;
      pending = s.pending || 0;
      uniqueCompanies = s.unique_companies || 0;
      last7 = s.added_last_7_days || 0;
    }

    // Query 2: Recent items
    const { data: recent } = await supabaseAdmin
      .from(TABLE_VERIFIED)
      .select('*')
      .order('created_at', { ascending: false })
      .limit(5);

    res.json({
      success: true,
      stats: { total, verified: verifiedCount, pending, uniqueCompanies, addedLast7Days: last7, recent }
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}
