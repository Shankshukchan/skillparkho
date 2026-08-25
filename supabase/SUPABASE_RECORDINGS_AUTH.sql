-- ============================================================================
-- SkillParkho — Private Call-Recording Storage with per-student isolation
-- Run in Supabase SQL Editor: https://supabase.com/dashboard/project/sgfxztqeanfytcjtykrr/sql/new
--
-- What this gives you:
--   1. A PRIVATE storage bucket 'student-call-recordings'
--   2. Files laid out as  <supabase-auth-user-id>/<call_log_id>/<filename>
--   3. Hard isolation: a student can only touch objects whose FIRST folder
--      equals their own auth.uid() (enforced by RLS on storage.objects)
--   4. Immutability: NO update/delete policies -> once written, an object can
--      never be overwritten or removed by anyone (owner included)
--   5. Metadata table locked down the same way (row follows its storage_path)
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Private bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'student-call-recordings',
  'student-call-recordings',
  false,
  157286400, -- 150 MB
  array['audio/aac','audio/x-m4a','audio/mp4','audio/mpeg','audio/mp3','audio/wav','audio/x-wav','audio/amr','audio/3gpp','video/3gpp','application/octet-stream']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 157286400; -- 150 MB

-- ---------------------------------------------------------------------------
-- 2. Isolation policies on storage.objects
--    Owner rule: first path segment MUST equal auth.uid()
--    ('student-call-recordings/<uid>/<callLogId>/<file>')
-- ---------------------------------------------------------------------------
drop policy if exists "recording_insert_owner" on storage.objects;
create policy "recording_insert_owner"
  on storage.objects for insert to authenticated
  with check (
    bucket_id = 'student-call-recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "recording_select_owner" on storage.objects;
create policy "recording_select_owner"
  on storage.objects for select to authenticated
  using (
    bucket_id = 'student-call-recordings'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- Intentionally NO policies for UPDATE or DELETE on this bucket:
-- recordings are immutable once uploaded. (Superuser/service_role can still
-- clean up from trusted jobs if ever needed.)

-- ---------------------------------------------------------------------------
-- 3. Lock down the recordings METADATA table
--    A row may only be read/created by the auth user who owns the
--    storage_path recorded in it. service_role (backend/admin) bypasses RLS.
-- ---------------------------------------------------------------------------
alter table public.student_call_recordings enable row level security;

drop policy if exists "recmeta_insert_owner" on public.student_call_recordings;
create policy "recmeta_insert_owner"
  on public.student_call_recordings for insert to authenticated
  with check (
    (storage.foldername(storage_path))[1] = auth.uid()::text
  );

drop policy if exists "recmeta_select_owner" on public.student_call_recordings;
create policy "recmeta_select_owner"
  on public.student_call_recordings for select to authenticated
  using (
    (storage.foldername(storage_path))[1] = auth.uid()::text
  );

-- No UPDATE / DELETE policies: metadata rows are immutable too.
-- call_log_id already carries UNIQUE, so a second recording for one call is
-- rejected at the database level regardless of client behavior.

-- ---------------------------------------------------------------------------
-- 4. Verify
-- ---------------------------------------------------------------------------
select id, name, public, file_size_limit from storage.buckets
where id = 'student-call-recordings';

select schemaname, tablename, policyname, cmd, roles
from pg_policies
where tablename = 'objects' and schemaname = 'storage'
order by policyname;
