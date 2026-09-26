-- Audit 06: admin console hardening (FN-90, FN-93, PRD §27.5).
--
-- admin_credentials
--   last_totp_step        the RFC 6238 step of the last accepted code; a code
--                         at or before it is a replay (A-06-005)
--   session_version       admin tokens carry it (claim sv); logout and disabling
--                         an admin increment it, which ends every live session
--                         of that admin at once (A-06-009)
--   pending_totp_secret,  a 2FA rotation waits here until its first code is
--   pending_backup_codes  verified, so the working secret stays live (A-06-010)
--
-- admin_audit_log
--   actor_id nullable     a failed login for an unknown email has no actor,
--                         and must still be recorded (A-06-008)
--   ip, user_agent        on every entry, not only in the login payload
--   append-only trigger   UPDATE and DELETE are refused (A-06-017)
--   created index         the unfiltered console listing (A-06-018)
--
-- Hand-written and idempotent, like 0018.

ALTER TABLE "admin_credentials" ADD COLUMN IF NOT EXISTS "last_totp_step" bigint;
--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD COLUMN IF NOT EXISTS "session_version" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD COLUMN IF NOT EXISTS "pending_totp_secret" text;
--> statement-breakpoint
ALTER TABLE "admin_credentials" ADD COLUMN IF NOT EXISTS "pending_backup_codes" text[];
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ALTER COLUMN "actor_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "ip" text;
--> statement-breakpoint
ALTER TABLE "admin_audit_log" ADD COLUMN IF NOT EXISTS "user_agent" text;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "admin_audit_log_created_idx" ON "admin_audit_log" ("created_at" DESC, "id" DESC);
--> statement-breakpoint
CREATE OR REPLACE FUNCTION admin_audit_log_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'admin_audit_log is append-only (% refused)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END $$;
--> statement-breakpoint
-- TRUNCATE is not guarded: it is an owner-level operation no code path
-- issues, and test resets rely on TRUNCATE users CASCADE. Closing it needs a
-- non-owner API role (PRD §42 #14), recorded as a recommendation.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'admin_audit_log_append_only') THEN
    CREATE TRIGGER admin_audit_log_append_only
      BEFORE UPDATE OR DELETE ON "admin_audit_log"
      FOR EACH ROW EXECUTE FUNCTION admin_audit_log_append_only();
  END IF;
END $$;
