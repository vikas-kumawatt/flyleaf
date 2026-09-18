CREATE TABLE IF NOT EXISTS "shelves" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "name" text NOT NULL,
  "slug" text NOT NULL,
  "description" text,
  "is_ranked" boolean DEFAULT false NOT NULL,
  "privacy" text DEFAULT 'public' NOT NULL,
  "cover_work_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
  "item_count" integer DEFAULT 0 NOT NULL,
  "save_count" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shelves_name_length_ck'
  ) THEN
    ALTER TABLE "shelves" ADD CONSTRAINT "shelves_name_length_ck" CHECK (char_length("name") <= 60);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shelves_privacy_ck'
  ) THEN
    ALTER TABLE "shelves" ADD CONSTRAINT "shelves_privacy_ck" CHECK ("privacy" IN ('public', 'followers', 'private'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shelves_user_slug_unq'
  ) THEN
    ALTER TABLE "shelves" ADD CONSTRAINT "shelves_user_slug_unq" UNIQUE ("user_id", "slug");
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelves_user_idx" ON "shelves" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelves_privacy_idx" ON "shelves" ("privacy");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelves_save_count_idx" ON "shelves" ("save_count" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shelf_items" (
  "shelf_id" uuid NOT NULL REFERENCES "shelves"("id") ON DELETE CASCADE,
  "work_id" uuid NOT NULL REFERENCES "works"("id") ON DELETE CASCADE,
  "position" integer DEFAULT 0 NOT NULL,
  "note" text,
  "added_at" timestamp with time zone DEFAULT now() NOT NULL,
  "added_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  PRIMARY KEY ("shelf_id", "work_id")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'shelf_items_note_length_ck'
  ) THEN
    ALTER TABLE "shelf_items" ADD CONSTRAINT "shelf_items_note_length_ck" CHECK ("note" IS NULL OR char_length("note") <= 280);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelf_items_order_idx" ON "shelf_items" ("shelf_id", "position");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelf_items_work_idx" ON "shelf_items" ("work_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shelf_saves" (
  "shelf_id" uuid NOT NULL REFERENCES "shelves"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("shelf_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelf_saves_user_idx" ON "shelf_saves" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelf_saves_shelf_idx" ON "shelf_saves" ("shelf_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION update_shelf_item_count_and_covers()
RETURNS TRIGGER AS $$
DECLARE
  target_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    target_id := OLD.shelf_id;
  ELSE
    target_id := NEW.shelf_id;
  END IF;

  UPDATE shelves
  SET
    item_count = (
      SELECT COUNT(*)::int
      FROM shelf_items
      WHERE shelf_id = target_id
    ),
    cover_work_ids = COALESCE(
      (
        SELECT ARRAY_AGG(work_id ORDER BY position ASC, added_at ASC)
        FROM (
          SELECT work_id, position, added_at
          FROM shelf_items
          WHERE shelf_id = target_id
          ORDER BY position ASC, added_at ASC
          LIMIT 4
        ) t
      ),
      '{}'::uuid[]
    )
  WHERE id = target_id;

  IF (TG_OP = 'UPDATE' AND OLD.shelf_id IS DISTINCT FROM NEW.shelf_id) THEN
    UPDATE shelves
    SET
      item_count = (
        SELECT COUNT(*)::int
        FROM shelf_items
        WHERE shelf_id = OLD.shelf_id
      ),
      cover_work_ids = COALESCE(
        (
          SELECT ARRAY_AGG(work_id ORDER BY position ASC, added_at ASC)
          FROM (
            SELECT work_id, position, added_at
            FROM shelf_items
            WHERE shelf_id = OLD.shelf_id
            ORDER BY position ASC, added_at ASC
            LIMIT 4
          ) t
        ),
        '{}'::uuid[]
      )
    WHERE id = OLD.shelf_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS shelf_items_counter_trigger ON shelf_items;
--> statement-breakpoint
CREATE TRIGGER shelf_items_counter_trigger
AFTER INSERT OR UPDATE OR DELETE ON shelf_items
FOR EACH ROW
EXECUTE FUNCTION update_shelf_item_count_and_covers();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION update_shelf_save_count()
RETURNS TRIGGER AS $$
DECLARE
  target_id uuid;
BEGIN
  IF (TG_OP = 'DELETE') THEN
    target_id := OLD.shelf_id;
  ELSE
    target_id := NEW.shelf_id;
  END IF;

  UPDATE shelves
  SET save_count = (
    SELECT COUNT(*)::int
    FROM shelf_saves
    WHERE shelf_id = target_id
  )
  WHERE id = target_id;

  IF (TG_OP = 'UPDATE' AND OLD.shelf_id IS DISTINCT FROM NEW.shelf_id) THEN
    UPDATE shelves
    SET save_count = (
      SELECT COUNT(*)::int
      FROM shelf_saves
      WHERE shelf_id = OLD.shelf_id
    )
    WHERE id = OLD.shelf_id;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS shelf_saves_counter_trigger ON shelf_saves;
--> statement-breakpoint
CREATE TRIGGER shelf_saves_counter_trigger
AFTER INSERT OR UPDATE OR DELETE ON shelf_saves
FOR EACH ROW
EXECUTE FUNCTION update_shelf_save_count();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION reconcile_shelf_counters()
RETURNS void AS $$
BEGIN
  UPDATE shelves s
  SET
    item_count = (
      SELECT COUNT(*)::int
      FROM shelf_items si
      WHERE si.shelf_id = s.id
    ),
    cover_work_ids = COALESCE(
      (
        SELECT ARRAY_AGG(work_id ORDER BY position ASC, added_at ASC)
        FROM (
          SELECT work_id, position, added_at
          FROM shelf_items
          WHERE shelf_id = s.id
          ORDER BY position ASC, added_at ASC
          LIMIT 4
        ) t
      ),
      '{}'::uuid[]
    ),
    save_count = (
      SELECT COUNT(*)::int
      FROM shelf_saves ss
      WHERE ss.shelf_id = s.id
    );
END;
$$ LANGUAGE plpgsql;
