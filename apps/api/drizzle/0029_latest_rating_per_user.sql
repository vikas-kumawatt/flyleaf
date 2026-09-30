-- Audit 09b (A-09-027, owner decision 2026-09-30): the rating aggregates count
-- each reader ONCE, with the rating of their most recent RATED attempt
-- (highest attempt_no with rating IS NOT NULL). Before, rating_count,
-- rating_sum, avg_rating, weighted_rating, polarisation, the catalog mean C
-- and the book histogram counted every attempt, so a reader who rated three
-- re-reads counted three times; heart_count, read_count and dnf_count already
-- counted distinct readers. An unrated newer attempt does not remove the
-- reader, and clearing the newest rating falls back to the previous one.
--
-- One definition, latest_ratings, read by all four: the per-work recompute
-- (the triggers), the nightly reconcile, C, and the histogram in
-- CatalogService.getWork. A predicate on work_id is pushed into the view
-- (it is a DISTINCT ON key), so the per-work form reads reads_work_idx.
--
-- Replaces functions only; no data is rewritten here. Existing work_stats
-- rows are recomputed by the nightly works.reconcile, or at once by hand
-- (docs/audit/findings/09-reviews.md, Part 09b).
--
-- Hand-written and idempotent, like 0018.

CREATE OR REPLACE VIEW latest_ratings AS
  SELECT DISTINCT ON (work_id, user_id) work_id, user_id, rating
  FROM reads
  WHERE rating IS NOT NULL
  ORDER BY work_id, user_id, attempt_no DESC;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION refresh_catalog_rating_mean()
RETURNS void AS $$
  INSERT INTO catalog_rating_stats (id, rating_sum, rating_count, refreshed_at)
  SELECT true, COALESCE(SUM(rating), 0), COUNT(rating), now() FROM latest_ratings
  ON CONFLICT (id) DO UPDATE SET
    rating_sum = EXCLUDED.rating_sum,
    rating_count = EXCLUDED.rating_count,
    refreshed_at = EXCLUDED.refreshed_at;
$$ LANGUAGE sql;
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
    COUNT(DISTINCT user_id) FILTER (WHERE hearted = true),
    COUNT(DISTINCT user_id) FILTER (WHERE status = 'finished'),
    COUNT(DISTINCT user_id) FILTER (WHERE status = 'dnf'),
    COUNT(DISTINCT user_id)
  INTO h_count, rd_count, d_count, readers
  FROM reads
  WHERE work_id = target_work_id;

  SELECT COUNT(rating), COALESCE(SUM(rating), 0), stddev_samp(rating)
  INTO v_count, r_sum, p_stddev
  FROM latest_ratings
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
-- As 0026, with the ratings taken from latest_ratings.
CREATE OR REPLACE FUNCTION reconcile_work_counters()
RETURNS jsonb AS $$
DECLARE
  c numeric;
  fixed_stats integer;
  fixed_readers integer;
BEGIN
  PERFORM refresh_catalog_rating_mean();
  c := flyleaf_catalog_mean();

  WITH ratings AS (
    SELECT work_id,
      COUNT(rating) AS v,
      COALESCE(SUM(rating), 0)::numeric(12, 1) AS s,
      stddev_samp(rating)::real AS p
    FROM latest_ratings GROUP BY work_id
  ),
  people AS (
    SELECT work_id,
      COUNT(DISTINCT user_id) FILTER (WHERE hearted = true) AS h,
      COUNT(DISTINCT user_id) FILTER (WHERE status = 'finished') AS rd,
      COUNT(DISTINCT user_id) FILTER (WHERE status = 'dnf') AS d,
      COUNT(DISTINCT user_id)::int AS readers
    FROM reads GROUP BY work_id
  ),
  truth AS (
    -- Every rated work has reads, so ratings adds nothing people lacks.
    SELECT pe.work_id, COALESCE(ra.v, 0) AS v, COALESCE(ra.s, 0) AS s,
           pe.h, pe.rd, pe.d, ra.p, pe.readers
    FROM people pe LEFT JOIN ratings ra USING (work_id)
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
