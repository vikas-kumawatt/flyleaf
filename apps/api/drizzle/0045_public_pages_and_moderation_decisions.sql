-- SO-5x public pages, with the SO-4x owner decisions (13 Oct 2026).
--
--   moderation_appeal_links   a banned account cannot sign in, so its appeal
--                             (PRD §27.6: once) arrives through an emailed
--                             one-time link. Only the SHA-256 of the token is
--                             stored; a link is spent by the appeal it carries
--                             (used_at), expires after 30 days, and goes with
--                             its action or account (cascade).
--
-- The index for cross-account duplicates (reviews_body_norm_idx) is not here:
-- reviews is a large table, so it is built CONCURRENTLY by migrate.ts
-- (ONLINE_SQL), after the journal, like reads_work_idx (the LA-05 lesson).
--
-- Public pages themselves need no schema: they read through the same
-- services, and username and slug history is 0037's claims tables.
-- Hand-written and idempotent, like 0018_read_interactions.sql.

CREATE TABLE IF NOT EXISTS "moderation_appeal_links" (
  "token_hash" text PRIMARY KEY,
  "action_id" uuid NOT NULL REFERENCES "moderation_actions"("id") ON DELETE CASCADE,
  "user_id" uuid NOT NULL REFERENCES "users"("id") ON DELETE CASCADE,
  "expires_at" timestamptz NOT NULL,
  "used_at" timestamptz,
  "created_at" timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "moderation_appeal_links_action_idx" ON "moderation_appeal_links" ("action_id");
