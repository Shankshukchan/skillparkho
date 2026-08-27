-- Increase Supabase Storage max file size to 700 MB for the video upload bucket only.
-- 700 MB = 700 * 1024 * 1024 = 734003200 bytes.
-- NOTE: This column only takes effect up to your Supabase plan's max object size.
--       If uploads still fail after this, raise the limit in Project Settings -> Storage (or upgrade the plan).

UPDATE storage.buckets
SET file_size_limit = 734003200
WHERE name = 'student-interview-videos';

-- Verify the change
SELECT name, file_size_limit, (file_size_limit / 1024 / 1024) AS file_size_limit_mb
FROM storage.buckets
WHERE name = 'student-interview-videos';
