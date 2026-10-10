-- Audit 12 (A-12-016): an export's download token is kept only as its SHA-256.
--
-- The emailed link is a bearer credential for a full copy of a reader's
-- library for 48 hours. Stored in the clear, anyone who could read the
-- exports table (a backup, a read replica, a SQL injection elsewhere) could
-- download every recent export. The token is now made when the file is ready,
-- emailed, and stored only as a hash; the owner's app gets its link from
-- GET /v1/exports/:id/link with their session instead.
--
-- Hand-written and idempotent. Live tokens are hashed in place, so links
-- already emailed keep working; download_token is left NULL from here on.

ALTER TABLE "exports" ADD COLUMN IF NOT EXISTS "download_token_hash" text;
--> statement-breakpoint
UPDATE "exports"
SET "download_token_hash" = encode(sha256(convert_to("download_token", 'UTF8')), 'hex'),
    "download_token" = NULL
WHERE "download_token" IS NOT NULL;
