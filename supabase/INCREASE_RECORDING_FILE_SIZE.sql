-- Increase Supabase Storage max file size to 150 MB for the audio/call-recording upload bucket.
-- 150 MB = 150 * 1024 * 1024 = 157286400 bytes.
-- NOTE: This column only takes effect up to your Supabase plan's max object size.
--       If uploads still fail after this, raise the limit in Project Settings -> Storage (or upgrade the plan).

UPDATE storage.buckets
SET file_size_limit = 157286400
WHERE name = 'student-call-recordings';

-- Verify the change
SELECT name, file_size_limit, (file_size_limit / 1024 / 1024) AS file_size_limit_mb
FROM storage.buckets
WHERE name = 'student-call-recordings';
