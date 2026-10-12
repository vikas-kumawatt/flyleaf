-- SO-30 to SO-32: notifications (PRD §19, §6.14; architecture §3.6, §9).
--
--   notifications              the in-app list and what each push is about.
--                              Likes and follows aggregate (PRD §19.3): while
--                              a group is unread its row is reused, keyed by
--                              group_key ('like:<read id>', 'follow'); a read
--                              group is closed and the next event opens a new
--                              row. updated_at moves with every new actor and
--                              is the list's sort key.
--   notification_actors        who is in a row, one row each: an unlike or an
--                              unfollow takes the actor back out, and the list
--                              and the push both count only actors the
--                              recipient may still see (blocks, mutes).
--                              pushed_at: this actor has been in a push, so a
--                              digest names only the ones since.
--   notification_preferences   per-category push / in-app switches (PRD §19.4),
--                              the master switch, quiet hours, the timezone
--                              they are read in, and the reading reminder
--                              (PRD §19.2 item 14: off until the user sets a time).
--   push_tokens                Expo push tokens, one row per device; a token
--                              that moves to another account moves its row.
--                              last_seen_at is refreshed on every app open.
--   push_tickets               Expo tickets waiting for their delivery receipt
--                              (PV-05 left receipts to SO-30).
--   rate_limit_events          the shared limiter's rolling store: one row per
--                              counted event, so "5 a day" is any 24 hours and
--                              not a window that resets (the push cap).
--
-- Hand-written and idempotent.

CREATE TABLE IF NOT EXISTS "notifications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "type" text NOT NULL,
  "object_type" text,
  "object_id" uuid,
  "group_key" text,
  "data" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "in_app" boolean DEFAULT true NOT NULL,
  "read_at" timestamp with time zone,
  "push_state" text DEFAULT 'none' NOT NULL,
  "push_reason" text,
  "pushed_at" timestamp with time zone,
  "digest_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notifications_type_ck" CHECK ("type" IN ('follow','follow_request','like','comment','import_complete')),
  CONSTRAINT "notifications_object_type_ck" CHECK ("object_type" IS NULL OR "object_type" IN ('user','read','comment','import')),
  CONSTRAINT "notifications_push_state_ck" CHECK ("push_state" IN ('none','queued','sent','skipped'))
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_user_idx"
  ON "notifications" ("user_id", "updated_at" DESC, "id" DESC) WHERE "in_app";
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_unread_idx"
  ON "notifications" ("user_id") WHERE "read_at" IS NULL AND "in_app";
--> statement-breakpoint
-- One open group per key: concurrent likes upsert into the same row.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_open_group_uq"
  ON "notifications" ("user_id", "group_key") WHERE "read_at" IS NULL AND "group_key" IS NOT NULL;
--> statement-breakpoint
-- Import complete is sent once (PRD §19.2 item 7), whatever retries the job.
CREATE UNIQUE INDEX IF NOT EXISTS "notifications_import_once_uq"
  ON "notifications" ("object_id") WHERE "type" = 'import_complete';
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notifications_object_idx" ON "notifications" ("object_type", "object_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_actors" (
  "notification_id" uuid NOT NULL REFERENCES "notifications"("id") ON DELETE CASCADE,
  "actor_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "pushed_at" timestamp with time zone,
  PRIMARY KEY ("notification_id", "actor_id")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_actors_actor_idx" ON "notification_actors" ("actor_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "notification_preferences" (
  "user_id" uuid PRIMARY KEY REFERENCES "users"("id") ON DELETE CASCADE,
  "push_enabled" boolean DEFAULT true NOT NULL,
  "categories" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "quiet_enabled" boolean DEFAULT true NOT NULL,
  "quiet_start" smallint DEFAULT 1320 NOT NULL,
  "quiet_end" smallint DEFAULT 480 NOT NULL,
  "timezone" text DEFAULT 'UTC' NOT NULL,
  "reminder_time" smallint,
  "reminder_last_sent_on" date,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "notification_preferences_quiet_ck" CHECK ("quiet_start" BETWEEN 0 AND 1439 AND "quiet_end" BETWEEN 0 AND 1439),
  CONSTRAINT "notification_preferences_reminder_ck" CHECK ("reminder_time" IS NULL OR "reminder_time" BETWEEN 0 AND 1439)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "notification_preferences_reminder_idx"
  ON "notification_preferences" ("user_id") WHERE "reminder_time" IS NOT NULL;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_tokens" (
  "token" text PRIMARY KEY,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "platform" text NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "push_tokens_platform_ck" CHECK ("platform" IN ('android','ios')),
  CONSTRAINT "push_tokens_token_ck" CHECK (char_length("token") BETWEEN 1 AND 255)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_tokens_user_idx" ON "push_tokens" ("user_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "push_tickets" (
  "ticket_id" text PRIMARY KEY,
  "token" text NOT NULL,
  "notification_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "push_tickets_created_idx" ON "push_tickets" ("created_at");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "rate_limit_events" (
  "bucket" text NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_events_bucket_idx" ON "rate_limit_events" ("bucket", "at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limit_events_at_idx" ON "rate_limit_events" ("at");
