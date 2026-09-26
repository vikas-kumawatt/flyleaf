-- Audit 07b (D-07-3, A-07-004): dates of birth nobody entered.
--
-- Until the 26 Sep 2026 signup fix the app sent 2000-01-01 for every signup,
-- whatever the person typed. Those accounts are asked for their date of birth
-- again, and until they answer they are treated as the most restricted viewer
-- (CatalogService #allowsExplicit, PRD §7.8, §26.6).
--
-- users.dob_confirmed   false: the stored date of birth was never entered.
--                       Set true by POST /v1/me/date-of-birth, which applies
--                       the signup rules. Every new account is true.
--
-- Backfilled: role 'user' accounts whose date of birth is exactly 2000-01-01.
-- Every such account that exists when this runs is included, a superset of
-- "created before the fix": one created after it with a real 2000-01-01 is
-- asked once more, which is harmless. Staff accounts cannot use the app.
-- The backfill runs only in the step that adds the column, so a re-run never
-- un-confirms someone who has since confirmed 2000-01-01.
--
-- Hand-written and idempotent, like 0018.

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = 'users' AND column_name = 'dob_confirmed'
  ) THEN
    ALTER TABLE "users" ADD COLUMN "dob_confirmed" boolean DEFAULT true NOT NULL;
    UPDATE "users" SET "dob_confirmed" = false
     WHERE "date_of_birth" = DATE '2000-01-01' AND "role" = 'user';
  END IF;
END $$;
