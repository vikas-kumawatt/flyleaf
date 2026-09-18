CREATE TABLE IF NOT EXISTS "events" (
  "id" bigserial PRIMARY KEY,
  "name" text NOT NULL,
  "user_id" uuid REFERENCES "users"("id") ON DELETE SET NULL,
  "session_id" uuid,
  "platform" text,
  "app_version" text,
  "properties" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_name_at_idx" ON "events" ("name", "at" DESC);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "events_user_at_idx" ON "events" ("user_id", "at" DESC);
