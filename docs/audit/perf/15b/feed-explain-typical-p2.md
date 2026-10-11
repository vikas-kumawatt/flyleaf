# GET /v1/feed?tab=friends&limit=20&cursor=eyJ0IjoiMjAyNi0wOS0yNFQxMzozOToxOC43NzcwMDBaIiwiaSI6IjI0YmZlODgwLTk2YWUtNDlkYS05YzMyLWM2ZmQ1ZjQ5MDc2ZSIsImQiOlsiZjU5MDVhZGItZmQ4NS00YzcxLTk4YTEtZmRkMjdlMzBlZjA3IiwiZDM1ZGVjYjEtZTc5Yi00Mzk5LWI2ZjItOTBiZTM1ZjI3YmNmIiwiNGQ3ZDUxOWUtNzhmOS00ZjE4LTkwYjktMTlhMThhYzI4ZmZhIiwiNDRlNTIwODItMzJkOC00YzAxLThmNDctODY0NTBkNDMwMGFmIiwiMzE4NzI3MzUtM2FjMS00NjJmLWIyNGYtZDdjZDc5OGI4ODQ5Il0sInMiOiJmIn0 as typical: 200, 20 items, 124.3 ms, 5 statements

## Statement 1

SELECT COUNT(*)::int AS count
      FROM follows f
      JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
      WHERE f.follower_id = $1::uuid AND f.state = 'accepted'

```
Aggregate  (cost=125.99..126.00 rows=1 width=4) (actual time=1.067..1.069 rows=1.00 loops=1)
  Buffers: shared hit=87
  ->  Hash Join  (cost=5.95..125.86 rows=51 width=0) (actual time=0.120..1.060 rows=40.00 loops=1)
        Hash Cond: (u.id = f.followee_id)
        Buffers: shared hit=87
        ->  Seq Scan on users u  (cost=0.00..112.02 rows=3002 width=16) (actual time=0.013..0.589 rows=3002.00 loops=1)
              Filter: (deleted_at IS NULL)
              Buffers: shared hit=82
        ->  Hash  (cost=5.31..5.31 rows=51 width=16) (actual time=0.097..0.098 rows=40.00 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 10kB
              Buffers: shared hit=5
              ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..5.31 rows=51 width=16) (actual time=0.060..0.070 rows=40.00 loops=1)
                    Index Cond: (follower_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                    Heap Fetches: 0
                    Index Searches: 1
                    Buffers: shared hit=5
Planning:
  Buffers: shared hit=15
Planning Time: 0.509 ms
Execution Time: 1.141 ms
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
Nested Loop Left Join  (cost=236.76..290.18 rows=1 width=353) (actual time=0.610..0.712 rows=5.00 loops=1)
  Join Filter: ((a.verb = 'followed'::text) AND (a.object_type = 'user'::text))
  Buffers: shared hit=150
  ->  Nested Loop Left Join  (cost=236.48..252.53 rows=1 width=266) (actual time=0.488..0.527 rows=5.00 loops=1)
        Buffers: shared hit=100
        ->  Nested Loop  (cost=236.06..244.09 rows=1 width=238) (actual time=0.460..0.481 rows=5.00 loops=1)
              Buffers: shared hit=80
              ->  Sort  (cost=235.78..235.79 rows=1 width=183) (actual time=0.431..0.436 rows=5.00 loops=1)
                    Sort Key: a.created_at DESC, a.id DESC
                    Sort Method: quicksort  Memory: 26kB
                    Buffers: shared hit=65
                    ->  Nested Loop Anti Join  (cost=8.09..235.77 rows=1 width=183) (actual time=0.259..0.418 rows=5.00 loops=1)
                          Join Filter: (((m.target_type = 'user'::text) AND (m.target_id = a.actor_id)) OR ((m.target_type = 'work'::text) AND (a.work_id IS NOT NULL) AND (m.target_id = a.work_id)))
                          Buffers: shared hit=65
                          ->  Nested Loop Anti Join  (cost=8.09..227.50 rows=1 width=183) (actual time=0.220..0.288 rows=5.00 loops=1)
                                Buffers: shared hit=50
                                ->  Nested Loop  (cost=1.12..213.81 rows=1 width=183) (actual time=0.201..0.251 rows=5.00 loops=1)
                                      Join Filter: (au.id = a.actor_id)
                                      Buffers: shared hit=40
                                      ->  Nested Loop  (cost=0.84..207.62 rows=1 width=199) (actual time=0.175..0.206 rows=5.00 loops=1)
                                            Join Filter: (a.actor_id = f.followee_id)
                                            Rows Removed by Join Filter: 195
                                            Buffers: shared hit=25
                                            ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..5.31 rows=51 width=16) (actual time=0.043..0.053 rows=40.00 loops=1)
                                                  Index Cond: (follower_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                  Heap Fetches: 0
                                                  Index Searches: 1
                                                  Buffers: shared hit=5
                                            ->  Materialize  (cost=0.42..200.02 rows=3 width=183) (actual time=0.002..0.003 rows=5.00 loops=40)
                                                  Storage: Memory  Maximum Storage: 18kB
                                                  Buffers: shared hit=20
                                                  ->  Index Scan using activity_pkey on activity a  (cost=0.42..200.01 rows=3 width=183) (actual time=0.048..0.079 rows=5.00 loops=1)
                                                        Index Cond: (id = ANY ('{f5905adb-fd85-4c71-98a1-fdd27e30ef07,d35decb1-e79b-4399-b6f2-90be35f27bcf,4d7d519e-78f9-4f18-90b9-19a18ac28ffa,44e52082-32d8-4c01-8f47-86450d4300af,31872735-3ac1-462f-b24f-d7cd798b8849}'::uuid[]))
                                                        Filter: ((visibility = ANY ('{public,followers}'::text[])) AND (created_at > (now() - '180 days'::interval)) AND ((verb <> 'followed'::text) OR (object_id IS NULL) OR (EXISTS(SubPlan 2) AND (NOT EXISTS(SubPlan 4)) AND (NOT (ANY (object_id = (hashed SubPlan 6).col1))))))
                                                        Index Searches: 5
                                                        Buffers: shared hit=20
                                                        SubPlan 2
                                                          ->  Index Scan using users_pkey on users tu  (cost=0.28..8.30 rows=1 width=0) (never executed)
                                                                Index Cond: (id = a.object_id)
                                                                Filter: (deleted_at IS NULL)
                                                                Index Searches: 0
                                                        SubPlan 4
                                                          ->  Bitmap Heap Scan on blocks tb  (cost=8.31..15.00 rows=1 width=0) (never executed)
                                                                Recheck Cond: ((blocked_id = a.object_id) OR (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid))
                                                                Filter: (((blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (blocked_id = a.object_id)) OR ((blocker_id = a.object_id) AND (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)))
                                                                ->  BitmapOr  (cost=8.31..8.31 rows=2 width=0) (never executed)
                                                                      ->  Bitmap Index Scan on blocks_blocked_idx  (cost=0.00..4.15 rows=1 width=0) (never executed)
                                                                            Index Cond: (blocked_id = a.object_id)
                                                                            Index Searches: 0
                                                                      ->  Bitmap Index Scan on blocks_blocked_idx  (cost=0.00..4.15 rows=1 width=0) (never executed)
                                                                            Index Cond: (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                                            Index Searches: 0
                                                        SubPlan 6
                                                          ->  Seq Scan on mutes tm  (cost=0.00..7.50 rows=1 width=16) (never executed)
                                                                Filter: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (target_type = 'user'::text))
                                      ->  Index Scan using users_pkey on users au  (cost=0.28..6.18 rows=1 width=16) (actual time=0.008..0.008 rows=1.00 loops=5)
                                            Index Cond: (id = f.followee_id)
                                            Filter: (deleted_at IS NULL)
                                            Index Searches: 5
                                            Buffers: shared hit=15
                                ->  Bitmap Heap Scan on blocks b  (cost=6.97..13.68 rows=1 width=32) (actual time=0.006..0.006 rows=0.00 loops=5)
                                      Recheck Cond: ((blocked_id = a.actor_id) OR (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid))
                                      Filter: (((blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) OR (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)) AND (((blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (blocked_id = a.actor_id)) OR ((blocker_id = a.actor_id) AND (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid))))
                                      Buffers: shared hit=10
                                      ->  BitmapOr  (cost=6.97..6.97 rows=2 width=0) (actual time=0.003..0.003 rows=0.00 loops=5)
                                            Buffers: shared hit=10
                                            ->  Bitmap Index Scan on blocks_blocked_idx  (cost=0.00..2.82 rows=1 width=0) (actual time=0.002..0.002 rows=0.00 loops=5)
                                                  Index Cond: (blocked_id = a.actor_id)
                                                  Index Searches: 5
                                                  Buffers: shared hit=5
                                            ->  Bitmap Index Scan on blocks_blocked_idx  (cost=0.00..4.15 rows=1 width=0) (actual time=0.001..0.001 rows=0.00 loops=5)
                                                  Index Cond: (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                  Index Searches: 5
                                                  Buffers: shared hit=5
                          ->  Seq Scan on mutes m  (cost=0.00..8.25 rows=1 width=21) (actual time=0.025..0.025 rows=0.00 loops=5)
                                Filter: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND ((target_type = 'user'::text) OR (target_type = 'work'::text)))
                                Rows Removed by Filter: 300
                                Buffers: shared hit=15
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..8.30 rows=1 width=71) (actual time=0.008..0.008 rows=1.00 loops=5)
                    Index Cond: (user_id = a.actor_id)
                    Index Searches: 5
                    Buffers: shared hit=15
        ->  Index Scan using works_pkey on works w  (cost=0.42..8.44 rows=1 width=44) (actual time=0.008..0.008 rows=1.00 loops=5)
              Index Cond: (id = a.work_id)
              Index Searches: 5
              Buffers: shared hit=20
  ->  Index Scan using profiles_pkey on profiles tp  (cost=0.28..8.30 rows=1 width=39) (actual time=0.006..0.006 rows=0.00 loops=5)
        Index Cond: (user_id = a.object_id)
        Index Searches: 5
        Buffers: shared hit=10
  SubPlan 1
    ->  Limit  (cost=29.33..29.33 rows=1 width=19) (actual time=0.025..0.026 rows=1.00 loops=5)
          Buffers: shared hit=40
          ->  Sort  (cost=29.33..29.34 rows=2 width=19) (actual time=0.025..0.025 rows=1.00 loops=5)
                Sort Key: wa."position"
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=40
                ->  Nested Loop  (cost=0.84..29.32 rows=2 width=19) (actual time=0.020..0.020 rows=1.00 loops=5)
                      Buffers: shared hit=40
                      ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.42..12.45 rows=2 width=20) (actual time=0.011..0.012 rows=1.00 loops=5)
                            Index Cond: (work_id = a.work_id)
                            Index Searches: 5
                            Buffers: shared hit=20
                      ->  Index Scan using authors_pkey on authors auth  (cost=0.42..8.44 rows=1 width=31) (actual time=0.007..0.007 rows=1.00 loops=5)
                            Index Cond: (id = wa.author_id)
                            Index Searches: 5
                            Buffers: shared hit=20
Planning:
  Buffers: shared hit=85
Planning Time: 4.718 ms
Execution Time: 1.393 ms
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
      WHERE tm.user_id = $8::uuid AND tm.target_type = 'user' AND tm.target_id = a.object_id))) AND (a.created_at, a.id) < ($9::timestamptz, $10::uuid) 
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $11
    ) a
    JOIN profiles p ON p.user_id = a.actor_id
    LEFT JOIN works w ON w.id = a.work_id
    LEFT JOIN profiles tp ON a.verb = 'followed' AND a.object_type = 'user' AND tp.user_id = a.object_id
    ORDER BY a.created_at DESC, a.id DESC

```
Nested Loop Left Join  (cost=78219.68..81300.48 rows=61 width=353) (actual time=10.928..12.313 rows=61.00 loops=1)
  Join Filter: ((a.verb = 'followed'::text) AND (a.object_type = 'user'::text))
  Buffers: shared hit=4062
  ->  Nested Loop Left Join  (cost=78219.40..79119.69 rows=61 width=266) (actual time=10.826..11.334 rows=61.00 loops=1)
        Buffers: shared hit=3517
        ->  Nested Loop  (cost=78218.98..78609.00 rows=61 width=238) (actual time=10.790..10.998 rows=61.00 loops=1)
              Buffers: shared hit=3333
              ->  Limit  (cost=78218.70..78218.85 rows=61 width=183) (actual time=10.743..10.765 rows=61.00 loops=1)
                    Buffers: shared hit=3150
                    ->  Sort  (cost=78218.70..78222.57 rows=1550 width=183) (actual time=10.742..10.756 rows=61.00 loops=1)
                          Sort Key: a.created_at DESC, a.id DESC
                          Sort Method: top-N heapsort  Memory: 52kB
                          Buffers: shared hit=3150
                          ->  Nested Loop Anti Join  (cost=9.56..78164.99 rows=1550 width=183) (actual time=0.203..9.576 rows=1912.00 loops=1)
                                Join Filter: (((m.target_type = 'user'::text) AND (m.target_id = a.actor_id)) OR ((m.target_type = 'work'::text) AND (a.work_id IS NOT NULL) AND (m.target_id = a.work_id)))
                                Buffers: shared hit=3150
                                ->  Nested Loop Anti Join  (cost=9.56..78121.86 rows=1550 width=183) (actual time=0.153..8.827 rows=1912.00 loops=1)
                                      Join Filter: (((b.blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (b.blocked_id = a.actor_id)) OR ((b.blocker_id = a.actor_id) AND (b.blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)))
                                      Buffers: shared hit=3147
                                      ->  Nested Loop  (cost=1.12..78036.98 rows=1550 width=183) (actual time=0.103..8.059 rows=1912.00 loops=1)
                                            Buffers: shared hit=3144
                                            ->  Nested Loop  (cost=0.70..320.49 rows=51 width=32) (actual time=0.063..0.249 rows=40.00 loops=1)
                                                  Buffers: shared hit=125
                                                  ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..5.31 rows=51 width=16) (actual time=0.035..0.054 rows=40.00 loops=1)
                                                        Index Cond: (follower_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                        Heap Fetches: 0
                                                        Index Searches: 1
                                                        Buffers: shared hit=5
                                                  ->  Index Scan using users_pkey on users au  (cost=0.28..6.18 rows=1 width=16) (actual time=0.004..0.004 rows=1.00 loops=40)
                                                        Index Cond: (id = f.followee_id)
                                                        Filter: (deleted_at IS NULL)
                                                        Index Searches: 40
                                                        Buffers: shared hit=120
                                            ->  Index Scan using activity_actor_idx on activity a  (cost=0.42..1523.54 rows=31 width=183) (actual time=0.016..0.184 rows=47.80 loops=40)
                                                  Index Cond: ((actor_id = au.id) AND (created_at > (now() - '180 days'::interval)) AND (created_at <= '2026-09-24 13:39:18.777+00'::timestamp with time zone))
                                                  Filter: ((visibility = ANY ('{public,followers}'::text[])) AND (ROW(created_at, id) < ROW('2026-09-24 13:39:18.777+00'::timestamp with time zone, '24bfe880-96ae-49da-9c32-c6fd5f49076e'::uuid)) AND ((verb <> 'followed'::text) OR (object_id IS NULL) OR ((ANY (object_id = (hashed SubPlan 3).col1)) AND (NOT EXISTS(SubPlan 4)) AND (NOT (ANY (object_id = (hashed SubPlan 6).col1))))))
                                                  Rows Removed by Filter: 1
                                                  Index Searches: 40
                                                  Buffers: shared hit=3019
                                                  SubPlan 3
                                                    ->  Seq Scan on users tu  (cost=0.00..112.02 rows=3002 width=16) (actual time=0.010..0.669 rows=3002.00 loops=1)
                                                          Filter: (deleted_at IS NULL)
                                                          Buffers: shared hit=82
                                                  SubPlan 4
                                                    ->  Bitmap Heap Scan on blocks tb  (cost=8.31..15.00 rows=1 width=0) (actual time=0.003..0.003 rows=0.00 loops=744)
                                                          Recheck Cond: ((blocked_id = a.object_id) OR (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid))
                                                          Filter: (((blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (blocked_id = a.object_id)) OR ((blocker_id = a.object_id) AND (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)))
                                                          Rows Removed by Filter: 0
                                                          Heap Blocks: exact=27
                                                          Buffers: shared hit=1515
                                                          ->  BitmapOr  (cost=8.31..8.31 rows=2 width=0) (actual time=0.002..0.002 rows=0.00 loops=744)
                                                                Buffers: shared hit=1488
                                                                ->  Bitmap Index Scan on blocks_blocked_idx  (cost=0.00..4.15 rows=1 width=0) (actual time=0.001..0.001 rows=0.04 loops=744)
                                                                      Index Cond: (blocked_id = a.object_id)
                                                                      Index Searches: 744
                                                                      Buffers: shared hit=744
                                                                ->  Bitmap Index Scan on blocks_blocked_idx  (cost=0.00..4.15 rows=1 width=0) (actual time=0.001..0.001 rows=0.00 loops=744)
                                                                      Index Cond: (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                                      Index Searches: 744
                                                                      Buffers: shared hit=744
                                                  SubPlan 6
                                                    ->  Seq Scan on mutes tm  (cost=0.00..7.50 rows=1 width=16) (actual time=0.054..0.054 rows=0.00 loops=1)
                                                          Filter: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (target_type = 'user'::text))
                                                          Rows Removed by Filter: 300
                                                          Buffers: shared hit=3
                                      ->  Materialize  (cost=8.43..15.13 rows=2 width=32) (actual time=0.000..0.000 rows=0.00 loops=1912)
                                            Storage: Memory  Maximum Storage: 17kB
                                            Buffers: shared hit=3
                                            ->  Bitmap Heap Scan on blocks b  (cost=8.43..15.12 rows=2 width=32) (actual time=0.025..0.026 rows=0.00 loops=1)
                                                  Recheck Cond: ((blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) OR (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid))
                                                  Buffers: shared hit=3
                                                  ->  BitmapOr  (cost=8.43..8.43 rows=2 width=0) (actual time=0.012..0.013 rows=0.00 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Bitmap Index Scan on blocks_pkey  (cost=0.00..4.28 rows=1 width=0) (actual time=0.008..0.008 rows=0.00 loops=1)
                                                              Index Cond: (blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                              Index Searches: 1
                                                              Buffers: shared hit=2
                                                        ->  Bitmap Index Scan on blocks_blocked_idx  (cost=0.00..4.15 rows=1 width=0) (actual time=0.004..0.004 rows=0.00 loops=1)
                                                              Index Cond: (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                              Index Searches: 1
                                                              Buffers: shared hit=1
                                ->  Materialize  (cost=0.00..8.26 rows=1 width=21) (actual time=0.000..0.000 rows=0.00 loops=1912)
                                      Storage: Memory  Maximum Storage: 17kB
                                      Buffers: shared hit=3
                                      ->  Seq Scan on mutes m  (cost=0.00..8.25 rows=1 width=21) (actual time=0.034..0.034 rows=0.00 loops=1)
                                            Filter: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND ((target_type = 'user'::text) OR (target_type = 'work'::text)))
                                            Rows Removed by Filter: 300
                                            Buffers: shared hit=3
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..6.40 rows=1 width=71) (actual time=0.003..0.003 rows=1.00 loops=61)
                    Index Cond: (user_id = a.actor_id)
                    Index Searches: 61
                    Buffers: shared hit=183
        ->  Index Scan using works_pkey on works w  (cost=0.42..8.37 rows=1 width=44) (actual time=0.005..0.005 rows=0.75 loops=61)
              Index Cond: (id = a.work_id)
              Index Searches: 46
              Buffers: shared hit=184
  ->  Index Scan using profiles_pkey on profiles tp  (cost=0.28..6.40 rows=1 width=39) (actual time=0.002..0.002 rows=0.25 loops=61)
        Index Cond: (user_id = a.object_id)
        Index Searches: 61
        Buffers: shared hit=137
  SubPlan 1
    ->  Limit  (cost=29.33..29.33 rows=1 width=19) (actual time=0.011..0.011 rows=0.75 loops=61)
          Buffers: shared hit=408
          ->  Sort  (cost=29.33..29.34 rows=2 width=19) (actual time=0.010..0.010 rows=0.75 loops=61)
                Sort Key: wa."position"
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=408
                ->  Nested Loop  (cost=0.84..29.32 rows=2 width=19) (actual time=0.008..0.009 rows=0.92 loops=61)
                      Buffers: shared hit=408
                      ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.42..12.45 rows=2 width=20) (actual time=0.004..0.004 rows=0.92 loops=61)
                            Index Cond: (work_id = a.work_id)
                            Index Searches: 46
                            Buffers: shared hit=184
                      ->  Index Scan using authors_pkey on authors auth  (cost=0.42..8.44 rows=1 width=31) (actual time=0.004..0.004 rows=1.00 loops=56)
                            Index Cond: (id = wa.author_id)
                            Index Searches: 56
                            Buffers: shared hit=224
Planning:
  Buffers: shared hit=85
Planning Time: 4.749 ms
Execution Time: 13.073 ms
```

## Statement 4

WITH actors(id) AS (VALUES ($1::uuid), ($2::uuid), ($3::uuid), ($4::uuid), ($5::uuid), ($6::uuid), ($7::uuid), ($8::uuid), ($9::uuid), ($10::uuid), ($11::uuid), ($12::uuid), ($13::uuid), ($14::uuid), ($15::uuid), ($16::uuid), ($17::uuid), ($18::uuid), ($19::uuid)),
      engaged AS (
        SELECT r.user_id AS actor_id, count(*)::int AS n
        FROM read_likes l JOIN reads r ON r.id = l.read_id
        WHERE l.user_id = $20::uuid AND l.created_at > now() - interval '90 days' AND r.user_id IN ($21::uuid, $22::uuid, $23::uuid, $24::uuid, $25::uuid, $26::uuid, $27::uuid, $28::uuid, $29::uuid, $30::uuid, $31::uuid, $32::uuid, $33::uuid, $34::uuid, $35::uuid, $36::uuid, $37::uuid, $38::uuid, $39::uuid)
        GROUP BY r.user_id
        UNION ALL
        SELECT r.user_id, count(*)::int
        FROM read_comments c JOIN reads r ON r.id = c.read_id
        WHERE c.user_id = $40::uuid AND c.deleted_at IS NULL AND c.created_at > now() - interval '90 days'
          AND r.user_id IN ($41::uuid, $42::uuid, $43::uuid, $44::uuid, $45::uuid, $46::uuid, $47::uuid, $48::uuid, $49::uuid, $50::uuid, $51::uuid, $52::uuid, $53::uuid, $54::uuid, $55::uuid, $56::uuid, $57::uuid, $58::uuid, $59::uuid)
        GROUP BY r.user_id
      )
      SELECT a.id AS actor_id,
        COALESCE((SELECT sum(e.n)::int FROM engaged e WHERE e.actor_id = a.id), 0) AS engagements,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = a.id AND f.followee_id = $60::uuid
                AND f.state = 'accepted') AS mutual
      FROM actors a

```
Values Scan on "*VALUES*"  (cost=0.00..2511.51 rows=19 width=21) (actual time=0.225..2.931 rows=19.00 loops=1)
  Buffers: shared hit=2322
  SubPlan 1
    ->  Aggregate  (cost=127.31..127.32 rows=1 width=4) (actual time=0.148..0.149 rows=1.00 loops=19)
          Buffers: shared hit=2317
          ->  Append  (cost=0.71..127.30 rows=2 width=4) (actual time=0.146..0.148 rows=0.26 loops=19)
                Buffers: shared hit=2317
                ->  Subquery Scan on "*SELECT* 1"  (cost=0.71..98.43 rows=1 width=4) (actual time=0.141..0.141 rows=0.26 loops=19)
                      Buffers: shared hit=2279
                      ->  GroupAggregate  (cost=0.71..98.42 rows=1 width=20) (actual time=0.140..0.140 rows=0.26 loops=19)
                            Buffers: shared hit=2279
                            ->  Nested Loop  (cost=0.71..98.41 rows=1 width=16) (actual time=0.118..0.140 rows=0.42 loops=19)
                                  Buffers: shared hit=2279
                                  ->  Index Scan using reads_user_visibility_idx on reads r  (cost=0.41..88.09 rows=1 width=32) (actual time=0.011..0.028 rows=25.58 loops=19)
                                        Index Cond: ((user_id = ANY ('{69cfc69c-b180-46e8-babf-3552a1f7b044,3ce32eae-16dc-44c6-91ba-8a2f52ba0d18,2620786d-3efc-46a9-a611-d83a27a7d2e8,c523ccc9-3619-4736-8dbb-63e4b490b126,03f467b9-fe86-4567-9740-9d110952fb43,e052a43a-adfd-4f32-b59a-72f75d645c56,dec34c67-6db2-4912-b18c-79637f7b5376,898ba8bf-0ff9-4774-b200-1a454b6dfc3a,d8976a59-04eb-489b-aab8-dfc4b4fb2337,bce6b67e-d5b8-4a11-8ec8-d9855b43a77d,55ae21e5-9eb2-4d3e-b3b7-e499d9eff3bf,a2df6029-e488-4fd4-9d15-817f17db87d8,123995d6-d3e0-4fc3-bc0e-c14159a3f923,a49d3995-ce59-4c94-9120-b1313b06c3e3,05fe8ec4-2411-41d9-82fb-e250dfc06649,be82feff-bfee-43e3-9b18-8b9ee0ba6a99,214c1d5d-aaab-410d-8286-7b014a74d557,7a365442-9b3d-4326-8fd4-c7c974d82b9a,bb958ade-0762-45ae-8fdb-51c2942f8f9d}'::uuid[])) AND (user_id = "*VALUES*".column1))
                                        Index Searches: 19
                                        Buffers: shared hit=405
                                  ->  Index Scan using read_likes_read_created_idx on read_likes l  (cost=0.29..8.32 rows=1 width=16) (actual time=0.004..0.004 rows=0.02 loops=486)
                                        Index Cond: ((read_id = r.id) AND (created_at > (now() - '90 days'::interval)))
                                        Filter: (user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                        Rows Removed by Filter: 2
                                        Index Searches: 486
                                        Buffers: shared hit=1874
                ->  Subquery Scan on "*SELECT* 2"  (cost=4.78..28.86 rows=1 width=4) (actual time=0.006..0.006 rows=0.00 loops=19)
                      Buffers: shared hit=38
                      ->  GroupAggregate  (cost=4.78..28.85 rows=1 width=20) (actual time=0.005..0.005 rows=0.00 loops=19)
                            Buffers: shared hit=38
                            ->  Nested Loop  (cost=4.78..28.84 rows=1 width=16) (actual time=0.003..0.003 rows=0.00 loops=19)
                                  Buffers: shared hit=38
                                  ->  Bitmap Heap Scan on read_comments c  (cost=4.31..11.82 rows=2 width=16) (actual time=0.003..0.003 rows=0.00 loops=19)
                                        Recheck Cond: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (created_at > (now() - '90 days'::interval)))
                                        Filter: (deleted_at IS NULL)
                                        Buffers: shared hit=38
                                        ->  Bitmap Index Scan on read_comments_user_idx  (cost=0.00..4.31 rows=2 width=0) (actual time=0.002..0.002 rows=0.00 loops=19)
                                              Index Cond: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (created_at > (now() - '90 days'::interval)))
                                              Index Searches: 19
                                              Buffers: shared hit=38
                                  ->  Memoize  (cost=0.47..8.50 rows=1 width=32) (never executed)
                                        Cache Key: c.read_id
                                        Cache Mode: logical
                                        ->  Index Scan using reads_pkey on reads r_1  (cost=0.46..8.49 rows=1 width=32) (never executed)
                                              Index Cond: (id = c.read_id)
                                              Filter: ((user_id = "*VALUES*".column1) AND (user_id = ANY ('{69cfc69c-b180-46e8-babf-3552a1f7b044,3ce32eae-16dc-44c6-91ba-8a2f52ba0d18,2620786d-3efc-46a9-a611-d83a27a7d2e8,c523ccc9-3619-4736-8dbb-63e4b490b126,03f467b9-fe86-4567-9740-9d110952fb43,e052a43a-adfd-4f32-b59a-72f75d645c56,dec34c67-6db2-4912-b18c-79637f7b5376,898ba8bf-0ff9-4774-b200-1a454b6dfc3a,d8976a59-04eb-489b-aab8-dfc4b4fb2337,bce6b67e-d5b8-4a11-8ec8-d9855b43a77d,55ae21e5-9eb2-4d3e-b3b7-e499d9eff3bf,a2df6029-e488-4fd4-9d15-817f17db87d8,123995d6-d3e0-4fc3-bc0e-c14159a3f923,a49d3995-ce59-4c94-9120-b1313b06c3e3,05fe8ec4-2411-41d9-82fb-e250dfc06649,be82feff-bfee-43e3-9b18-8b9ee0ba6a99,214c1d5d-aaab-410d-8286-7b014a74d557,7a365442-9b3d-4326-8fd4-c7c974d82b9a,bb958ade-0762-45ae-8fdb-51c2942f8f9d}'::uuid[])))
                                              Index Searches: 0
  SubPlan 3
    ->  Index Only Scan using follows_followee_list_idx on follows f  (cost=0.42..5.16 rows=42 width=16) (actual time=0.030..0.036 rows=22.00 loops=1)
          Index Cond: (followee_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
          Heap Fetches: 0
          Index Searches: 1
          Buffers: shared hit=5
Planning:
  Buffers: shared hit=28
Planning Time: 1.919 ms
Execution Time: 3.265 ms
```

## Statement 5

SELECT r.id, r.like_count, r.comment_count,
        EXISTS (SELECT 1 FROM read_likes l WHERE l.read_id = r.id AND l.user_id = $1::uuid) AS viewer_has_liked
      FROM reads r
      WHERE r.id IN ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid)
        AND r.status IN ('finished', 'dnf')

```
Bitmap Heap Scan on reads r  (cost=39.83..100.44 rows=6 width=25) (actual time=0.117..0.165 rows=9.00 loops=1)
  Recheck Cond: (id = ANY ('{40294714-d8f5-4121-8668-f83bef7aeae5,dea9a3af-8ea1-4ed4-9ee1-aded53afcfcb,26a621e1-ce84-44be-bc9a-a8659b0afc7e,547f14e4-95ae-4621-afdc-1e783097f569,f0e07f64-4a67-40b7-abb1-8c46f2d00da9,fb113fa7-93a8-4ea8-9b98-5e2614f9a036,93ce19f5-f48c-408a-9a7d-edb073281747,2077ca3a-a956-4593-9977-8313fb66178c,eb1399f5-ea66-44da-9f9d-408401847f9a}'::uuid[]))
  Filter: (status = ANY ('{finished,dnf}'::text[]))
  Heap Blocks: exact=9
  Buffers: shared hit=64
  ->  Bitmap Index Scan on reads_pkey  (cost=0.00..39.80 rows=9 width=0) (actual time=0.068..0.068 rows=9.00 loops=1)
        Index Cond: (id = ANY ('{40294714-d8f5-4121-8668-f83bef7aeae5,dea9a3af-8ea1-4ed4-9ee1-aded53afcfcb,26a621e1-ce84-44be-bc9a-a8659b0afc7e,547f14e4-95ae-4621-afdc-1e783097f569,f0e07f64-4a67-40b7-abb1-8c46f2d00da9,fb113fa7-93a8-4ea8-9b98-5e2614f9a036,93ce19f5-f48c-408a-9a7d-edb073281747,2077ca3a-a956-4593-9977-8313fb66178c,eb1399f5-ea66-44da-9f9d-408401847f9a}'::uuid[]))
        Index Searches: 9
        Buffers: shared hit=27
  SubPlan 1
    ->  Index Only Scan using read_likes_pkey on read_likes l  (cost=0.41..4.43 rows=1 width=0) (actual time=0.007..0.007 rows=0.11 loops=9)
          Index Cond: ((read_id = r.id) AND (user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid))
          Heap Fetches: 0
          Index Searches: 9
          Buffers: shared hit=28
Planning Time: 0.228 ms
Execution Time: 0.254 ms
```

