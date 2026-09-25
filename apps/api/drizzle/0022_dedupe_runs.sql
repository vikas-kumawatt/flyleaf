-- Audit 03b: one row per dedupe pass that writes (never for a dry run).
-- Stage 3 also probes works created since the start of the last FINISHED run,
-- so works ingested or gap-filled between runs are looked at once, even when
-- they are below the popularity line. A run that dies leaves finished_at NULL
-- and the next run covers its window again.
--
-- Hand-written and idempotent, like 0018.

CREATE TABLE IF NOT EXISTS "dedupe_runs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "started_at" timestamp with time zone DEFAULT now() NOT NULL,
  "finished_at" timestamp with time zone,
  "auto_merge" boolean NOT NULL,
  "report" jsonb
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "dedupe_runs_finished_idx" ON "dedupe_runs" ("started_at" DESC) WHERE "finished_at" IS NOT NULL;
