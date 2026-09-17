ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "abandoned_at" date;
--> statement-breakpoint
ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "abandoned_page" integer;
--> statement-breakpoint
ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "dnf_reason" text;
--> statement-breakpoint
ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "format_override" text;
--> statement-breakpoint
ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "source" text DEFAULT 'app' NOT NULL;
--> statement-breakpoint
ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "like_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "comment_count" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reads_format_override_ck'
  ) THEN
    ALTER TABLE "reads" ADD CONSTRAINT "reads_format_override_ck" CHECK ("format_override" IS NULL OR "format_override" IN ('print','ebook','audiobook'));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reads_source_ck'
  ) THEN
    ALTER TABLE "reads" ADD CONSTRAINT "reads_source_ck" CHECK ("source" IN ('app','import'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reads_work_finished_idx" ON "reads" ("work_id") WHERE status = 'finished';
--> statement-breakpoint
ALTER TABLE "progress_events" ADD COLUMN IF NOT EXISTS "note" text;
--> statement-breakpoint
ALTER TABLE "progress_events" ADD COLUMN IF NOT EXISTS "audio_seconds" integer;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'progress_events_note_ck'
  ) THEN
    ALTER TABLE "progress_events" ADD CONSTRAINT "progress_events_note_ck" CHECK ("note" IS NULL OR char_length("note") <= 280);
  END IF;
END $$;
