# GET /v1/feed?tab=popular&limit=20 as guest: 200, 1 items, 4.6 ms, 1 statements

## Statement 1

WITH cand AS (
        SELECT a.id, a.actor_id, a.work_id, a.verb, a.created_at,
          (a.verb = 'finished' AND a.metadata ? 'rating' AND a.metadata->'rating' <> 'null'::jsonb) AS rated,
          CASE WHEN a.object_type = 'read' THEN a.object_id
               WHEN a.object_type = 'review' AND a.metadata->>'readId' ~* $1
                 THEN (a.metadata->>'readId')::uuid END AS read_id
        FROM activity a
        JOIN users au ON au.id = a.actor_id AND au.deleted_at IS NULL
        LEFT JOIN popular_exposures e ON e.activity_id = a.id
        WHERE a.visibility = 'public' AND a.verb IN ('reviewed', 'finished')
          AND a.created_at <= $2::timestamptz
          AND a.created_at > $3::timestamptz - make_interval(days => $4)
          AND COALESCE(e.served, 0) < $5
          
          
      ),
      scored AS (
        SELECT c.id, c.actor_id, c.work_id, c.created_at,
          (CASE WHEN c.verb = 'reviewed' THEN $6::float8
                WHEN c.rated THEN $7::float8 ELSE 0.7::float8 END)
          * power(0.5::float8, (extract(epoch FROM ($8::timestamptz - c.created_at)) / $9)::float8)
          * (1 + ln(1 + COALESCE(lk.n, 0) + 2 * COALESCE(cm.n, 0))::float8) AS base
        FROM cand c
        LEFT JOIN LATERAL (
          SELECT count(*) AS n FROM read_likes l
          WHERE l.read_id = c.read_id AND l.created_at <= $10::timestamptz) lk ON true
        LEFT JOIN LATERAL (
          SELECT count(*) AS n FROM read_comments rc
          WHERE rc.read_id = c.read_id AND rc.created_at <= $11::timestamptz AND rc.deleted_at IS NULL) cm ON true
      ),
      ranked AS (
        SELECT s.id, s.created_at,
          round((s.base
            * power(0.5::float8, greatest(row_number() OVER (PARTITION BY s.actor_id ORDER BY s.base DESC, s.created_at DESC, s.id DESC) - 2, 0))
            * power(0.5::float8, greatest(row_number() OVER (PARTITION BY s.work_id ORDER BY s.base DESC, s.created_at DESC, s.id DESC) - 3, 0))
          )::numeric, 12) AS score
        FROM scored s
      )
      SELECT id, score::text AS score,
        to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us
      FROM ranked
      
      ORDER BY score DESC, created_at DESC, id DESC
      LIMIT $12

```
Limit  (cost=30.67..30.67 rows=1 width=88) (actual time=0.106..0.107 rows=0.00 loops=1)
  Buffers: shared hit=7
  ->  Sort  (cost=30.67..30.67 rows=1 width=88) (actual time=0.105..0.106 rows=0.00 loops=1)
        Sort Key: ((ranked.score)::text) DESC, ranked.created_at DESC, ranked.id DESC
        Sort Method: quicksort  Memory: 25kB
        Buffers: shared hit=7
        ->  Subquery Scan on ranked  (cost=30.49..30.66 rows=1 width=88) (actual time=0.091..0.093 rows=0.00 loops=1)
              Buffers: shared hit=7
              ->  WindowAgg  (cost=30.49..30.64 rows=1 width=96) (actual time=0.091..0.092 rows=0.00 loops=1)
                    Window: w2 AS (PARTITION BY a.actor_id ORDER BY (((CASE WHEN (a.verb = 'reviewed'::text) THEN '1'::double precision WHEN ((a.verb = 'finished'::text) AND (a.metadata ? 'rating'::text) AND ((a.metadata -> 'rating'::text) <> 'null'::jsonb)) THEN '0.9'::double precision ELSE '0.7'::double precision END * power('0.5'::double precision, ((EXTRACT(epoch FROM ('2026-10-11 08:24:00.289+00'::timestamp with time zone - a.created_at)) / '259200'::numeric))::double precision)) * ('1'::double precision + ln((((1 + COALESCE((count(*)), '0'::bigint)) + (2 * COALESCE((count(*)), '0'::bigint))))::double precision)))), a.created_at, a.id ROWS UNBOUNDED PRECEDING)
                    Buffers: shared hit=7
                    ->  Sort  (cost=30.49..30.49 rows=1 width=185) (actual time=0.090..0.091 rows=0.00 loops=1)
                          Sort Key: a.actor_id, (((CASE WHEN (a.verb = 'reviewed'::text) THEN '1'::double precision WHEN ((a.verb = 'finished'::text) AND (a.metadata ? 'rating'::text) AND ((a.metadata -> 'rating'::text) <> 'null'::jsonb)) THEN '0.9'::double precision ELSE '0.7'::double precision END * power('0.5'::double precision, ((EXTRACT(epoch FROM ('2026-10-11 08:24:00.289+00'::timestamp with time zone - a.created_at)) / '259200'::numeric))::double precision)) * ('1'::double precision + ln((((1 + COALESCE((count(*)), '0'::bigint)) + (2 * COALESCE((count(*)), '0'::bigint))))::double precision)))) DESC, a.created_at DESC, a.id DESC
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=7
                          ->  WindowAgg  (cost=30.41..30.48 rows=1 width=185) (actual time=0.071..0.072 rows=0.00 loops=1)
                                Window: w1 AS (PARTITION BY a.work_id ORDER BY (((CASE WHEN (a.verb = 'reviewed'::text) THEN '1'::double precision WHEN ((a.verb = 'finished'::text) AND (a.metadata ? 'rating'::text) AND ((a.metadata -> 'rating'::text) <> 'null'::jsonb)) THEN '0.9'::double precision ELSE '0.7'::double precision END * power('0.5'::double precision, ((EXTRACT(epoch FROM ('2026-10-11 08:24:00.289+00'::timestamp with time zone - a.created_at)) / '259200'::numeric))::double precision)) * ('1'::double precision + ln((((1 + COALESCE((count(*)), '0'::bigint)) + (2 * COALESCE((count(*)), '0'::bigint))))::double precision)))), a.created_at, a.id ROWS UNBOUNDED PRECEDING)
                                Buffers: shared hit=7
                                ->  Sort  (cost=30.41..30.41 rows=1 width=177) (actual time=0.070..0.071 rows=0.00 loops=1)
                                      Sort Key: a.work_id, (((CASE WHEN (a.verb = 'reviewed'::text) THEN '1'::double precision WHEN ((a.verb = 'finished'::text) AND (a.metadata ? 'rating'::text) AND ((a.metadata -> 'rating'::text) <> 'null'::jsonb)) THEN '0.9'::double precision ELSE '0.7'::double precision END * power('0.5'::double precision, ((EXTRACT(epoch FROM ('2026-10-11 08:24:00.289+00'::timestamp with time zone - a.created_at)) / '259200'::numeric))::double precision)) * ('1'::double precision + ln((((1 + COALESCE((count(*)), '0'::bigint)) + (2 * COALESCE((count(*)), '0'::bigint))))::double precision)))) DESC, a.created_at DESC, a.id DESC
                                      Sort Method: quicksort  Memory: 25kB
                                      Buffers: shared hit=7
                                      ->  Nested Loop Left Join  (cost=13.24..30.40 rows=1 width=177) (actual time=0.059..0.060 rows=0.00 loops=1)
                                            Buffers: shared hit=7
                                            ->  Nested Loop Left Join  (cost=4.92..22.01 rows=1 width=184) (actual time=0.059..0.060 rows=0.00 loops=1)
                                                  Buffers: shared hit=7
                                                  ->  Nested Loop Left Join  (cost=0.57..17.64 rows=1 width=176) (actual time=0.059..0.059 rows=0.00 loops=1)
                                                        Join Filter: (e.activity_id = a.id)
                                                        Filter: (COALESCE(e.served, 0) < 1000)
                                                        Rows Removed by Filter: 1
                                                        Buffers: shared hit=7
                                                        ->  Nested Loop  (cost=0.57..16.61 rows=1 width=176) (actual time=0.050..0.051 rows=1.00 loops=1)
                                                              Buffers: shared hit=6
                                                              ->  Index Scan using activity_popular_idx on activity a  (cost=0.29..8.31 rows=1 width=176) (actual time=0.021..0.022 rows=1.00 loops=1)
                                                                    Index Cond: ((created_at <= '2026-10-11 08:24:00.289+00'::timestamp with time zone) AND (created_at > ('2026-10-11 08:24:00.289+00'::timestamp with time zone - '14 days'::interval)))
                                                                    Index Searches: 1
                                                                    Buffers: shared hit=3
                                                              ->  Index Scan using users_pkey on users au  (cost=0.28..8.30 rows=1 width=16) (actual time=0.027..0.027 rows=1.00 loops=1)
                                                                    Index Cond: (id = a.actor_id)
                                                                    Filter: (deleted_at IS NULL)
                                                                    Index Searches: 1
                                                                    Buffers: shared hit=3
                                                        ->  Seq Scan on popular_exposures e  (cost=0.00..1.01 rows=1 width=20) (actual time=0.006..0.006 rows=1.00 loops=1)
                                                              Buffers: shared hit=1
                                                  ->  Aggregate  (cost=4.35..4.36 rows=1 width=8) (never executed)
                                                        ->  Index Only Scan using read_likes_read_created_idx on read_likes l  (cost=0.31..4.35 rows=2 width=0) (never executed)
                                                              Index Cond: ((read_id = CASE WHEN (a.object_type = 'read'::text) THEN a.object_id WHEN ((a.object_type = 'review'::text) AND ((a.metadata ->> 'readId'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)) THEN ((a.metadata ->> 'readId'::text))::uuid ELSE NULL::uuid END) AND (created_at <= '2026-10-11 08:24:00.289+00'::timestamp with time zone))
                                                              Heap Fetches: 0
                                                              Index Searches: 0
                                            ->  Aggregate  (cost=8.32..8.33 rows=1 width=8) (never executed)
                                                  ->  Index Scan using read_comments_read_idx on read_comments rc  (cost=0.30..8.32 rows=1 width=0) (never executed)
                                                        Index Cond: ((read_id = CASE WHEN (a.object_type = 'read'::text) THEN a.object_id WHEN ((a.object_type = 'review'::text) AND ((a.metadata ->> 'readId'::text) ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'::text)) THEN ((a.metadata ->> 'readId'::text))::uuid ELSE NULL::uuid END) AND (created_at <= '2026-10-11 08:24:00.289+00'::timestamp with time zone))
                                                        Filter: (deleted_at IS NULL)
                                                        Index Searches: 0
Planning:
  Buffers: shared hit=15
Planning Time: 1.397 ms
Execution Time: 0.314 ms
```

