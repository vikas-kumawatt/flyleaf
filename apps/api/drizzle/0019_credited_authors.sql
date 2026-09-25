-- Audit 02b (A-02-012): search only the authors that are credited on a work.
--
-- `authors` holds 15.4M rows, but only 1.66M (10.8%) appear in work_authors:
-- the Open Library dump ships every author record, credited or not. The
-- search author arm matched over all of them and then probed work_authors
-- once per match ("pir": 16,771 authors, 16,507 probes, 9 s), so its cost
-- grew with the authors table rather than with the result.
--
-- A partial index cannot say "has a row in work_authors" (no subqueries in
-- an index predicate), so the fact is stored as a column.
--
-- SET-ONLY, ON PURPOSE. The trigger sets has_works when an author is first
-- credited and nothing ever clears it. A stale TRUE (every work of an author
-- deleted) only costs index space: the arm still joins work_authors, so it
-- cannot return a wrong row. A trigger that CLEARED the flag on the last
-- delete would race a concurrent insert (its NOT EXISTS cannot see the other
-- transaction's link) and could hide a credited author from search, which
-- is the one failure that matters.
--
-- INSERT is the only event: nothing updates work_authors.author_id (dedupe
-- repoints by insert + delete). Statement-level with a transition table so a
-- bulk ingest (3.8M links in one INSERT ... SELECT) runs one UPDATE, not 3.8M.
--
-- Hand-written and idempotent, like 0018. SLOW ON THE FULL CATALOG: the
-- backfill rewrites 1.66M author rows and the index covers them; both run in
-- the migration transaction, which holds an exclusive lock on authors.

ALTER TABLE "authors" ADD COLUMN IF NOT EXISTS "has_works" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION authors_has_works_fn()
RETURNS TRIGGER AS $$
BEGIN
  UPDATE authors a SET has_works = true
  WHERE a.id IN (SELECT author_id FROM new_links) AND NOT a.has_works;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS work_authors_has_works_trigger ON work_authors;
--> statement-breakpoint
CREATE TRIGGER work_authors_has_works_trigger
  AFTER INSERT ON work_authors
  REFERENCING NEW TABLE AS new_links
  FOR EACH STATEMENT EXECUTE FUNCTION authors_has_works_fn();
--> statement-breakpoint
-- Hashing 3.8M links spills at the default 4 MB (see ingest.ts, "loading
-- referenced author keys"). Scoped to this transaction.
SET LOCAL work_mem = '256MB';
--> statement-breakpoint
SET LOCAL maintenance_work_mem = '256MB';
--> statement-breakpoint
UPDATE authors a SET has_works = true
WHERE NOT a.has_works
  AND EXISTS (SELECT 1 FROM work_authors wa WHERE wa.author_id = a.id);
--> statement-breakpoint
-- The expression must be byte-identical to the one SEARCH_SQL uses, or the
-- planner will not pick this index.
CREATE INDEX IF NOT EXISTS "authors_credited_trgm_idx"
  ON "authors" USING gin (flyleaf_author_names(name, alternate_names) gin_trgm_ops)
  WHERE has_works;
