-- Audit 11: shelves and lists.
--
-- Hand-written and idempotent, like 0013 and 0018: every statement can be
-- re-applied to a database that has part of it.
--
-- 1. The shelf_items counter trigger becomes statement-level (A-11-010).
--    0013's row-level trigger recounted the whole shelf and rebuilt its
--    mosaic once per changed row, so a reorder of n items paid n full
--    recounts (O(n^2): ~40 s for 1,000 items on PGlite). Transition tables
--    give one recount per touched shelf per statement. Covers break ties on
--    work_id so the mosaic no longer depends on physical row order.
-- 2. reconcile_shelf_counters() writes only drifted rows and returns how many
--    it fixed, like reconcile_read_counters() (A-11-021).
-- 3. Indexes for browse (A-11-019): trigram indexes for the name/description
--    search, and a partial index that makes "has per-entry notes" an index
--    probe instead of a walk over every item of every candidate shelf.
-- 4. DB-side constraints the API already enforced (A-11-023): a name that is
--    not blank and a description of at most 2,000 characters. NOT VALID, so
--    applying this never fails on old rows; every new write is checked.

CREATE OR REPLACE FUNCTION refresh_shelf_item_counters(shelf_ids uuid[])
RETURNS void AS $$
  UPDATE shelves s
  SET item_count = c.n, cover_work_ids = c.covers
  FROM (
    SELECT x.id,
      (SELECT count(*)::int FROM shelf_items si WHERE si.shelf_id = x.id) AS n,
      COALESCE((
        SELECT array_agg(t.work_id ORDER BY t.position, t.added_at, t.work_id)
        FROM (
          SELECT work_id, position, added_at FROM shelf_items
          WHERE shelf_id = x.id
          ORDER BY position, added_at, work_id
          LIMIT 4
        ) t
      ), '{}'::uuid[]) AS covers
    FROM (SELECT DISTINCT unnest(shelf_ids) AS id) x
  ) c
  WHERE s.id = c.id
    AND (s.item_count, s.cover_work_ids) IS DISTINCT FROM (c.n, c.covers);
$$ LANGUAGE sql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shelf_items_counters()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    PERFORM refresh_shelf_item_counters(ARRAY(SELECT DISTINCT shelf_id FROM new_rows));
  ELSIF TG_OP = 'UPDATE' THEN
    PERFORM refresh_shelf_item_counters(ARRAY(
      SELECT shelf_id FROM new_rows UNION SELECT shelf_id FROM old_rows));
  ELSE
    PERFORM refresh_shelf_item_counters(ARRAY(SELECT DISTINCT shelf_id FROM old_rows));
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS shelf_items_counter_trigger ON shelf_items;
--> statement-breakpoint
DROP TRIGGER IF EXISTS shelf_items_counters_ins ON shelf_items;
--> statement-breakpoint
CREATE TRIGGER shelf_items_counters_ins
AFTER INSERT ON shelf_items
REFERENCING NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION shelf_items_counters();
--> statement-breakpoint
DROP TRIGGER IF EXISTS shelf_items_counters_upd ON shelf_items;
--> statement-breakpoint
CREATE TRIGGER shelf_items_counters_upd
AFTER UPDATE ON shelf_items
REFERENCING OLD TABLE AS old_rows NEW TABLE AS new_rows
FOR EACH STATEMENT EXECUTE FUNCTION shelf_items_counters();
--> statement-breakpoint
DROP TRIGGER IF EXISTS shelf_items_counters_del ON shelf_items;
--> statement-breakpoint
CREATE TRIGGER shelf_items_counters_del
AFTER DELETE ON shelf_items
REFERENCING OLD TABLE AS old_rows
FOR EACH STATEMENT EXECUTE FUNCTION shelf_items_counters();
--> statement-breakpoint
DROP FUNCTION IF EXISTS update_shelf_item_count_and_covers();
--> statement-breakpoint
DROP FUNCTION IF EXISTS reconcile_shelf_counters();
--> statement-breakpoint
CREATE FUNCTION reconcile_shelf_counters()
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
CREATE INDEX IF NOT EXISTS "shelves_name_trgm_idx" ON "shelves" USING gin ("name" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelves_description_trgm_idx" ON "shelves" USING gin ("description" gin_trgm_ops);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelf_items_noted_idx" ON "shelf_items" ("shelf_id") WHERE "note" IS NOT NULL;
--> statement-breakpoint
-- The deleted-shelves list and the purge both look shelves up by deletion time.
CREATE INDEX IF NOT EXISTS "shelves_deleted_idx" ON "shelves" ("user_id", "deleted_at" DESC)
  WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shelves_name_not_blank_ck') THEN
    ALTER TABLE "shelves" ADD CONSTRAINT "shelves_name_not_blank_ck"
      CHECK (char_length(btrim("name")) >= 1) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'shelves_description_length_ck') THEN
    ALTER TABLE "shelves" ADD CONSTRAINT "shelves_description_length_ck"
      CHECK ("description" IS NULL OR char_length("description") <= 2000) NOT VALID;
  END IF;
END $$;
