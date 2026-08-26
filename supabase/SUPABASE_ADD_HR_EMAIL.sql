-- ============================================================================
-- Add optional HR email to student_hr_contacts
-- For existing DBs: runs idempotently; safe to re-run
-- New column: hr_email (optional, validated as email when present)
-- ============================================================================

ALTER TABLE public.student_hr_contacts
  ADD COLUMN IF NOT EXISTS hr_email TEXT DEFAULT NULL;

-- Ensure email format check (allow NULL/empty, else must be valid email)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'chk_hr_email_format'
  ) THEN
    ALTER TABLE public.student_hr_contacts
      ADD CONSTRAINT chk_hr_email_format
      CHECK (hr_email IS NULL OR hr_email = '' OR hr_email ~* '^[^@\s]+@[^@\s]+\.[^@\s]+$');
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_shc_hr_email ON public.student_hr_contacts(hr_email) WHERE hr_email IS NOT NULL AND hr_email <> '';

-- Migration for older DBs that used snake_case without hr_email:
-- No data backfill needed (NULL = not provided)

-- Example verification:
-- SELECT column_name, data_type FROM information_schema.columns WHERE table_name='student_hr_contacts' AND column_name='hr_email';
