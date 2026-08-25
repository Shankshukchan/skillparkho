-- RUN THIS IN SUPABASE SQL EDITOR for project sgfxztqeanfytcjtykrr
-- https://supabase.com/dashboard/project/sgfxztqeanfytcjtykrr/sql/new
-- This creates the missing student tables and allows the Flutter app to save HR contacts

-- 1. Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- 2. Students Table
CREATE TABLE IF NOT EXISTS public.students (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    auth_user_id TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    mobile_number TEXT NOT NULL,
    normalized_mobile_number TEXT UNIQUE NOT NULL,
    batch_name TEXT NOT NULL,
    course_name TEXT,
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 3. Student HR Contacts Table (where Flutter saves HR contacts)
CREATE TABLE IF NOT EXISTS public.student_hr_contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id TEXT NOT NULL,
    phone_number TEXT NOT NULL,
    normalized_phone_number TEXT NOT NULL,
    hr_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    hr_designation TEXT NOT NULL DEFAULT '',
    job_position_called_for TEXT NOT NULL DEFAULT 'Other',
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT student_hr_contacts_student_phone_unique UNIQUE (student_id, normalized_phone_number)
);

-- 4. Student Call Logs Table
CREATE TABLE IF NOT EXISTS public.student_call_logs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id TEXT NOT NULL,
    hr_contact_id TEXT NULL,
    android_call_log_id TEXT NULL,
    phone_number TEXT NOT NULL,
    normalized_phone_number TEXT NOT NULL,
    call_type TEXT NOT NULL CHECK (call_type IN ('INCOMING', 'OUTGOING', 'MISSED', 'REJECTED')),
    duration_seconds INTEGER DEFAULT 0,
    start_time TIMESTAMPTZ NOT NULL,
    end_time TIMESTAMPTZ NOT NULL,
    sim_subscription_id TEXT NULL,
    sim_slot INTEGER NULL,
    recording_required BOOLEAN DEFAULT false,
    recording_uploaded BOOLEAN DEFAULT false,
    pending_reason TEXT NULL,
    reminder_status TEXT DEFAULT 'not_required' CHECK (reminder_status IN ('not_required','pending','completed','reason_provided')),
    interview_notes TEXT NULL,
    interview_round TEXT NULL,
    interview_rating INTEGER NULL,
    interview_questions JSONB NULL,
    interview_topics JSONB NULL,
    interview_next_steps TEXT NULL,
    notes_updated_at TIMESTAMPTZ NULL,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5. Student Call Recordings Table
CREATE TABLE IF NOT EXISTS public.student_call_recordings (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    student_id TEXT NOT NULL,
    call_log_id TEXT UNIQUE NOT NULL,
    storage_path TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    file_size_bytes BIGINT NOT NULL,
    uploaded_at TIMESTAMPTZ DEFAULT NOW(),
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- 5b. Per-call HR snapshot columns (fix: each call retains its own HR details, not mixed)
-- Run even if table already exists (IF NOT EXISTS)
ALTER TABLE public.student_call_logs ADD COLUMN IF NOT EXISTS hr_snapshot_name TEXT;
ALTER TABLE public.student_call_logs ADD COLUMN IF NOT EXISTS hr_snapshot_company TEXT;
ALTER TABLE public.student_call_logs ADD COLUMN IF NOT EXISTS hr_snapshot_location TEXT;
ALTER TABLE public.student_call_logs ADD COLUMN IF NOT EXISTS hr_snapshot_designation TEXT;
ALTER TABLE public.student_call_logs ADD COLUMN IF NOT EXISTS hr_snapshot_position TEXT;

-- 6. Disable RLS for dev (allow Flutter anon key to write) OR create permissive policies
ALTER TABLE public.students DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_hr_contacts DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_call_logs DISABLE ROW LEVEL SECURITY;
ALTER TABLE public.student_call_recordings DISABLE ROW LEVEL SECURITY;

-- Alternative: if you want to keep RLS enabled, create permissive policies:
-- ALTER TABLE public.student_hr_contacts ENABLE ROW LEVEL SECURITY;
-- CREATE POLICY "Allow all for dev" ON public.student_hr_contacts FOR ALL USING (true) WITH CHECK (true);
-- (repeat for other tables)

-- 7. Verify
SELECT 'students' as table_name, count(*) FROM public.students
UNION ALL SELECT 'student_hr_contacts', count(*) FROM public.student_hr_contacts
UNION ALL SELECT 'student_call_logs', count(*) FROM public.student_call_logs;
