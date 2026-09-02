-- Flyleaf — Phase -1 walking skeleton schema
--
-- SIX TABLES, BY HAND. No migration tool yet (that is FN-01).
-- This file is mounted into the Postgres container's init directory and runs
-- once, on first boot of an empty volume. To re-run it: `make reset`.
--
-- Deliberately crude. What survives Phase -1 is the SHAPE of these tables,
-- not this file. See architecture.md §3 for the real schema.

CREATE EXTENSION IF NOT EXISTS pgcrypto;   -- gen_random_uuid
CREATE EXTENSION IF NOT EXISTS pg_trgm;    -- fuzzy title search
CREATE EXTENSION IF NOT EXISTS citext;

-- ---------------------------------------------------------------- identity

CREATE TABLE users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         citext UNIQUE NOT NULL,
  password_hash text NOT NULL,
  username      citext UNIQUE NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now()
);

-- Opaque bearer tokens. Phase -1 only: real auth is JWT + rotating refresh
-- with family reuse detection (FN-63/64, architecture.md §7).
CREATE TABLE sessions (
  token      text PRIMARY KEY,
  user_id    uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------- catalog

-- The work/edition split is here from the very first day ON PURPOSE.
-- It is the single hardest thing to retrofit, and the skeleton exists partly
-- to find out whether it survives contact with a real UI (phases.md, P-1).
CREATE TABLE works (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title              text NOT NULL,
  author_name        text NOT NULL,
  first_publish_year int,
  ol_cover_id        int,           -- INTEGER, never a URL. architecture.md §5.3
  log_count          int NOT NULL DEFAULT 0
);

CREATE TABLE editions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  work_id    uuid NOT NULL REFERENCES works(id) ON DELETE CASCADE,
  isbn_13    text,
  page_count int,
  format     text NOT NULL DEFAULT 'paperback',
  ol_cover_id int
);

CREATE INDEX works_title_trgm  ON works USING GIN (title gin_trgm_ops);
CREATE INDEX works_author_trgm ON works USING GIN (author_name gin_trgm_ops);
CREATE INDEX editions_work     ON editions (work_id);

-- ---------------------------------------------------------------- reading

-- One row per reading ATTEMPT, never per book. A re-read is a new row.
-- This is the spine of the product (PRD §8.1).
CREATE TABLE reads (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  work_id     uuid NOT NULL REFERENCES works(id),
  edition_id  uuid REFERENCES editions(id),
  status      text NOT NULL CHECK (status IN ('want','reading','paused','finished','dnf')),
  attempt_no  int  NOT NULL DEFAULT 1,
  started_at  date,
  finished_at date,
  rating      numeric(2,1)
                CHECK (rating IS NULL OR (rating BETWEEN 0.5 AND 5.0
                       AND (rating * 2) = floor(rating * 2))),
  hearted     bool NOT NULL DEFAULT false,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, work_id, attempt_no)
);

CREATE INDEX reads_user_status ON reads (user_id, status, updated_at DESC);

-- APPEND-ONLY. No UPDATE, no DELETE except by cascade.
-- Current position is always the latest row. This is the most important
-- schema decision in the tracker (PRD §8.3) and it is here from day one so
-- the skeleton can prove it feels right rather than over-engineered.
CREATE TABLE progress_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  read_id         uuid NOT NULL REFERENCES reads(id) ON DELETE CASCADE,
  at              timestamptz NOT NULL DEFAULT now(),
  page            int,
  percent         numeric(5,2),
  minutes         int,
  client_event_id uuid UNIQUE NOT NULL   -- offline idempotency, from day one
);

CREATE INDEX progress_events_read ON progress_events (read_id, at DESC);

-- ---------------------------------------------------------------- limits

-- Rate-limit counters live in Postgres, not in process memory.
--
-- In-process counters are PER-INSTANCE, so the moment a second API process
-- exists behind the proxy, "10 login attempts a minute" silently becomes
-- twenty. On auth endpoints that is a security weakening, not a tuning miss.
--
-- Redis is not in the v1 stack. When it arrives (trigger: the day a second
-- API instance exists) it implements the same RateLimiter interface and this
-- table stays as the auth-endpoint backstop.
CREATE TABLE rate_limits (
  bucket       text PRIMARY KEY,
  count        int  NOT NULL DEFAULT 0,
  window_start timestamptz NOT NULL DEFAULT now()
);
