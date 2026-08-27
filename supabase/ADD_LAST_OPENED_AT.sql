-- SkillParkho — Track when a student last opened the app
-- Run this in Supabase SQL Editor AFTER UNIFIED_SCHEMA.sql:
-- https://supabase.com/dashboard/project/lkmqpllmxrjgnwmqjrgl/sql/new

-- 1. Add last_opened_at to the student whitelist table.
--    NULL until the first app open after this migration ships.
ALTER TABLE public.allowed_app_users
  ADD COLUMN IF NOT EXISTS last_opened_at TIMESTAMPTZ;

-- 2. Index for quick "who hasn't opened recently" reporting.
CREATE INDEX IF NOT EXISTS idx_allowed_last_opened
  ON public.allowed_app_users(last_opened_at DESC);

-- 3. Keep it fresh on every update (covers manual admin edits too).
DROP TRIGGER IF EXISTS trg_allowed_users_last_opened ON public.allowed_app_users;
CREATE TRIGGER trg_allowed_users_last_opened
  BEFORE UPDATE ON public.allowed_app_users
  FOR EACH ROW EXECUTE FUNCTION public.handle_updated_at();
