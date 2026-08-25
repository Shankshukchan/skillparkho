-- SkillParkho Allowed App Users + Email OTP - Supabase Schema
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/lkmqpllmxrjgnwmqjrgl/sql/new
-- Project: https://lkmqpllmxrjgnwmqjrgl.supabase.co
-- Depends on: supabase/schema.sql (verified_hr_contacts)
-- This implements: Admin uploads user phone+email, only those numbers can request OTP via email

CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. ALLOWED APP USERS (whitelist curated by Admin)
--    Admin uploads phone_number + email, only these phones can login
-- ============================================================
CREATE TABLE IF NOT EXISTS public.allowed_app_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number TEXT NOT NULL,
    normalized_phone_number TEXT UNIQUE NOT NULL, -- last 10 digits, unique
    email TEXT NOT NULL,
    full_name TEXT NOT NULL DEFAULT '',
    course TEXT DEFAULT '',
    batch_name TEXT DEFAULT '',
    is_active BOOLEAN NOT NULL DEFAULT true,
    created_by TEXT, -- admin email or google_sheet
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW(),
    CONSTRAINT email_format CHECK (email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$')
);

-- Add course/batch columns if table already exists (migration patch)
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='allowed_app_users' AND column_name='course') THEN
    ALTER TABLE public.allowed_app_users ADD COLUMN course TEXT DEFAULT '';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='allowed_app_users' AND column_name='batch_name') THEN
    ALTER TABLE public.allowed_app_users ADD COLUMN batch_name TEXT DEFAULT '';
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_allowed_app_users_normalized_phone ON public.allowed_app_users(normalized_phone_number);
CREATE INDEX IF NOT EXISTS idx_allowed_app_users_email ON public.allowed_app_users(email);
CREATE INDEX IF NOT EXISTS idx_allowed_app_users_active ON public.allowed_app_users(is_active);
CREATE INDEX IF NOT EXISTS idx_allowed_app_users_created_at ON public.allowed_app_users(created_at DESC);

-- updated_at trigger (reuse handle_updated_at if exists)
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_allowed_app_users_updated_at ON public.allowed_app_users;
CREATE TRIGGER set_allowed_app_users_updated_at
  BEFORE UPDATE ON public.allowed_app_users
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- RLS
ALTER TABLE public.allowed_app_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow read allowed users for all" ON public.allowed_app_users;
CREATE POLICY "Allow read allowed users for all"
  ON public.allowed_app_users FOR SELECT
  USING (true);

DROP POLICY IF EXISTS "Allow service_role all allowed" ON public.allowed_app_users;
CREATE POLICY "Allow service_role all allowed"
  ON public.allowed_app_users FOR ALL
  USING (true) WITH CHECK (true);

DROP POLICY IF EXISTS "Allow anon write for dev allowed" ON public.allowed_app_users;
CREATE POLICY "Allow anon write for dev allowed"
  ON public.allowed_app_users FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================
-- 2. OTP VERIFICATIONS (email OTP lifecycle)
--    Generated on request-otp, verified on verify-otp
-- ============================================================
CREATE TABLE IF NOT EXISTS public.otp_verifications (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    normalized_phone TEXT NOT NULL,
    email TEXT NOT NULL,
    otp_code TEXT NOT NULL, -- plain 6-digit in dev, hash in prod recommended
    attempts_left INT NOT NULL DEFAULT 3,
    expires_at TIMESTAMPTZ NOT NULL,
    consumed BOOLEAN NOT NULL DEFAULT false,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_verifications_phone ON public.otp_verifications(normalized_phone);
CREATE INDEX IF NOT EXISTS idx_otp_verifications_expires ON public.otp_verifications(expires_at);
CREATE INDEX IF NOT EXISTS idx_otp_verifications_created ON public.otp_verifications(created_at DESC);

ALTER TABLE public.otp_verifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow all otp" ON public.otp_verifications;
CREATE POLICY "Allow all otp" ON public.otp_verifications FOR ALL USING (true) WITH CHECK (true);

-- Cleanup old expired OTPs (optional helper view)
CREATE OR REPLACE VIEW public.otp_stats AS
SELECT
  COUNT(*)::int AS total_pending,
  COUNT(*) FILTER (WHERE expires_at < NOW())::int AS expired_pending,
  COUNT(DISTINCT normalized_phone)::int AS unique_phones
FROM public.otp_verifications
WHERE consumed = false;

-- ============================================================
-- 3. AUDIT LOG FOR ALLOWED USER UPLOADS (optional)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.allowed_user_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename TEXT,
    total_rows INT NOT NULL DEFAULT 0,
    success_count INT NOT NULL DEFAULT 0,
    failed_count INT NOT NULL DEFAULT 0,
    duplicate_count INT NOT NULL DEFAULT 0,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.allowed_user_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all allowed uploads log" ON public.allowed_user_uploads;
CREATE POLICY "Allow all allowed uploads log" ON public.allowed_user_uploads FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 4. RPC: Check if phone is allowed (for Flutter/backend)
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_phone_allowed(phone_input TEXT)
RETURNS TABLE (
  is_allowed BOOLEAN,
  email TEXT,
  full_name TEXT
) LANGUAGE plpgsql AS $$
DECLARE
  norm TEXT;
BEGIN
  norm := regexp_replace(phone_input, '[^0-9]', '', 'g');
  IF length(norm) > 10 THEN
    norm := right(norm, 10);
  END IF;
  RETURN QUERY
  SELECT
    a.is_active,
    a.email,
    a.full_name
  FROM public.allowed_app_users a
  WHERE a.normalized_phone_number = norm
  LIMIT 1;
END;
$$;

-- No seed data - all verified students come from Google Sheet 1djvPugtfUfC6ELT_OSxWcwqi9ofJ1Tj-4YilpB4Cogk
-- To clean old seed rows if they exist: DELETE FROM public.allowed_app_users WHERE created_by='seed';
