-- Audit 15 (§4; D-10-1, D-10-3, A-04-022, A-11-033, A-PV-008): every
-- soft delete and every log has an end.
--
-- The daily `retention.sweep` job deletes, in batches:
--   rate_limits       buckets whose window ended (0038's expires_at)
--   events            older than 13 months (D-10-1); search_zero_results
--                     older than a flat 30 days (PRD §23.5, D-10-1 corrected)
--   shelves           soft-deleted more than 30 days ago (PRD §15.6)
--   reviews           soft-deleted more than 30 days ago (PRD §23.5)
--   read_comments     soft-deleted more than 30 days ago (as reviews)
--   users             soft-deleted more than 30 days ago (PRD §23.5, §26),
--                     with their stored objects first
--   ...and trims the copy of a committed import row's file line (D-15-5).
-- These indexes let each batch find its rows without scanning the table.
--
-- D-10-3, the weekly zero-result summary: each zero-result event carries a
-- searcher key, hmac(week salt, account id or guest session id). The salt
-- lives in search_week_salts, one row per week, and is deleted in the same
-- transaction that writes that week's rows of search_zero_summaries: after
-- that, the keys in the (30-day) events cannot be linked to anyone. A query's
-- text is kept only when at least 5 distinct searchers searched it that week;
-- the rest of the week is one row of counts with a NULL query.
--
-- Hand-written and idempotent.

CREATE INDEX IF NOT EXISTS "events_at_idx" ON "events" ("at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_deleted_idx" ON "reviews" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_comments_deleted_idx" ON "read_comments" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelves_purge_idx" ON "shelves" ("deleted_at") WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_week_salts" (
  "week" date PRIMARY KEY,
  "salt" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "search_zero_summaries" (
  "week" date NOT NULL,
  "query" text,
  "searches" integer NOT NULL,
  "distinct_searchers" integer NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "search_zero_summaries_counts_ck" CHECK ("searches" >= "distinct_searchers" AND "distinct_searchers" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "search_zero_summaries_week_query_uq"
  ON "search_zero_summaries" ("week", "query") NULLS NOT DISTINCT;
