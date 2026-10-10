-- Audit 10 (A-02-024 routed here): the "Did you mean …?" vocabulary for a
-- search that finds nothing (PRD §14.7 step 1, AC-7).
--
-- A zero-result query has already failed both typo arms of SEARCH_SQL, so a
-- suggestion needs a looser trigram pass. Run over 3.2M titles and 15.4M
-- authors that is the cost audit 02b removed (A-02-023). Run over this table
-- it is one small GIN probe: the titles and credited authors of works with at
-- least 20 logs (about 112k terms; 74k works on both databases), never
-- explicit ones, since a suggestion is a push surface (§7.8).
--
-- weight: the term's popularity (a title's log_count; an author's summed over
-- their works). The query ranks by word similarity times ln(2 + weight), so a
-- famous near miss beats an obscure closer one ("tolkein": J.R.R. Tolkien,
-- not "What Einstein Told His Cook").
--
-- refresh_search_suggestions() rebuilds it in one transaction; the worker
-- runs it weekly. Hand-written and idempotent.

CREATE TABLE IF NOT EXISTS search_suggestions (
  term text PRIMARY KEY,
  weight integer NOT NULL
);

CREATE INDEX IF NOT EXISTS search_suggestions_term_trgm_idx
  ON search_suggestions USING gin (lower(term) gin_trgm_ops);

CREATE OR REPLACE FUNCTION refresh_search_suggestions()
RETURNS integer
LANGUAGE plpgsql
AS $$
DECLARE
  n integer;
BEGIN
  DELETE FROM search_suggestions;
  INSERT INTO search_suggestions (term, weight)
  SELECT term, max(weight)
    FROM (
      SELECT a.name AS term, sum(w.log_count)::integer AS weight
        FROM works w
        JOIN work_authors wa ON wa.work_id = w.id
        JOIN authors a ON a.id = wa.author_id
       WHERE w.log_count >= 20 AND w.merged_into_id IS NULL AND w.maturity <> 'explicit'
       GROUP BY a.name
      UNION ALL
      SELECT w.title, max(w.log_count)::integer
        FROM works w
       WHERE w.log_count >= 20 AND w.merged_into_id IS NULL AND w.maturity <> 'explicit'
       GROUP BY w.title
    ) t
   WHERE length(term) BETWEEN 3 AND 120
   GROUP BY term;
  GET DIAGNOSTICS n = ROW_COUNT;
  RETURN n;
END;
$$;

SELECT refresh_search_suggestions();
