CREATE TABLE IF NOT EXISTS "reviews" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "read_id" uuid NOT NULL UNIQUE REFERENCES "reads"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "work_id" uuid NOT NULL REFERENCES "works"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "has_spoilers" boolean DEFAULT false NOT NULL,
  "spoiler_after_page" integer,
  "visibility" text DEFAULT 'public' NOT NULL,
  "published_at" timestamp with time zone DEFAULT now() NOT NULL,
  "edited_at" timestamp with time zone,
  "deleted_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_body_length_ck'
  ) THEN
    ALTER TABLE "reviews" ADD CONSTRAINT "reviews_body_length_ck" CHECK (char_length("body") <= 10000);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'reviews_visibility_ck'
  ) THEN
    ALTER TABLE "reviews" ADD CONSTRAINT "reviews_visibility_ck" CHECK ("visibility" IN ('public', 'followers', 'private'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_work_idx" ON "reviews" ("work_id", "published_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reviews_user_idx" ON "reviews" ("user_id", "published_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "read_likes" (
  "read_id" uuid NOT NULL REFERENCES "reads"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("read_id", "user_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "read_likes_user_idx" ON "read_likes" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "follows" (
  "follower_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "followee_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "state" text DEFAULT 'accepted' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  PRIMARY KEY ("follower_id", "followee_id")
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'follows_no_self_follow_ck'
  ) THEN
    ALTER TABLE "follows" ADD CONSTRAINT "follows_no_self_follow_ck" CHECK ("follower_id" <> "followee_id");
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'follows_state_ck'
  ) THEN
    ALTER TABLE "follows" ADD CONSTRAINT "follows_state_ck" CHECK ("state" IN ('pending', 'accepted'));
  END IF;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follows_follower_idx" ON "follows" ("follower_id", "state");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "follows_followee_idx" ON "follows" ("followee_id", "state");
--> statement-breakpoint
CREATE OR REPLACE FUNCTION recompute_work_stats_for_work(target_work_id uuid)
RETURNS void AS $$
DECLARE
  v_count bigint;
  r_sum numeric(12, 1);
  r_mean numeric;
  c_global numeric;
  w_rating numeric(3, 2);
  p_stddev real;
  h_count bigint;
  rd_count bigint;
  d_count bigint;
  m_const numeric := 25.0;
BEGIN
  IF target_work_id IS NULL THEN
    RETURN;
  END IF;

  -- Calculate work-level aggregates from reads
  SELECT
    COUNT(rating) FILTER (WHERE rating IS NOT NULL),
    COALESCE(SUM(rating), 0),
    COUNT(DISTINCT user_id) FILTER (WHERE hearted = true),
    COUNT(DISTINCT user_id) FILTER (WHERE status = 'finished'),
    COUNT(DISTINCT user_id) FILTER (WHERE status = 'dnf'),
    stddev_samp(rating)
  INTO
    v_count,
    r_sum,
    h_count,
    rd_count,
    d_count,
    p_stddev
  FROM reads
  WHERE work_id = target_work_id;

  -- Catalog global mean rating C (default 3.9 if no ratings on other works in catalog)
  SELECT COALESCE(AVG(rating), 3.9) INTO c_global FROM reads WHERE rating IS NOT NULL AND work_id <> target_work_id;

  IF v_count > 0 THEN
    r_mean := r_sum / v_count;
    -- Bayesian weighted rating formula: (v / (v + m)) * R + (m / (v + m)) * C
    w_rating := ROUND(CAST(((v_count::numeric / (v_count + m_const)) * r_mean + (m_const / (v_count + m_const)) * c_global) AS numeric), 2);
  ELSE
    r_mean := NULL;
    w_rating := NULL;
  END IF;

  -- Upsert into work_stats
  INSERT INTO work_stats (
    work_id,
    rating_sum,
    rating_count,
    avg_rating,
    weighted_rating,
    heart_count,
    read_count,
    dnf_count,
    polarisation,
    updated_at
  ) VALUES (
    target_work_id,
    r_sum,
    v_count,
    CASE WHEN r_mean IS NOT NULL THEN ROUND(r_mean, 2) ELSE NULL END,
    w_rating,
    h_count,
    rd_count,
    d_count,
    p_stddev,
    NOW()
  )
  ON CONFLICT (work_id) DO UPDATE SET
    rating_sum = EXCLUDED.rating_sum,
    rating_count = EXCLUDED.rating_count,
    avg_rating = EXCLUDED.avg_rating,
    weighted_rating = EXCLUDED.weighted_rating,
    heart_count = EXCLUDED.heart_count,
    read_count = EXCLUDED.read_count,
    dnf_count = EXCLUDED.dnf_count,
    polarisation = EXCLUDED.polarisation,
    updated_at = NOW();
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION update_work_stats_from_reads()
RETURNS TRIGGER AS $$
BEGIN
  IF (TG_OP = 'DELETE') THEN
    PERFORM recompute_work_stats_for_work(OLD.work_id);
  ELSIF (TG_OP = 'UPDATE') THEN
    PERFORM recompute_work_stats_for_work(NEW.work_id);
    IF OLD.work_id IS DISTINCT FROM NEW.work_id THEN
      PERFORM recompute_work_stats_for_work(OLD.work_id);
    END IF;
  ELSE
    PERFORM recompute_work_stats_for_work(NEW.work_id);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS reads_work_stats_trigger ON reads;
--> statement-breakpoint
CREATE TRIGGER reads_work_stats_trigger
AFTER INSERT OR UPDATE OR DELETE ON reads
FOR EACH ROW
EXECUTE FUNCTION update_work_stats_from_reads();
