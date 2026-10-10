-- Audit 13: social graph.
--
-- Hand-written and idempotent, like 0018 and 0034: every statement can be
-- re-applied to a database that has part of it.
--
-- 1. The follows counter trigger becomes incremental, with the two profile
--    rows locked in user_id order (A-13-001). 0016's trigger recounted both
--    users' follows with COUNT(*) under READ COMMITTED: concurrent follows of
--    one user each counted without the others' uncommitted rows, so the last
--    writer won (50 concurrent follows left follower_count at 2), and two
--    users following each other at once locked the two profiles in opposite
--    orders and deadlocked (13–17 of 25 pairs, a 500 each). An increment is
--    re-applied to the newest row version, and one lock order cannot cycle.
-- 2. reconcile_follow_counters() writes only drifted rows and returns how
--    many it fixed, like reconcile_read_counters() (A-13-002). It rewrote
--    every profile every night.
-- 3. Partial indexes for the followers / following lists (A-13-010): accepted
--    edges in list order (newest first, then the other user's id), so a page
--    is an index range instead of every follower joined and sorted. The
--    lists leave out deleted accounts as one hashed set; a partial index on
--    users keeps that set an index read instead of a scan of every user.
-- 4. Backfill: counters start from the truth, which the old trigger lost.

CREATE OR REPLACE FUNCTION follows_count_delta(p_follower uuid, p_followee uuid, d integer)
RETURNS void AS $$
BEGIN
  -- Both rows, always in user_id order: a follow and the reverse follow take
  -- the same locks in the same order.
  PERFORM 1 FROM profiles
  WHERE user_id IN (p_follower, p_followee)
  ORDER BY user_id
  FOR UPDATE;
  UPDATE profiles SET following_count = GREATEST(following_count + d, 0) WHERE user_id = p_follower;
  UPDATE profiles SET follower_count = GREATEST(follower_count + d, 0) WHERE user_id = p_followee;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION follows_counter_trigger_fn()
RETURNS TRIGGER AS $$
DECLARE
  was_accepted boolean := CASE WHEN TG_OP = 'INSERT' THEN false ELSE OLD.state = 'accepted' END;
  is_accepted boolean := CASE WHEN TG_OP = 'DELETE' THEN false ELSE NEW.state = 'accepted' END;
BEGIN
  IF TG_OP = 'UPDATE'
     AND (OLD.follower_id IS DISTINCT FROM NEW.follower_id OR OLD.followee_id IS DISTINCT FROM NEW.followee_id) THEN
    IF was_accepted THEN PERFORM follows_count_delta(OLD.follower_id, OLD.followee_id, -1); END IF;
    IF is_accepted THEN PERFORM follows_count_delta(NEW.follower_id, NEW.followee_id, 1); END IF;
  ELSIF was_accepted AND NOT is_accepted THEN
    PERFORM follows_count_delta(OLD.follower_id, OLD.followee_id, -1);
  ELSIF is_accepted AND NOT was_accepted THEN
    PERFORM follows_count_delta(NEW.follower_id, NEW.followee_id, 1);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS follows_counter_trigger ON follows;
--> statement-breakpoint
CREATE TRIGGER follows_counter_trigger
AFTER INSERT OR UPDATE OR DELETE ON follows
FOR EACH ROW
EXECUTE FUNCTION follows_counter_trigger_fn();
--> statement-breakpoint
-- The return type changes (void → integer), which CREATE OR REPLACE cannot do.
DROP FUNCTION IF EXISTS reconcile_follow_counters();
--> statement-breakpoint
CREATE FUNCTION reconcile_follow_counters()
RETURNS integer AS $$
DECLARE
  fixed integer;
BEGIN
  WITH truth AS (
    SELECT p.user_id,
      COALESCE(fr.n, 0) AS followers,
      COALESCE(fg.n, 0) AS following
    FROM profiles p
    LEFT JOIN (SELECT followee_id AS id, COUNT(*)::int AS n FROM follows
               WHERE state = 'accepted' GROUP BY followee_id) fr ON fr.id = p.user_id
    LEFT JOIN (SELECT follower_id AS id, COUNT(*)::int AS n FROM follows
               WHERE state = 'accepted' GROUP BY follower_id) fg ON fg.id = p.user_id
  )
  UPDATE profiles p
  SET follower_count = t.followers, following_count = t.following
  FROM truth t
  WHERE p.user_id = t.user_id
    AND (p.follower_count <> t.followers OR p.following_count <> t.following);
  GET DIAGNOSTICS fixed = ROW_COUNT;
  RETURN fixed;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follows_followee_list_idx"
  ON "follows" ("followee_id", "created_at" DESC, "follower_id" DESC)
  WHERE "state" = 'accepted';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follows_follower_list_idx"
  ON "follows" ("follower_id", "created_at" DESC, "followee_id" DESC)
  WHERE "state" = 'accepted';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_deleted_idx" ON "users" ("id") WHERE "deleted_at" IS NOT NULL;
--> statement-breakpoint
-- 0016's refresh_profile_follow_counts() has no caller left.
DROP FUNCTION IF EXISTS refresh_profile_follow_counts(uuid);
--> statement-breakpoint
SELECT reconcile_follow_counters();
