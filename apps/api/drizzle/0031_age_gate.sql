-- Audit 10, D-07b-1: the neutral age gate at date-of-birth confirmation.
--
-- A date under 13 entered at POST /me/date-of-birth is refused (as before)
-- and now recorded here. Once set, every later attempt is refused with the
-- same neutral words, whatever date it carries, so a child cannot simply try
-- an older year. The account stays unconfirmed, which is the most restricted
-- state, until someone reviews it; when SO-42 adds suspension, this becomes a
-- suspension instead.
--
-- Nullable, no default: adding it rewrites nothing. Hand-written, idempotent.

ALTER TABLE users ADD COLUMN IF NOT EXISTS underage_attempt_at timestamptz;
