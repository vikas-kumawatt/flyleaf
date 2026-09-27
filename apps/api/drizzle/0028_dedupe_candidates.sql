-- Audit 03c (D7): a dedupe pass queues for review only pairs where either work
-- has user data or 100+ logs, stage 3 takes at most 20% of a run's free queue
-- slots, and nothing is queued while 500 items are open. Every other
-- review-bound pair a pass detects is recorded here, against the pass that
-- found it, so it can be recomputed or promoted later instead of being lost.
--
-- No foreign key to works: like dedupe_queue history, a candidate names the
-- ids as they were when the pass ran, and merges do not repoint it.
--
-- Also (D5): the auto-merge guard looks series entries up by work, and the
-- merge moves them by work; series_entries had only (series_id, work_id).
--
-- Hand-written and idempotent, like 0018.

CREATE TABLE IF NOT EXISTS "dedupe_candidates" (
  "run_id" uuid NOT NULL REFERENCES "dedupe_runs" ("id") ON DELETE CASCADE,
  "survivor_id" uuid NOT NULL,
  "loser_id" uuid NOT NULL,
  "stage" smallint NOT NULL,
  "reason" text NOT NULL,
  "confidence" real,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "impact" integer DEFAULT 0 NOT NULL,
  "not_queued" text NOT NULL,
  CONSTRAINT "dedupe_candidates_pk" PRIMARY KEY ("run_id", "survivor_id", "loser_id"),
  CONSTRAINT "dedupe_candidates_stage_ck" CHECK ("stage" BETWEEN 1 AND 3),
  CONSTRAINT "dedupe_candidates_not_queued_ck" CHECK ("not_queued" IN ('cold', 'queue_full', 'stage3_share'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "series_entries_work_idx" ON "series_entries" ("work_id");
