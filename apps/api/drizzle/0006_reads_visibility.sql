ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "visibility" text DEFAULT 'public' NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reads_visibility_ck'
  ) THEN
    ALTER TABLE "reads" ADD CONSTRAINT "reads_visibility_ck" CHECK ("visibility" IN ('public','followers','private'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reads_user_visibility_idx" ON "reads" ("user_id", "visibility", "status", "updated_at");
