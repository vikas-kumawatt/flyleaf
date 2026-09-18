CREATE TABLE IF NOT EXISTS "imports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "source" text NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "total_rows" integer DEFAULT 0 NOT NULL,
  "matched" integer DEFAULT 0 NOT NULL,
  "unmatched" integer DEFAULT 0 NOT NULL,
  "file_key" text,
  "filename" text,
  "file_size_bytes" bigint,
  "content_hash" text,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'imports_source_ck'
  ) THEN
    ALTER TABLE "imports" ADD CONSTRAINT "imports_source_ck" CHECK ("source" IN ('goodreads','storygraph','librarything','calibre','openlibrary','openreads'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'imports_state_ck'
  ) THEN
    ALTER TABLE "imports" ADD CONSTRAINT "imports_state_ck" CHECK ("state" IN ('queued','processing','completed','failed'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'imports_counts_ck'
  ) THEN
    ALTER TABLE "imports" ADD CONSTRAINT "imports_counts_ck" CHECK ("total_rows" >= 0 AND "matched" >= 0 AND "unmatched" >= 0);
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "imports_user_idx" ON "imports" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "imports_state_idx" ON "imports" ("state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "imports_user_hash_idx" ON "imports" ("user_id", "content_hash");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "import_rows" (
  "import_id" uuid NOT NULL REFERENCES "imports"("id") ON DELETE CASCADE,
  "row_no" integer NOT NULL,
  "raw" jsonb NOT NULL,
  "state" text NOT NULL,
  "work_id" uuid REFERENCES "works"("id") ON DELETE SET NULL,
  "edition_id" uuid REFERENCES "editions"("id") ON DELETE SET NULL,
  "confidence" real,
  "failure_reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("import_id", "row_no")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'import_rows_state_ck'
  ) THEN
    ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_state_ck" CHECK ("state" IN ('matched','unmatched','resolved','skipped'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'import_rows_confidence_ck'
  ) THEN
    ALTER TABLE "import_rows" ADD CONSTRAINT "import_rows_confidence_ck" CHECK ("confidence" IS NULL OR ("confidence" >= 0 AND "confidence" <= 1));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_rows_import_state_idx" ON "import_rows" ("import_id", "state", "row_no");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_rows_work_idx" ON "import_rows" ("work_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "import_rows_edition_idx" ON "import_rows" ("edition_id");
