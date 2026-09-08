EXPLAIN (ANALYZE, BUFFERS, TIMING)

  WITH fts AS (
    SELECT id FROM works
    WHERE 'murakami:*'::text IS NOT NULL
      AND search_vector @@ to_tsquery('simple', 'murakami:*'::text)
    ORDER BY log_count DESC
    LIMIT 300
  ),
  title_like AS (
    SELECT id FROM works
    WHERE title ILIKE '%murakami%'::text
    ORDER BY log_count DESC
    LIMIT 300
  ),
  title_fuzzy AS (
    SELECT id FROM works
    WHERE title % 'murakami'::text
    ORDER BY log_count DESC
    LIMIT 150
  ),
  by_author AS (
    -- ORDER BY log_count, like every other arm. Without it this took an
    -- ARBITRARY 300 works by authors matching the pattern -- and there are
    -- many Murakamis with many books, so Haruki's novels simply were not in
    -- the 300 that came back. An unordered LIMIT is a silent quality bug:
    -- the query looks right and quietly discards the best results.
    SELECT w.id
    FROM authors a
    JOIN work_authors wa ON wa.author_id = a.id
    JOIN works w ON w.id = wa.work_id
    WHERE a.name ILIKE '%murakami%'::text
    ORDER BY w.log_count DESC
    LIMIT 300
  ),
  candidate AS (
    SELECT id FROM fts
    UNION SELECT id FROM title_like
    UNION SELECT id FROM title_fuzzy
    UNION SELECT id FROM by_author
  )
  SELECT
    w.id, w.title, w.first_publish_year, w.log_count,
    (SELECT a.name
       FROM work_authors wa JOIN authors a ON a.id = wa.author_id
      WHERE wa.work_id = w.id
      ORDER BY wa.position, a.name
      LIMIT 1) AS author_name,
    -- The work's own cover, set at ingest; an edition's only as a fallback.
    COALESCE(w.ol_cover_id, (
      SELECT e.ol_cover_id
        FROM editions e
       WHERE e.work_id = w.id AND e.ol_cover_id IS NOT NULL
       ORDER BY e.publish_year DESC NULLS LAST
       LIMIT 1)) AS cover_id
  FROM candidate c
  JOIN works w ON w.id = c.id
  WHERE w.merged_into_id IS NULL      -- a merged work is never a result
    AND w.is_provisional = false      -- user-created, not yet promoted
  ORDER BY
      (CASE WHEN w.title ILIKE 'murakami%'::text THEN 0.30 ELSE 0 END)
    + (CASE WHEN lower(w.title) = lower('murakami'::text) THEN 0.20 ELSE 0 END)
    -- Matching the AUTHOR is a first-class signal, not just a way of finding
    -- candidates. Without this term "murakami" surfaces books with Murakami
    -- in the TITLE and scores Norwegian Wood at zero, which is the opposite
    -- of what someone typing an author's name wants.
    + (CASE WHEN EXISTS (
        SELECT 1 FROM work_authors wa JOIN authors a ON a.id = wa.author_id
        WHERE wa.work_id = w.id AND a.name ILIKE '%murakami%'::text
      ) THEN 0.20 ELSE 0 END)
    + similarity(w.title, 'murakami'::text) * 0.10
    -- Popularity, from the reading-log and ratings dumps (--popularity).
    -- ln() so 10,000 logs beats 100 without burying everything else; the cap
    -- stops one runaway title dominating every query it happens to match.
    -- This is the term that puts Susanna Clarke's Piranesi above a 1910
    -- monograph on the architect.
    + LEAST(ln(1 + w.log_count) / 10.0, 1.0) * 0.35 DESC,
    w.log_count DESC,
    w.title
  LIMIT 20
;
