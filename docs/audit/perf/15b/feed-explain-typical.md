# GET /v1/feed?tab=friends&limit=20 as typical: 200, 20 items, 55.4 ms, 4 statements

## Statement 1

SELECT COUNT(*)::int AS count
      FROM follows f
      JOIN users u ON u.id = f.followee_id AND u.deleted_at IS NULL
      WHERE f.follower_id = $1::uuid AND f.state = 'accepted'

```
Aggregate  (cost=125.99..126.00 rows=1 width=4) (actual time=1.865..1.869 rows=1.00 loops=1)
  Buffers: shared hit=87
  ->  Hash Join  (cost=5.95..125.86 rows=51 width=0) (actual time=0.137..1.855 rows=40.00 loops=1)
        Hash Cond: (u.id = f.followee_id)
        Buffers: shared hit=87
        ->  Seq Scan on users u  (cost=0.00..112.02 rows=3002 width=16) (actual time=0.017..1.079 rows=3002.00 loops=1)
              Filter: (deleted_at IS NULL)
              Buffers: shared hit=82
        ->  Hash  (cost=5.31..5.31 rows=51 width=16) (actual time=0.106..0.107 rows=40.00 loops=1)
              Buckets: 1024  Batches: 1  Memory Usage: 10kB
              Buffers: shared hit=5
              ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..5.31 rows=51 width=16) (actual time=0.059..0.074 rows=40.00 loops=1)
                    Index Cond: (follower_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                    Heap Fetches: 0
                    Index Searches: 1
                    Buffers: shared hit=5
Planning:
  Buffers: shared hit=15
Planning Time: 0.754 ms
Execution Time: 1.983 ms
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
      WHERE tm.user_id = $8::uuid AND tm.target_type = 'user' AND tm.target_id = a.object_id)))  
      ORDER BY a.created_at DESC, a.id DESC
      LIMIT $9
    ) a
    JOIN profiles p ON p.user_id = a.actor_id
    LEFT JOIN works w ON w.id = a.work_id
    LEFT JOIN profiles tp ON a.verb = 'followed' AND a.object_type = 'user' AND tp.user_id = a.object_id
    ORDER BY a.created_at DESC, a.id DESC

```
Nested Loop Left Join  (cost=78207.20..81995.85 rows=76 width=353) (actual time=11.156..12.923 rows=76.00 loops=1)
  Join Filter: ((a.verb = 'followed'::text) AND (a.object_type = 'user'::text))
  Buffers: shared hit=4336
  ->  Nested Loop Left Join  (cost=78206.92..79302.27 rows=76 width=266) (actual time=10.877..11.440 rows=76.00 loops=1)
        Buffers: shared hit=3626
        ->  Nested Loop  (cost=78206.50..78669.02 rows=76 width=238) (actual time=10.751..11.000 rows=76.00 loops=1)
              Buffers: shared hit=3378
              ->  Limit  (cost=78206.22..78206.41 rows=76 width=183) (actual time=10.709..10.734 rows=76.00 loops=1)
                    Buffers: shared hit=3150
                    ->  Sort  (cost=78206.22..78210.18 rows=1583 width=183) (actual time=10.708..10.722 rows=76.00 loops=1)
                          Sort Key: a.created_at DESC, a.id DESC
                          Sort Method: top-N heapsort  Memory: 57kB
                          Buffers: shared hit=3150
                          ->  Nested Loop Anti Join  (cost=9.56..78148.85 rows=1583 width=183) (actual time=0.471..9.465 rows=1937.00 loops=1)
                                Join Filter: (((m.target_type = 'user'::text) AND (m.target_id = a.actor_id)) OR ((m.target_type = 'work'::text) AND (a.work_id IS NOT NULL) AND (m.target_id = a.work_id)))
                                Buffers: shared hit=3150
                                ->  Nested Loop Anti Join  (cost=9.56..78104.98 rows=1583 width=183) (actual time=0.410..8.668 rows=1937.00 loops=1)
                                      Join Filter: (((b.blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (b.blocked_id = a.actor_id)) OR ((b.blocker_id = a.actor_id) AND (b.blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)))
                                      Buffers: shared hit=3147
                                      ->  Nested Loop  (cost=1.12..78018.62 rows=1583 width=183) (actual time=0.285..7.830 rows=1937.00 loops=1)
                                            Buffers: shared hit=3144
                                            ->  Nested Loop  (cost=0.70..320.49 rows=51 width=32) (actual time=0.212..0.386 rows=40.00 loops=1)
                                                  Buffers: shared hit=125
                                                  ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..5.31 rows=51 width=16) (actual time=0.178..0.194 rows=40.00 loops=1)
                                                        Index Cond: (follower_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                        Heap Fetches: 0
                                                        Index Searches: 1
                                                        Buffers: shared hit=5
                                                  ->  Index Scan using users_pkey on users au  (cost=0.28..6.18 rows=1 width=16) (actual time=0.004..0.004 rows=1.00 loops=40)
                                                        Index Cond: (id = f.followee_id)
                                                        Filter: (deleted_at IS NULL)
                                                        Index Searches: 40
                                                        Buffers: shared hit=120
                                            ->  Index Scan using activity_actor_idx on activity a  (cost=0.42..1523.18 rows=31 width=183) (actual time=0.011..0.174 rows=48.42 loops=40)
                                                  Index Cond: ((actor_id = au.id) AND (created_at > (now() - '180 days'::interval)))
                                                  Filter: ((visibility = ANY ('{public,followers}'::text[])) AND ((verb <> 'followed'::text) OR (object_id IS NULL) OR ((ANY (object_id = (hashed SubPlan 3).col1)) AND (NOT EXISTS(SubPlan 4)) AND (NOT (ANY (object_id = (hashed SubPlan 6).col1))))))
                                                  Index Searches: 40
                                                  Buffers: shared hit=3019
                                                  SubPlan 3
                                                    ->  Seq Scan on users tu  (cost=0.00..112.02 rows=3002 width=16) (actual time=0.013..0.647 rows=3002.00 loops=1)
                                                          Filter: (deleted_at IS NULL)
                                                          Buffers: shared hit=82
                                                  SubPlan 4
                                                    ->  Bitmap Heap Scan on blocks tb  (cost=8.31..15.00 rows=1 width=0) (actual time=0.002..0.002 rows=0.00 loops=744)
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
                                                    ->  Seq Scan on mutes tm  (cost=0.00..7.50 rows=1 width=16) (actual time=0.032..0.032 rows=0.00 loops=1)
                                                          Filter: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (target_type = 'user'::text))
                                                          Rows Removed by Filter: 300
                                                          Buffers: shared hit=3
                                      ->  Materialize  (cost=8.43..15.13 rows=2 width=32) (actual time=0.000..0.000 rows=0.00 loops=1937)
                                            Storage: Memory  Maximum Storage: 17kB
                                            Buffers: shared hit=3
                                            ->  Bitmap Heap Scan on blocks b  (cost=8.43..15.12 rows=2 width=32) (actual time=0.023..0.024 rows=0.00 loops=1)
                                                  Recheck Cond: ((blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) OR (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid))
                                                  Buffers: shared hit=3
                                                  ->  BitmapOr  (cost=8.43..8.43 rows=2 width=0) (actual time=0.011..0.011 rows=0.00 loops=1)
                                                        Buffers: shared hit=3
                                                        ->  Bitmap Index Scan on blocks_pkey  (cost=0.00..4.28 rows=1 width=0) (actual time=0.008..0.008 rows=0.00 loops=1)
                                                              Index Cond: (blocker_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                              Index Searches: 1
                                                              Buffers: shared hit=2
                                                        ->  Bitmap Index Scan on blocks_blocked_idx  (cost=0.00..4.15 rows=1 width=0) (actual time=0.003..0.003 rows=0.00 loops=1)
                                                              Index Cond: (blocked_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                                              Index Searches: 1
                                                              Buffers: shared hit=1
                                ->  Materialize  (cost=0.00..8.26 rows=1 width=21) (actual time=0.000..0.000 rows=0.00 loops=1937)
                                      Storage: Memory  Maximum Storage: 17kB
                                      Buffers: shared hit=3
                                      ->  Seq Scan on mutes m  (cost=0.00..8.25 rows=1 width=21) (actual time=0.035..0.035 rows=0.00 loops=1)
                                            Filter: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND ((target_type = 'user'::text) OR (target_type = 'work'::text)))
                                            Rows Removed by Filter: 300
                                            Buffers: shared hit=3
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..6.09 rows=1 width=71) (actual time=0.003..0.003 rows=1.00 loops=76)
                    Index Cond: (user_id = a.actor_id)
                    Index Searches: 76
                    Buffers: shared hit=228
        ->  Index Scan using works_pkey on works w  (cost=0.42..8.33 rows=1 width=44) (actual time=0.005..0.005 rows=0.82 loops=76)
              Index Cond: (id = a.work_id)
              Index Searches: 62
              Buffers: shared hit=248
  ->  Index Scan using profiles_pkey on profiles tp  (cost=0.28..6.09 rows=1 width=39) (actual time=0.003..0.003 rows=0.18 loops=76)
        Index Cond: (user_id = a.object_id)
        Index Searches: 76
        Buffers: shared hit=166
  SubPlan 1
    ->  Limit  (cost=29.33..29.33 rows=1 width=19) (actual time=0.014..0.014 rows=0.82 loops=76)
          Buffers: shared hit=544
          ->  Sort  (cost=29.33..29.34 rows=2 width=19) (actual time=0.012..0.012 rows=0.82 loops=76)
                Sort Key: wa."position"
                Sort Method: quicksort  Memory: 25kB
                Buffers: shared hit=544
                ->  Nested Loop  (cost=0.84..29.32 rows=2 width=19) (actual time=0.008..0.010 rows=0.97 loops=76)
                      Buffers: shared hit=544
                      ->  Index Scan using work_authors_work_id_author_id_role_pk on work_authors wa  (cost=0.42..12.45 rows=2 width=20) (actual time=0.004..0.004 rows=0.97 loops=76)
                            Index Cond: (work_id = a.work_id)
                            Index Searches: 62
                            Buffers: shared hit=248
                      ->  Index Scan using authors_pkey on authors auth  (cost=0.42..8.44 rows=1 width=31) (actual time=0.004..0.004 rows=1.00 loops=74)
                            Index Cond: (id = wa.author_id)
                            Index Searches: 74
                            Buffers: shared hit=296
Planning:
  Buffers: shared hit=85
Planning Time: 5.009 ms
Execution Time: 14.348 ms
```

## Statement 3

WITH actors(id) AS (VALUES ($1::uuid), ($2::uuid), ($3::uuid), ($4::uuid), ($5::uuid), ($6::uuid), ($7::uuid), ($8::uuid), ($9::uuid), ($10::uuid), ($11::uuid), ($12::uuid), ($13::uuid), ($14::uuid), ($15::uuid)),
      engaged AS (
        SELECT r.user_id AS actor_id, count(*)::int AS n
        FROM read_likes l JOIN reads r ON r.id = l.read_id
        WHERE l.user_id = $16::uuid AND l.created_at > now() - interval '90 days' AND r.user_id IN ($17::uuid, $18::uuid, $19::uuid, $20::uuid, $21::uuid, $22::uuid, $23::uuid, $24::uuid, $25::uuid, $26::uuid, $27::uuid, $28::uuid, $29::uuid, $30::uuid, $31::uuid)
        GROUP BY r.user_id
        UNION ALL
        SELECT r.user_id, count(*)::int
        FROM read_comments c JOIN reads r ON r.id = c.read_id
        WHERE c.user_id = $32::uuid AND c.deleted_at IS NULL AND c.created_at > now() - interval '90 days'
          AND r.user_id IN ($33::uuid, $34::uuid, $35::uuid, $36::uuid, $37::uuid, $38::uuid, $39::uuid, $40::uuid, $41::uuid, $42::uuid, $43::uuid, $44::uuid, $45::uuid, $46::uuid, $47::uuid)
        GROUP BY r.user_id
      )
      SELECT a.id AS actor_id,
        COALESCE((SELECT sum(e.n)::int FROM engaged e WHERE e.actor_id = a.id), 0) AS engagements,
        EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = a.id AND f.followee_id = $48::uuid
                AND f.state = 'accepted') AS mutual
      FROM actors a

```
Values Scan on "*VALUES*"  (cost=0.00..1716.97 rows=15 width=21) (actual time=0.234..2.566 rows=15.00 loops=1)
  Buffers: shared hit=1614
  SubPlan 1
    ->  Aggregate  (cost=109.59..109.60 rows=1 width=4) (actual time=0.164..0.164 rows=1.00 loops=15)
          Buffers: shared hit=1609
          ->  Append  (cost=0.71..109.58 rows=2 width=4) (actual time=0.162..0.163 rows=0.13 loops=15)
                Buffers: shared hit=1609
                ->  Subquery Scan on "*SELECT* 1"  (cost=0.71..80.73 rows=1 width=4) (actual time=0.156..0.156 rows=0.13 loops=15)
                      Buffers: shared hit=1579
                      ->  GroupAggregate  (cost=0.71..80.72 rows=1 width=20) (actual time=0.156..0.156 rows=0.13 loops=15)
                            Buffers: shared hit=1579
                            ->  Nested Loop  (cost=0.71..80.71 rows=1 width=16) (actual time=0.132..0.155 rows=0.27 loops=15)
                                  Buffers: shared hit=1579
                                  ->  Index Scan using reads_user_visibility_idx on reads r  (cost=0.41..70.39 rows=1 width=32) (actual time=0.012..0.031 rows=27.93 loops=15)
                                        Index Cond: ((user_id = ANY ('{69cfc69c-b180-46e8-babf-3552a1f7b044,898ba8bf-0ff9-4774-b200-1a454b6dfc3a,dec34c67-6db2-4912-b18c-79637f7b5376,3ce32eae-16dc-44c6-91ba-8a2f52ba0d18,03f467b9-fe86-4567-9740-9d110952fb43,e052a43a-adfd-4f32-b59a-72f75d645c56,a2df6029-e488-4fd4-9d15-817f17db87d8,7a365442-9b3d-4326-8fd4-c7c974d82b9a,1f756411-26d3-4ff9-94e9-e2fb778f63b1,0c5d2e96-f468-4f30-83e9-8bc274eef8f4,2620786d-3efc-46a9-a611-d83a27a7d2e8,bce6b67e-d5b8-4a11-8ec8-d9855b43a77d,0a01f650-718c-4a45-98c1-d48d56737049,c523ccc9-3619-4736-8dbb-63e4b490b126,6e4ebf1c-99b8-409c-a4de-130b4f3a5bbc}'::uuid[])) AND (user_id = "*VALUES*".column1))
                                        Index Searches: 15
                                        Buffers: shared hit=334
                                  ->  Index Scan using read_likes_read_created_idx on read_likes l  (cost=0.29..8.32 rows=1 width=16) (actual time=0.004..0.004 rows=0.01 loops=419)
                                        Index Cond: ((read_id = r.id) AND (created_at > (now() - '90 days'::interval)))
                                        Filter: (user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                                        Rows Removed by Filter: 1
                                        Index Searches: 419
                                        Buffers: shared hit=1245
                ->  Subquery Scan on "*SELECT* 2"  (cost=4.77..28.84 rows=1 width=4) (actual time=0.006..0.006 rows=0.00 loops=15)
                      Buffers: shared hit=30
                      ->  GroupAggregate  (cost=4.77..28.83 rows=1 width=20) (actual time=0.005..0.006 rows=0.00 loops=15)
                            Buffers: shared hit=30
                            ->  Nested Loop  (cost=4.77..28.82 rows=1 width=16) (actual time=0.003..0.003 rows=0.00 loops=15)
                                  Buffers: shared hit=30
                                  ->  Bitmap Heap Scan on read_comments c  (cost=4.31..11.82 rows=2 width=16) (actual time=0.003..0.003 rows=0.00 loops=15)
                                        Recheck Cond: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (created_at > (now() - '90 days'::interval)))
                                        Filter: (deleted_at IS NULL)
                                        Buffers: shared hit=30
                                        ->  Bitmap Index Scan on read_comments_user_idx  (cost=0.00..4.31 rows=2 width=0) (actual time=0.002..0.002 rows=0.00 loops=15)
                                              Index Cond: ((user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid) AND (created_at > (now() - '90 days'::interval)))
                                              Index Searches: 15
                                              Buffers: shared hit=30
                                  ->  Memoize  (cost=0.46..8.49 rows=1 width=32) (never executed)
                                        Cache Key: c.read_id
                                        Cache Mode: logical
                                        ->  Index Scan using reads_pkey on reads r_1  (cost=0.45..8.48 rows=1 width=32) (never executed)
                                              Index Cond: (id = c.read_id)
                                              Filter: ((user_id = "*VALUES*".column1) AND (user_id = ANY ('{69cfc69c-b180-46e8-babf-3552a1f7b044,898ba8bf-0ff9-4774-b200-1a454b6dfc3a,dec34c67-6db2-4912-b18c-79637f7b5376,3ce32eae-16dc-44c6-91ba-8a2f52ba0d18,03f467b9-fe86-4567-9740-9d110952fb43,e052a43a-adfd-4f32-b59a-72f75d645c56,a2df6029-e488-4fd4-9d15-817f17db87d8,7a365442-9b3d-4326-8fd4-c7c974d82b9a,1f756411-26d3-4ff9-94e9-e2fb778f63b1,0c5d2e96-f468-4f30-83e9-8bc274eef8f4,2620786d-3efc-46a9-a611-d83a27a7d2e8,bce6b67e-d5b8-4a11-8ec8-d9855b43a77d,0a01f650-718c-4a45-98c1-d48d56737049,c523ccc9-3619-4736-8dbb-63e4b490b126,6e4ebf1c-99b8-409c-a4de-130b4f3a5bbc}'::uuid[])))
                                              Index Searches: 0
  SubPlan 3
    ->  Index Only Scan using follows_followee_list_idx on follows f  (cost=0.42..5.16 rows=42 width=16) (actual time=0.045..0.052 rows=22.00 loops=1)
          Index Cond: (followee_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
          Heap Fetches: 0
          Index Searches: 1
          Buffers: shared hit=5
Planning:
  Buffers: shared hit=28
Planning Time: 1.941 ms
Execution Time: 2.846 ms
```

## Statement 4

SELECT r.id, r.like_count, r.comment_count,
        EXISTS (SELECT 1 FROM read_likes l WHERE l.read_id = r.id AND l.user_id = $1::uuid) AS viewer_has_liked
      FROM reads r
      WHERE r.id IN ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14::uuid, $15::uuid, $16::uuid, $17::uuid, $18::uuid, $19::uuid, $20::uuid)
        AND r.status IN ('finished', 'dnf')

```
Bitmap Heap Scan on reads r  (cost=84.08..211.47 rows=13 width=25) (actual time=0.218..0.243 rows=19.00 loops=1)
  Recheck Cond: (id = ANY ('{303ccc58-52a7-43a1-b014-7988f230205d,801341e6-2b16-40fc-8c32-5d29d4b0abab,e5918d4e-a3cf-4258-bdf9-ade21c3ad289,4c608d14-00c1-4c98-860b-a7036586505a,93ce19f5-f48c-408a-9a7d-edb073281747,eb1399f5-ea66-44da-9f9d-408401847f9a,9fdd6c60-203e-4e66-b6bc-9e27269d2dfc,547f14e4-95ae-4621-afdc-1e783097f569,d8a734d2-7df9-491d-a79a-e30dbed1f087,d4a2d05a-7681-4e50-9522-1ab15404be19,879849b8-181f-4e33-96ad-ae40c381eaf4,54815460-3070-4c61-ad77-17c18faec852,3b7d9857-e127-4ea0-8418-7ba9dde776da,8f71fce0-0d63-4961-be20-220c383b63fc,89baeb13-d351-404c-b22c-cb205ba92113,f3e37e27-94b9-4e25-b916-7d393318cb2f,e8314a71-ee64-4601-b5fd-6e5af7b7f7b0,6dc8f66f-201f-4c2d-9481-c34d15034fe4,26a621e1-ce84-44be-bc9a-a8659b0afc7e}'::uuid[]))
  Filter: (status = ANY ('{finished,dnf}'::text[]))
  Heap Blocks: exact=18
  Buffers: shared hit=88
  ->  Bitmap Index Scan on reads_pkey  (cost=0.00..84.03 rows=19 width=0) (actual time=0.100..0.100 rows=19.00 loops=1)
        Index Cond: (id = ANY ('{303ccc58-52a7-43a1-b014-7988f230205d,801341e6-2b16-40fc-8c32-5d29d4b0abab,e5918d4e-a3cf-4258-bdf9-ade21c3ad289,4c608d14-00c1-4c98-860b-a7036586505a,93ce19f5-f48c-408a-9a7d-edb073281747,eb1399f5-ea66-44da-9f9d-408401847f9a,9fdd6c60-203e-4e66-b6bc-9e27269d2dfc,547f14e4-95ae-4621-afdc-1e783097f569,d8a734d2-7df9-491d-a79a-e30dbed1f087,d4a2d05a-7681-4e50-9522-1ab15404be19,879849b8-181f-4e33-96ad-ae40c381eaf4,54815460-3070-4c61-ad77-17c18faec852,3b7d9857-e127-4ea0-8418-7ba9dde776da,8f71fce0-0d63-4961-be20-220c383b63fc,89baeb13-d351-404c-b22c-cb205ba92113,f3e37e27-94b9-4e25-b916-7d393318cb2f,e8314a71-ee64-4601-b5fd-6e5af7b7f7b0,6dc8f66f-201f-4c2d-9481-c34d15034fe4,26a621e1-ce84-44be-bc9a-a8659b0afc7e}'::uuid[]))
        Index Searches: 18
        Buffers: shared hit=54
  SubPlan 2
    ->  Bitmap Heap Scan on read_likes l  (cost=4.38..42.52 rows=11 width=16) (actual time=0.037..0.054 rows=15.00 loops=1)
          Recheck Cond: (user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
          Heap Blocks: exact=14
          Buffers: shared hit=16
          ->  Bitmap Index Scan on read_likes_user_idx  (cost=0.00..4.37 rows=11 width=0) (actual time=0.027..0.027 rows=15.00 loops=1)
                Index Cond: (user_id = '7efcbcdb-fc7f-4267-9021-378e70aabda3'::uuid)
                Index Searches: 1
                Buffers: shared hit=2
Planning Time: 0.208 ms
Execution Time: 0.382 ms
```

