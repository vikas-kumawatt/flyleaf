CREATE TABLE IF NOT EXISTS "blocks" (
  "blocker_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "blocked_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("blocker_id", "blocked_id")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'blocks_no_self_block_ck'
  ) THEN
    ALTER TABLE "blocks" ADD CONSTRAINT "blocks_no_self_block_ck" CHECK ("blocker_id" <> "blocked_id");
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "blocks_blocked_idx" ON "blocks" ("blocked_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "mutes" (
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "target_type" text NOT NULL,
  "target_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("user_id", "target_type", "target_id")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'mutes_target_type_ck'
  ) THEN
    ALTER TABLE "mutes" ADD CONSTRAINT "mutes_target_type_ck" CHECK ("target_type" IN ('user', 'work'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "mutes_user_idx" ON "mutes" ("user_id", "target_type");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION refresh_profile_follow_counts(target_user_id uuid)
RETURNS void AS $$
BEGIN
  UPDATE profiles
  SET
    follower_count = (
      SELECT COUNT(*)::int
      FROM follows
      WHERE followee_id = target_user_id AND state = 'accepted'
    ),
    following_count = (
      SELECT COUNT(*)::int
      FROM follows
      WHERE follower_id = target_user_id AND state = 'accepted'
    )
  WHERE user_id = target_user_id;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION follows_counter_trigger_fn()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM refresh_profile_follow_counts(OLD.follower_id);
    PERFORM refresh_profile_follow_counts(OLD.followee_id);
    RETURN OLD;
  ELSIF (TG_OP = 'INSERT') THEN
    PERFORM refresh_profile_follow_counts(NEW.follower_id);
    PERFORM refresh_profile_follow_counts(NEW.followee_id);
    RETURN NEW;
  ELSIF (TG_OP = 'UPDATE') THEN
    IF OLD.follower_id IS DISTINCT FROM NEW.follower_id
       OR OLD.followee_id IS DISTINCT FROM NEW.followee_id THEN
      PERFORM refresh_profile_follow_counts(OLD.follower_id);
      PERFORM refresh_profile_follow_counts(OLD.followee_id);
    END IF;
    PERFORM refresh_profile_follow_counts(NEW.follower_id);
    PERFORM refresh_profile_follow_counts(NEW.followee_id);
    RETURN NEW;
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
CREATE OR REPLACE FUNCTION reconcile_follow_counters()
RETURNS void AS $$
BEGIN
  UPDATE profiles p
  SET
    follower_count = (
      SELECT COUNT(*)::int
      FROM follows f
      WHERE f.followee_id = p.user_id AND f.state = 'accepted'
    ),
    following_count = (
      SELECT COUNT(*)::int
      FROM follows f
      WHERE f.follower_id = p.user_id AND f.state = 'accepted'
    );
END;
$$ LANGUAGE plpgsql;
