-- Why does "murakami" not return Norwegian Wood?
--
-- Three hypotheses, and these queries distinguish them:
--   A. The book is not in the catalog at all.
--   B. It is there, but its author record is named in Japanese, so
--      `a.name ILIKE '%murakami%'` cannot match it.
--   C. It is there with a matching author, and the query is dropping it.

\echo '=== A. Is Norwegian Wood in the catalog at all? ==='
SELECT w.title, w.log_count, a.name AS author, w.ol_work_key
FROM works w
LEFT JOIN work_authors wa ON wa.work_id = w.id
LEFT JOIN authors a ON a.id = wa.author_id
WHERE w.title ILIKE 'norwegian wood%'
ORDER BY w.log_count DESC
LIMIT 10;

\echo ''
\echo '=== B. What are the author records that match %murakami%? ==='
\echo '(if Haruki is stored as a Japanese name, he will NOT appear here)'
SELECT a.name,
       count(wa.work_id) AS works,
       COALESCE(sum(w.log_count), 0) AS total_logs
FROM authors a
JOIN work_authors wa ON wa.author_id = a.id
JOIN works w ON w.id = wa.work_id
WHERE a.name ILIKE '%murakami%'
GROUP BY a.name
ORDER BY total_logs DESC
LIMIT 15;

\echo ''
\echo '=== B2. Who actually wrote the high-log books we would expect? ==='
SELECT a.name AS author, count(*) AS works, sum(w.log_count) AS logs
FROM authors a
JOIN work_authors wa ON wa.author_id = a.id
JOIN works w ON w.id = wa.work_id
WHERE w.title ILIKE ANY (ARRAY['norwegian wood%', 'kafka on the shore%',
                               '1q84%', 'the wind-up bird%'])
GROUP BY a.name
ORDER BY logs DESC
LIMIT 10;

\echo ''
\echo '=== C. What the by_author arm actually returns for %murakami% ==='
SELECT w.title, a.name AS author, w.log_count
FROM authors a
JOIN work_authors wa ON wa.author_id = a.id
JOIN works w ON w.id = wa.work_id
WHERE a.name ILIKE '%murakami%'
ORDER BY w.log_count DESC
LIMIT 15;
