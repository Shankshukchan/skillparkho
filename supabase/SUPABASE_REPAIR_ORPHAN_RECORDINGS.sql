-- ============================================================================
-- ONE-TIME REPAIR: re-attach orphaned recording metadata rows
--
-- Symptom this fixes: uploaded audio loses its Play/Download buttons after
-- logout/login because its recording row points at a call_log_id that no
-- longer exists (the log was deduped/deleted under a canonical id).
--
-- Strategy: match each orphan to the same student's >20s saved-HR call that
-- (a) happened before the upload (+1h slack), (b) is within 48h before the
-- upload, and (c) has no recording attached yet. Nearest start_time wins.
--
-- Run in: Supabase SQL Editor. Safe to run multiple times (idempotent).
-- ============================================================================

-- 1) PREVIEW what will be re-attached (no changes yet)
WITH orphans AS (
  SELECT r.*
  FROM student_call_recordings r
  WHERE NOT EXISTS (SELECT 1 FROM student_call_logs c WHERE c.id::text = r.call_log_id)
),
candidates AS (
  SELECT o.id AS rec_id,
         o.call_log_id AS dead_id,
         c.id  AS new_log_id,
         c.start_time AS cand_start,
         ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY ABS(EXTRACT(EPOCH FROM (o.uploaded_at - c.start_time))) ASC) AS rn
  FROM orphans o
  JOIN student_call_logs c
    ON c.student_id = o.student_id
   AND c.duration_seconds > 20
   AND c.start_time < o.uploaded_at + INTERVAL '1 hour'
   AND o.uploaded_at - c.start_time < INTERVAL '48 hours'
   AND NOT EXISTS (SELECT 1 FROM student_call_recordings x WHERE x.call_log_id = c.id::text)
)
SELECT rec_id, dead_id, new_log_id, cand_start FROM candidates WHERE rn = 1;

-- 2) APPLY the repair
WITH orphans AS (
  SELECT r.*
  FROM student_call_recordings r
  WHERE NOT EXISTS (SELECT 1 FROM student_call_logs c WHERE c.id::text = r.call_log_id)
),
candidates AS (
  SELECT o.id AS rec_id,
         c.id  AS new_log_id,
         ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY ABS(EXTRACT(EPOCH FROM (o.uploaded_at - c.start_time))) ASC) AS rn
  FROM orphans o
  JOIN student_call_logs c
    ON c.student_id = o.student_id
   AND c.duration_seconds > 20
   AND c.start_time < o.uploaded_at + INTERVAL '1 hour'
   AND o.uploaded_at - c.start_time < INTERVAL '48 hours'
   AND NOT EXISTS (SELECT 1 FROM student_call_recordings x WHERE x.call_log_id = c.id::text)
)
UPDATE student_call_recordings r
SET call_log_id = candidates.new_log_id
FROM candidates
WHERE r.id = candidates.rec_id
  AND candidates.rn = 1;

-- 3) Also flip the uploaded flag on logs that gained a repaired recording
UPDATE student_call_logs c
SET recording_uploaded = true,
    updated_at = now()
FROM student_call_recordings r
WHERE r.call_log_id = c.id::text
  AND c.recording_uploaded = false;

-- 4) REVIEW anything still orphaned (needs manual mapping - no time match found)
SELECT r.id, r.call_log_id AS dead_id, r.storage_path, r.uploaded_at
FROM student_call_recordings r
WHERE NOT EXISTS (SELECT 1 FROM student_call_logs c WHERE c.id::text = r.call_log_id);

-- 5) ISOLATION AUDIT - recordings must only reference logs of the SAME student
SELECT r.id, r.student_id AS rec_student, c.student_id AS log_student
FROM student_call_recordings r
JOIN student_call_logs c ON c.id::text = r.call_log_id
WHERE r.student_id <> c.student_id;
