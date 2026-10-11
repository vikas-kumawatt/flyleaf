-- Audit 15c (A-15-029): the activity statements a review save runs
-- (syncReviewActivity), and the read-visibility one, for one review.
--
--   psql "$URL" -v opts='(COSTS)' -f explain-activity.sql               plan only (the laptop)
--   psql "$URL" -v opts='(ANALYZE, BUFFERS)' -f explain-activity.sql    runs them, rolled back
--
-- -v review=<uuid> picks the review (the sandbox used the bench's hot review);
-- otherwise any review, or a random id where there is none: the plan does not
-- depend on the row existing.
\set ON_ERROR_STOP on
\if :{?review}
\else
SELECT COALESCE((SELECT id FROM reviews LIMIT 1), gen_random_uuid()) AS review \gset
\endif
SELECT COALESCE((SELECT read_id FROM reviews WHERE id = :'review'::uuid), gen_random_uuid()) AS read \gset
\echo review :review read :read
SELECT count(*) AS activity_rows FROM activity;
BEGIN;
\echo '--- syncReviewActivity: the UPDATE every review save runs'
EXPLAIN :opts
UPDATE activity SET visibility = 'public', metadata = metadata
WHERE object_type = 'review' AND object_id = :'review'::uuid
RETURNING id;
\echo '--- syncReviewActivity: the DELETE (review deleted, private or imported)'
EXPLAIN :opts
DELETE FROM activity WHERE object_type = 'review' AND object_id = :'review'::uuid;
\echo '--- updateActivityVisibility(read): a read''s visibility change'
EXPLAIN :opts
UPDATE activity SET visibility = 'followers'
WHERE object_type = 'read' AND object_id = :'read'::uuid;
ROLLBACK;
