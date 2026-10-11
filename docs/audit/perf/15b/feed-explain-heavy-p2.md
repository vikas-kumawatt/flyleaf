# GET /v1/feed?tab=friends&limit=20&cursor=eyJ0IjoiMjAyNi0wOS0yNFQxMzozOToxOC43NzcwMDBaIiwiaSI6ImZhZWUwNGU5LTNjMzEtNDAxMS05ZjIwLWY2MmRlMjVhZTU2MyIsImQiOlsiZmU2ZmVkZTQtMmRlMi00NjZmLWI3NDgtM2Q4OTk4OGExZmQ1IiwiZmU0YzdiN2EtMGEzMy00MDkwLWFlMTAtZWJmYzhiYmExZTc2IiwiZmUzNzAxMTMtOGE2Ni00NzlkLWJhNDItZTdlN2I5NDc2Y2EyIiwiZmNlY2YzMzgtMmQwZi00OWU2LWEzMjEtMThiYzZhNDVkZDMwIiwiZmNhMGViMzEtNTkzZS00MWUzLTk2OTItNTZlZmU2NjIxMGIwIl0sInMiOiJmIn0 as heavy: 200, 20 items, 95.2 ms, 5 statements

## Statement 1

SELECT COUNT(*)::int AS count
      FROM follows f
      JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
      WHERE f.follower_id = $1::uuid AND f.state = 'accepted'

```
Aggregate  (cost=194.10..194.11 rows=1 width=4) (actual time=0.856..0.857 rows=1.00 loops=1)
  Buffers: shared hit=94
  ->  Hash Join  (cost=71.28..191.19 rows=1162 width=0) (actual time=0.268..0.811 rows=1158.00 loops=1)
        Hash Cond: (u.id = f.followee_id)
        Buffers: shared hit=94
        ->  Seq Scan on users u  (cost=0.00..112.02 rows=3002 width=16) (actual time=0.007..0.289 rows=3002.00 loops=1)
              Filter: (deleted_at IS NULL)
              Buffers: shared hit=82
        ->  Hash  (cost=56.76..56.76 rows=1162 width=16) (actual time=0.258..0.258 rows=1158.00 loops=1)
              Buckets: 2048  Batches: 1  Memory Usage: 71kB
              Buffers: shared hit=12
              ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..56.76 rows=1162 width=16) (actual time=0.023..0.111 rows=1158.00 loops=1)
                    Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                    Heap Fetches: 0
                    Index Searches: 1
                    Buffers: shared hit=12
Planning:
  Buffers: shared hit=13
Planning Time: 0.387 ms
Execution Time: 0.897 ms
```

## Statement 2

SELECT
      a.id, a.actor_id, a.verb, a.work_id, a.object_type, a.object_id, a.metadata, a.visibility, a.created_at,
      to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us,
      p.username AS actor_username,
      p.display_name AS actor_display_name,
      p.avatar_key AS actor_avatar_key,
      w.title AS work_title,
      w.ol_cover_id AS work_cover_id,
      (
        SELECT auth.name
        FROM work_authors wa
        JOIN authors auth ON auth.id = wa.author_id
        WHERE wa.work_id = a.work_id
        ORDER BY wa.position ASC
        LIMIT 1
      ) AS author_name,
      tp.username AS target_username,
      tp.display_name AS target_display_name
    FROM (
      SELECT a.*
      FROM activity a
      -- Deleted accounts are hidden platform-wide (PRD §25.4, Audit 05).
      JOIN users au ON au.id = a.actor_id AND au.deleted_at IS NULL
      WHERE EXISTS (
      SELECT 1 FROM follows f
      WHERE f.followee_id = a.actor_id AND f.follower_id = $1::uuid AND f.state = 'accepted')
    AND a.visibility IN ('public', 'followers')
    AND a.created_at > now() - make_interval(days => $2)
    AND NOT EXISTS (
      SELECT 1 FROM blocks b
      WHERE (b.blocker_id = $3::uuid AND b.blocked_id = a.actor_id)
         OR (b.blocker_id = a.actor_id AND b.blocked_id = $4::uuid)
    )
    AND NOT EXISTS (
      SELECT 1 FROM mutes m
      WHERE m.user_id = $5::uuid
        AND (
          (m.target_type = 'user' AND m.target_id = a.actor_id)
          OR (m.target_type = 'work' AND a.work_id IS NOT NULL AND m.target_id = a.work_id)
        )
    )
    AND (a.verb <> 'followed' OR a.object_id IS NULL OR (
    EXISTS (SELECT 1 FROM users tu WHERE tu.id = a.object_id AND tu.deleted_at IS NULL)
    
    AND NOT EXISTS (
      SELECT 1 FROM blocks tb
      WHERE (tb.blocker_id = $6::uuid AND tb.blocked_id = a.object_id)
         OR (tb.blocker_id = a.object_id AND tb.blocked_id = $7::uuid))
    AND NOT EXISTS (
      SELECT 1 FROM mutes tm
      WHERE tm.user_id = $8::uuid AND tm.target_type = 'user' AND tm.target_id = a.object_id))) AND a.id IN ($9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::uuid)
      ORDER BY a.created_at DESC, a.id DESC
      
    ) a
    JOIN profiles p ON p.user_id = a.actor_id
    LEFT JOIN works w ON w.id = a.work_id
    LEFT JOIN profiles tp ON a.verb = 'followed' AND a.object_type = 'user' AND tp.user_id = a.object_id
    ORDER BY a.created_at DESC, a.id DESC

```
Nested Loop Left Join  (cost=175.69..229.10 rows=1 width=353) (actual time=0.446..0.521 rows=5.00 loops=1)
  Join Filter: ((a.verb = 'followed'::text) AND (a.object_type = 'user'::text))
  Buffers: shared hit=165
  ->  Nested Loop Left Join  (cost=175.41..191.45 rows=1 width=266) (actual time=0.365..0.393 rows=5.00 loops=1)
        Buffers: shared hit=111
        ->  Nested Loop  (cost=174.99..183.01 rows=1 width=238) (actual time=0.350..0.363 rows=5.00 loops=1)
              Buffers: shared hit=91
              ->  Sort  (cost=174.71..174.71 rows=1 width=183) (actual time=0.297..0.299 rows=5.00 loops=1)
                    Sort Key: a.created_at DESC, a.id DESC
                    Sort Method: quicksort  Memory: 25kB
                    Buffers: shared hit=76
                    ->  Nested Loop Anti Join  (cost=1.12..174.70 rows=1 width=183) (actual time=0.138..0.287 rows=5.00 loops=1)
                          Join Filter: (((m.target_type = 'user'::text) AND (m.target_id = a.actor_id)) OR ((m.target_type = 'work'::text) AND (a.work_id IS NOT NULL) AND (m.target_id = a.work_id)))
                          Rows Removed by Join Filter: 65
                          Buffers: shared hit=76
                          ->  Nested Loop Anti Join  (cost=1.12..166.25 rows=1 width=183) (actual time=0.113..0.209 rows=5.00 loops=1)
                                Join Filter: (((b.blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (b.blocked_id = a.actor_id)) OR ((b.blocker_id = a.actor_id) AND (b.blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                Buffers: shared hit=61
                                ->  Nested Loop  (cost=1.12..161.96 rows=1 width=183) (actual time=0.101..0.168 rows=5.00 loops=1)
                                      Join Filter: (au.id = a.actor_id)
                                      Buffers: shared hit=51
                                      ->  Nested Loop  (cost=0.84..161.30 rows=1 width=199) (actual time=0.087..0.144 rows=5.00 loops=1)
                                            Buffers: shared hit=36
                                            ->  Index Scan using activity_pkey on activity a  (cost=0.42..146.20 rows=3 width=183) (actual time=0.057..0.074 rows=5.00 loops=1)
                                                  Index Cond: (id = ANY ('{fe6fede4-2de2-466f-b748-3d89988a1fd5,fe4c7b7a-0a33-4090-ae10-ebfc8bba1e76,fe370113-8a66-479d-ba42-e7e7b9476ca2,fcecf338-2d0f-49e6-a321-18bc6a45dd30,fca0eb31-593e-41e3-9692-56efe66210b0}'::uuid[]))
                                                  Filter: ((visibility = ANY ('{public,followers}'::text[])) AND (created_at > (now() - '180 days'::interval)) AND ((verb <> 'followed'::text) OR (object_id IS NULL) OR (EXISTS(SubPlan 2) AND (NOT EXISTS(SubPlan 4)) AND (NOT (ANY (object_id = (hashed SubPlan 6).col1))))))
                                                  Index Searches: 4
                                                  Buffers: shared hit=19
                                                  SubPlan 2
                                                    ->  Index Scan using users_pkey on users tu  (cost=0.28..8.30 rows=1 width=0) (never executed)
                                                          Index Cond: (id = a.object_id)
                                                          Filter: (deleted_at IS NULL)
                                                          Index Searches: 0
                                                  SubPlan 4
                                                    ->  Seq Scan on blocks tb  (cost=0.00..5.00 rows=1 width=0) (never executed)
                                                          Filter: (((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (blocked_id = a.object_id)) OR ((blocker_id = a.object_id) AND (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                                  SubPlan 6
                                                    ->  Seq Scan on mutes tm  (cost=0.00..7.50 rows=8 width=16) (never executed)
                                                          Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (target_type = 'user'::text))
                                            ->  Index Only Scan using follows_followee_list_idx on follows f  (cost=0.42..5.03 rows=1 width=16) (actual time=0.013..0.013 rows=1.00 loops=5)
                                                  Index Cond: ((followee_id = a.actor_id) AND (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                                  Heap Fetches: 0
                                                  Index Searches: 5
                                                  Buffers: shared hit=17
                                      ->  Index Scan using users_pkey on users au  (cost=0.28..0.65 rows=1 width=16) (actual time=0.004..0.004 rows=1.00 loops=5)
                                            Index Cond: (id = f.followee_id)
                                            Filter: (deleted_at IS NULL)
                                            Index Searches: 5
                                            Buffers: shared hit=15
                                ->  Seq Scan on blocks b  (cost=0.00..4.25 rows=2 width=32) (actual time=0.007..0.007 rows=0.00 loops=5)
                                      Filter: ((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                      Rows Removed by Filter: 150
                                      Buffers: shared hit=10
                          ->  Seq Scan on mutes m  (cost=0.00..8.25 rows=10 width=21) (actual time=0.003..0.013 rows=13.00 loops=5)
                                Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND ((target_type = 'user'::text) OR (target_type = 'work'::text)))
                                Rows Removed by Filter: 287
                                Buffers: shared hit=15
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..8.30 rows=1 width=71) (actual time=0.012..0.012 rows=1.00 loops=5)
                    Index Cond: (user_id = a.actor_id)
                    Index Searches: 5
                    Buffers: shared hit=15
        ->  Index Scan using works_pkey on works w  (cost=0.42..8.44 rows=1 width=44) (actual time=0.005..0.005 rows=1.00 loops=5)
              Index Cond: (id = a.work_id)
              Index Searches: 5
              Buffers: shared hit=20
  ->  Index Scan using profiles_pkey on profiles tp  (cost=0.28..8.30 rows=1 width=39) (actual time=0.003..0.003 rows=0.00 loops=5)
        Index Cond: (user_id = a.object_id)
        Index Searches: 5
        Buffers: shared hit=10
  SubPlan 1
    ->  Limit  (cost=29.33..29.33 rows=1 width=19) (actual time=0.019..0.019 rows=1.00 loops=5)
          Buffers: shared hit=44
          ->  Sort  (cost=29.33..29.34 rows=2 width=19) (actual time=0.019..0.019 rows=1.00 loops=5)
                Sort Key: wa."position"
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=44
                ->  Nested Loop  (cost=0.84..29.32 rows=2 width=19) (actual time=0.015..0.016 rows=1.20 loops=5)
                      Buffers: shared hit=44
                      ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.42..12.45 rows=2 width=20) (actual time=0.005..0.005 rows=1.20 loops=5)
                            Index Cond: (work_id = a.work_id)
                            Index Searches: 5
                            Buffers: shared hit=20
                      ->  Index Scan using authors_pkey on authors auth  (cost=0.42..8.44 rows=1 width=31) (actual time=0.009..0.009 rows=1.00 loops=6)
                            Index Cond: (id = wa.author_id)
                            Index Searches: 6
                            Buffers: shared hit=24
Planning:
  Buffers: shared hit=81
Planning Time: 2.384 ms
Execution Time: 0.807 ms
```

## Statement 3

SELECT
      a.id, a.actor_id, a.verb, a.work_id, a.object_type, a.object_id, a.metadata, a.visibility, a.created_at,
      to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_us,
      p.username AS actor_username,
      p.display_name AS actor_display_name,
      p.avatar_key AS actor_avatar_key,
      w.title AS work_title,
      w.ol_cover_id AS work_cover_id,
      (
        SELECT auth.name
        FROM work_authors wa
        JOIN authors auth ON auth.id = wa.author_id
        WHERE wa.work_id = a.work_id
        ORDER BY wa.position ASC
        LIMIT 1
      ) AS author_name,
      tp.username AS target_username,
      tp.display_name AS target_display_name
    FROM (
      SELECT a.*
      FROM activity a
      -- Deleted accounts are hidden platform-wide (PRD §25.4, Audit 05).
      JOIN users au ON au.id = a.actor_id AND au.deleted_at IS NULL
      WHERE EXISTS (
      SELECT 1 FROM follows f
      WHERE f.followee_id = a.actor_id AND f.follower_id = $1::uuid AND f.state = 'accepted')
    AND a.visibility IN ('public', 'followers')
    AND a.created_at > now() - make_interval(days => $2)
    AND NOT EXISTS (
      SELECT 1 FROM blocks b
      WHERE (b.blocker_id = $3::uuid AND b.blocked_id = a.actor_id)
         OR (b.blocker_id = a.actor_id AND b.blocked_id = $4::uuid)
    )
    AND NOT EXISTS (
      SELECT 1 FROM mutes m
      WHERE m.user_id = $5::uuid
        AND (
          (m.target_type = 'user' AND m.target_id = a.actor_id)
          OR (m.target_type = 'work' AND a.work_id IS NOT NULL AND m.target_id = a.work_id)
        )
    )
    AND (a.verb <> 'followed' OR a.object_id IS NULL OR (
    EXISTS (SELECT 1 FROM users tu WHERE tu.id = a.object_id AND tu.deleted_at IS NULL)
    
    AND NOT EXISTS (
      SELECT 1 FROM blocks tb
      WHERE (tb.blocker_id = $6::uuid AND tb.blocked_id = a.object_id)
         OR (tb.blocker_id = a.object_id AND tb.blocked_id = $7::uuid))
    AND NOT EXISTS (
      SELECT 1 FROM mutes tm
      WHERE tm.user_id = $8::uuid AND tm.target_type = 'user' AND tm.target_id = a.object_id))) AND (a.created_at, a.id) < ($9::timestamptz, $10::uuid) AND a.created_at >= $11::timestamptz
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $12
    ) a
    JOIN profiles p ON p.user_id = a.actor_id
    LEFT JOIN works w ON w.id = a.work_id
    LEFT JOIN profiles tp ON a.verb = 'followed' AND a.object_type = 'user' AND tp.user_id = a.object_id
    ORDER BY a.created_at DESC, a.id DESC

```
Nested Loop Left Join  (cost=50135.40..53040.20 rows=61 width=353) (actual time=18.245..19.319 rows=61.00 loops=1)
  Join Filter: ((a.verb = 'followed'::text) AND (a.object_type = 'user'::text))
  Buffers: shared hit=12575
  ->  Nested Loop Left Join  (cost=50135.12..50947.41 rows=61 width=266) (actual time=18.115..18.526 rows=61.00 loops=1)
        Buffers: shared hit=11949
        ->  Nested Loop  (cost=50134.70..50436.72 rows=61 width=238) (actual time=18.090..18.243 rows=61.00 loops=1)
              Buffers: shared hit=11705
              ->  Limit  (cost=50134.42..50134.57 rows=61 width=183) (actual time=18.061..18.074 rows=61.00 loops=1)
                    Buffers: shared hit=11522
                    ->  Sort  (cost=50134.42..50137.54 rows=1248 width=183) (actual time=18.061..18.068 rows=61.00 loops=1)
                          Sort Key: a.created_at DESC, a.id DESC
                          Sort Method: top-N heapsort  Memory: 52kB
                          Buffers: shared hit=11522
                          ->  Nested Loop Anti Join  (cost=1.14..50091.17 rows=1248 width=183) (actual time=0.140..17.260 rows=1780.00 loops=1)
                                Join Filter: (((b.blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (b.blocked_id = a.actor_id)) OR ((b.blocker_id = a.actor_id) AND (b.blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                Buffers: shared hit=11522
                                ->  Nested Loop Anti Join  (cost=1.14..50030.75 rows=1248 width=183) (actual time=0.126..16.900 rows=1780.00 loops=1)
                                      Join Filter: (((m.target_type = 'user'::text) AND (m.target_id = a.actor_id)) OR ((m.target_type = 'work'::text) AND (a.work_id IS NOT NULL) AND (m.target_id = a.work_id)))
                                      Rows Removed by Join Filter: 24542
                                      Buffers: shared hit=11520
                                      ->  Nested Loop  (cost=1.14..49741.11 rows=1251 width=183) (actual time=0.091..12.570 rows=1933.00 loops=1)
                                            Buffers: shared hit=11517
                                            ->  Nested Loop  (cost=0.85..49170.31 rows=1351 width=199) (actual time=0.079..9.524 rows=1933.00 loops=1)
                                                  Buffers: shared hit=5718
                                                  ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..56.76 rows=1162 width=16) (actual time=0.027..0.210 rows=1158.00 loops=1)
                                                        Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                                        Heap Fetches: 0
                                                        Index Searches: 1
                                                        Buffers: shared hit=12
                                                  ->  Memoize  (cost=0.43..50.92 rows=1 width=183) (actual time=0.005..0.008 rows=1.67 loops=1158)
                                                        Cache Key: f.followee_id
                                                        Cache Mode: logical
                                                        Hits: 0  Misses: 1158  Evictions: 0  Overflows: 0  Memory Usage: 523kB
                                                        Buffers: shared hit=5706
                                                        ->  Index Scan using activity_actor_idx on activity a  (cost=0.42..50.91 rows=1 width=183) (actual time=0.004..0.006 rows=1.67 loops=1158)
                                                              Index Cond: ((actor_id = f.followee_id) AND (created_at > (now() - '180 days'::interval)) AND (created_at <= '2026-09-24 13:39:18.777+00'::timestamp with time zone) AND (created_at >= '2026-09-23 13:39:18.777+00'::timestamp with time zone))
                                                              Filter: ((visibility = ANY ('{public,followers}'::text[])) AND (ROW(created_at, id) < ROW('2026-09-24 13:39:18.777+00'::timestamp with time zone, 'faee04e9-3c31-4011-9f20-f62de25ae563'::uuid)) AND ((verb <> 'followed'::text) OR (object_id IS NULL) OR (EXISTS(SubPlan 2) AND (NOT EXISTS(SubPlan 4)) AND (NOT (ANY (object_id = (hashed SubPlan 6).col1))))))
                                                              Rows Removed by Filter: 0
                                                              Index Searches: 1158
                                                              Buffers: shared hit=5706
                                                              SubPlan 2
                                                                ->  Index Scan using users_pkey on users tu  (cost=0.28..8.30 rows=1 width=0) (actual time=0.001..0.001 rows=1.00 loops=143)
                                                                      Index Cond: (id = a.object_id)
                                                                      Filter: (deleted_at IS NULL)
                                                                      Index Searches: 143
                                                                      Buffers: shared hit=429
                                                              SubPlan 4
                                                                ->  Seq Scan on blocks tb  (cost=0.00..5.00 rows=1 width=0) (actual time=0.009..0.009 rows=0.00 loops=143)
                                                                      Filter: (((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (blocked_id = a.object_id)) OR ((blocker_id = a.object_id) AND (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                                                      Rows Removed by Filter: 150
                                                                      Buffers: shared hit=286
                                                              SubPlan 6
                                                                ->  Seq Scan on mutes tm  (cost=0.00..7.50 rows=8 width=16) (actual time=0.004..0.014 rows=8.00 loops=1)
                                                                      Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (target_type = 'user'::text))
                                                                      Rows Removed by Filter: 292
                                                                      Buffers: shared hit=3
                                            ->  Index Scan using users_pkey on users au  (cost=0.28..0.42 rows=1 width=16) (actual time=0.001..0.001 rows=1.00 loops=1933)
                                                  Index Cond: (id = a.actor_id)
                                                  Filter: (deleted_at IS NULL)
                                                  Index Searches: 1933
                                                  Buffers: shared hit=5799
                                      ->  Materialize  (cost=0.00..8.30 rows=10 width=21) (actual time=0.000..0.001 rows=12.78 loops=1933)
                                            Storage: Memory  Maximum Storage: 17kB
                                            Buffers: shared hit=3
                                            ->  Seq Scan on mutes m  (cost=0.00..8.25 rows=10 width=21) (actual time=0.006..0.018 rows=13.00 loops=1)
                                                  Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND ((target_type = 'user'::text) OR (target_type = 'work'::text)))
                                                  Rows Removed by Filter: 287
                                                  Buffers: shared hit=3
                                ->  Materialize  (cost=0.00..4.26 rows=2 width=32) (actual time=0.000..0.000 rows=0.00 loops=1780)
                                      Storage: Memory  Maximum Storage: 17kB
                                      Buffers: shared hit=2
                                      ->  Seq Scan on blocks b  (cost=0.00..4.25 rows=2 width=32) (actual time=0.010..0.010 rows=0.00 loops=1)
                                            Filter: ((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                            Rows Removed by Filter: 150
                                            Buffers: shared hit=2
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..4.95 rows=1 width=71) (actual time=0.002..0.002 rows=1.00 loops=61)
                    Index Cond: (user_id = a.actor_id)
                    Index Searches: 61
                    Buffers: shared hit=183
        ->  Index Scan using works_pkey on works w  (cost=0.42..8.37 rows=1 width=44) (actual time=0.004..0.004 rows=1.00 loops=61)
              Index Cond: (id = a.work_id)
              Index Searches: 61
              Buffers: shared hit=244
  ->  Index Scan using profiles_pkey on profiles tp  (cost=0.28..4.95 rows=1 width=39) (actual time=0.002..0.002 rows=0.00 loops=61)
        Index Cond: (user_id = a.object_id)
        Index Searches: 61
        Buffers: shared hit=122
  SubPlan 1
    ->  Limit  (cost=29.33..29.33 rows=1 width=19) (actual time=0.010..0.010 rows=1.00 loops=61)
          Buffers: shared hit=504
          ->  Sort  (cost=29.33..29.34 rows=2 width=19) (actual time=0.009..0.009 rows=1.00 loops=61)
                Sort Key: wa."position"
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=504
                ->  Nested Loop  (cost=0.84..29.32 rows=2 width=19) (actual time=0.008..0.008 rows=1.07 loops=61)
                      Buffers: shared hit=504
                      ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.42..12.45 rows=2 width=20) (actual time=0.004..0.004 rows=1.07 loops=61)
                            Index Cond: (work_id = a.work_id)
                            Index Searches: 61
                            Buffers: shared hit=244
                      ->  Index Scan using authors_pkey on authors auth  (cost=0.42..8.44 rows=1 width=31) (actual time=0.003..0.003 rows=1.00 loops=65)
                            Index Cond: (id = wa.author_id)
                            Index Searches: 65
                            Buffers: shared hit=260
Planning:
  Buffers: shared hit=81
Planning Time: 2.053 ms
Execution Time: 19.771 ms
```

## Statement 4

WITH actors(id) AS (VALUES ($1::uuid), ($2::uuid), ($3::uuid), ($4::uuid), ($5::uuid), ($6::uuid), ($7::uuid), ($8::uuid), ($9::uuid), ($10::uuid), ($11::uuid), ($12::uuid), ($13::uuid), ($14::uuid), ($15::uuid), ($16::uuid), ($17::uuid), ($18::uuid), ($19::uuid), ($20::uuid), ($21::uuid), ($22::uuid), ($23::uuid), ($24::uuid)),
      engaged AS (
        SELECT r.user_id AS actor_id, count(*)::int AS n
        FROM read_likes l JOIN reads r ON r.id = l.read_id
        WHERE l.user_id = $25::uuid AND l.created_at > now() - interval '90 days' AND r.user_id IN ($26::uuid, $27::uuid, $28::uuid, $29::uuid, $30::uuid, $31::uuid, $32::uuid, $33::uuid, $34::uuid, $35::uuid, $36::uuid, $37::uuid, $38::uuid, $39::uuid, $40::uuid, $41::uuid, $42::uuid, $43::uuid, $44::uuid, $45::uuid, $46::uuid, $47::uuid, $48::uuid, $49::uuid)
        GROUP BY r.user_id
        UNION ALL
        SELECT r.user_id, count(*)::int
        FROM read_comments c JOIN reads r ON r.id = c.read_id
        WHERE c.user_id = $50::uuid AND c.deleted_at IS NULL AND c.created_at > now() - interval '90 days'
          AND r.user_id IN ($51::uuid, $52::uuid, $53::uuid, $54::uuid, $55::uuid, $56::uuid, $57::uuid, $58::uuid, $59::uuid, $60::uuid, $61::uuid, $62::uuid, $63::uuid, $64::uuid, $65::uuid, $66::uuid, $67::uuid, $68::uuid, $69::uuid, $70::uuid, $71::uuid, $72::uuid, $73::uuid, $74::uuid)
        GROUP BY r.user_id
      )
      SELECT a.id AS actor_id,
        COALESCE((SELECT sum(e.n)::int FROM engaged e WHERE e.actor_id = a.id), 0) AS engagements,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = a.id AND f.followee_id = $75::uuid
                AND f.state = 'accepted') AS mutual
      FROM actors a

```
Values Scan on "*VALUES*"  (cost=0.00..5810.02 rows=24 width=21) (actual time=0.282..3.903 rows=24.00 loops=1)
  Buffers: shared hit=5993
  SubPlan 1
    ->  Aggregate  (cost=237.21..237.22 rows=1 width=4) (actual time=0.159..0.159 rows=1.00 loops=24)
          Buffers: shared hit=5988
          ->  Append  (cost=0.71..237.20 rows=2 width=4) (actual time=0.136..0.159 rows=0.38 loops=24)
                Buffers: shared hit=5988
                ->  Subquery Scan on "*SELECT* 1"  (cost=0.71..118.64 rows=1 width=4) (actual time=0.100..0.100 rows=0.33 loops=24)
                      Buffers: shared hit=3262
                      ->  GroupAggregate  (cost=0.71..118.63 rows=1 width=20) (actual time=0.100..0.100 rows=0.33 loops=24)
                            Buffers: shared hit=3262
                            ->  Nested Loop  (cost=0.71..118.61 rows=1 width=16) (actual time=0.081..0.099 rows=0.33 loops=24)
                                  Buffers: shared hit=3262
                                  ->  Index Scan using reads_user_visibility_idx on reads r  (cost=0.41..110.21 rows=1 width=32) (actual time=0.006..0.024 rows=38.79 loops=24)
                                        Index Cond: ((user_id = ANY ('{eb0a2381-1e39-43b7-9df2-bc170013e83d,7b731744-0b76-4ffb-bcb1-de075e1ea89c,5ad77475-4777-487c-985d-c30da8f29097,5047df7b-1f62-4f24-9086-35f2e498578f,f484eb30-af75-4b61-b025-b01a11ad7250,34f7b6d1-b115-4d39-bbea-2cc335c08b30,8db20c69-09f4-4c92-9642-6e336da99a6a,bf701fc0-f45f-4c76-9e3f-0a003ee1b3d0,a9f10a87-94ca-4cd0-9ffe-1777682013a3,c903278c-f8c4-44be-93c6-e01348667537,a6b79726-6e6f-4098-b7cf-d78e150c3f29,5e4f3c0b-6583-4ec3-87ed-7bc7a51aaba0,616f1b7e-8729-43bd-9742-dc51aa9e4755,93156b90-7419-43ac-b8a1-c5983f011ca3,8374bbda-4592-499c-9db4-7e5af4124c73,e6f51419-4ea8-4482-a0d4-692503574e90,044b0d59-a10e-46a1-bf56-5f9b027a59cb,1e77e840-f656-43ec-b813-4cd3a4e243da,85ae4585-f587-4c30-a4f8-2fd632d69016,7222ee24-88e4-4b90-935a-d3f6e45ae06a,21f21ad7-1cc8-440a-86ed-5a3f43419b29,6ca990b9-e276-4eca-90a1-9238071bffd4,91e46a6b-34a0-488d-8bc2-0c6297d12986,1a6d748d-9542-47ed-a343-e58e76175429}'::uuid[])) AND (user_id = "*VALUES*".column1))
                                        Index Searches: 24
                                        Buffers: shared hit=750
                                  ->  Index Scan using read_likes_read_created_idx on read_likes l  (cost=0.29..8.32 rows=1 width=16) (actual time=0.002..0.002 rows=0.01 loops=931)
                                        Index Cond: ((read_id = r.id) AND (created_at > (now() - '90 days'::interval)))
                                        Filter: (user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                        Rows Removed by Filter: 1
                                        Index Searches: 931
                                        Buffers: shared hit=2512
                ->  Subquery Scan on "*SELECT* 2"  (cost=0.70..118.55 rows=1 width=4) (actual time=0.058..0.058 rows=0.04 loops=24)
                      Buffers: shared hit=2726
                      ->  GroupAggregate  (cost=0.70..118.54 rows=1 width=20) (actual time=0.058..0.058 rows=0.04 loops=24)
                            Buffers: shared hit=2726
                            ->  Nested Loop  (cost=0.70..118.53 rows=1 width=16) (actual time=0.053..0.058 rows=0.04 loops=24)
                                  Buffers: shared hit=2726
                                  ->  Index Scan using reads_user_visibility_idx on reads r_1  (cost=0.41..110.21 rows=1 width=32) (actual time=0.004..0.011 rows=38.79 loops=24)
                                        Index Cond: ((user_id = ANY ('{eb0a2381-1e39-43b7-9df2-bc170013e83d,7b731744-0b76-4ffb-bcb1-de075e1ea89c,5ad77475-4777-487c-985d-c30da8f29097,5047df7b-1f62-4f24-9086-35f2e498578f,f484eb30-af75-4b61-b025-b01a11ad7250,34f7b6d1-b115-4d39-bbea-2cc335c08b30,8db20c69-09f4-4c92-9642-6e336da99a6a,bf701fc0-f45f-4c76-9e3f-0a003ee1b3d0,a9f10a87-94ca-4cd0-9ffe-1777682013a3,c903278c-f8c4-44be-93c6-e01348667537,a6b79726-6e6f-4098-b7cf-d78e150c3f29,5e4f3c0b-6583-4ec3-87ed-7bc7a51aaba0,616f1b7e-8729-43bd-9742-dc51aa9e4755,93156b90-7419-43ac-b8a1-c5983f011ca3,8374bbda-4592-499c-9db4-7e5af4124c73,e6f51419-4ea8-4482-a0d4-692503574e90,044b0d59-a10e-46a1-bf56-5f9b027a59cb,1e77e840-f656-43ec-b813-4cd3a4e243da,85ae4585-f587-4c30-a4f8-2fd632d69016,7222ee24-88e4-4b90-935a-d3f6e45ae06a,21f21ad7-1cc8-440a-86ed-5a3f43419b29,6ca990b9-e276-4eca-90a1-9238071bffd4,91e46a6b-34a0-488d-8bc2-0c6297d12986,1a6d748d-9542-47ed-a343-e58e76175429}'::uuid[])) AND (user_id = "*VALUES*".column1))
                                        Index Searches: 24
                                        Buffers: shared hit=750
                                  ->  Index Scan using read_comments_read_idx on read_comments c  (cost=0.29..8.31 rows=1 width=16) (actual time=0.001..0.001 rows=0.00 loops=931)
                                        Index Cond: ((read_id = r_1.id) AND (created_at > (now() - '90 days'::interval)))
                                        Filter: ((deleted_at IS NULL) AND (user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                        Rows Removed by Filter: 0
                                        Index Searches: 931
                                        Buffers: shared hit=1976
  SubPlan 3
    ->  Index Only Scan using follows_followee_list_idx on follows f  (cost=0.42..5.16 rows=42 width=16) (actual time=0.023..0.033 rows=141.00 loops=1)
          Index Cond: (followee_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
          Heap Fetches: 0
          Index Searches: 1
          Buffers: shared hit=5
Planning:
  Buffers: shared hit=28
Planning Time: 0.863 ms
Execution Time: 4.042 ms
```

## Statement 5

SELECT r.id, r.like_count, r.comment_count,
        EXISTS (SELECT 1 FROM read_likes l WHERE l.read_id = r.id AND l.user_id = $1::uuid) AS viewer_has_liked
      FROM reads r
      WHERE r.id IN ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14::uuid, $15::uuid, $16::uuid, $17::uuid, $18::uuid, $19::uuid, $20::uuid, $21::uuid)
        AND r.status IN ('finished', 'dnf')

```
Bitmap Heap Scan on reads r  (cost=88.50..223.68 rows=14 width=25) (actual time=0.073..0.124 rows=20.00 loops=1)
  Recheck Cond: (id = ANY ('{d3a18f11-05b1-4449-b290-61a26ef7001d,741c71a7-1a1f-4f5d-ab46-e60c080dacf0,8becf83a-cfac-48f1-8128-8ebc1bd72b90,a7ade173-b065-49ac-80e8-4d85c0883d3a,8f6b2826-4be2-4303-92a8-a979c715ffef,65ef368f-a9da-4249-90ff-35d33e623694,b735b3ab-5864-4ba1-8351-33c59fc32137,bb3eb35b-68e6-447f-90a7-47ad22471f71,ee8ab160-2edc-45d5-b5f0-94be9e23d057,3020517c-7886-45b6-bcfb-5a1374bc9d5c,358c79fe-4ff0-49dc-8961-280f2dbc3769,b270e13f-07a9-4f8d-b3ad-ab0d14965308,099b9cc8-c995-4a7b-93fb-e0eb9e944934,1e98e5c4-2870-4002-b0fa-a563164dc368,a5aee5bb-fb20-4504-bf7c-6d3f4ff96595,38d81de1-0ea0-4fcd-a96b-3812c71570be,da3d8a70-bb61-4739-9674-0adbaf199996,3cd979b2-6bdf-4368-a61f-bf4d26ed79d2,04a93cc8-41ee-4b1e-bf15-7742f7403e40,618a3033-24aa-47ad-85c9-af1e94534c9f}'::uuid[]))
  Filter: (status = ANY ('{finished,dnf}'::text[]))
  Heap Blocks: exact=20
  Buffers: shared hit=141
  ->  Bitmap Index Scan on reads_pkey  (cost=0.00..88.45 rows=20 width=0) (actual time=0.053..0.053 rows=20.00 loops=1)
        Index Cond: (id = ANY ('{d3a18f11-05b1-4449-b290-61a26ef7001d,741c71a7-1a1f-4f5d-ab46-e60c080dacf0,8becf83a-cfac-48f1-8128-8ebc1bd72b90,a7ade173-b065-49ac-80e8-4d85c0883d3a,8f6b2826-4be2-4303-92a8-a979c715ffef,65ef368f-a9da-4249-90ff-35d33e623694,b735b3ab-5864-4ba1-8351-33c59fc32137,bb3eb35b-68e6-447f-90a7-47ad22471f71,ee8ab160-2edc-45d5-b5f0-94be9e23d057,3020517c-7886-45b6-bcfb-5a1374bc9d5c,358c79fe-4ff0-49dc-8961-280f2dbc3769,b270e13f-07a9-4f8d-b3ad-ab0d14965308,099b9cc8-c995-4a7b-93fb-e0eb9e944934,1e98e5c4-2870-4002-b0fa-a563164dc368,a5aee5bb-fb20-4504-bf7c-6d3f4ff96595,38d81de1-0ea0-4fcd-a96b-3812c71570be,da3d8a70-bb61-4739-9674-0adbaf199996,3cd979b2-6bdf-4368-a61f-bf4d26ed79d2,04a93cc8-41ee-4b1e-bf15-7742f7403e40,618a3033-24aa-47ad-85c9-af1e94534c9f}'::uuid[]))
        Index Searches: 20
        Buffers: shared hit=60
  SubPlan 1
    ->  Index Only Scan using read_likes_pkey on read_likes l  (cost=0.41..4.43 rows=1 width=0) (actual time=0.002..0.002 rows=0.05 loops=20)
          Index Cond: ((read_id = r.id) AND (user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
          Heap Fetches: 0
          Index Searches: 20
          Buffers: shared hit=61
Planning Time: 0.138 ms
Execution Time: 0.165 ms
```

