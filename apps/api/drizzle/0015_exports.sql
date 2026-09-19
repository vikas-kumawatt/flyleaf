CREATE TABLE IF NOT EXISTS "exports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "format" text DEFAULT 'csv' NOT NULL,
  "state" text DEFAULT 'queued' NOT NULL,
  "file_key" text,
  "file_size_bytes" bigint,
  "download_token" text,
  "expires_at" timestamp with time zone,
  "error" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'exports_format_ck'
  ) THEN
    ALTER TABLE "exports" ADD CONSTRAINT "exports_format_ck" CHECK ("format" IN ('csv','json'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'exports_state_ck'
  ) THEN
    ALTER TABLE "exports" ADD CONSTRAINT "exports_state_ck" CHECK ("state" IN ('queued','processing','completed','failed'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exports_user_idx" ON "exports" ("user_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "exports_token_idx" ON "exports" ("download_token");
