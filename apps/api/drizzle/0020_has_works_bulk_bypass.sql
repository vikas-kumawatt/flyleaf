-- Audit 02c: the catalog ingest must not maintain authors.has_works row by row.
--
-- 0019's trigger is statement-level, but each works batch (20k works) still
-- rewrote every author it credited for the first time, one non-HOT update
-- each (has_works is in the partial index predicate, so HOT is impossible),
-- interleaved with the load. Measured on a 200k-work pass: 200,993 author
-- updates, 50-132 s inside the trigger; the same flags set afterwards by one
-- set-based UPDATE: 38 s (docs/audit/findings/02-search.md, Part 02c).
--
-- So a session that sets flyleaf.bulk_load = 'on' skips the trigger, and
-- `npm run ingest -- --finalise` sets has_works in one statement
-- (MARK_CREDITED_AUTHORS in catalog/ingest/writer.ts). The setting is
-- per-session: every other writer (gap-fill, dedupe, imports) keeps the
-- trigger. A global DISABLE TRIGGER was rejected: it takes a lock, affects
-- those writers too, and stays off if the ingest dies.
--
-- Replaces the function body only; no table is touched.

CREATE OR REPLACE FUNCTION authors_has_works_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF current_setting('flyleaf.bulk_load', true) = 'on' THEN
    RETURN NULL;
  END IF;
  UPDATE authors a SET has_works = true
  WHERE a.id IN (SELECT author_id FROM new_links) AND NOT a.has_works;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
