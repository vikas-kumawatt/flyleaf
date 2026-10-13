-- Phase 5 C (ST-09, ST-10, owner decisions on Phase 5 B). Hand-written and
-- idempotent, like 0018_read_interactions.sql.
--
--   card_covers       one row per cover copied into our storage for share
--                     cards (covers/ol/<id>-L.jpg). last_used_at moves (at
--                     most once a day) whenever a card draws it; the daily
--                     retention sweep deletes the object and the row after
--                     180 days unused (owner decision on Phase 5 B).
--   milestones        PRD §18.4: each fires once per (user, key). Keys:
--                     books_1, books_10, books_100, books_500, books_1000,
--                     first_review, first_follower, goal_<year>. seen_at is
--                     when the app showed its moment; a milestone passed
--                     silently (an import) is stored already seen.
--   year_in_review_notices
--                     PRD §19.2 item 8 "once annually": the notify.yir job
--                     claims (user, year) here before it emits, so the claim
--                     holds whatever the user's preferences say.
--   notifications     two new types: 'year_in_review' (item 8) and
--                     'milestone' (item 12, in-app only); one of each per
--                     year / key.

CREATE TABLE IF NOT EXISTS "card_covers" (
  "cover_id" integer PRIMARY KEY,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "last_used_at" timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "card_covers_last_used_idx" ON "card_covers" ("last_used_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "milestones" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "key" text NOT NULL,
  "achieved_at" timestamptz NOT NULL DEFAULT now(),
  "seen_at" timestamptz,
  "data" jsonb NOT NULL DEFAULT '{}'::jsonb,
  PRIMARY KEY ("user_id", "key")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'milestones_key_ck') THEN
    ALTER TABLE "milestones" ADD CONSTRAINT "milestones_key_ck"
      CHECK ("key" ~ '^(books_(1|10|100|500|1000)|first_review|first_follower|goal_[0-9]{4})$');
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "milestones_unseen_idx" ON "milestones" ("user_id") WHERE "seen_at" IS NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "year_in_review_notices" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "year" integer NOT NULL,
  "claimed_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "year")
);
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_ck";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_ck"
  CHECK ("type" IN ('follow','follow_request','like','comment','import_complete','reply','moderation','year_in_review','milestone'));
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_yir_once_uq"
  ON "notifications" ("user_id", ("data"->>'year')) WHERE "type" = 'year_in_review';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_milestone_once_uq"
  ON "notifications" ("user_id", ("data"->>'key')) WHERE "type" = 'milestone';
