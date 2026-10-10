-- Audit 15 (§1, A-04-022): rate-limit buckets end, and a sweep deletes them.
--
-- `rate_limits` held one row per bucket forever: every attempted email, every
-- account that ever commented, and now every IP that searched. The windows
-- range from a minute (login) to 30 days (username changes), so the sweep
-- needs to know when each row's window ends: `expires_at`, written by
-- PgRateLimiter on every hit. Rows written before this migration have none;
-- the sweep treats them as ended 31 days after their window started (longer
-- than any window in RATE_LIMITS).
--
-- Hand-written and idempotent.

ALTER TABLE "rate_limits" ADD COLUMN IF NOT EXISTS "expires_at" timestamptz;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "rate_limits_expires_idx" ON "rate_limits" ("expires_at");
