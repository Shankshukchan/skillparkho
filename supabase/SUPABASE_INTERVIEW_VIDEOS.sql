-- ============================================================================
-- SkillParkho - Interview Videos (per-student private library)
-- Run ONCE in Supabase SQL Editor (idempotent - safe to re-run).
--
-- Bucket layout: student-interview-videos/<supabase-auth-uid>/<filename>
-- Isolation: RLS pins every row/object to the folder matching auth.uid(),
-- exactly like student-call-recordings. Only the logged-in student whose
-- Supabase Auth uid owns the leading path segment can ever read/write it.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 1. Private bucket
-- ---------------------------------------------------------------------------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'student-interview-videos',
  'student-interview-videos',
  false,
  157286400, -- 150 MB
  array['video/mp4','video/webm','video/3gpp','video/quicktime','video/x-matroska','application/octet-stream']
)
on conflict (id) do update
  set public = false,
      file_size_limit = 157286400; -- 150 MB

-- ---------------------------------------------------------------------------
-- 2. Metadata table
-- ---------------------------------------------------------------------------
create table if not exists student_interview_videos (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  stage_name text not null,
  storage_path text not null unique,
  original_filename text not null,
  mime_type text,
  file_size_bytes bigint,
  uploaded_at timestamptz not null default now(),
  created_at timestamptz not null default now()
);
create index if not exists idx_siv_student on student_interview_videos (student_id);

alter table student_interview_videos enable row level security;

drop policy if exists "siv_insert_own" on student_interview_videos;
create policy "siv_insert_own" on student_interview_videos
  for insert to authenticated
  with check ((storage.foldername(storage_path))[1] = auth.uid()::text);

drop policy if exists "siv_select_own" on student_interview_videos;
create policy "siv_select_own" on student_interview_videos
  for select to authenticated
  using ((storage.foldername(storage_path))[1] = auth.uid()::text);

drop policy if exists "siv_delete_own" on student_interview_videos;
create policy "siv_delete_own" on student_interview_videos
  for delete to authenticated
  using ((storage.foldername(storage_path))[1] = auth.uid()::text);

-- No UPDATE policy: metadata rows are immutable after insert.

-- ---------------------------------------------------------------------------
-- 3. Storage object policies for the bucket
-- ---------------------------------------------------------------------------
drop policy if exists "siv_obj_insert_own" on storage.objects;
create policy "siv_obj_insert_own" on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'student-interview-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "siv_obj_select_own" on storage.objects;
create policy "siv_obj_select_own" on storage.objects
  for select to authenticated
  using (
    bucket_id = 'student-interview-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

drop policy if exists "siv_obj_delete_own" on storage.objects;
create policy "siv_obj_delete_own" on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'student-interview-videos'
    and (storage.foldername(name))[1] = auth.uid()::text
  );

-- No UPDATE policy on objects either.

-- ---------------------------------------------------------------------------
-- 4. Verify
-- ---------------------------------------------------------------------------
select id, name, public, file_size_limit from storage.buckets where id = 'student-interview-videos';
select policyname, cmd from pg_policies where tablename = 'student_interview_videos';
