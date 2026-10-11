-- Audit 15c (DECISIONS.md question 6, option a): two plan fixes on write and
-- batch paths. Hand-written and idempotent (CREATE OR REPLACE).
--
-- A-15-029: activity_object_idx on activity (object_type, object_id).
--   syncReviewActivity runs `UPDATE/DELETE activity WHERE object_type =
--   'review' AND object_id = $1` on every review save, inside the transaction
--   that holds the read's row lock, and updateActivityVisibility filters the
--   same way. With no index on those columns each one was a seq scan of
--   activity, whose size is set by 180-day retention, not by the user. The
--   index is built CONCURRENTLY by migrate.ts (ONLINE_SQL) after the journal:
--   CREATE INDEX CONCURRENTLY cannot run inside this migration's transaction,
--   and the plain form would block every activity write for the whole build.
--
-- A-15-027: repair_author_has_works(lo, hi), the set arm. It was
--   `NOT a.has_works AND EXISTS (work_authors ⋈ works WHERE wa.author_id =
--   a.id …)`. The author range did not reach work_authors or works, so a
--   plan could hash all of both for every 20,000-author range (on `flyleaf`,
--   a Parallel Hash Semi Join over 3.79M + 3.2M rows), ~770 times a night.
--   The planner picks that when it overestimates a range's authors. Its
--   uuid range estimates are coarse in both directions (it does not
--   interpolate a uuid inside a histogram bucket): in the sandbox a
--   20,000-author range was estimated at ~77,000 rows and, a few ranges on,
--   at 1. A rewrite that joins the range's credits to the range's authors is
--   no safer: at the 77k estimate it hashed all of works, and at the 1-row
--   estimate it rescanned all of the range's credits for every author (one
--   range ran for minutes). So the set arm now has one plan, whatever the
--   estimates:
--   * an InitPlan collects the authors with a live credit in [lo, hi):
--     work_authors through work_authors_author_idx on the range, and works
--     once per credit by primary key (a scalar subquery is never turned
--     into a join, so works cannot be hashed);
--   * authors are then updated by primary key, `id = ANY (that array)`.
--   Each range reads its own credits, their works and their authors only.
--
-- A-15-032: the clear arm's `x.has_works` is now `x.has_works IS TRUE` (the
--   same rows: the column is NOT NULL). Plain `has_works` is the predicate of
--   the partial index authors_credited_trgm_idx, so with the same
--   overestimate the planner ANDed the range with a scan of that whole GIN
--   index (every credited author, ~9,000 buffers in the sandbox's first
--   range). `IS TRUE` does not prove the index's predicate, so the arm stays
--   on authors_pkey's range. Otherwise the clear arm is unchanged: an index
--   nested-loop anti-join over the range.

CREATE OR REPLACE FUNCTION repair_author_has_works(lo uuid, hi uuid)
RETURNS jsonb AS $$
DECLARE
  set_n integer;
  cleared_n integer;
BEGIN
  UPDATE authors a SET has_works = true
  WHERE a.id = ANY (ARRAY(
      SELECT wa.author_id FROM work_authors wa
      WHERE wa.author_id >= lo AND (hi IS NULL OR wa.author_id < hi)
        AND (SELECT w.merged_into_id IS NULL FROM works w WHERE w.id = wa.work_id)))
    AND NOT a.has_works;
  GET DIAGNOSTICS set_n = ROW_COUNT;

  UPDATE authors a SET has_works = false
  WHERE a.id IN (
    SELECT x.id FROM authors x
    WHERE x.id >= lo AND (hi IS NULL OR x.id < hi)
      AND x.has_works IS TRUE
      AND NOT EXISTS (
        SELECT 1 FROM work_authors wa JOIN works w ON w.id = wa.work_id
        WHERE wa.author_id = x.id AND w.merged_into_id IS NULL)
    FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS cleared_n = ROW_COUNT;

  RETURN jsonb_build_object('set', set_n, 'cleared', cleared_n);
END;
$$ LANGUAGE plpgsql;
