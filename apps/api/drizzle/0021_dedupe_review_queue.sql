-- Audit 03b (D1): stage 1-2 pairs that are not unambiguous go to the review
-- queue instead of being auto-merged, so the queue must accept stages 1 and 2.
-- `impact` is how many rows of user data (reads, reviews, shelf items,
-- favourites) sit on either work; the queue is reviewed highest-impact first.
--
-- Hand-written and idempotent, like 0018.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'dedupe_queue_stage_ck'
      AND pg_get_constraintdef(oid) NOT LIKE '%BETWEEN 1 AND 4%'
      AND pg_get_constraintdef(oid) NOT LIKE '%>= 1)%'
  ) THEN
    ALTER TABLE "dedupe_queue" DROP CONSTRAINT "dedupe_queue_stage_ck";
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'dedupe_queue_stage_ck') THEN
    ALTER TABLE "dedupe_queue" ADD CONSTRAINT "dedupe_queue_stage_ck"
      CHECK ("stage" BETWEEN 1 AND 4);
  END IF;
END $$;
--> statement-breakpoint
ALTER TABLE "dedupe_queue" ADD COLUMN IF NOT EXISTS "impact" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dedupe_queue_impact_idx"
  ON "dedupe_queue" ("status", "impact" DESC, "created_at" DESC);
