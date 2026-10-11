# GET /v1/feed?tab=friends&limit=20 as heavy: 200, 20 items, 143.9 ms, 6 statements

## Statement 1

SELECT COUNT(*)::int AS count
      FROM follows f
      JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
      WHERE f.follower_id = $1::uuid AND f.state = 'accepted'

```
Aggregate  (cost=194.10..194.11 rows=1 width=4) (actual time=1.047..1.049 rows=1.00 loops=1)
  Buffers: shared hit=94
  ->  Hash Join  (cost=71.28..191.19 rows=1162 width=0) (actual time=0.314..0.999 rows=1158.00 loops=1)
        Hash Cond: (u.id = f.followee_id)
        Buffers: shared hit=94
        ->  Seq Scan on users u  (cost=0.00..112.02 rows=3002 width=16) (actual time=0.020..0.442 rows=3002.00 loops=1)
              Filter: (deleted_at IS NULL)
              Buffers: shared hit=82
        ->  Hash  (cost=56.76..56.76 rows=1162 width=16) (actual time=0.286..0.287 rows=1158.00 loops=1)
              Buckets: 2048  Batches: 1  Memory Usage: 71kB
              Buffers: shared hit=12
              ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..56.76 rows=1162 width=16) (actual time=0.024..0.139 rows=1158.00 loops=1)
                    Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                    Heap Fetches: 0
                    Index Searches: 1
                    Buffers: shared hit=12
Planning:
  Buffers: shared hit=13
Planning Time: 0.705 ms
Execution Time: 1.124 ms
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
      WHERE tm.user_id = $8::uuid AND tm.target_type = 'user' AND tm.target_id = a.object_id)))  AND a.created_at >= $9::timestamptz
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $10
    ) a
    JOIN profiles p ON p.user_id = a.actor_id
    LEFT JOIN works w ON w.id = a.work_id
    LEFT JOIN profiles tp ON a.verb = 'followed' AND a.object_type = 'user' AND tp.user_id = a.object_id
    ORDER BY a.created_at DESC, a.id DESC

```
Nested Loop Left Join  (cost=403.35..565.54 rows=3 width=353) (actual time=0.031..0.033 rows=0.00 loops=1)
  Join Filter: ((a.verb = 'followed'::text) AND (a.object_type = 'user'::text))
  Buffers: shared hit=6
  ->  Nested Loop Left Join  (cost=403.07..452.59 rows=3 width=266) (actual time=0.031..0.033 rows=0.00 loops=1)
        Buffers: shared hit=6
        ->  Nested Loop  (cost=402.65..427.27 rows=3 width=238) (actual time=0.031..0.032 rows=0.00 loops=1)
              Buffers: shared hit=6
              ->  Limit  (cost=402.37..402.37 rows=3 width=183) (actual time=0.031..0.032 rows=0.00 loops=1)
                    Buffers: shared hit=6
                    ->  Sort  (cost=402.37..402.37 rows=3 width=183) (actual time=0.030..0.031 rows=0.00 loops=1)
                          Sort Key: a.created_at DESC, a.id DESC
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=6
                          ->  Nested Loop Anti Join  (cost=1.12..402.34 rows=3 width=183) (actual time=0.026..0.027 rows=0.00 loops=1)
                                Join Filter: (((m.target_type = 'user'::text) AND (m.target_id = a.actor_id)) OR ((m.target_type = 'work'::text) AND (a.work_id IS NOT NULL) AND (m.target_id = a.work_id)))
                                Buffers: shared hit=6
                                ->  Nested Loop Anti Join  (cost=1.12..393.39 rows=3 width=183) (actual time=0.026..0.027 rows=0.00 loops=1)
                                      Join Filter: (((b.blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (b.blocked_id = a.actor_id)) OR ((b.blocker_id = a.actor_id) AND (b.blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                      Buffers: shared hit=6
                                      ->  Nested Loop  (cost=1.12..389.00 rows=3 width=183) (actual time=0.026..0.027 rows=0.00 loops=1)
                                            Join Filter: (au.id = a.actor_id)
                                            Buffers: shared hit=6
                                            ->  Nested Loop  (cost=0.84..386.37 rows=4 width=199) (actual time=0.026..0.027 rows=0.00 loops=1)
                                                  Buffers: shared hit=6
                                                  ->  Index Scan using activity_visibility_idx on activity a  (cost=0.42..341.10 rows=9 width=183) (actual time=0.026..0.026 rows=0.00 loops=1)
                                                        Index Cond: ((visibility = ANY ('{public,followers}'::text[])) AND (created_at > (now() - '180 days'::interval)) AND (created_at >= '2026-10-10 08:23:43.371+00'::timestamp with time zone))
                                                        Filter: ((verb <> 'followed'::text) OR (object_id IS NULL) OR ((ANY (object_id = (hashed SubPlan 3).col1)) AND (NOT EXISTS(SubPlan 4)) AND (NOT (ANY (object_id = (hashed SubPlan 6).col1)))))
                                                        Index Searches: 2
                                                        Buffers: shared hit=6
                                                        SubPlan 3
                                                          ->  Seq Scan on users tu  (cost=0.00..112.02 rows=3002 width=16) (never executed)
                                                                Filter: (deleted_at IS NULL)
                                                        SubPlan 4
                                                          ->  Seq Scan on blocks tb  (cost=0.00..5.00 rows=1 width=0) (never executed)
                                                                Filter: (((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (blocked_id = a.object_id)) OR ((blocker_id = a.object_id) AND (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                                        SubPlan 6
                                                          ->  Seq Scan on mutes tm  (cost=0.00..7.50 rows=8 width=16) (never executed)
                                                                Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (target_type = 'user'::text))
                                                  ->  Index Only Scan using follows_followee_list_idx on follows f  (cost=0.42..5.03 rows=1 width=16) (never executed)
                                                        Index Cond: ((followee_id = a.actor_id) AND (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                                        Heap Fetches: 0
                                                        Index Searches: 0
                                            ->  Index Scan using users_pkey on users au  (cost=0.28..0.65 rows=1 width=16) (never executed)
                                                  Index Cond: (id = f.followee_id)
                                                  Filter: (deleted_at IS NULL)
                                                  Index Searches: 0
                                      ->  Materialize  (cost=0.00..4.26 rows=2 width=32) (never executed)
                                            ->  Seq Scan on blocks b  (cost=0.00..4.25 rows=2 width=32) (never executed)
                                                  Filter: ((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                ->  Materialize  (cost=0.00..8.30 rows=10 width=21) (never executed)
                                      ->  Seq Scan on mutes m  (cost=0.00..8.25 rows=10 width=21) (never executed)
                                            Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND ((target_type = 'user'::text) OR (target_type = 'work'::text)))
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..8.30 rows=1 width=71) (never executed)
                    Index Cond: (user_id = a.actor_id)
                    Index Searches: 0
        ->  Index Scan using works_pkey on works w  (cost=0.42..8.44 rows=1 width=44) (never executed)
              Index Cond: (id = a.work_id)
              Index Searches: 0
  ->  Index Scan using profiles_pkey on profiles tp  (cost=0.28..8.30 rows=1 width=39) (never executed)
        Index Cond: (user_id = a.object_id)
        Index Searches: 0
  SubPlan 1
    ->  Limit  (cost=29.33..29.33 rows=1 width=19) (never executed)
          ->  Sort  (cost=29.33..29.34 rows=2 width=19) (never executed)
                Sort Key: wa."position"
                ->  Nested Loop  (cost=0.84..29.32 rows=2 width=19) (never executed)
                      ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.42..12.45 rows=2 width=20) (never executed)
                            Index Cond: (work_id = a.work_id)
                            Index Searches: 0
                      ->  Index Scan using authors_pkey on authors auth  (cost=0.42..8.44 rows=1 width=31) (never executed)
                            Index Cond: (id = wa.author_id)
                            Index Searches: 0
Planning:
  Buffers: shared hit=81
Planning Time: 2.323 ms
Execution Time: 0.261 ms
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
      WHERE tm.user_id = $8::uuid AND tm.target_type = 'user' AND tm.target_id = a.object_id)))  AND a.created_at >= $9::timestamptz
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $10
    ) a
    JOIN profiles p ON p.user_id = a.actor_id
    LEFT JOIN works w ON w.id = a.work_id
    LEFT JOIN profiles tp ON a.verb = 'followed' AND a.object_type = 'user' AND tp.user_id = a.object_id
    ORDER BY a.created_at DESC, a.id DESC

```
Nested Loop Left Join  (cost=403.35..565.54 rows=3 width=353) (actual time=0.039..0.041 rows=0.00 loops=1)
  Join Filter: ((a.verb = 'followed'::text) AND (a.object_type = 'user'::text))
  Buffers: shared hit=6
  ->  Nested Loop Left Join  (cost=403.07..452.59 rows=3 width=266) (actual time=0.039..0.040 rows=0.00 loops=1)
        Buffers: shared hit=6
        ->  Nested Loop  (cost=402.65..427.27 rows=3 width=238) (actual time=0.038..0.040 rows=0.00 loops=1)
              Buffers: shared hit=6
              ->  Limit  (cost=402.37..402.37 rows=3 width=183) (actual time=0.038..0.039 rows=0.00 loops=1)
                    Buffers: shared hit=6
                    ->  Sort  (cost=402.37..402.37 rows=3 width=183) (actual time=0.038..0.039 rows=0.00 loops=1)
                          Sort Key: a.created_at DESC, a.id DESC
                          Sort Method: quicksort  Memory: 25kB
                          Buffers: shared hit=6
                          ->  Nested Loop Anti Join  (cost=1.12..402.34 rows=3 width=183) (actual time=0.027..0.028 rows=0.00 loops=1)
                                Join Filter: (((m.target_type = 'user'::text) AND (m.target_id = a.actor_id)) OR ((m.target_type = 'work'::text) AND (a.work_id IS NOT NULL) AND (m.target_id = a.work_id)))
                                Buffers: shared hit=6
                                ->  Nested Loop Anti Join  (cost=1.12..393.39 rows=3 width=183) (actual time=0.027..0.027 rows=0.00 loops=1)
                                      Join Filter: (((b.blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (b.blocked_id = a.actor_id)) OR ((b.blocker_id = a.actor_id) AND (b.blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                      Buffers: shared hit=6
                                      ->  Nested Loop  (cost=1.12..389.00 rows=3 width=183) (actual time=0.027..0.027 rows=0.00 loops=1)
                                            Join Filter: (au.id = a.actor_id)
                                            Buffers: shared hit=6
                                            ->  Nested Loop  (cost=0.84..386.37 rows=4 width=199) (actual time=0.026..0.027 rows=0.00 loops=1)
                                                  Buffers: shared hit=6
                                                  ->  Index Scan using activity_visibility_idx on activity a  (cost=0.42..341.10 rows=9 width=183) (actual time=0.026..0.027 rows=0.00 loops=1)
                                                        Index Cond: ((visibility = ANY ('{public,followers}'::text[])) AND (created_at > (now() - '180 days'::interval)) AND (created_at >= '2026-10-04 08:23:43.371+00'::timestamp with time zone))
                                                        Filter: ((verb <> 'followed'::text) OR (object_id IS NULL) OR ((ANY (object_id = (hashed SubPlan 3).col1)) AND (NOT EXISTS(SubPlan 4)) AND (NOT (ANY (object_id = (hashed SubPlan 6).col1)))))
                                                        Index Searches: 2
                                                        Buffers: shared hit=6
                                                        SubPlan 3
                                                          ->  Seq Scan on users tu  (cost=0.00..112.02 rows=3002 width=16) (never executed)
                                                                Filter: (deleted_at IS NULL)
                                                        SubPlan 4
                                                          ->  Seq Scan on blocks tb  (cost=0.00..5.00 rows=1 width=0) (never executed)
                                                                Filter: (((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (blocked_id = a.object_id)) OR ((blocker_id = a.object_id) AND (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                                        SubPlan 6
                                                          ->  Seq Scan on mutes tm  (cost=0.00..7.50 rows=8 width=16) (never executed)
                                                                Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (target_type = 'user'::text))
                                                  ->  Index Only Scan using follows_followee_list_idx on follows f  (cost=0.42..5.03 rows=1 width=16) (never executed)
                                                        Index Cond: ((followee_id = a.actor_id) AND (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                                        Heap Fetches: 0
                                                        Index Searches: 0
                                            ->  Index Scan using users_pkey on users au  (cost=0.28..0.65 rows=1 width=16) (never executed)
                                                  Index Cond: (id = f.followee_id)
                                                  Filter: (deleted_at IS NULL)
                                                  Index Searches: 0
                                      ->  Materialize  (cost=0.00..4.26 rows=2 width=32) (never executed)
                                            ->  Seq Scan on blocks b  (cost=0.00..4.25 rows=2 width=32) (never executed)
                                                  Filter: ((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                ->  Materialize  (cost=0.00..8.30 rows=10 width=21) (never executed)
                                      ->  Seq Scan on mutes m  (cost=0.00..8.25 rows=10 width=21) (never executed)
                                            Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND ((target_type = 'user'::text) OR (target_type = 'work'::text)))
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..8.30 rows=1 width=71) (never executed)
                    Index Cond: (user_id = a.actor_id)
                    Index Searches: 0
        ->  Index Scan using works_pkey on works w  (cost=0.42..8.44 rows=1 width=44) (never executed)
              Index Cond: (id = a.work_id)
              Index Searches: 0
  ->  Index Scan using profiles_pkey on profiles tp  (cost=0.28..8.30 rows=1 width=39) (never executed)
        Index Cond: (user_id = a.object_id)
        Index Searches: 0
  SubPlan 1
    ->  Limit  (cost=29.33..29.33 rows=1 width=19) (never executed)
          ->  Sort  (cost=29.33..29.34 rows=2 width=19) (never executed)
                Sort Key: wa."position"
                ->  Nested Loop  (cost=0.84..29.32 rows=2 width=19) (never executed)
                      ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.42..12.45 rows=2 width=20) (never executed)
                            Index Cond: (work_id = a.work_id)
                            Index Searches: 0
                      ->  Index Scan using authors_pkey on authors auth  (cost=0.42..8.44 rows=1 width=31) (never executed)
                            Index Cond: (id = wa.author_id)
                            Index Searches: 0
Planning:
  Buffers: shared hit=81
Planning Time: 2.536 ms
Execution Time: 0.284 ms
```

## Statement 4

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
      WHERE tm.user_id = $8::uuid AND tm.target_type = 'user' AND tm.target_id = a.object_id)))  AND a.created_at >= $9::timestamptz
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $10
    ) a
    JOIN profiles p ON p.user_id = a.actor_id
    LEFT JOIN works w ON w.id = a.work_id
    LEFT JOIN profiles tp ON a.verb = 'followed' AND a.object_type = 'user' AND tp.user_id = a.object_id
    ORDER BY a.created_at DESC, a.id DESC

```
Nested Loop Left Join  (cost=180493.83..184050.47 rows=76 width=353) (actual time=94.558..95.532 rows=76.00 loops=1)
  Join Filter: ((a.verb = 'followed'::text) AND (a.object_type = 'user'::text))
  Buffers: shared hit=26255
  ->  Nested Loop Left Join  (cost=180493.55..181472.90 rows=76 width=266) (actual time=94.463..94.783 rows=76.00 loops=1)
        Buffers: shared hit=25459
        ->  Nested Loop  (cost=180493.13..180839.65 rows=76 width=238) (actual time=94.394..94.530 rows=76.00 loops=1)
              Buffers: shared hit=25155
              ->  Limit  (cost=180492.85..180493.04 rows=76 width=183) (actual time=94.352..94.371 rows=76.00 loops=1)
                    Buffers: shared hit=24927
                    ->  Sort  (cost=180492.85..180508.06 rows=6086 width=183) (actual time=56.843..56.857 rows=76.00 loops=1)
                          Sort Key: a.created_at DESC, a.id DESC
                          Sort Method: top-N heapsort  Memory: 62kB
                          Buffers: shared hit=24927
                          ->  Nested Loop Anti Join  (cost=1.14..180272.29 rows=6086 width=183) (actual time=0.206..54.566 rows=8514.00 loops=1)
                                Join Filter: (((b.blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (b.blocked_id = a.actor_id)) OR ((b.blocker_id = a.actor_id) AND (b.blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                Buffers: shared hit=24927
                                ->  Nested Loop Anti Join  (cost=1.14..179994.17 rows=6086 width=183) (actual time=0.186..53.172 rows=8514.00 loops=1)
                                      Join Filter: (((m.target_type = 'user'::text) AND (m.target_id = a.actor_id)) OR ((m.target_type = 'work'::text) AND (a.work_id IS NOT NULL) AND (m.target_id = a.work_id)))
                                      Rows Removed by Join Filter: 116539
                                      Buffers: shared hit=24925
                                      ->  Nested Loop  (cost=1.14..178613.86 rows=6100 width=183) (actual time=0.142..38.458 rows=9195.00 loops=1)
                                            Join Filter: (au.id = a.actor_id)
                                            Buffers: shared hit=24922
                                            ->  Nested Loop  (cost=0.70..806.45 rows=1162 width=32) (actual time=0.068..2.013 rows=1158.00 loops=1)
                                                  Buffers: shared hit=3486
                                                  ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..56.76 rows=1162 width=16) (actual time=0.033..0.226 rows=1158.00 loops=1)
                                                        Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                                        Heap Fetches: 0
                                                        Index Searches: 1
                                                        Buffers: shared hit=12
                                                  ->  Index Scan using users_pkey on users au  (cost=0.28..0.65 rows=1 width=16) (actual time=0.001..0.001 rows=1.00 loops=1158)
                                                        Index Cond: (id = f.followee_id)
                                                        Filter: (deleted_at IS NULL)
                                                        Index Searches: 1158
                                                        Buffers: shared hit=3474
                                            ->  Memoize  (cost=0.43..184.32 rows=5 width=183) (actual time=0.006..0.030 rows=7.94 loops=1158)
                                                  Cache Key: f.followee_id
                                                  Cache Mode: logical
                                                  Hits: 0  Misses: 1158  Evictions: 0  Overflows: 0  Memory Usage: 2141kB
                                                  Buffers: shared hit=21436
                                                  ->  Index Scan using activity_actor_idx on activity a  (cost=0.42..184.31 rows=5 width=183) (actual time=0.005..0.026 rows=7.94 loops=1158)
                                                        Index Cond: ((actor_id = f.followee_id) AND (created_at > (now() - '180 days'::interval)) AND (created_at >= '2026-09-11 08:23:43.371+00'::timestamp with time zone))
                                                        Filter: ((visibility = ANY ('{public,followers}'::text[])) AND ((verb <> 'followed'::text) OR (object_id IS NULL) OR (EXISTS(SubPlan 2) AND (NOT EXISTS(SubPlan 4)) AND (NOT (ANY (object_id = (hashed SubPlan 6).col1))))))
                                                        Rows Removed by Filter: 0
                                                        Index Searches: 1158
                                                        Buffers: shared hit=21436
                                                        SubPlan 2
                                                          ->  Index Scan using users_pkey on users tu  (cost=0.28..8.30 rows=1 width=0) (actual time=0.001..0.001 rows=1.00 loops=2282)
                                                                Index Cond: (id = a.object_id)
                                                                Filter: (deleted_at IS NULL)
                                                                Index Searches: 2282
                                                                Buffers: shared hit=6846
                                                        SubPlan 4
                                                          ->  Seq Scan on blocks tb  (cost=0.00..5.00 rows=1 width=0) (actual time=0.006..0.006 rows=0.00 loops=2282)
                                                                Filter: (((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (blocked_id = a.object_id)) OR ((blocker_id = a.object_id) AND (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                                                                Rows Removed by Filter: 150
                                                                Buffers: shared hit=4564
                                                        SubPlan 6
                                                          ->  Seq Scan on mutes tm  (cost=0.00..7.50 rows=8 width=16) (actual time=0.117..0.140 rows=8.00 loops=1)
                                                                Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (target_type = 'user'::text))
                                                                Rows Removed by Filter: 292
                                                                Buffers: shared hit=3
                                      ->  Materialize  (cost=0.00..8.30 rows=10 width=21) (actual time=0.000..0.000 rows=12.75 loops=9195)
                                            Storage: Memory  Maximum Storage: 17kB
                                            Buffers: shared hit=3
                                            ->  Seq Scan on mutes m  (cost=0.00..8.25 rows=10 width=21) (actual time=0.016..0.028 rows=13.00 loops=1)
                                                  Filter: ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND ((target_type = 'user'::text) OR (target_type = 'work'::text)))
                                                  Rows Removed by Filter: 287
                                                  Buffers: shared hit=3
                                ->  Materialize  (cost=0.00..4.26 rows=2 width=32) (actual time=0.000..0.000 rows=0.00 loops=8514)
                                      Storage: Memory  Maximum Storage: 17kB
                                      Buffers: shared hit=2
                                      ->  Seq Scan on blocks b  (cost=0.00..4.25 rows=2 width=32) (actual time=0.013..0.013 rows=0.00 loops=1)
                                            Filter: ((blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                            Rows Removed by Filter: 150
                                            Buffers: shared hit=2
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..4.56 rows=1 width=71) (actual time=0.001..0.001 rows=1.00 loops=76)
                    Index Cond: (user_id = a.actor_id)
                    Index Searches: 76
                    Buffers: shared hit=228
        ->  Index Scan using works_pkey on works w  (cost=0.42..8.33 rows=1 width=44) (actual time=0.003..0.003 rows=1.00 loops=76)
              Index Cond: (id = a.work_id)
              Index Searches: 76
              Buffers: shared hit=304
  ->  Index Scan using profiles_pkey on profiles tp  (cost=0.28..4.56 rows=1 width=39) (actual time=0.001..0.001 rows=0.00 loops=76)
        Index Cond: (user_id = a.object_id)
        Index Searches: 76
        Buffers: shared hit=152
  SubPlan 1
    ->  Limit  (cost=29.33..29.33 rows=1 width=19) (actual time=0.007..0.007 rows=1.00 loops=76)
          Buffers: shared hit=644
          ->  Sort  (cost=29.33..29.34 rows=2 width=19) (actual time=0.007..0.007 rows=1.00 loops=76)
                Sort Key: wa."position"
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=644
                ->  Nested Loop  (cost=0.84..29.32 rows=2 width=19) (actual time=0.005..0.005 rows=1.12 loops=76)
                      Buffers: shared hit=644
                      ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.42..12.45 rows=2 width=20) (actual time=0.002..0.002 rows=1.12 loops=76)
                            Index Cond: (work_id = a.work_id)
                            Index Searches: 76
                            Buffers: shared hit=304
                      ->  Index Scan using authors_pkey on authors auth  (cost=0.42..8.44 rows=1 width=31) (actual time=0.002..0.002 rows=1.00 loops=85)
                            Index Cond: (id = wa.author_id)
                            Index Searches: 85
                            Buffers: shared hit=340
Planning:
  Buffers: shared hit=81
Planning Time: 2.731 ms
JIT:
  Functions: 90
  Options: Inlining false, Optimization false, Expressions true, Deforming true
  Timing: Generation 5.278 ms (Deform 1.955 ms), Inlining 0.000 ms, Optimization 1.606 ms, Emission 37.637 ms, Total 44.521 ms
Execution Time: 101.291 ms
```

## Statement 5

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
Values Scan on "*VALUES*"  (cost=0.00..5810.02 rows=24 width=21) (actual time=0.294..7.373 rows=24.00 loops=1)
  Buffers: shared hit=11779
  SubPlan 1
    ->  Aggregate  (cost=237.21..237.22 rows=1 width=4) (actual time=0.302..0.303 rows=1.00 loops=24)
          Buffers: shared hit=11774
          ->  Append  (cost=0.71..237.20 rows=2 width=4) (actual time=0.210..0.302 rows=0.62 loops=24)
                Buffers: shared hit=11774
                ->  Subquery Scan on "*SELECT* 1"  (cost=0.71..118.64 rows=1 width=4) (actual time=0.182..0.182 rows=0.46 loops=24)
                      Buffers: shared hit=6314
                      ->  GroupAggregate  (cost=0.71..118.63 rows=1 width=20) (actual time=0.182..0.182 rows=0.46 loops=24)
                            Buffers: shared hit=6314
                            ->  Nested Loop  (cost=0.71..118.61 rows=1 width=16) (actual time=0.106..0.181 rows=0.75 loops=24)
                                  Buffers: shared hit=6314
                                  ->  Index Scan using reads_user_visibility_idx on reads r  (cost=0.41..110.21 rows=1 width=32) (actual time=0.007..0.041 rows=76.67 loops=24)
                                        Index Cond: ((user_id = ANY ('{1f1d22a0-aa63-45cc-9d8e-03051a50f990,c2267f4a-5a97-4a4d-9144-d69cc5890186,90abbf7a-a0a8-46af-b1cc-b6580a2338eb,315e6ec7-da99-49bc-a968-8d52a24bdae7,eb0a2381-1e39-43b7-9df2-bc170013e83d,f5f7adde-c87b-4fcc-b598-96659cfe737f,8d0650d8-e13f-4547-8d02-198e7055edba,7b731744-0b76-4ffb-bcb1-de075e1ea89c,155b9469-ebf7-4392-89be-17bba8f9696d,79335f92-0d9b-4558-9710-d64cb56adcda,5ad77475-4777-487c-985d-c30da8f29097,bf23d584-559a-401a-94d9-be4c430e8a0a,07f7cdab-16fd-4b8a-83f1-2d74dc1a46d7,5047df7b-1f62-4f24-9086-35f2e498578f,f484eb30-af75-4b61-b025-b01a11ad7250,45561da0-1c93-421d-a952-b46a520414fb,a3ef6854-762b-4541-bb00-83de8d3a4391,71e59f8f-e65e-4ecf-a492-211b32ad5c57,bc8f8b27-bd37-4dd2-8491-315c0b19750b,7aeaacbd-e1d7-428f-9e73-d63fb57cc1e3,5b852df7-d6d8-4eec-b34f-9491b46f758d,76fc542c-b00d-4e4a-8f82-e19e8d1b4f12,e8b145b4-ba27-4fa5-be89-2ebe308b5322,d59fa532-90e3-4511-bed1-1de0e14c97dc}'::uuid[])) AND (user_id = "*VALUES*".column1))
                                        Index Searches: 24
                                        Buffers: shared hit=1585
                                  ->  Index Scan using read_likes_read_created_idx on read_likes l  (cost=0.29..8.32 rows=1 width=16) (actual time=0.002..0.002 rows=0.01 loops=1840)
                                        Index Cond: ((read_id = r.id) AND (created_at > (now() - '90 days'::interval)))
                                        Filter: (user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                        Rows Removed by Filter: 1
                                        Index Searches: 1840
                                        Buffers: shared hit=4729
                ->  Subquery Scan on "*SELECT* 2"  (cost=0.70..118.55 rows=1 width=4) (actual time=0.119..0.119 rows=0.17 loops=24)
                      Buffers: shared hit=5460
                      ->  GroupAggregate  (cost=0.70..118.54 rows=1 width=20) (actual time=0.119..0.119 rows=0.17 loops=24)
                            Buffers: shared hit=5460
                            ->  Nested Loop  (cost=0.70..118.53 rows=1 width=16) (actual time=0.078..0.119 rows=0.25 loops=24)
                                  Buffers: shared hit=5460
                                  ->  Index Scan using reads_user_visibility_idx on reads r_1  (cost=0.41..110.21 rows=1 width=32) (actual time=0.005..0.024 rows=76.67 loops=24)
                                        Index Cond: ((user_id = ANY ('{1f1d22a0-aa63-45cc-9d8e-03051a50f990,c2267f4a-5a97-4a4d-9144-d69cc5890186,90abbf7a-a0a8-46af-b1cc-b6580a2338eb,315e6ec7-da99-49bc-a968-8d52a24bdae7,eb0a2381-1e39-43b7-9df2-bc170013e83d,f5f7adde-c87b-4fcc-b598-96659cfe737f,8d0650d8-e13f-4547-8d02-198e7055edba,7b731744-0b76-4ffb-bcb1-de075e1ea89c,155b9469-ebf7-4392-89be-17bba8f9696d,79335f92-0d9b-4558-9710-d64cb56adcda,5ad77475-4777-487c-985d-c30da8f29097,bf23d584-559a-401a-94d9-be4c430e8a0a,07f7cdab-16fd-4b8a-83f1-2d74dc1a46d7,5047df7b-1f62-4f24-9086-35f2e498578f,f484eb30-af75-4b61-b025-b01a11ad7250,45561da0-1c93-421d-a952-b46a520414fb,a3ef6854-762b-4541-bb00-83de8d3a4391,71e59f8f-e65e-4ecf-a492-211b32ad5c57,bc8f8b27-bd37-4dd2-8491-315c0b19750b,7aeaacbd-e1d7-428f-9e73-d63fb57cc1e3,5b852df7-d6d8-4eec-b34f-9491b46f758d,76fc542c-b00d-4e4a-8f82-e19e8d1b4f12,e8b145b4-ba27-4fa5-be89-2ebe308b5322,d59fa532-90e3-4511-bed1-1de0e14c97dc}'::uuid[])) AND (user_id = "*VALUES*".column1))
                                        Index Searches: 24
                                        Buffers: shared hit=1585
                                  ->  Index Scan using read_comments_read_idx on read_comments c  (cost=0.29..8.31 rows=1 width=16) (actual time=0.001..0.001 rows=0.00 loops=1840)
                                        Index Cond: ((read_id = r_1.id) AND (created_at > (now() - '90 days'::interval)))
                                        Filter: ((deleted_at IS NULL) AND (user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
                                        Rows Removed by Filter: 0
                                        Index Searches: 1840
                                        Buffers: shared hit=3875
  SubPlan 3
    ->  Index Only Scan using follows_followee_list_idx on follows f  (cost=0.42..5.16 rows=42 width=16) (actual time=0.033..0.045 rows=141.00 loops=1)
          Index Cond: (followee_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
          Heap Fetches: 0
          Index Searches: 1
          Buffers: shared hit=5
Planning:
  Buffers: shared hit=28
Planning Time: 1.017 ms
Execution Time: 7.572 ms
```

## Statement 6

SELECT r.id, r.like_count, r.comment_count,
        EXISTS (SELECT 1 FROM read_likes l WHERE l.read_id = r.id AND l.user_id = $1::uuid) AS viewer_has_liked
      FROM reads r
      WHERE r.id IN ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14::uuid, $15::uuid, $16::uuid, $17::uuid, $18::uuid, $19::uuid, $20::uuid, $21::uuid)
        AND r.status IN ('finished', 'dnf')

```
Bitmap Heap Scan on reads r  (cost=88.50..223.68 rows=14 width=25) (actual time=0.126..0.178 rows=20.00 loops=1)
  Recheck Cond: (id = ANY ('{4eeb120d-129a-4bf9-ad9b-44dfdca75fc0,72b72b27-fe81-4525-8517-c9884ef6fbe5,9875a512-07fc-4802-ab01-8401130e6db1,aedb5b6b-1897-4357-b07f-c420535510f5,f5d182e3-621c-4100-b5d5-0dae9832a800,1e314155-25ec-453b-83cd-e91fbe40e395,d0599018-6333-4868-8ec4-bff6034e110c,39f9a17a-3d11-445e-b73b-83008d94cc8f,cefda6d7-a1ed-45f6-92a4-eaab507aa07c,0b21ffeb-58d9-455e-ba2f-ef6f8e57fcfb,f65bf673-e3f2-475d-a2a9-0fb04eeb199c,c57f3e39-0a71-462c-82d4-1ae16cf4e61f,8dac7ed5-6c4b-4061-b67b-3cc86d6fd31a,323b96cc-c3f6-488c-ab7a-11e384e02cc4,92042b4a-f219-49cf-bb1e-b1272e7c5c4f,65505844-1acc-4f1f-b964-e074a3519bef,e407b55f-7006-4f48-b210-3e336ee1a9fd,64ec735e-5b49-4bb7-9c5a-5f700607bffa,55d9e9c9-6e1c-46e6-b2e0-677cefa77aad,d82c1935-e768-4f04-ab96-fdd13e278e14}'::uuid[]))
  Filter: (status = ANY ('{finished,dnf}'::text[]))
  Heap Blocks: exact=20
  Buffers: shared hit=137
  ->  Bitmap Index Scan on reads_pkey  (cost=0.00..88.45 rows=20 width=0) (actual time=0.096..0.096 rows=21.00 loops=1)
        Index Cond: (id = ANY ('{4eeb120d-129a-4bf9-ad9b-44dfdca75fc0,72b72b27-fe81-4525-8517-c9884ef6fbe5,9875a512-07fc-4802-ab01-8401130e6db1,aedb5b6b-1897-4357-b07f-c420535510f5,f5d182e3-621c-4100-b5d5-0dae9832a800,1e314155-25ec-453b-83cd-e91fbe40e395,d0599018-6333-4868-8ec4-bff6034e110c,39f9a17a-3d11-445e-b73b-83008d94cc8f,cefda6d7-a1ed-45f6-92a4-eaab507aa07c,0b21ffeb-58d9-455e-ba2f-ef6f8e57fcfb,f65bf673-e3f2-475d-a2a9-0fb04eeb199c,c57f3e39-0a71-462c-82d4-1ae16cf4e61f,8dac7ed5-6c4b-4061-b67b-3cc86d6fd31a,323b96cc-c3f6-488c-ab7a-11e384e02cc4,92042b4a-f219-49cf-bb1e-b1272e7c5c4f,65505844-1acc-4f1f-b964-e074a3519bef,e407b55f-7006-4f48-b210-3e336ee1a9fd,64ec735e-5b49-4bb7-9c5a-5f700607bffa,55d9e9c9-6e1c-46e6-b2e0-677cefa77aad,d82c1935-e768-4f04-ab96-fdd13e278e14}'::uuid[]))
        Index Searches: 19
        Buffers: shared hit=57
  SubPlan 1
    ->  Index Only Scan using read_likes_pkey on read_likes l  (cost=0.41..4.43 rows=1 width=0) (actual time=0.003..0.003 rows=0.00 loops=20)
          Index Cond: ((read_id = r.id) AND (user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
          Heap Fetches: 0
          Index Searches: 20
          Buffers: shared hit=60
Planning Time: 0.121 ms
Execution Time: 0.236 ms
```

