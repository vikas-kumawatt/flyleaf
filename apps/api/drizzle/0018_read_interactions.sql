-- SO-20: read_likes + read_comments, trigger-maintained counters, reconciliation.
--
-- Likes and comments target the READ, not the review (PRD §10.3, LOCKED).
-- `read_likes` already exists (0011); this migration adds `read_comments`,
-- moves `reads.like_count` / `reads.comment_count` from application code to
-- triggers, and gives both counters a reconciliation procedure.
--
-- Hand-written, like 0011 and 0013: every statement is idempotent so the file
-- can be re-applied to a database that has part of it.

CREATE TABLE IF NOT EXISTS "read_comments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "read_id" uuid NOT NULL REFERENCES "reads"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  -- Whitespace-only is empty. 2,000 is the architecture §3.5 cap.
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'read_comments_body_ck') THEN
    ALTER TABLE "read_comments" ADD CONSTRAINT "read_comments_body_ck"
      CHECK (char_length(btrim("body")) BETWEEN 1 AND 2000);
  END IF;
END $$;
--> statement-breakpoint
-- Thread order: oldest first, id as the tiebreak so the cursor is total.
CREATE INDEX IF NOT EXISTS "read_comments_read_idx" ON "read_comments" ("read_id", "created_at", "id");
--> statement-breakpoint
-- A user's recent comments: moderation (SO-4x) and duplicate detection.
CREATE INDEX IF NOT EXISTS "read_comments_user_idx" ON "read_comments" ("user_id", "created_at" DESC);
--> statement-breakpoint
-- "Liked by" list, newest first. The PK (read_id, user_id) cannot order by time.
CREATE INDEX IF NOT EXISTS "read_likes_read_created_idx" ON "read_likes" ("read_id", "created_at" DESC);
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Counters. Incremental, not recount: UPDATE takes the row lock on the read,
-- so concurrent likes serialise on that one row and never lose an increment.
-- The previous application-side read-modify-write (SL-64) lost one on every
-- race. `updated_at` is deliberately NOT touched: it orders the Reading tab,
-- and somebody liking your finish must not reshuffle your shelf.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION read_likes_counter_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    UPDATE reads SET like_count = like_count + 1 WHERE id = NEW.read_id;
  ELSIF (TG_OP = 'DELETE') THEN
    UPDATE reads SET like_count = GREATEST(like_count - 1, 0) WHERE id = OLD.read_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS read_likes_counter_trigger ON read_likes;
--> statement-breakpoint
CREATE TRIGGER read_likes_counter_trigger
AFTER INSERT OR DELETE ON read_likes
FOR EACH ROW EXECUTE FUNCTION read_likes_counter_fn();
--> statement-breakpoint

-- comment_count counts LIVE comments only. A soft delete decrements; an
-- un-delete (moderation reversal) increments.
CREATE OR REPLACE FUNCTION read_comments_counter_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'INSERT') THEN
    IF NEW.deleted_at IS NULL THEN
      UPDATE reads SET comment_count = comment_count + 1 WHERE id = NEW.read_id;
    END IF;
  ELSIF (TG_OP = 'DELETE') THEN
    IF OLD.deleted_at IS NULL THEN
      UPDATE reads SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = OLD.read_id;
    END IF;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF OLD.deleted_at IS NULL AND OLD.read_id IS DISTINCT FROM NEW.read_id THEN
      UPDATE reads SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = OLD.read_id;
      IF NEW.deleted_at IS NULL THEN
        UPDATE reads SET comment_count = comment_count + 1 WHERE id = NEW.read_id;
      END IF;
    ELSIF OLD.deleted_at IS NULL AND NEW.deleted_at IS NOT NULL THEN
      UPDATE reads SET comment_count = GREATEST(comment_count - 1, 0) WHERE id = OLD.read_id;
    ELSIF OLD.deleted_at IS NOT NULL AND NEW.deleted_at IS NULL THEN
      UPDATE reads SET comment_count = comment_count + 1 WHERE id = NEW.read_id;
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS read_comments_counter_trigger ON read_comments;
--> statement-breakpoint
CREATE TRIGGER read_comments_counter_trigger
AFTER INSERT OR DELETE OR UPDATE OF deleted_at, read_id ON read_comments
FOR EACH ROW EXECUTE FUNCTION read_comments_counter_fn();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- ⚠️ Narrow the work_stats trigger (0011) to the columns it reads.
--
-- It fired AFTER UPDATE of ANY column, and recompute_work_stats_for_work()
-- runs `AVG(rating) FROM reads WHERE work_id <> x` — a scan of the whole
-- table. With counters now maintained by UPDATE reads, every like and every
-- comment would have paid for that scan. Only these columns feed work_stats.
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS reads_work_stats_trigger ON reads;
--> statement-breakpoint
CREATE TRIGGER reads_work_stats_trigger
AFTER INSERT OR DELETE OR UPDATE OF work_id, user_id, rating, hearted, status ON reads
FOR EACH ROW
EXECUTE FUNCTION update_work_stats_from_reads();
--> statement-breakpoint

-- ---------------------------------------------------------------------------
-- Reconciliation (architecture §3.9: "every counter has a reconciliation
-- job"). Only rows that actually drifted are written, so the nightly run is
-- cheap on a healthy table and does not bloat it with dead tuples.
-- Returns the number of reads corrected, which the job logs.
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION reconcile_read_counters()
RETURNS integer AS $$
DECLARE
  fixed integer;
BEGIN
  WITH truth AS (
    SELECT r.id,
      COALESCE(l.n, 0) AS likes,
      COALESCE(c.n, 0) AS comments
    FROM reads r
    LEFT JOIN (SELECT read_id, COUNT(*)::int AS n FROM read_likes GROUP BY read_id) l
      ON l.read_id = r.id
    LEFT JOIN (SELECT read_id, COUNT(*)::int AS n FROM read_comments
               WHERE deleted_at IS NULL GROUP BY read_id) c
      ON c.read_id = r.id
  )
  UPDATE reads r
  SET like_count = t.likes, comment_count = t.comments
  FROM truth t
  WHERE r.id = t.id
    AND (r.like_count <> t.likes OR r.comment_count <> t.comments);
  GET DIAGNOSTICS fixed = ROW_COUNT;
  RETURN fixed;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- Backfill: SL-64 maintained like_count in application code, which could
-- drift. Start from the truth.
SELECT reconcile_read_counters();
