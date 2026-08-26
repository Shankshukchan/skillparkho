import jwt from 'jsonwebtoken';
import { randomUUID } from 'crypto';
import {
  supabaseAdmin,
  TABLE_STUDENT_HR,
  TABLE_CALL_LOGS,
  TABLE_CALL_NOTES,
  TABLE_CALL_RECORDINGS,
  TABLE_UNKNOWN_CALLS,
} from '../config/supabase.js';
import { validateHrPayload, validateCallLogPayload } from '../utils/validators.js';

function isValidUuid(str) {
  return typeof str === 'string' && /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/.test(str);
}
function ensureUuid(id) {
  if (!id || !isValidUuid(id)) return randomUUID();
  return id;
}

// ---------------------------------------------------------------------------
// Student JWT middleware
// ---------------------------------------------------------------------------
export function authenticateStudent(req, res, next) {
  let token = null;
  const auth = req.headers.authorization;
  if (auth && auth.startsWith('Bearer ')) {
    token = auth.split(' ')[1];
  } else if (req.query?.token) {
    token = req.query.token; // streaming endpoints where players can't send headers
  } else if (req.headers['x-student-token']) {
    token = req.headers['x-student-token'];
  }
  if (!token) return res.status(401).json({ success: false, error: 'Missing student token' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.role !== 'student') throw new Error('Not student');
    req.student = decoded;
    next();
  } catch {
    return res.status(401).json({ success: false, error: 'Invalid student token' });
  }
}

// ---------------------------------------------------------------------------
// POST /api/app/hr-contacts  (single or array)
// ---------------------------------------------------------------------------
export async function upsertHrContact(req, res) {
  try {
    const studentId = req.student.id || req.student.phone;
    const body = req.body;
    const contacts = Array.isArray(body) ? body : (body.contacts ? body.contacts : [body]);
    const results = [];
    for (const c of contacts) {
      const vErr = validateHrPayload(c);
      if (vErr) { results.push({ success: false, error: 'Validation failed', details: vErr, payload: c }); continue; }
      const payload = {
        id: ensureUuid(c.id),
        student_id: c.student_id || studentId,
        phone_number: String(c.phone_number).trim(),
        normalized_phone_number: c.normalized_phone_number
          ? String(c.normalized_phone_number).trim()
          : String(c.phone_number).trim().replace(/\D/g, '').slice(-10),
        hr_name: String(c.hr_name).trim(),
        company_name: String(c.company_name).trim(),
        location: (c.location || '').trim(),
        hr_designation: (c.hr_designation || '').trim(),
        job_position_called_for: String(c.job_position_called_for || 'Other').trim(),
        created_at: c.created_at || new Date().toISOString(),
        updated_at: c.updated_at || new Date().toISOString(),
      };
      if (!payload.phone_number || !payload.hr_name || !payload.company_name) {
        results.push({ success: false, error: 'Missing required fields', payload });
        continue;
      }
      // Upsert by id
      let { data, error } = await supabaseAdmin
        .from(TABLE_STUDENT_HR)
        .upsert(payload, { onConflict: 'id' })
        .select()
        .maybeSingle();
      // If duplicate phone unique constraint, update by student+phone
      if (error?.code === '23505') {
        const upd = await supabaseAdmin
          .from(TABLE_STUDENT_HR)
          .update(payload)
          .eq('student_id', payload.student_id)
          .eq('normalized_phone_number', payload.normalized_phone_number)
          .select()
          .maybeSingle();
        data = upd.data; error = upd.error;
      }
      if (error) {
        results.push({ success: false, error: error.message, payload });
      } else {
        results.push({ success: true, data });
      }
    }
    const allOk = results.length > 0 && results.every(r => r.success);
    if (res.headersSent) return;
    res.json({ success: allOk, results });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/hr-contacts
// ---------------------------------------------------------------------------
export async function listHrContacts(req, res) {
  try {
    const studentId = req.student.id || req.query.student_id;
    const { data, error } = await supabaseAdmin
      .from(TABLE_STUDENT_HR)
      .select('*')
      .eq('student_id', studentId)
      .order('created_at', { ascending: false })
      .limit(200);
    if (error) throw error;
    if (res.headersSent) return;
    res.json({ success: true, data });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/app/hr-contacts/:id
// ---------------------------------------------------------------------------
export async function deleteHrContact(req, res) {
  try {
    const studentId = req.student.id;
    const { id } = req.params;
    if (!id || !isValidUuid(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

    // Fetch normalized phone for cascade
    const { data: hr } = await supabaseAdmin
      .from(TABLE_STUDENT_HR)
      .select('normalized_phone_number')
      .eq('id', id)
      .eq('student_id', studentId)
      .maybeSingle();
    const normalized = hr?.normalized_phone_number || null;

    // Delete HR contact
    const { data: deleted } = await supabaseAdmin
      .from(TABLE_STUDENT_HR)
      .delete()
      .eq('id', id)
      .eq('student_id', studentId)
      .select('id');

    let deletedOk = !!(deleted && deleted.length > 0);

    // Cascade: delete associated call logs and recordings
    if (normalized) {
      const { data: logs } = await supabaseAdmin
        .from(TABLE_CALL_LOGS)
        .select('id')
        .eq('student_id', studentId)
        .eq('normalized_phone_number', normalized);
      const logIds = (logs || []).map(r => r.id);
      if (logIds.length > 0) {
        await supabaseAdmin.from(TABLE_CALL_NOTES).delete().in('call_log_id', logIds);
        await supabaseAdmin.from(TABLE_CALL_RECORDINGS).delete().in('call_log_id', logIds);
        await supabaseAdmin.from(TABLE_CALL_LOGS).delete().in('id', logIds);
      }
    }

    if (!deletedOk) {
      // Idempotent: if row is gone, it's a success
      const { data: check } = await supabaseAdmin
        .from(TABLE_STUDENT_HR)
        .select('id')
        .eq('id', id)
        .maybeSingle();
      if (!check) deletedOk = true;
    }
    if (res.headersSent) return;
    res.json({ success: deletedOk, deleted: deletedOk, cascaded: !!normalized });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/app/call-logs  (single or array)
// ---------------------------------------------------------------------------
export async function upsertCallLog(req, res) {
  try {
    const body = req.body;
    const logs = Array.isArray(body) ? body : (body.logs ? body.logs : [body]);
    const results = [];
    for (const l of logs) {
      const vErr = validateCallLogPayload(l);
      if (vErr) { results.push({ success: false, error: 'Validation failed', details: vErr }); continue; }

      const normalizedPhone = String(l.normalized_phone_number || l.phone_number).trim().replace(/\D/g, '').slice(-10);

      // --- Call log payload (no note columns) ---
      const callPayload = {
        id: ensureUuid(l.id),
        student_id: l.student_id,
        hr_contact_id: l.hr_contact_id && isValidUuid(l.hr_contact_id) ? l.hr_contact_id : null,
        android_call_log_id: l.android_call_log_id || null,
        phone_number: String(l.phone_number).trim(),
        normalized_phone_number: normalizedPhone,
        call_type: l.call_type,
        duration_seconds: l.duration_seconds || 0,
        start_time: l.start_time,
        end_time: l.end_time,
        sim_subscription_id: l.sim_subscription_id || null,
        sim_slot: l.sim_slot || 0,
        recording_required: l.recording_required || false,
        recording_uploaded: l.recording_uploaded || false,
        created_at: l.created_at || new Date().toISOString(),
        updated_at: l.updated_at || new Date().toISOString(),
        hr_snapshot_name: l.hr_snapshot_name || null,
        hr_snapshot_company: l.hr_snapshot_company || null,
        hr_snapshot_location: l.hr_snapshot_location || null,
        hr_snapshot_designation: l.hr_snapshot_designation || null,
        hr_snapshot_position: l.hr_snapshot_position || null,
      };

      // --- Notes payload (only if caller sent note fields) ---
      const hasNotes =
        l.interview_notes != null || l.interview_round != null || l.interview_rating != null ||
        l.interview_questions != null || l.interview_topics != null || l.interview_next_steps != null ||
        l.notes_updated_at != null || l.pending_reason != null ||
        (l.reminder_status && l.reminder_status !== 'not_required');

      const notesPayload = hasNotes ? {
        call_log_id: callPayload.id,
        student_id: callPayload.student_id,
        interview_notes: l.interview_notes || null,
        interview_round: l.interview_round || null,
        interview_rating: l.interview_rating || null,
        interview_questions: l.interview_questions || null,
        interview_topics: l.interview_topics || null,
        interview_next_steps: l.interview_next_steps || null,
        notes_updated_at: l.notes_updated_at || null,
        pending_reason: l.pending_reason || null,
        reminder_status: l.reminder_status || 'not_required',
      } : null;

      // Determine if this number is a saved HR
      let hasSavedHr = !!callPayload.hr_contact_id;
      if (!hasSavedHr && normalizedPhone) {
        const { data: hr } = await supabaseAdmin
          .from(TABLE_STUDENT_HR)
          .select('id')
          .eq('student_id', callPayload.student_id)
          .eq('normalized_phone_number', normalizedPhone)
          .maybeSingle();
        if (hr) {
          hasSavedHr = true;
          if (!callPayload.hr_contact_id) callPayload.hr_contact_id = hr.id;
        }
      }

      // Unknown (not saved) calls go to unknown_calls table (all monitored SIM traffic)
      if (!hasSavedHr) {
        // Dedup in unknown_calls
        let unknownDedupId = null;
        if (callPayload.android_call_log_id) {
          const { data: existingU } = await supabaseAdmin
            .from(TABLE_UNKNOWN_CALLS)
            .select('id')
            .eq('student_id', callPayload.student_id)
            .eq('android_call_log_id', callPayload.android_call_log_id)
            .maybeSingle();
          if (existingU) unknownDedupId = existingU.id;
        }
        if (!unknownDedupId && normalizedPhone && callPayload.start_time) {
          const { data: existingU2 } = await supabaseAdmin
            .from(TABLE_UNKNOWN_CALLS)
            .select('id')
            .eq('student_id', callPayload.student_id)
            .eq('normalized_phone_number', normalizedPhone)
            .eq('start_time', callPayload.start_time)
            .eq('call_type', callPayload.call_type)
            .eq('duration_seconds', callPayload.duration_seconds)
            .maybeSingle();
          if (existingU2) unknownDedupId = existingU2.id;
        }
        const unknownPayload = {
          id: unknownDedupId || ensureUuid(l.id),
          student_id: callPayload.student_id,
          android_call_log_id: callPayload.android_call_log_id,
          phone_number: callPayload.phone_number,
          normalized_phone_number: normalizedPhone,
          call_type: callPayload.call_type,
          duration_seconds: callPayload.duration_seconds || 0,
          start_time: callPayload.start_time,
          end_time: callPayload.end_time,
          sim_subscription_id: callPayload.sim_subscription_id,
          sim_slot: callPayload.sim_slot,
          created_at: callPayload.created_at,
          updated_at: callPayload.updated_at,
        };
        let { data: uData, error: uError } = await supabaseAdmin
          .from(TABLE_UNKNOWN_CALLS)
          .upsert(unknownPayload, { onConflict: 'id' })
          .select()
          .maybeSingle();
        if (uError) {
          results.push({ success: false, error: uError.message });
          continue;
        }
        results.push({ success: true, data: uData, unknown: true });
        continue;
      }

      // Known HR calls: dedup in student_call_logs
      let dedupId = null;
      if (callPayload.android_call_log_id) {
        const { data: existing } = await supabaseAdmin
          .from(TABLE_CALL_LOGS)
          .select('id')
          .eq('student_id', callPayload.student_id)
          .eq('android_call_log_id', callPayload.android_call_log_id)
          .maybeSingle();
        if (existing) dedupId = existing.id;
      }
      if (!dedupId && normalizedPhone && callPayload.start_time) {
        const { data: existing2 } = await supabaseAdmin
          .from(TABLE_CALL_LOGS)
          .select('id')
          .eq('student_id', callPayload.student_id)
          .eq('normalized_phone_number', normalizedPhone)
          .eq('start_time', callPayload.start_time)
          .eq('call_type', callPayload.call_type)
          .eq('duration_seconds', callPayload.duration_seconds)
          .maybeSingle();
        if (existing2) dedupId = existing2.id;
      }
      if (dedupId) callPayload.id = dedupId;

      // Only saved-HR calls > 20s go to student_call_logs (new calls only)
      if (!dedupId) {
        const duration = Number(callPayload.duration_seconds) || 0;
        if (duration <= 20) {
          results.push({ success: false, skipped: true, local_only: true, reason: 'Call stays on device (short <=20s)' });
          continue;
        }
      }

      // Upsert call log
      let { data, error } = await supabaseAdmin
        .from(TABLE_CALL_LOGS)
        .upsert(callPayload, { onConflict: 'id' })
        .select()
        .maybeSingle();
      if (error?.code === '23505') {
        const upd = await supabaseAdmin
          .from(TABLE_CALL_LOGS)
          .update(callPayload)
          .eq('id', callPayload.id)
          .select()
          .maybeSingle();
        data = upd.data; error = upd.error;
      }
      if (error) {
        // Snapshot columns may not exist on old DBs - retry without them
        if (error.message?.includes('hr_snapshot')) {
          const fb = { ...callPayload };
          delete fb.hr_snapshot_name; delete fb.hr_snapshot_company;
          delete fb.hr_snapshot_location; delete fb.hr_snapshot_designation;
          delete fb.hr_snapshot_position;
          const retry = await supabaseAdmin
            .from(TABLE_CALL_LOGS)
            .upsert(fb, { onConflict: 'id' })
            .select()
            .maybeSingle();
          data = retry.data; error = retry.error;
        }
      }
      if (error) {
        results.push({ success: false, error: error.message });
        continue;
      }

      // Upsert notes (separate table)
      if (notesPayload) {
        const { error: nErr } = await supabaseAdmin
          .from(TABLE_CALL_NOTES)
          .upsert(notesPayload, { onConflict: 'call_log_id' });
        if (nErr) {
          // Notes table may not exist on old DBs — fail gracefully
          console.warn('notes upsert failed (table may not exist):', nErr.message);
        }
      }

      // Merge notes into response so Flutter sees the same shape
      if (data && notesPayload) {
        data = { ...data, ...notesPayload };
      } else if (data && !notesPayload) {
        // Return existing notes if present (for dedup re-upserts)
        const { data: existingNotes } = await supabaseAdmin
          .from(TABLE_CALL_NOTES)
          .select('*')
          .eq('call_log_id', data.id)
          .maybeSingle();
        if (existingNotes) data = { ...data, ...existingNotes };
      }

      results.push({ success: true, data });
    }
    const allOk = results.length > 0 && results.every(r => r.success);
    if (res.headersSent) return;
    res.json({ success: allOk, results });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/call-logs
// ---------------------------------------------------------------------------
export async function listCallLogs(req, res) {
  try {
    const studentId = req.student.id || req.query.student_id;
    const [{ data: logs, error: lErr }, { data: notes }] = await Promise.all([
      supabaseAdmin
        .from(TABLE_CALL_LOGS)
        .select('*')
        .eq('student_id', studentId)
        .order('start_time', { ascending: false })
        .limit(200),
      supabaseAdmin
        .from(TABLE_CALL_NOTES)
        .select('*')
        .eq('student_id', studentId),
    ]);
    if (lErr) throw lErr;

    // Index notes by call_log_id for O(n) merge.
    // Only merge note-specific columns — do NOT spread the entire notes row
    // because it has its own `id` column which would overwrite the call log's ID.
    const notesByCall = {};
    for (const n of (notes || [])) {
      notesByCall[n.call_log_id] = {
        interview_notes: n.interview_notes,
        interview_round: n.interview_round,
        interview_rating: n.interview_rating,
        interview_questions: n.interview_questions,
        interview_topics: n.interview_topics,
        interview_next_steps: n.interview_next_steps,
        notes_updated_at: n.notes_updated_at,
        pending_reason: n.pending_reason,
        reminder_status: n.reminder_status,
      };
    }
    const merged = (logs || []).map(log => {
      const n = notesByCall[log.id];
      return n ? { ...log, ...n } : log;
    });
    if (res.headersSent) return;
    res.json({ success: true, data: merged });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// DELETE /api/app/call-logs/:id  (now blocked for all - per spec no deletes)
// ---------------------------------------------------------------------------
export async function deleteCallLog(req, res) {
  try {
    const studentId = req.student.id;
    const { id } = req.params;
    if (!id || !isValidUuid(id)) return res.status(400).json({ success: false, error: 'Invalid id' });

    // Check if it's an unknown call — also blocked (per spec: unknown not deletable)
    const { data: unknown } = await supabaseAdmin.from(TABLE_UNKNOWN_CALLS).select('id').eq('id', id).eq('student_id', studentId).maybeSingle();
    if (unknown) {
      return res.status(403).json({ success: false, error: 'Stored in database. Cannot be deleted.' });
    }

    // For known HR calls, deletion is also now blocked per spec (all calls permanent)
    // Keep legacy behavior for call_logs but enforce block for qualifiesForDetails equivalent
    // For backwards compatibility we check if call exists - if so, block delete
    const { data: existing } = await supabaseAdmin.from(TABLE_CALL_LOGS).select('id').eq('id', id).eq('student_id', studentId).maybeSingle();
    if (existing) {
      return res.status(403).json({ success: false, error: 'Stored in database. Cannot be deleted.' });
    }

    // If not found in either, treat as already deleted (idempotent)
    if (res.headersSent) return;
    res.json({ success: true, deleted: true });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// GET /api/app/unknown-calls  — list unknown calls for student
// ---------------------------------------------------------------------------
export async function listUnknownCalls(req, res) {
  try {
    const studentId = req.student.id || req.query.student_id;
    const { data, error } = await supabaseAdmin
      .from(TABLE_UNKNOWN_CALLS)
      .select('*')
      .eq('student_id', studentId)
      .order('start_time', { ascending: false })
      .limit(200);
    if (error) throw error;
    if (res.headersSent) return;
    res.json({ success: true, data });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/app/unknown-calls — upsert single unknown call (used by direct unknown sync)
// ---------------------------------------------------------------------------
export async function upsertUnknownCall(req, res) {
  try {
    const body = req.body;
    const logs = Array.isArray(body) ? body : (body.logs ? body.logs : [body]);
    const results = [];
    for (const l of logs) {
      const vErr = validateCallLogPayload(l);
      if (vErr) { results.push({ success: false, error: 'Validation failed', details: vErr }); continue; }
      const normalizedPhone = String(l.normalized_phone_number || l.phone_number).trim().replace(/\D/g, '').slice(-10);
      const payload = {
        id: ensureUuid(l.id),
        student_id: l.student_id,
        android_call_log_id: l.android_call_log_id || null,
        phone_number: String(l.phone_number).trim(),
        normalized_phone_number: normalizedPhone,
        call_type: l.call_type,
        duration_seconds: l.duration_seconds || 0,
        start_time: l.start_time,
        end_time: l.end_time,
        sim_subscription_id: l.sim_subscription_id || null,
        sim_slot: l.sim_slot || 0,
        created_at: l.created_at || new Date().toISOString(),
        updated_at: l.updated_at || new Date().toISOString(),
      };
      let dedupId = null;
      if (payload.android_call_log_id) {
        const { data: e } = await supabaseAdmin.from(TABLE_UNKNOWN_CALLS).select('id').eq('student_id', payload.student_id).eq('android_call_log_id', payload.android_call_log_id).maybeSingle();
        if (e) dedupId = e.id;
      }
      if (!dedupId && normalizedPhone && payload.start_time) {
        const { data: e2 } = await supabaseAdmin.from(TABLE_UNKNOWN_CALLS).select('id').eq('student_id', payload.student_id).eq('normalized_phone_number', normalizedPhone).eq('start_time', payload.start_time).eq('call_type', payload.call_type).eq('duration_seconds', payload.duration_seconds).maybeSingle();
        if (e2) dedupId = e2.id;
      }
      if (dedupId) payload.id = dedupId;
      const { data, error } = await supabaseAdmin.from(TABLE_UNKNOWN_CALLS).upsert(payload, { onConflict: 'id' }).select().maybeSingle();
      if (error) { results.push({ success: false, error: error.message }); continue; }
      results.push({ success: true, data });
    }
    const allOk = results.length > 0 && results.every(r => r.success);
    if (res.headersSent) return;
    res.json({ success: allOk, results });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}

// ---------------------------------------------------------------------------
// POST /api/app/sync — Bulk sync (hrContacts + callLogs)
// ---------------------------------------------------------------------------
export async function syncAll(req, res) {
  try {
    const { hrContacts = [], callLogs = [] } = req.body;
    const studentId = req.student.id;
    const hrResults = [], callResults = [];

    // Batch HR contacts
    for (const c of hrContacts) {
      const payload = { ...c, student_id: c.student_id || studentId };
      const { error } = await supabaseAdmin
        .from(TABLE_STUDENT_HR)
        .upsert(payload, { onConflict: 'id' });
      hrResults.push(error ? { success: false, error: error.message } : { success: true });
    }

    // Batch call logs — route unknown numbers to unknown_calls
    for (const l of callLogs) {
      const isUnknown = !l.hr_contact_id && !hrContacts.find(h => h.normalized_phone_number === l.normalized_phone_number);
      // Check DB for HR existence if payload claims unknown but DB has HR
      let hasHrInDb = !isUnknown;
      if (isUnknown && l.normalized_phone_number) {
        const { data: hr } = await supabaseAdmin.from(TABLE_STUDENT_HR).select('id').eq('student_id', l.student_id || studentId).eq('normalized_phone_number', l.normalized_phone_number).maybeSingle();
        if (hr) hasHrInDb = true;
      }
      if (isUnknown && !hasHrInDb) {
        // Route to unknown_calls
        const normalizedPhone = String(l.normalized_phone_number || l.phone_number).replace(/\D/g,'').slice(-10);
        const unknownPayload = {
          id: l.id || randomUUID(),
          student_id: l.student_id || studentId,
          android_call_log_id: l.android_call_log_id || null,
          phone_number: String(l.phone_number).trim(),
          normalized_phone_number: normalizedPhone,
          call_type: l.call_type,
          duration_seconds: l.duration_seconds || 0,
          start_time: l.start_time,
          end_time: l.end_time,
          sim_subscription_id: l.sim_subscription_id || null,
          sim_slot: l.sim_slot || 0,
        };
        const { error: uErr } = await supabaseAdmin.from(TABLE_UNKNOWN_CALLS).upsert(unknownPayload, { onConflict: 'id' });
        callResults.push(uErr ? { success: false, error: uErr.message } : { success: true, unknown: true });
        continue;
      }

      // Split call log vs notes
      const callPayload = {
        id: l.id, student_id: l.student_id || studentId,
        hr_contact_id: l.hr_contact_id, android_call_log_id: l.android_call_log_id,
        phone_number: l.phone_number, normalized_phone_number: l.normalized_phone_number,
        call_type: l.call_type, duration_seconds: l.duration_seconds,
        start_time: l.start_time, end_time: l.end_time,
        sim_subscription_id: l.sim_subscription_id, sim_slot: l.sim_slot,
        recording_required: l.recording_required, recording_uploaded: l.recording_uploaded,
        created_at: l.created_at, updated_at: l.updated_at,
        hr_snapshot_name: l.hr_snapshot_name, hr_snapshot_company: l.hr_snapshot_company,
        hr_snapshot_location: l.hr_snapshot_location, hr_snapshot_designation: l.hr_snapshot_designation,
        hr_snapshot_position: l.hr_snapshot_position,
      };

      const { error: cErr } = await supabaseAdmin
        .from(TABLE_CALL_LOGS)
        .upsert(callPayload, { onConflict: 'id' });

      // Upsert notes if present
      const hasNotes = l.interview_notes || l.interview_round || l.interview_rating ||
        l.interview_questions || l.interview_topics || l.interview_next_steps ||
        l.pending_reason || (l.reminder_status && l.reminder_status !== 'not_required');
      if (hasNotes && !cErr) {
        await supabaseAdmin
          .from(TABLE_CALL_NOTES)
          .upsert({
            call_log_id: callPayload.id,
            student_id: callPayload.student_id,
            interview_notes: l.interview_notes || null,
            interview_round: l.interview_round || null,
            interview_rating: l.interview_rating || null,
            interview_questions: l.interview_questions || null,
            interview_topics: l.interview_topics || null,
            interview_next_steps: l.interview_next_steps || null,
            notes_updated_at: l.notes_updated_at || null,
            pending_reason: l.pending_reason || null,
            reminder_status: l.reminder_status || 'not_required',
          }, { onConflict: 'call_log_id' });
      }

      callResults.push(cErr ? { success: false, error: cErr.message } : { success: true });
    }

    const hrOk = !hrResults.length || hrResults.every(r => r.success);
    const callOk = callResults.every(r => r.success);
    res.json({ success: hrOk && callOk, hrResults, callResults });
  } catch (err) {
    if (res.headersSent) return;
    res.status(500).json({ success: false, error: err.message });
  }
}
