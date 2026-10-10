-- Audit 13: slug and username history (D-11-2, A-11-028).
--
-- Hand-written and idempotent, like 0034.
--
-- A share link names a shelf by `/u/:username/shelves/:slug`. Renaming the
-- shelf or changing the username used to break the link, and the freed slug
-- or name could later open someone else's content. One mechanism for both:
-- a claims table holding every value the owner has ever used (the current
-- one included), with the primary key as the reservation:
--
--   shelf_slugs      (user_id, slug) → shelf_id   a slug stays with its shelf
--   username_claims  (username)      → user_id    a name stays with its account
--
-- Triggers on shelves and profiles write the claims, so every path that sets
-- a slug or a username (API, import, admin, a hand-run UPDATE) is covered,
-- and a value claimed by another shelf / account is a unique violation like
-- the existing UNIQUE constraints (the API maps both to the same response).
-- Claims are never deleted while their shelf / account row exists: a
-- soft-deleted shelf keeps its links for its 30-day restore window, and the
-- rows go with the shelf or account when it is purged (ON DELETE CASCADE).

CREATE TABLE IF NOT EXISTS "shelf_slugs" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "slug" text NOT NULL,
  "shelf_id" uuid NOT NULL REFERENCES "shelves"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "slug")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "shelf_slugs_shelf_idx" ON "shelf_slugs" ("shelf_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "username_claims" (
  "username" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "username_claims_user_idx" ON "username_claims" ("user_id");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION shelf_slug_claim_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO shelf_slugs (user_id, slug, shelf_id)
  VALUES (NEW.user_id, NEW.slug, NEW.id)
  ON CONFLICT (user_id, slug) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM shelf_slugs WHERE user_id = NEW.user_id AND slug = NEW.slug AND shelf_id = NEW.id
  ) THEN
    -- Another shelf of this user had this slug: it still answers to it.
    RAISE EXCEPTION 'slug % is reserved by another shelf', NEW.slug
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'shelf_slugs_pkey';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS shelf_slug_claim_trigger ON shelves;
--> statement-breakpoint
CREATE TRIGGER shelf_slug_claim_trigger
AFTER INSERT OR UPDATE OF slug, user_id ON shelves
FOR EACH ROW
EXECUTE FUNCTION shelf_slug_claim_fn();
--> statement-breakpoint
CREATE OR REPLACE FUNCTION username_claim_fn()
RETURNS TRIGGER AS $$
BEGIN
  INSERT INTO username_claims (username, user_id)
  VALUES (NEW.username, NEW.user_id)
  ON CONFLICT (username) DO NOTHING;
  IF NOT FOUND AND NOT EXISTS (
    SELECT 1 FROM username_claims WHERE username = NEW.username AND user_id = NEW.user_id
  ) THEN
    -- Another account used this name: it stays theirs (and their old links keep working).
    RAISE EXCEPTION 'username % is reserved', NEW.username
      USING ERRCODE = 'unique_violation', CONSTRAINT = 'username_claims_pkey';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS username_claim_trigger ON profiles;
--> statement-breakpoint
CREATE TRIGGER username_claim_trigger
AFTER INSERT OR UPDATE OF username ON profiles
FOR EACH ROW
EXECUTE FUNCTION username_claim_fn();
--> statement-breakpoint
-- Backfill: today's values are the first claims.
INSERT INTO shelf_slugs (user_id, slug, shelf_id, created_at)
SELECT user_id, slug, id, created_at FROM shelves
ON CONFLICT (user_id, slug) DO NOTHING;
--> statement-breakpoint
INSERT INTO username_claims (username, user_id, created_at)
SELECT username, user_id, created_at FROM profiles
ON CONFLICT (username) DO NOTHING;
