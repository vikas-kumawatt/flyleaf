-- Audit 15 (D-14-1, accepted by the owner 2026-10-10): what makes Popular popular.
--
-- Popular is now public reviews and finishes from the last 14 days, scored by
-- the likes and comments on their read (never by rating, PRD §12.6), with a
-- per-card exposure ceiling (§12.6: "Popular is capped by a per-item exposure
-- ceiling"). Two objects:
--
--   popular_exposures   how many Popular pages have served each card; a card
--                       stops being a candidate at the ceiling. Rows go with
--                       their activity (the 180-day prune cascades here).
--   activity_popular_idx  the candidate range: public reviewed/finished cards
--                       by time. A partial index, so the 14-day range never
--                       reads shelf adds, starts or follows.
--
-- Hand-written and idempotent.

CREATE TABLE IF NOT EXISTS "popular_exposures" (
  "activity_id" uuid PRIMARY KEY REFERENCES "activity"("id") ON DELETE CASCADE,
  "served" integer NOT NULL DEFAULT 0
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "activity_popular_idx" ON "activity" ("created_at" DESC, "id" DESC)
  WHERE "visibility" = 'public' AND "verb" IN ('reviewed', 'finished');
