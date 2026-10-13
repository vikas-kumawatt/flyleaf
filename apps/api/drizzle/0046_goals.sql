-- ST-05: reading goals (PRD §8.6 [LOCKED], architecture §3.4).
--
--   goals   one row per (user, year): a book target (primary) and an optional
--           page target. Editable any time, downward included; deleting the
--           row means "no goal". Progress is never stored: it is the stats
--           books/pages count for that year, computed per viewer (§17.5), so
--           marking a read private can never make a stored figure stale.
--
-- Shown in exactly two places (§8.6): the ring on the profile stats strip
-- and, later, a Year in Review card. Nothing here is read by the feed,
-- notifications or the stats screen.
--
-- Bounds: the year is the user's calendar year, 1900–9999; targets are
-- positive and capped (10,000 books, 10,000,000 pages) so a typo cannot store
-- a number no ring can draw. Hand-written and idempotent,
-- like 0018_read_interactions.sql.

CREATE TABLE IF NOT EXISTS "goals" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "year" integer NOT NULL,
  "target_books" integer NOT NULL,
  "target_pages" integer,
  "created_at" timestamptz NOT NULL DEFAULT now(),
  "updated_at" timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY ("user_id", "year")
);

--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goals_year_ck') THEN
    ALTER TABLE "goals" ADD CONSTRAINT "goals_year_ck" CHECK ("year" BETWEEN 1900 AND 9999);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goals_target_books_ck') THEN
    ALTER TABLE "goals" ADD CONSTRAINT "goals_target_books_ck" CHECK ("target_books" BETWEEN 1 AND 10000);
  END IF;
END $$;
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'goals_target_pages_ck') THEN
    ALTER TABLE "goals" ADD CONSTRAINT "goals_target_pages_ck" CHECK ("target_pages" IS NULL OR "target_pages" BETWEEN 1 AND 10000000);
  END IF;
END $$;
