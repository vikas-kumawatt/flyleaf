-- Audit 10, D-08-3: one rule for a read's page count, everywhere it is
-- derived (the reads list and progress %, stats pages, the book page, and
-- Year in Review when it exists).
--
--   1. the edition the reader chose, if it has a page count;
--   2. else the work's default edition's page count;
--   3. else the median of the work's editions' page counts.
--
-- A count under 20 is not a page count at any step (OL data has 0s, 1s and
-- sheet counts: 13,114 editions on flyleaf_dev). The old fallback was the
-- SMALLEST edition, which picked abridged and mass-market editions and
-- understated pages read.
--
-- LANGUAGE sql, STABLE and one SELECT, so the planner can inline it; COALESCE
-- evaluates the work-level subqueries only when the chosen edition has no
-- usable count. Hand-written and idempotent (CREATE OR REPLACE).

CREATE OR REPLACE FUNCTION flyleaf_page_count(p_edition_id uuid, p_work_id uuid)
RETURNS integer
LANGUAGE sql
STABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    (SELECT e.page_count FROM editions e
      WHERE e.id = p_edition_id AND e.page_count >= 20),
    (SELECT e.page_count FROM works w JOIN editions e ON e.id = w.default_edition_id
      WHERE w.id = p_work_id AND e.page_count >= 20),
    (SELECT round(percentile_cont(0.5) WITHIN GROUP (ORDER BY e.page_count))::integer
       FROM editions e
      WHERE e.work_id = p_work_id AND e.page_count >= 20)
  )
$$;
