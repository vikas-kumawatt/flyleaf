-- A small Flyleaf database for deploy/test/: a "laptop" with a catalog AND
-- user, bench and telemetry data, so the tests can prove that only the
-- catalog leaves. Load after migrations. Catalog text is deliberately awkward
-- (quotes, commas, newlines, RTL, emoji) because the backup's catalog delta
-- is CSV.

BEGIN;

-- ---- catalog ------------------------------------------------------------------
INSERT INTO authors (id, ol_author_key, name) VALUES
  ('a0000000-0000-4000-8000-000000000001', 'OL1A', 'Ursula K. Le Guin'),
  ('a0000000-0000-4000-8000-000000000002', 'OL2A', 'Naguib Mahfouz نجيب محفوظ'),
  ('a0000000-0000-4000-8000-000000000003', 'OL3A', 'Author, "Quoted"');

INSERT INTO works (id, ol_work_key, title, first_publish_year, ol_log_count, created_at, updated_at) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'OL1W', 'A Wizard of Earthsea', 1968, 900, '2026-01-01', '2026-01-01'),
  ('b0000000-0000-4000-8000-000000000002', 'OL2W', 'The Left Hand of Darkness', 1969, 800, '2026-01-01', '2026-01-01'),
  ('b0000000-0000-4000-8000-000000000003', 'OL3W', 'Palace Walk بين القصرين', 1956, 300, '2026-01-01', '2026-01-01'),
  ('b0000000-0000-4000-8000-000000000004', 'OL4W', E'A title with a\nnewline, a comma and "quotes" 📚', 2001, 25, '2026-01-01', '2026-01-01'),
  ('b0000000-0000-4000-8000-000000000005', 'OL5W', 'The Dispossessed', 1974, 700, '2026-01-01', '2026-01-01');

INSERT INTO editions (id, work_id, title) VALUES
  ('c0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'A Wizard of Earthsea (Parnassus)'),
  ('c0000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'The Left Hand of Darkness (Ace)'),
  ('c0000000-0000-4000-8000-000000000003', 'b0000000-0000-4000-8000-000000000003', 'Palace Walk (Anchor)');

INSERT INTO work_authors (work_id, author_id) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000005', 'a0000000-0000-4000-8000-000000000001'),
  ('b0000000-0000-4000-8000-000000000003', 'a0000000-0000-4000-8000-000000000002'),
  ('b0000000-0000-4000-8000-000000000004', 'a0000000-0000-4000-8000-000000000003');

INSERT INTO pending_work_authors (work_key, author_key) VALUES ('OL9W', 'OL9A');

INSERT INTO series (id, name) VALUES ('d0000000-0000-4000-8000-000000000001', 'Earthsea Cycle');
INSERT INTO series_entries (series_id, work_id) VALUES
  ('d0000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');

INSERT INTO subjects (id, slug, name, kind) VALUES
  ('e0000000-0000-4000-8000-000000000001', 'fantasy', 'Fantasy', 'genre');
INSERT INTO work_subjects (work_id, subject_id) VALUES
  ('b0000000-0000-4000-8000-000000000001', 'e0000000-0000-4000-8000-000000000001');

INSERT INTO external_ids (entity_type, entity_id, provider, external_id) VALUES
  ('work', 'b0000000-0000-4000-8000-000000000001', 'open_library', 'OL1W'),
  ('author', 'a0000000-0000-4000-8000-000000000001', 'open_library', 'OL1A');
INSERT INTO field_provenance (entity_type, entity_id, field_name, provider) VALUES
  ('work', 'b0000000-0000-4000-8000-000000000001', 'title', 'open_library');

INSERT INTO raw_payloads (provider, external_id, entity_type, payload, payload_hash) VALUES
  ('open_library', 'OL1W', 'work', '{"title": "A Wizard of Earthsea"}', 'h1');

INSERT INTO search_suggestions (term, weight) VALUES ('Earthsea', 900);

-- ---- user, bench and telemetry data: must NEVER leave the laptop ----------------
INSERT INTO users (id, email, password_hash, date_of_birth, email_verified_at) VALUES
  ('10000000-0000-4000-8000-000000000001', 'alice.private@example.com', 'secret-hash-alice', '1990-01-01', now()),
  ('10000000-0000-4000-8000-000000000002', 'bench_reader_7@example.com', 'secret-hash-bench', '1990-01-01', now());
INSERT INTO profiles (user_id, username, display_name) VALUES
  ('10000000-0000-4000-8000-000000000001', 'alice', 'Alice Private'),
  ('10000000-0000-4000-8000-000000000002', 'bench_reader_7', 'Bench Reader');
INSERT INTO reads (id, user_id, work_id, status, rating) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001', 'finished', 4.5),
  ('20000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000001', 'finished', 3.0),
  ('20000000-0000-4000-8000-000000000003', '10000000-0000-4000-8000-000000000002', 'b0000000-0000-4000-8000-000000000002', 'reading', NULL);
INSERT INTO reviews (read_id, user_id, work_id, body) VALUES
  ('20000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001',
   'b0000000-0000-4000-8000-000000000001', 'PRIVATE-REVIEW-TEXT-MUST-NOT-LEAVE');
INSERT INTO follows (follower_id, followee_id) VALUES
  ('10000000-0000-4000-8000-000000000002', '10000000-0000-4000-8000-000000000001');
INSERT INTO shelves (id, user_id, name, slug) VALUES
  ('30000000-0000-4000-8000-000000000001', '10000000-0000-4000-8000-000000000001', 'Favourites', 'favourites');
INSERT INTO shelf_items (shelf_id, work_id) VALUES
  ('30000000-0000-4000-8000-000000000001', 'b0000000-0000-4000-8000-000000000001');
INSERT INTO activity (actor_id, verb) VALUES ('10000000-0000-4000-8000-000000000001', 'finished');
INSERT INTO events (name) VALUES ('search.performed');

COMMIT;

-- Something a laptop also has: a schema of its own, and pg-boss's.
CREATE SCHEMA IF NOT EXISTS scratch;
CREATE TABLE IF NOT EXISTS scratch.notes (body text);
INSERT INTO scratch.notes VALUES ('SCRATCH-NOTE-MUST-NOT-LEAVE');
CREATE SCHEMA IF NOT EXISTS pgboss;
CREATE TABLE IF NOT EXISTS pgboss.job (data text);
INSERT INTO pgboss.job VALUES ('PGBOSS-JOB-MUST-NOT-LEAVE');
