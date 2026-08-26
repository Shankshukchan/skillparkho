-- ============================================================================
-- SkillParkho HR Tracker — Database Schema
-- ============================================================================
-- Tables that actually hold data:
--   allowed_app_users, otp_verifications, student_hr_contacts,
--   student_call_logs, student_call_notes, student_call_recordings,
--   student_interview_videos
--
-- Run in Supabase SQL Editor. Idempotent (IF NOT EXISTS) — safe to re-run.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- Extensions
-- ---------------------------------------------------------------------------
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ---------------------------------------------------------------------------
-- Shared: auto-update updated_at column
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;


-- ============================================================================
-- 1. allowed_app_users — Student whitelist (who can log in)
-- ============================================================================
-- Admin uploads phone+email via panel or Google Sheet sync.
-- Only numbers here (or matching Sheet rows) can request OTP.
CREATE TABLE IF NOT EXISTS public.allowed_app_users (
    id                       UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number             TEXT NOT NULL,
    normalized_phone_number  TEXT UNIQUE NOT NULL,    -- last 10 digits, unique
    email                    TEXT NOT NULL,
    full_name                TEXT NOT NULL DEFAULT '',
    course                   TEXT DEFAULT '',
    batch_name               TEXT DEFAULT '',
    is_active                BOOLEAN NOT NULL DEFAULT true,
    created_by               TEXT,                    -- admin email or 'google_sheet'
    created_at               TIMESTAMPTZ DEFAULT NOW(),
    updated_at               TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT chk_allowed_email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE INDEX IF NOT EXISTS idx_allowed_phone   ON public.allowed_app_users(normalized_phone_number);
CREATE INDEX IF NOT EXISTS idx_allowed_email   ON public.allowed_app_users(email);
CREATE INDEX IF NOT EXISTS idx_allowed_active  ON public.allowed_app_users(is_active);
CREATE INDEX IF NOT EXISTS idx_allowed_created ON public.allowed_app_users(created_at DESC);

DROP TRIGGER IF EXISTS trg_allowed_users_updated_at ON public.allowed_app_users;
CREATE TRIGGER trg_allowed_users_updated_at
  BEFORE UPDATE ON public.allowed_app_users
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.allowed_app_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "allowed_users_service_all" ON public.allowed_app_users;
CREATE POLICY "allowed_users_service_all"
  ON public.allowed_app_users FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- 2. otp_verifications — OTP lifecycle
-- ============================================================================
CREATE TABLE IF NOT EXISTS public.otp_verifications (
    id               UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    normalized_phone  TEXT NOT NULL,
    email             TEXT NOT NULL,
    otp_code          TEXT NOT NULL,
    attempts_left     INT NOT NULL DEFAULT 3,
    expires_at        TIMESTAMPTZ NOT NULL,
    consumed          BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_phone    ON public.otp_verifications(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_otp_expires  ON public.otp_verifications(expires_at);
CREATE INDEX IF NOT EXISTS idx_otp_created  ON public.otp_verifications(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_otp_active   ON public.otp_verifications(normalized_phone, consumed, created_at DESC)
  WHERE consumed = false;

ALTER TABLE public.otp_verifications ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "otp_service_all" ON public.otp_verifications;
CREATE POLICY "otp_service_all"
  ON public.otp_verifications FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- 3. student_hr_contacts — HR contacts saved by each student
-- ============================================================================
-- Unique on (student_id, normalized_phone_number) prevents per-student dupes.
CREATE TABLE IF NOT EXISTS public.student_hr_contacts (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id                  TEXT NOT NULL,
    phone_number                TEXT NOT NULL,
    normalized_phone_number     TEXT NOT NULL,
    hr_name                     TEXT NOT NULL,
    company_name                TEXT NOT NULL,
    hr_email                    TEXT DEFAULT NULL,
    location                    TEXT NOT NULL DEFAULT '',
    hr_designation              TEXT NOT NULL DEFAULT '',
    job_position_called_for     TEXT NOT NULL DEFAULT 'Other',
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT uq_student_hr_phone UNIQUE (student_id, normalized_phone_number),
    CONSTRAINT chk_hr_email_format CHECK (hr_email IS NULL OR hr_email = '' OR hr_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

CREATE INDEX IF NOT EXISTS idx_shc_student   ON public.student_hr_contacts(student_id);
CREATE INDEX IF NOT EXISTS idx_shc_phone     ON public.student_hr_contacts(normalized_phone_number);

DROP TRIGGER IF EXISTS trg_shc_updated_at ON public.student_hr_contacts;
CREATE TRIGGER trg_shc_updated_at
  BEFORE UPDATE ON public.student_hr_contacts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.student_hr_contacts ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "shc_service_all" ON public.student_hr_contacts;
CREATE POLICY "shc_service_all"
  ON public.student_hr_contacts FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- 4. student_call_logs — Call log entries synced from student devices
-- ============================================================================
-- Only saved-HR calls > 20 seconds reach the DB.
-- HR snapshot columns preserve HR details at time of call.
CREATE TABLE IF NOT EXISTS public.student_call_logs (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id                  TEXT NOT NULL,
    hr_contact_id               TEXT NULL,
    android_call_log_id         TEXT NULL,
    phone_number                TEXT NOT NULL,
    normalized_phone_number     TEXT NOT NULL,
    call_type                   TEXT NOT NULL
                                CHECK (call_type IN ('INCOMING','OUTGOING','MISSED','REJECTED')),
    duration_seconds            INTEGER DEFAULT 0,
    start_time                  TIMESTAMPTZ NOT NULL,
    end_time                    TIMESTAMPTZ NOT NULL,
    sim_subscription_id         TEXT NULL,
    sim_slot                    INTEGER NULL,
    recording_required          BOOLEAN DEFAULT false,
    recording_uploaded          BOOLEAN DEFAULT false,
    hr_snapshot_name            TEXT NULL,
    hr_snapshot_company         TEXT NULL,
    hr_snapshot_location        TEXT NULL,
    hr_snapshot_designation     TEXT NULL,
    hr_snapshot_position        TEXT NULL,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scl_student       ON public.student_call_logs(student_id);
CREATE INDEX IF NOT EXISTS idx_scl_student_time  ON public.student_call_logs(student_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_scl_phone         ON public.student_call_logs(normalized_phone_number);
CREATE INDEX IF NOT EXISTS idx_scl_android_id    ON public.student_call_logs(android_call_log_id)
  WHERE android_call_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_scl_dedup         ON public.student_call_logs(
  student_id, normalized_phone_number, start_time, call_type, duration_seconds
);

DROP TRIGGER IF EXISTS trg_scl_updated_at ON public.student_call_logs;
CREATE TRIGGER trg_scl_updated_at
  BEFORE UPDATE ON public.student_call_logs
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.student_call_logs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scl_service_all" ON public.student_call_logs;
CREATE POLICY "scl_service_all"
  ON public.student_call_logs FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- 4.2. unknown_calls — Calls from numbers NOT in student_hr_contacts
-- ============================================================================
-- Every call on the verified (monitored) SIM that is NOT a saved HR contact
-- is stored here. This keeps student_call_logs clean (only HR calls >20s)
-- while still giving full visibility of all monitored traffic.
CREATE TABLE IF NOT EXISTS public.unknown_calls (
    id                          UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id                  TEXT NOT NULL,
    android_call_log_id         TEXT NULL,
    phone_number                TEXT NOT NULL,
    normalized_phone_number     TEXT NOT NULL,
    call_type                   TEXT NOT NULL
                                CHECK (call_type IN ('INCOMING','OUTGOING','MISSED','REJECTED')),
    duration_seconds            INTEGER DEFAULT 0,
    start_time                  TIMESTAMPTZ NOT NULL,
    end_time                    TIMESTAMPTZ NOT NULL,
    sim_subscription_id         TEXT NULL,
    sim_slot                    INTEGER NULL,
    created_at                  TIMESTAMPTZ DEFAULT NOW(),
    updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_uc_student       ON public.unknown_calls(student_id);
CREATE INDEX IF NOT EXISTS idx_uc_student_time  ON public.unknown_calls(student_id, start_time DESC);
CREATE INDEX IF NOT EXISTS idx_uc_phone         ON public.unknown_calls(normalized_phone_number);
CREATE INDEX IF NOT EXISTS idx_uc_android_id    ON public.unknown_calls(android_call_log_id)
  WHERE android_call_log_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_uc_dedup         ON public.unknown_calls(
  student_id, normalized_phone_number, start_time, call_type, duration_seconds
);

DROP TRIGGER IF EXISTS trg_uc_updated_at ON public.unknown_calls;
CREATE TRIGGER trg_uc_updated_at
  BEFORE UPDATE ON public.unknown_calls
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.unknown_calls ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "uc_service_all" ON public.unknown_calls;
CREATE POLICY "uc_service_all"
  ON public.unknown_calls FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- 4.5. student_call_notes — Interview notes / call notes (1:1 with call_logs)
-- ============================================================================
-- Separated from student_call_logs so call data and notes have independent
-- lifecycles. One notes row per call log (call_log_id UNIQUE).
CREATE TABLE IF NOT EXISTS public.student_call_notes (
    id                      UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    call_log_id             TEXT UNIQUE NOT NULL,
    student_id              TEXT NOT NULL,
    interview_notes         TEXT NULL,
    interview_round         TEXT NULL,
    interview_rating        INTEGER NULL
                            CHECK (interview_rating IS NULL OR interview_rating BETWEEN 1 AND 5),
    interview_questions     JSONB NULL,
    interview_topics        JSONB NULL,
    interview_next_steps    TEXT NULL,
    notes_updated_at        TIMESTAMPTZ NULL,
    pending_reason          TEXT NULL,
    reminder_status         TEXT DEFAULT 'not_required'
                            CHECK (reminder_status IN ('not_required','pending','completed','reason_provided')),
    created_at              TIMESTAMPTZ DEFAULT NOW(),
    updated_at              TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scn_call_log ON public.student_call_notes(call_log_id);
CREATE INDEX IF NOT EXISTS idx_scn_student  ON public.student_call_notes(student_id);

DROP TRIGGER IF EXISTS trg_scn_updated_at ON public.student_call_notes;
CREATE TRIGGER trg_scn_updated_at
  BEFORE UPDATE ON public.student_call_notes
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

ALTER TABLE public.student_call_notes ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scn_service_all" ON public.student_call_notes;
CREATE POLICY "scn_service_all"
  ON public.student_call_notes FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- 5. student_call_recordings — Recording metadata
-- ============================================================================
-- Files in Supabase Storage: student-call-recordings/<student_id>/<call_log_id>/<file>
-- UNIQUE on call_log_id = one recording per call.
CREATE TABLE IF NOT EXISTS public.student_call_recordings (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id          TEXT NOT NULL,
    call_log_id         TEXT UNIQUE NOT NULL,
    storage_path        TEXT NOT NULL,
    original_filename   TEXT NOT NULL,
    mime_type           TEXT NOT NULL DEFAULT 'audio/mpeg',
    file_size_bytes     BIGINT NOT NULL DEFAULT 0,
    uploaded_at         TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_scr_student  ON public.student_call_recordings(student_id);
CREATE INDEX IF NOT EXISTS idx_scr_call_log ON public.student_call_recordings(call_log_id);

ALTER TABLE public.student_call_recordings ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "scr_service_all" ON public.student_call_recordings;
CREATE POLICY "scr_service_all"
  ON public.student_call_recordings FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- 6. student_interview_videos — Video metadata
-- ============================================================================
-- Files in Supabase Storage: student-interview-videos/<student_id>/videos/<ts>_<file>
CREATE TABLE IF NOT EXISTS public.student_interview_videos (
    id                  UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id          TEXT NOT NULL,
    stage_name          TEXT NOT NULL,
    storage_path        TEXT NOT NULL UNIQUE,
    original_filename   TEXT NOT NULL,
    mime_type           TEXT DEFAULT 'video/mp4',
    file_size_bytes     BIGINT DEFAULT 0,
    uploaded_at         TIMESTAMPTZ DEFAULT NOW(),
    created_at          TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_siv_student ON public.student_interview_videos(student_id);

ALTER TABLE public.student_interview_videos ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "siv_service_all" ON public.student_interview_videos;
CREATE POLICY "siv_service_all"
  ON public.student_interview_videos FOR ALL USING (true) WITH CHECK (true);


-- ============================================================================
-- 7. STORAGE BUCKETS
-- ============================================================================

-- student-call-recordings (private, immutable)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'student-call-recordings', 'student-call-recordings', false, 157286400,
  ARRAY['audio/aac','audio/x-m4a','audio/mp4','audio/mpeg','audio/mp3',
        'audio/wav','audio/x-wav','audio/amr','audio/3gpp','video/3gpp',
        'application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 157286400;

DROP POLICY IF EXISTS "rec_insert_own" ON storage.objects;
CREATE POLICY "rec_insert_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'student-call-recordings'
              AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "rec_select_own" ON storage.objects;
CREATE POLICY "rec_select_own" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'student-call-recordings'
         AND (storage.foldername(name))[1] = auth.uid()::text);

-- student-interview-videos (private)
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'student-interview-videos', 'student-interview-videos', false, 157286400,
  ARRAY['video/mp4','video/webm','video/3gpp','video/quicktime',
        'video/x-matroska','application/octet-stream']
)
ON CONFLICT (id) DO UPDATE SET public = false, file_size_limit = 157286400;

DROP POLICY IF EXISTS "vid_insert_own" ON storage.objects;
CREATE POLICY "vid_insert_own" ON storage.objects FOR INSERT TO authenticated
  WITH CHECK (bucket_id = 'student-interview-videos'
              AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "vid_select_own" ON storage.objects;
CREATE POLICY "vid_select_own" ON storage.objects FOR SELECT TO authenticated
  USING (bucket_id = 'student-interview-videos'
         AND (storage.foldername(name))[1] = auth.uid()::text);

DROP POLICY IF EXISTS "vid_delete_own" ON storage.objects;
CREATE POLICY "vid_delete_own" ON storage.objects FOR DELETE TO authenticated
  USING (bucket_id = 'student-interview-videos'
         AND (storage.foldername(name))[1] = auth.uid()::text);


-- ============================================================================
-- 8. RPC FUNCTIONS
-- ============================================================================

-- is_phone_allowed — Check whitelist for login
CREATE OR REPLACE FUNCTION public.is_phone_allowed(phone_input TEXT)
RETURNS TABLE (is_allowed BOOLEAN, email TEXT, full_name TEXT)
LANGUAGE plpgsql AS $$
DECLARE norm TEXT;
BEGIN
  norm := regexp_replace(phone_input, '[^0-9]', '', 'g');
  IF length(norm) > 10 THEN norm := right(norm, 10); END IF;
  RETURN QUERY
  SELECT a.is_active, a.email, a.full_name
  FROM public.allowed_app_users a
  WHERE a.normalized_phone_number = norm
  LIMIT 1;
END;
$$;

-- get_allowed_users_stats — Single-query stats for admin dashboard
CREATE OR REPLACE FUNCTION public.get_allowed_users_stats()
RETURNS TABLE (total BIGINT, active_count BIGINT, inactive_count BIGINT, added_last_7_days BIGINT)
LANGUAGE sql STABLE AS $$
  SELECT
    COUNT(*)::bigint                                              AS total,
    COUNT(*) FILTER (WHERE is_active = true)::bigint              AS active_count,
    COUNT(*) FILTER (WHERE is_active = false)::bigint             AS inactive_count,
    COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::bigint AS added_last_7_days
  FROM public.allowed_app_users;
$$;

-- cleanup_expired_otps — Delete consumed/expired OTPs (run via cron or on read)
CREATE OR REPLACE FUNCTION public.cleanup_expired_otps()
RETURNS void LANGUAGE sql AS $$
  DELETE FROM public.otp_verifications
  WHERE consumed = true
     OR expires_at < NOW() - INTERVAL '1 hour';
$$;


-- ============================================================================
-- DONE
-- ============================================================================
