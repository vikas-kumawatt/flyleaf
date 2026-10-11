-- Audit 15 (§3 A-03-026, §4): the nightly jobs work in key ranges.
--
-- Each reconcile was one statement aggregating a whole table (reads, follows,
-- read_likes, read_comments, the latest_ratings view over all reads). Small
-- today, but its memory and time grew with the table, and one statement is
-- the shape that took the server down in Part 03c (A-03-026). These versions
-- take a key range [lo, hi) (hi NULL: to the end); the job handlers walk the
-- key space in batches, each a short statement under the worker's work_mem
-- and statement_timeout. The ranges partition the whole uuid space, so a row
-- the walk has no key for (a work_stats row whose reads are gone) is still
-- inside some range. The whole-table versions stay for devdb:build and tests.
--
-- New: authors.has_works repair (Part 02b/02c). The ingest skips the
-- has_works trigger (flyleaf.bulk_load) and relies on `--finalise`; an ingest
-- that dies before it leaves new authors out of author search. The repair
-- sets the flag where a live work credits the author and clears it where
-- every credited work was merged away. Clearing races a concurrent insert of
-- a credit only if it could see the author's row being written, so it skips
-- rows locked by an in-flight transaction (FOR UPDATE SKIP LOCKED); the
-- insert's own statement trigger sets the flag after it.
--
-- Hand-written and idempotent (CREATE OR REPLACE; new overloads only).

CREATE OR REPLACE FUNCTION reconcile_read_counters(lo uuid, hi uuid)
RETURNS integer AS $$
DECLARE
  fixed integer;
BEGIN
  WITH truth AS (
    SELECT r.id,
      (SELECT count(*)::int FROM read_likes l WHERE l.read_id = r.id) AS likes,
      (SELECT count(*)::int FROM read_comments c WHERE c.read_id = r.id AND c.deleted_at IS NULL) AS comments
    FROM reads r
    WHERE r.id >= lo AND (hi IS NULL OR r.id < hi)
  )
  UPDATE reads r
  SET like_count = t.likes, comment_count = t.comments
  FROM truth t
  WHERE r.id = t.id
    AND (r.like_count <> t.likes OR r.comment_count <> t.comments);
  GET DIAGNOSTICS fixed = ROW_COUNT;
  RETURN fixed;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reconcile_follow_counters(lo uuid, hi uuid)
RETURNS integer AS $$
DECLARE
  fixed integer;
BEGIN
  WITH truth AS (
    SELECT p.user_id,
      (SELECT count(*)::int FROM follows f WHERE f.followee_id = p.user_id AND f.state = 'accepted') AS followers,
      (SELECT count(*)::int FROM follows f WHERE f.follower_id = p.user_id AND f.state = 'accepted') AS following
    FROM profiles p
    WHERE p.user_id >= lo AND (hi IS NULL OR p.user_id < hi)
  )
  UPDATE profiles p
  SET follower_count = t.followers, following_count = t.following
  FROM truth t
  WHERE p.user_id = t.user_id
    AND (p.follower_count <> t.followers OR p.following_count <> t.following);
  GET DIAGNOSTICS fixed = ROW_COUNT;
  RETURN fixed;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reconcile_shelf_counters(lo uuid, hi uuid)
RETURNS integer AS $$
DECLARE
  fixed integer;
BEGIN
  WITH truth AS (
    SELECT s.id,
      (SELECT count(*)::int FROM shelf_items si WHERE si.shelf_id = s.id) AS n,
      COALESCE((
        SELECT array_agg(t.work_id ORDER BY t.position, t.added_at, t.work_id)
        FROM (
          SELECT work_id, position, added_at FROM shelf_items
          WHERE shelf_id = s.id
          ORDER BY position, added_at, work_id
          LIMIT 4
        ) t
      ), '{}'::uuid[]) AS covers,
      (SELECT count(*)::int FROM shelf_saves ss WHERE ss.shelf_id = s.id) AS saves
    FROM shelves s
    WHERE s.id >= lo AND (hi IS NULL OR s.id < hi)
  ),
  updated AS (
    UPDATE shelves s
    SET item_count = t.n, cover_work_ids = t.covers, save_count = t.saves
    FROM truth t
    WHERE s.id = t.id
      AND (s.item_count, s.cover_work_ids, s.save_count) IS DISTINCT FROM (t.n, t.covers, t.saves)
    RETURNING 1
  )
  SELECT count(*)::int INTO fixed FROM updated;
  RETURN fixed;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- The catalog mean's two sums over one range of works; the job adds the
-- ranges up and writes catalog_rating_stats once.
CREATE OR REPLACE FUNCTION catalog_rating_sums(lo uuid, hi uuid)
RETURNS TABLE (rating_sum numeric, rating_count bigint) AS $$
  SELECT COALESCE(SUM(rating), 0), COUNT(rating)
  FROM latest_ratings
  WHERE work_id >= lo AND (hi IS NULL OR work_id < hi);
$$ LANGUAGE sql STABLE;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reconcile_work_counters(lo uuid, hi uuid, c numeric)
RETURNS jsonb AS $$
DECLARE
  fixed_stats integer;
  fixed_readers integer;
BEGIN
  WITH ratings AS (
    SELECT work_id,
      COUNT(rating) AS v,
      COALESCE(SUM(rating), 0)::numeric(12, 1) AS s,
      stddev_samp(rating)::real AS p
    FROM latest_ratings
    WHERE work_id >= lo AND (hi IS NULL OR work_id < hi)
    GROUP BY work_id
  ),
  people AS (
    SELECT work_id,
      COUNT(DISTINCT user_id) FILTER (WHERE hearted = true) AS h,
      COUNT(DISTINCT user_id) FILTER (WHERE status = 'finished') AS rd,
      COUNT(DISTINCT user_id) FILTER (WHERE status = 'dnf') AS d,
      COUNT(DISTINCT user_id)::int AS readers
    FROM reads
    WHERE work_id >= lo AND (hi IS NULL OR work_id < hi)
    GROUP BY work_id
  ),
  truth AS (
    SELECT pe.work_id, COALESCE(ra.v, 0) AS v, COALESCE(ra.s, 0) AS s,
           pe.h, pe.rd, pe.d, ra.p, pe.readers
    FROM people pe LEFT JOIN ratings ra USING (work_id)
  ),
  expected AS (
    SELECT k.work_id,
      COALESCE(t.v, 0) AS v, COALESCE(t.s, 0) AS s, COALESCE(t.h, 0) AS h,
      COALESCE(t.rd, 0) AS rd, COALESCE(t.d, 0) AS d, t.p, COALESCE(t.readers, 0) AS readers
    FROM (
      SELECT work_id FROM truth
      UNION
      SELECT work_id FROM work_stats WHERE work_id >= lo AND (hi IS NULL OR work_id < hi)
    ) k
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

  RETURN jsonb_build_object('work_stats', fixed_stats, 'reader_count', fixed_readers);
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION repair_author_has_works(lo uuid, hi uuid)
RETURNS jsonb AS $$
DECLARE
  set_n integer;
  cleared_n integer;
BEGIN
  UPDATE authors a SET has_works = true
  WHERE a.id >= lo AND (hi IS NULL OR a.id < hi)
    AND NOT a.has_works
    AND EXISTS (
      SELECT 1 FROM work_authors wa JOIN works w ON w.id = wa.work_id
      WHERE wa.author_id = a.id AND w.merged_into_id IS NULL);
  GET DIAGNOSTICS set_n = ROW_COUNT;

  UPDATE authors a SET has_works = false
  WHERE a.id IN (
    SELECT x.id FROM authors x
    WHERE x.id >= lo AND (hi IS NULL OR x.id < hi)
      AND x.has_works
      AND NOT EXISTS (
        SELECT 1 FROM work_authors wa JOIN works w ON w.id = wa.work_id
        WHERE wa.author_id = x.id AND w.merged_into_id IS NULL)
    FOR UPDATE SKIP LOCKED);
  GET DIAGNOSTICS cleared_n = ROW_COUNT;

  RETURN jsonb_build_object('set', set_n, 'cleared', cleared_n);
END;
$$ LANGUAGE plpgsql;
