import { createClient } from '@supabase/supabase-js';
import dotenv from 'dotenv';
dotenv.config();

const supabaseUrl = process.env.SUPABASE_URL;
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const supabaseAnonKey = process.env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceKey) {
  console.warn('Supabase URL or Key missing. Check .env');
}

// Service role client (bypasses RLS) - used by backend for all DB operations
export const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey, {
  auth: { autoRefreshToken: false, persistSession: false },
  db: { schema: 'public' },
  global: {
    headers: { 'x-client-info': 'skillparkho-backend/2.0' },
  },
});

// Anon client (respects RLS) - used for Supabase Auth sign-in only
export const supabaseAnon = createClient(supabaseUrl, supabaseAnonKey, {
  auth: { autoRefreshToken: false, persistSession: false },
});

// Canonical table names (single source of truth — no fallbacks)
export const TABLE_ALLOWED_USERS   = 'allowed_app_users';
export const TABLE_OTP             = 'otp_verifications';
export const TABLE_STUDENT_HR      = 'student_hr_contacts';
export const TABLE_CALL_LOGS       = 'student_call_logs';
export const TABLE_CALL_NOTES      = 'student_call_notes';
export const TABLE_CALL_RECORDINGS = 'student_call_recordings';
export const TABLE_INTERVIEW_VIDEOS = 'student_interview_videos';

// Health check with cached result (called by /api/health)
let _healthCache = null;
let _healthCacheTime = 0;
const HEALTH_TTL = 10000; // 10s

export async function testConnection() {
  const now = Date.now();
  if (_healthCache && (now - _healthCacheTime) < HEALTH_TTL) {
    return _healthCache;
  }

  try {
    // Check allowed_app_users
    const { error: aErr } = await supabaseAdmin
      .from(TABLE_ALLOWED_USERS).select('id').limit(1);
    if (aErr && aErr.code === '42P01') {
      _healthCache = { connected: true, tableExists: false, message: 'Run UNIFIED_SCHEMA.sql' };
      _healthCacheTime = now;
      return _healthCache;
    }

    // Check student tables
    const { error: sErr } = await supabaseAdmin
      .from(TABLE_STUDENT_HR).select('id').limit(1);
    const studentTablesExist = !(sErr && sErr.code === '42P01');

    const { error: rErr } = await supabaseAdmin
      .from(TABLE_CALL_RECORDINGS).select('id').limit(1);
    const recordingsExist = !(rErr && rErr.code === '42P01');

    _healthCache = {
      connected: true,
      tables: {
        allowedAppUsers: true,
        studentHrContacts: studentTablesExist,
        callRecordings: recordingsExist,
      },
    };
    _healthCacheTime = now;
    return _healthCache;
  } catch (e) {
    _healthCache = { connected: false, error: e.message };
    _healthCacheTime = now;
    return _healthCache;
  }
}
