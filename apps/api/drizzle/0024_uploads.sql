-- PV-02: presigned uploads. A client asks for an upload (POST /v1/uploads),
-- sends the bytes straight to object storage, and confirms
-- (POST /v1/uploads/:id/complete). A consumer (imports first) then takes the
-- upload id and marks it consumed in the same transaction as its job enqueue.
--
-- Hand-written and idempotent, like 0018: every statement can be re-applied
-- to a database that already has part of it.

CREATE TABLE IF NOT EXISTS "uploads" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "purpose" text NOT NULL,
  "key" text NOT NULL,
  "content_type" text NOT NULL,
  -- The declared size, bound into the presigned URL; complete() checks the
  -- stored object against it.
  "size" bigint NOT NULL,
  "max_bytes" bigint NOT NULL,
  "filename" text,
  -- SHA-256 of the object as complete() read it. Import duplicate detection
  -- (PRD §34.4) and the worker's "unchanged since complete" check use it.
  "sha256" text,
  "status" text DEFAULT 'pending' NOT NULL,
  "expires_at" timestamp with time zone NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "completed_at" timestamp with time zone,
  "consumed_at" timestamp with time zone
);
--> statement-breakpoint
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uploads_purpose_ck') THEN
    ALTER TABLE "uploads" ADD CONSTRAINT "uploads_purpose_ck" CHECK ("purpose" IN ('import'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uploads_status_ck') THEN
    ALTER TABLE "uploads" ADD CONSTRAINT "uploads_status_ck"
      CHECK ("status" IN ('pending','uploaded','consumed','expired'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uploads_size_ck') THEN
    ALTER TABLE "uploads" ADD CONSTRAINT "uploads_size_ck" CHECK ("size" > 0 AND "size" <= "max_bytes");
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'uploads_filename_ck') THEN
    ALTER TABLE "uploads" ADD CONSTRAINT "uploads_filename_ck" CHECK (char_length("filename") <= 255);
  END IF;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uploads_key_uq" ON "uploads" ("key");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "uploads_user_idx" ON "uploads" ("user_id", "created_at" DESC);
--> statement-breakpoint
-- The daily cleanup reads only the live rows past their expiry.
CREATE INDEX IF NOT EXISTS "uploads_cleanup_idx" ON "uploads" ("expires_at")
  WHERE "status" IN ('pending','uploaded');
