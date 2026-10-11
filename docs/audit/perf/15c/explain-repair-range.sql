-- Audit 15c (A-15-027, A-15-032): the has_works repair's two arms for one
-- 20,000-author range, before (0040) and after (0042), as standalone statements so both can
-- be EXPLAINed on any database, whichever function it has.
--
--   psql "$URL" -v opts='(COSTS)' -v offset=0 -f explain-repair-range.sql            plan only (the laptop)
--   psql "$URL" -v opts='(ANALYZE, BUFFERS)' -v offset=0 -f explain-repair-range.sql  runs them, rolled back
--
-- offset = the range's first author, as walkRanges finds it (0 = the first range).
-- The worker's settings (JOB_DB_SETTINGS.worker): work_mem 32 MB, 1 parallel worker.
\set ON_ERROR_STOP on
SET work_mem = '32MB';
SET max_parallel_workers_per_gather = 1;
SELECT CASE WHEN :offset = 0 THEN '00000000-0000-0000-0000-000000000000'::uuid
            ELSE (SELECT id FROM authors ORDER BY id OFFSET :offset LIMIT 1) END AS lo,
       (SELECT id FROM authors ORDER BY id OFFSET :offset + 20000 LIMIT 1) AS hi \gset
\echo range [:lo, :hi)
BEGIN;
\echo '--- before (0040): the set arm'
EXPLAIN :opts
UPDATE authors a SET has_works = true
WHERE a.id >= :'lo' AND a.id < :'hi'
  AND NOT a.has_works
  AND EXISTS (
    SELECT 1 FROM work_authors wa JOIN works w ON w.id = wa.work_id
    WHERE wa.author_id = a.id AND w.merged_into_id IS NULL);
ROLLBACK;
BEGIN;
\echo '--- after (0042): the set arm, driven by the range''s credits'
EXPLAIN :opts
UPDATE authors a SET has_works = true
WHERE a.id = ANY (ARRAY(
    SELECT wa.author_id FROM work_authors wa
    WHERE wa.author_id >= :'lo' AND wa.author_id < :'hi'
      AND (SELECT w.merged_into_id IS NULL FROM works w WHERE w.id = wa.work_id)))
  AND NOT a.has_works;
ROLLBACK;
BEGIN;
\echo '--- before (0040): the clear arm'
EXPLAIN :opts
UPDATE authors a SET has_works = false
WHERE a.id IN (
  SELECT x.id FROM authors x
  WHERE x.id >= :'lo' AND x.id < :'hi'
    AND x.has_works
    AND NOT EXISTS (
      SELECT 1 FROM work_authors wa JOIN works w ON w.id = wa.work_id
      WHERE wa.author_id = x.id AND w.merged_into_id IS NULL)
  FOR UPDATE SKIP LOCKED);
ROLLBACK;
BEGIN;
\echo '--- after (0042): the clear arm, has_works IS TRUE'
EXPLAIN :opts
UPDATE authors a SET has_works = false
WHERE a.id IN (
  SELECT x.id FROM authors x
  WHERE x.id >= :'lo' AND x.id < :'hi'
    AND x.has_works IS TRUE
    AND NOT EXISTS (
      SELECT 1 FROM work_authors wa JOIN works w ON w.id = wa.work_id
      WHERE wa.author_id = x.id AND w.merged_into_id IS NULL)
  FOR UPDATE SKIP LOCKED);
ROLLBACK;
