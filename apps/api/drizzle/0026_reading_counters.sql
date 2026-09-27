-- Audit 08: the reads → work counters, rewritten together.
--
-- L-01. reads_work_stats_trigger called recompute_work_stats_for_work() per
-- ROW, and that function scanned the whole of `reads` twice: the per-work
-- aggregate (no index led with work_id) and the catalog mean
-- `AVG(rating) FROM reads WHERE work_id <> x`. ~20 ms per call at 62k reads,
-- growing with the table, on every log, finish, rating, heart and delete. A
-- dedupe merge paid it twice per moved read (A-03-016): 20 s for 466 reads.
--
--   * The catalog mean C is cached in catalog_rating_stats (one row),
--     refreshed by the nightly works.reconcile job and by this migration.
--     C no longer excludes the work being scored: with m = 25 that changes a
--     weighted rating by at most m/N x 4.5 (0.002 at N = 50k ratings), under
--     the column's 0.01 resolution. Drift tolerance: C is at most one day old.
--   * The per-work aggregate uses reads_work_idx (work_id, user_id), built
--     CONCURRENTLY by migrate.ts after the journal (it cannot run inside this
--     transaction).
--   * Statement-level triggers with transition tables: one recompute per
--     affected WORK per statement, not per row, so a merge moving N reads
--     recomputes two works once each instead of 2N times.
--   * The trigger locks the affected works rows (id order) BEFORE reading
--     `reads`. In READ COMMITTED each later statement takes a new snapshot,
--     so two writers on one work serialise and the second sees the first's
--     committed read. Without it both could compute a count missing the other.
--
-- A-02-013 (decided): what works.log_count counts.
--
--   * ol_log_count  Open Library's reading-log baseline, set only by the
--                   ingest --popularity pass. RENAMED from log_count, which
--                   held exactly that plus four in-app increments on these
--                   databases (see findings 08): a rename keeps 3.2M values
--                   without rewriting a table with two GIN indexes (~1 ms a
--                   row measured, ~55 min and ~1.6 GB of bloat on flyleaf).
--   * reader_count  distinct users with a read of the work, any status,
--                   imports included. A re-read does not count again. Set by
--                   recompute_work_stats_for_work(), so the triggers keep it
--                   and a merge, undo, delete or account deletion re-derives
--                   it from the reads that remain.
--   * log_count     VIRTUAL generated: ol_log_count + reader_count. One
--                   Flyleaf reader weighs the same as one OL shelving. No
--                   storage, no rewrite; search SQL keeps reading log_count,
--                   and works_log_count_idx becomes an expression index on
--                   (ol_log_count + reader_count), which the planner matches
--                   for ORDER BY log_count (built CONCURRENTLY by migrate.ts).
--
-- Hand-written and idempotent, like 0018.

DO $$
BEGIN
  IF EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'works'
         AND column_name = 'log_count' AND is_generated = 'NEVER')
     AND NOT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'works'
         AND column_name = 'ol_log_count') THEN
    ALTER TABLE works RENAME COLUMN log_count TO ol_log_count;
    -- The old index now covers ol_log_count. It keeps search working until
    -- the expression index exists, and migrate.ts drops it afterwards.
    ALTER INDEX IF EXISTS works_log_count_idx RENAME TO works_ol_log_count_idx;
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE works ADD COLUMN IF NOT EXISTS reader_count integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE works ADD COLUMN IF NOT EXISTS log_count integer
  GENERATED ALWAYS AS (ol_log_count + reader_count) VIRTUAL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS catalog_rating_stats (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  rating_sum numeric(14, 1) DEFAULT 0 NOT NULL,
  rating_count bigint DEFAULT 0 NOT NULL,
  refreshed_at timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION refresh_catalog_rating_mean()
RETURNS void AS $$
  INSERT INTO catalog_rating_stats (id, rating_sum, rating_count, refreshed_at)
  SELECT true, COALESCE(SUM(rating), 0), COUNT(rating), now() FROM reads
  ON CONFLICT (id) DO UPDATE SET
    rating_sum = EXCLUDED.rating_sum,
    rating_count = EXCLUDED.rating_count,
    refreshed_at = EXCLUDED.refreshed_at;
$$ LANGUAGE sql;
--> statement-breakpoint
-- C: 3.9 until anything has been rated (the old default for an empty catalog).
CREATE OR REPLACE FUNCTION flyleaf_catalog_mean()
RETURNS numeric AS $$
  SELECT COALESCE((SELECT rating_sum / NULLIF(rating_count, 0) FROM catalog_rating_stats), 3.9);
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
-- Bayesian weighted rating, (v/(v+m))·R + (m/(v+m))·C with m = 25 (PRD §9.5).
-- One definition, used by the trigger path and by the nightly reconcile.
CREATE OR REPLACE FUNCTION flyleaf_weighted_rating(v bigint, r_sum numeric, c numeric)
RETURNS numeric AS $$
  SELECT CASE WHEN v > 0 THEN
    ROUND(CAST(((v::numeric / (v + 25.0)) * (r_sum / v) + (25.0 / (v + 25.0)) * c) AS numeric), 2)
  END;
$$ LANGUAGE sql IMMUTABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION recompute_work_stats_for_work(target_work_id uuid)
RETURNS void AS $$
DECLARE
  v_count bigint;
  r_sum numeric(12, 1);
  p_stddev real;
  h_count bigint;
  rd_count bigint;
  d_count bigint;
  readers integer;
BEGIN
  IF target_work_id IS NULL THEN
    RETURN;
  END IF;

  -- reads_work_idx: cost grows with this work's reads, not with the table.
  SELECT
    COUNT(rating),
    COALESCE(SUM(rating), 0),
    COUNT(DISTINCT user_id) FILTER (WHERE hearted = true),
    COUNT(DISTINCT user_id) FILTER (WHERE status = 'finished'),
    COUNT(DISTINCT user_id) FILTER (WHERE status = 'dnf'),
    stddev_samp(rating),
    COUNT(DISTINCT user_id)
  INTO v_count, r_sum, h_count, rd_count, d_count, p_stddev, readers
  FROM reads
  WHERE work_id = target_work_id;

  INSERT INTO work_stats (
    work_id, rating_sum, rating_count, avg_rating, weighted_rating,
    heart_count, read_count, dnf_count, polarisation, updated_at
  ) VALUES (
    target_work_id, r_sum, v_count,
    CASE WHEN v_count > 0 THEN ROUND(r_sum / v_count, 2) END,
    flyleaf_weighted_rating(v_count, r_sum, flyleaf_catalog_mean()),
    h_count, rd_count, d_count, p_stddev, NOW()
  )
  ON CONFLICT (work_id) DO UPDATE SET
    rating_sum = EXCLUDED.rating_sum,
    rating_count = EXCLUDED.rating_count,
    avg_rating = EXCLUDED.avg_rating,
    weighted_rating = EXCLUDED.weighted_rating,
    heart_count = EXCLUDED.heart_count,
    read_count = EXCLUDED.read_count,
    dnf_count = EXCLUDED.dnf_count,
    polarisation = EXCLUDED.polarisation,
    updated_at = NOW();

  -- Only when it changed: works carries two GIN indexes, and an unchanged
  -- row must not be rewritten through them.
  UPDATE works SET reader_count = readers
  WHERE id = target_work_id AND reader_count <> readers;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION refresh_work_read_stats(work_ids uuid[])
RETURNS void AS $$
DECLARE
  w uuid;
BEGIN
  -- Lock, THEN read (see the header). NO KEY UPDATE, so inserting a read
  -- (whose foreign key takes KEY SHARE on the work) is not blocked by it.
  PERFORM 1 FROM works WHERE id = ANY (work_ids) ORDER BY id FOR NO KEY UPDATE;
  FOR w IN SELECT DISTINCT u FROM unnest(work_ids) AS u WHERE u IS NOT NULL ORDER BY 1 LOOP
    PERFORM recompute_work_stats_for_work(w);
  END LOOP;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reads_stats_after_insert()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM refresh_work_read_stats(ARRAY(SELECT DISTINCT work_id FROM new_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reads_stats_after_delete()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM refresh_work_read_stats(ARRAY(SELECT DISTINCT work_id FROM old_rows));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Transition tables cannot be combined with an UPDATE OF column list, so the
-- narrowing 0018 did by column list is done here by comparing old and new:
-- a like or comment counter update joins one row and recomputes nothing.
CREATE OR REPLACE FUNCTION reads_stats_after_update()
RETURNS TRIGGER AS $$
BEGIN
  PERFORM refresh_work_read_stats(ARRAY(
    SELECT unnest(ARRAY[o.work_id, n.work_id])
    FROM old_rows o JOIN new_rows n ON n.id = o.id
    WHERE (o.work_id, o.user_id, o.status, o.rating, o.hearted)
          IS DISTINCT FROM (n.work_id, n.user_id, n.status, n.rating, n.hearted)));
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS reads_work_stats_trigger ON reads;
--> statement-breakpoint
DROP FUNCTION IF EXISTS update_work_stats_from_reads();
--> statement-breakpoint
DROP TRIGGER IF EXISTS reads_stats_insert_trigger ON reads;
--> statement-breakpoint
CREATE TRIGGER reads_stats_insert_trigger
AFTER INSERT ON reads REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION reads_stats_after_insert();
--> statement-breakpoint
DROP TRIGGER IF EXISTS reads_stats_delete_trigger ON reads;
--> statement-breakpoint
CREATE TRIGGER reads_stats_delete_trigger
AFTER DELETE ON reads REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION reads_stats_after_delete();
--> statement-breakpoint
DROP TRIGGER IF EXISTS reads_stats_update_trigger ON reads;
--> statement-breakpoint
CREATE TRIGGER reads_stats_update_trigger
AFTER UPDATE ON reads REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION reads_stats_after_update();
--> statement-breakpoint
-- Nightly repair (works.reconcile, architecture §3.9): refresh C, then make
-- every work_stats row and every reader_count match `reads`, writing only
-- rows that differ. Weighted ratings of works nobody touched pick up the new
-- C here. Candidates are works with reads or with a work_stats row: every
-- work whose reader_count was ever non-zero has one (the trigger writes it).
-- One aggregate over reads, like reconcile_read_counters().
CREATE OR REPLACE FUNCTION reconcile_work_counters()
RETURNS jsonb AS $$
DECLARE
  c numeric;
  fixed_stats integer;
  fixed_readers integer;
BEGIN
  PERFORM refresh_catalog_rating_mean();
  c := flyleaf_catalog_mean();

  WITH truth AS (
    SELECT work_id,
      COUNT(rating) AS v,
      COALESCE(SUM(rating), 0)::numeric(12, 1) AS s,
      COUNT(DISTINCT user_id) FILTER (WHERE hearted = true) AS h,
      COUNT(DISTINCT user_id) FILTER (WHERE status = 'finished') AS rd,
      COUNT(DISTINCT user_id) FILTER (WHERE status = 'dnf') AS d,
      stddev_samp(rating)::real AS p,
      COUNT(DISTINCT user_id)::int AS readers
    FROM reads GROUP BY work_id
  ),
  expected AS (
    SELECT k.work_id,
      COALESCE(t.v, 0) AS v, COALESCE(t.s, 0) AS s, COALESCE(t.h, 0) AS h,
      COALESCE(t.rd, 0) AS rd, COALESCE(t.d, 0) AS d, t.p, COALESCE(t.readers, 0) AS readers
    FROM (SELECT work_id FROM truth UNION SELECT work_id FROM work_stats) k
    LEFT JOIN truth t USING (work_id)
  ),
  stats AS (
    INSERT INTO work_stats AS ws (
      work_id, rating_sum, rating_count, avg_rating, weighted_rating,
      heart_count, read_count, dnf_count, polarisation, updated_at)
    SELECT work_id, s, v, CASE WHEN v > 0 THEN ROUND(s / v, 2) END,
           flyleaf_weighted_rating(v, s, c), h, rd, d, p, now()
    FROM expected
    ON CONFLICT (work_id) DO UPDATE SET
      rating_sum = EXCLUDED.rating_sum, rating_count = EXCLUDED.rating_count,
      avg_rating = EXCLUDED.avg_rating, weighted_rating = EXCLUDED.weighted_rating,
      heart_count = EXCLUDED.heart_count, read_count = EXCLUDED.read_count,
      dnf_count = EXCLUDED.dnf_count, polarisation = EXCLUDED.polarisation,
      updated_at = now()
    WHERE (ws.rating_sum, ws.rating_count, ws.avg_rating, ws.weighted_rating,
           ws.heart_count, ws.read_count, ws.dnf_count, ws.polarisation)
          IS DISTINCT FROM
          (EXCLUDED.rating_sum, EXCLUDED.rating_count, EXCLUDED.avg_rating, EXCLUDED.weighted_rating,
           EXCLUDED.heart_count, EXCLUDED.read_count, EXCLUDED.dnf_count, EXCLUDED.polarisation)
    RETURNING 1
  ),
  readers AS (
    UPDATE works w SET reader_count = e.readers
    FROM expected e
    WHERE w.id = e.work_id AND w.reader_count <> e.readers
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM stats), (SELECT count(*) FROM readers)
  INTO fixed_stats, fixed_readers;

  RETURN jsonb_build_object('work_stats', fixed_stats, 'reader_count', fixed_readers, 'catalog_mean', c);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
SELECT refresh_catalog_rating_mean();
