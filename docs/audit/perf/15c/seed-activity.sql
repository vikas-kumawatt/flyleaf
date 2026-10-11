-- Audit 15c (A-15-029), sandbox only: grow `activity` past 1M rows on top of
-- the Part 01 bench set. Every row's actor is a bench user, so
-- `npm run bench:seed -- --clean` removes them by cascade. Object ids are
-- random: the rows exist to make the table big, as 180 days of retention will.
\timing on
WITH bench AS (
  SELECT array_agg(id ORDER BY id) AS ids FROM users WHERE email LIKE '%@bench.flyleaf.invalid')
INSERT INTO activity (actor_id, verb, work_id, object_type, object_id, visibility, created_at)
SELECT bench.ids[1 + g % array_length(bench.ids, 1)],
       (ARRAY['started','finished','reviewed','rated','shelved'])[1 + g % 5],
       NULL,
       (ARRAY['read','read','review','read','shelf_item'])[1 + g % 5],
       gen_random_uuid(),
       (ARRAY['public','public','followers'])[1 + g % 3],
       now() - (g % 180) * interval '1 day' - (g % 86400) * interval '1 second'
FROM bench, generate_series(1, 1000000) g;
VACUUM ANALYZE activity;
SELECT count(*) AS activity_rows, pg_size_pretty(pg_relation_size('activity')) AS heap FROM activity;
