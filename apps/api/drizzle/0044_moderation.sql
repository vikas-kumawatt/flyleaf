-- SO-40 to SO-42: moderation (PRD §27, §6.44, §26.3; architecture §3.6),
-- and the SO-3x owner decisions on notifications (reply notifications).
--
--   reports              one row per report. A person's report (source 'user')
--                        or layer 1's (source 'automated', reporter NULL, the
--                        rule in auto_rule). The queue groups open reports by
--                        subject; an action closes every open report on it.
--                        snapshot: the reported text as it was when reported,
--                        so an edit or delete afterwards cannot hide it.
--   moderation_actions   one row per decision: dismiss (no violation), enforce
--                        (a rule from §27.3, its ladder step, and what it did:
--                        `effects`, with the values it replaced, so an
--                        overturned appeal can put them back), or resolve
--                        (catalog reports: handled with the catalog tools).
--                        The appeal lives on the action it appeals (§27.6:
--                        once). The audit row is in admin_audit_log.
--   users                suspended_until (posting suspension), banned_at (the
--                        account is also soft-deleted, so it disappears like a
--                        deleted one; retention never hard-deletes it),
--                        ratings_excluded_at (vote manipulation), review_flag_until
--                        (§27.3 spoilers, 3rd: new reviews queue for 30 days).
--   reviews, read_comments, shelves.hidden_at
--                        hidden by a moderator: the row is ALSO soft-deleted,
--                        so every read path already leaves it out; hidden_at
--                        tells it apart from the owner's own delete, keeps the
--                        owner from reviving it, and keeps retention from
--                        purging it (§27.5: hidden, not deleted; reversible).
--   reads.rating_excluded
--                        §27.3 fake reviews, 1st: that read's rating leaves the
--                        aggregates. latest_ratings (0029) skips it, and every
--                        rating of an account with ratings_excluded_at.
--
-- Hand-written and idempotent.

ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "suspended_until" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "banned_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "ratings_excluded_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "review_flag_until" timestamp with time zone;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "users_ratings_excluded_idx" ON "users" ("id") WHERE "ratings_excluded_at" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "reviews" ADD COLUMN IF NOT EXISTS "hidden_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "read_comments" ADD COLUMN IF NOT EXISTS "hidden_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "shelves" ADD COLUMN IF NOT EXISTS "hidden_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "reads" ADD COLUMN IF NOT EXISTS "rating_excluded" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE OR REPLACE VIEW latest_ratings AS
  SELECT DISTINCT ON (work_id, user_id) work_id, user_id, rating
  FROM reads
  WHERE rating IS NOT NULL
    AND NOT rating_excluded
    AND user_id NOT IN (SELECT id FROM users WHERE ratings_excluded_at IS NOT NULL)
  ORDER BY work_id, user_id, attempt_no DESC;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "moderation_actions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "subject_type" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "target_user_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "decision" text NOT NULL,
  "rule" text,
  "step" smallint,
  "effects" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "reason" text NOT NULL,
  "actor_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reversed_at" timestamp with time zone,
  "appeal_body" text,
  "appealed_at" timestamp with time zone,
  "appeal_state" text,
  "appeal_resolved_at" timestamp with time zone,
  "appeal_resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "appeal_reason" text,
  CONSTRAINT "moderation_actions_subject_ck" CHECK ("subject_type" IN ('review','comment','user','shelf','work')),
  CONSTRAINT "moderation_actions_decision_ck" CHECK ("decision" IN ('dismiss','enforce','resolve')),
  CONSTRAINT "moderation_actions_rule_ck" CHECK ("rule" IS NULL OR "rule" IN
    ('spoilers','spam','harassment','hate_speech','fake_review','impersonation','vote_manipulation')),
  CONSTRAINT "moderation_actions_enforce_ck" CHECK (("decision" = 'enforce') = ("rule" IS NOT NULL AND "step" IS NOT NULL)),
  CONSTRAINT "moderation_actions_appeal_state_ck" CHECK ("appeal_state" IS NULL OR "appeal_state" IN ('pending','upheld','overturned')),
  CONSTRAINT "moderation_actions_appeal_body_ck" CHECK ("appeal_body" IS NULL OR char_length("appeal_body") BETWEEN 1 AND 2000)
);
--> statement-breakpoint
-- The ladder counts a user's standing strikes per rule.
CREATE INDEX IF NOT EXISTS "moderation_actions_strikes_idx"
  ON "moderation_actions" ("target_user_id", "rule") WHERE "decision" = 'enforce' AND "reversed_at" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_appeals_idx"
  ON "moderation_actions" ("appealed_at") WHERE "appeal_state" = 'pending';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_subject_idx" ON "moderation_actions" ("subject_type", "subject_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "moderation_actions_target_idx" ON "moderation_actions" ("target_user_id", "created_at" DESC);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reports" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "reporter_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "source" text DEFAULT 'user' NOT NULL,
  "auto_rule" text,
  "subject_type" text NOT NULL,
  "subject_id" uuid NOT NULL,
  "subject_owner_id" uuid REFERENCES "users"("id") ON DELETE CASCADE,
  "reason" text NOT NULL,
  "detail" text,
  "snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "state" text DEFAULT 'open' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "resolved_at" timestamp with time zone,
  "resolved_by" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "action_id" uuid REFERENCES "moderation_actions"("id") ON DELETE SET NULL,
  CONSTRAINT "reports_source_ck" CHECK ("source" IN ('user','automated')),
  CONSTRAINT "reports_auto_rule_ck" CHECK (("source" = 'automated') = ("auto_rule" IS NOT NULL)),
  CONSTRAINT "reports_subject_ck" CHECK ("subject_type" IN ('review','comment','user','shelf','work')),
  CONSTRAINT "reports_reason_ck" CHECK ("reason" IN
    ('spam','harassment','hate_speech','spoilers','nsfw','copyright','fake_review','other')),
  CONSTRAINT "reports_detail_ck" CHECK ("detail" IS NULL OR char_length("detail") <= 1000),
  CONSTRAINT "reports_state_ck" CHECK ("state" IN ('open','actioned','dismissed'))
);
--> statement-breakpoint
-- One open report per person per subject: a second tap, or an offline replay, is the same report.
CREATE UNIQUE INDEX IF NOT EXISTS "reports_open_reporter_uq"
  ON "reports" ("reporter_id", "subject_type", "subject_id") WHERE "state" = 'open' AND "reporter_id" IS NOT NULL;
--> statement-breakpoint
-- One open automated report per rule per subject.
CREATE UNIQUE INDEX IF NOT EXISTS "reports_open_auto_uq"
  ON "reports" ("subject_type", "subject_id", "auto_rule") WHERE "state" = 'open' AND "source" = 'automated';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_open_subject_idx"
  ON "reports" ("subject_type", "subject_id") WHERE "state" = 'open';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_open_created_idx" ON "reports" ("created_at") WHERE "state" = 'open';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_reporter_idx" ON "reports" ("reporter_id", "created_at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "reports_owner_idx" ON "reports" ("subject_owner_id", "created_at" DESC);
--> statement-breakpoint
-- Replies (PRD §19.2 item 5, owner decision on SO-3x) and moderation notices (§27.6).
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_type_ck";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_type_ck"
  CHECK ("type" IN ('follow','follow_request','like','comment','import_complete','reply','moderation'));
--> statement-breakpoint
ALTER TABLE "notifications" DROP CONSTRAINT IF EXISTS "notifications_object_type_ck";
--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_object_type_ck"
  CHECK ("object_type" IS NULL OR "object_type" IN ('user','read','comment','import','moderation_action'));
--> statement-breakpoint
-- Notification retention, 180 days like activity (owner decision on SO-3x): the sweep's index.
CREATE INDEX IF NOT EXISTS "notifications_updated_idx" ON "notifications" ("updated_at");
