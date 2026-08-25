-- SkillParkho Verified HR Contacts - Supabase Schema
-- Run this in Supabase SQL Editor: https://supabase.com/dashboard/project/lkmqpllmxrjgnwmqjrgl/sql/new
-- Project: https://lkmqpllmxrjgnwmqjrgl.supabase.co

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. VERIFIED HR CONTACTS (Global pool curated by Admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verified_hr_contacts (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    phone_number TEXT NOT NULL,
    normalized_phone_number TEXT UNIQUE NOT NULL,
    hr_name TEXT NOT NULL,
    company_name TEXT NOT NULL,
    location TEXT NOT NULL DEFAULT '',
    hr_designation TEXT NOT NULL DEFAULT '',
    job_position_called_for TEXT NOT NULL DEFAULT 'Other',
    email TEXT,
    verified BOOLEAN NOT NULL DEFAULT true,
    verification_status TEXT NOT NULL DEFAULT 'verified' CHECK (verification_status IN ('verified','pending','rejected','expired')),
    source TEXT DEFAULT 'admin_upload' CHECK (source IN ('admin_upload','bulk_import','api','manual')),
    notes TEXT,
    created_by TEXT, -- admin identifier (email or id)
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_verified_hr_contacts_normalized_phone ON public.verified_hr_contacts(normalized_phone_number);
CREATE INDEX IF NOT EXISTS idx_verified_hr_contacts_company ON public.verified_hr_contacts(company_name);
CREATE INDEX IF NOT EXISTS idx_verified_hr_contacts_verified ON public.verified_hr_contacts(verified);
CREATE INDEX IF NOT EXISTS idx_verified_hr_contacts_created_at ON public.verified_hr_contacts(created_at DESC);

-- Updated at trigger
CREATE OR REPLACE FUNCTION public.handle_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_verified_hr_contacts_updated_at ON public.verified_hr_contacts;
CREATE TRIGGER set_verified_hr_contacts_updated_at
  BEFORE UPDATE ON public.verified_hr_contacts
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();

-- RLS
ALTER TABLE public.verified_hr_contacts ENABLE ROW LEVEL SECURITY;

-- Allow anon + authenticated to READ verified contacts (for Flutter app)
DROP POLICY IF EXISTS "Allow read verified contacts for all" ON public.verified_hr_contacts;
CREATE POLICY "Allow read verified contacts for all"
  ON public.verified_hr_contacts FOR SELECT
  USING (true);

-- Allow service_role to do everything (backend will use service_role)
DROP POLICY IF EXISTS "Allow service_role all" ON public.verified_hr_contacts;
CREATE POLICY "Allow service_role all"
  ON public.verified_hr_contacts FOR ALL
  USING (true) WITH CHECK (true);

-- Alternatively, allow anon insert/update/delete if you don't use service_role (for dev)
-- Comment out in production:
DROP POLICY IF EXISTS "Allow anon write for dev" ON public.verified_hr_contacts;
CREATE POLICY "Allow anon write for dev"
  ON public.verified_hr_contacts FOR ALL
  USING (true) WITH CHECK (true);

-- ============================================================
-- 2. ADMIN USERS (optional, if using Supabase Auth for admin)
-- ============================================================
CREATE TABLE IF NOT EXISTS public.admin_users (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    email TEXT UNIQUE NOT NULL,
    full_name TEXT NOT NULL,
    role TEXT NOT NULL DEFAULT 'admin' CHECK (role IN ('super_admin','admin','viewer')),
    is_active BOOLEAN DEFAULT true,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.admin_users ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow read admin_users" ON public.admin_users;
CREATE POLICY "Allow read admin_users" ON public.admin_users FOR SELECT USING (true);
DROP POLICY IF EXISTS "Allow write admin_users" ON public.admin_users;
CREATE POLICY "Allow write admin_users" ON public.admin_users FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 3. UPLOAD AUDIT LOG
-- ============================================================
CREATE TABLE IF NOT EXISTS public.verified_contact_uploads (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    filename TEXT,
    total_rows INTEGER NOT NULL DEFAULT 0,
    success_count INTEGER NOT NULL DEFAULT 0,
    failed_count INTEGER NOT NULL DEFAULT 0,
    duplicate_count INTEGER NOT NULL DEFAULT 0,
    uploaded_by TEXT,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.verified_contact_uploads ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Allow all uploads log" ON public.verified_contact_uploads;
CREATE POLICY "Allow all uploads log" ON public.verified_contact_uploads FOR ALL USING (true) WITH CHECK (true);

-- ============================================================
-- 4. Example: view to expose verified contacts with stats
-- ============================================================
CREATE OR REPLACE VIEW public.verified_contacts_stats AS
SELECT
  COUNT(*)::int AS total_verified,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')::int AS added_last_7_days,
  COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '30 days')::int AS added_last_30_days,
  COUNT(DISTINCT company_name)::int AS unique_companies,
  COUNT(DISTINCT location)::int AS unique_locations
FROM public.verified_hr_contacts
WHERE verified = true;

-- ============================================================
-- 5. RPC: Check if phone is verified (for Flutter app)
-- ============================================================
CREATE OR REPLACE FUNCTION public.is_phone_verified(phone_input TEXT)
RETURNS TABLE (
  is_verified BOOLEAN,
  hr_name TEXT,
  company_name TEXT,
  designation TEXT
) LANGUAGE plpgsql AS $$
DECLARE
  norm TEXT;
BEGIN
  -- Normalize: keep last 10 digits
  norm := regexp_replace(phone_input, '[^0-9]', '', 'g');
  IF length(norm) > 10 THEN
    norm := right(norm, 10);
  END IF;
  RETURN QUERY
  SELECT
    v.verified,
    v.hr_name,
    v.company_name,
    v.hr_designation
  FROM public.verified_hr_contacts v
  WHERE v.normalized_phone_number = norm
  LIMIT 1;
END;
$$;

-- No seed data - HR contacts also come from Sheet/Admin if needed
-- To clean old seed: DELETE FROM public.verified_hr_contacts WHERE phone_number IN ('+91 9811122233','+91 9876543211','+91 9123456789');
