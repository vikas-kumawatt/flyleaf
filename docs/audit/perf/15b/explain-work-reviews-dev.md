# Step 11: EXPLAIN (ANALYZE, BUFFERS) of GET /v1/works/:hot_work/reviews (friends as heavy; newest as guest). Database: flyleaf_dev, 2026-10-11.

Captured with a throwaway copy of feed-explain.ts's method for an arbitrary GET (statements recorded through postgres.js's debug hook during one app.inject, then explained with their parameters). Source:

```ts
// 15b step 11 (throwaway): EXPLAIN (ANALYZE, BUFFERS) of every read statement one
// GET sends, for routes feed-explain.ts does not cover. Same method as feed-explain.ts.
//   npx tsx src/bench/route-explain.tmp.ts <persona|guest> <path>
import fs from 'node:fs';
import postgres from 'postgres';
import { drizzle } from 'drizzle-orm/postgres-js';
import * as schema from '../db/schema.js';
import { buildApp } from '../app.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { config, PgRateLimiter } from '../platform/index.js';
import { TOKENS_PATH } from './seed.js';

const [persona, rawPath] = process.argv.slice(2) as [string, string];
const seed = JSON.parse(fs.readFileSync(TOKENS_PATH, 'utf8')) as { personas: Record<string, { user_id: string }>; ids: Record<string, string> };
const path = rawPath.replace(/\{(\w+)\}/g, (_m, k: string) => String(seed.ids[k]));
const who = persona === 'guest' ? null : seed.personas[persona]!;
let recording = false;
const seen: { query: string; params: unknown[] }[] = [];
const client = postgres(config.databaseUrl, { max: 4, idle_timeout: 30, onnotice: () => {},
  debug: (_c, query, params) => { if (recording) seen.push({ query, params: params as unknown[] }); } });
const db = drizzle(client, { schema });
const app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), reading: new ReadingService(db) });
await app.ready();
try {
  const headers: Record<string, string> = who ? { authorization: `Bearer ${await signAccessToken(who.user_id)}` } : {};
  await app.inject({ method: 'GET', url: path, headers }); // warm-up: type metadata
  recording = true;
  const t0 = performance.now();
  const res = await app.inject({ method: 'GET', url: path, headers });
  const ms = performance.now() - t0;
  recording = false;
  console.log(`# GET ${path} as ${persona}: ${res.statusCode}, ${ms.toFixed(1)} ms, ${seen.length} statements\n`);
  for (const [i, s] of seen.entries()) {
    const text = s.query.trim();
    const reads = /^(select|with)\b/i.test(text) && !/\b(insert|update|delete)\b/i.test(text);
    console.log(`## Statement ${i + 1}${reads ? '' : ' (writes or control: not explained)'}\n\n${text.length > 4000 ? `${text.slice(0, 4000)}…` : text}\n`);
    if (!reads) continue;
    const plan = await client.unsafe(`EXPLAIN (ANALYZE, BUFFERS) ${text}`, s.params as never[]);
    console.log('```\n' + plan.map((r) => r['QUERY PLAN']).join('\n') + '\n```\n');
  }
} finally {
  await app.close();
  await client.end({ timeout: 5 });
}
```

---
# GET /v1/works/6ddee7fc-a0cc-4bd0-a981-db72ec1a9768/reviews?sort=friends as heavy: 200, 219.9 ms, 8 statements

## Statement 1

SELECT merged_into_id FROM works WHERE id = $1

```
Index Scan using works_pkey on works  (cost=0.42..8.44 rows=1 width=16) (actual time=0.041..0.043 rows=1.00 loops=1)
  Index Cond: (id = '6ddee7fc-a0cc-4bd0-a981-db72ec1a9768'::uuid)
  Index Searches: 1
  Buffers: shared hit=4
Planning:
  Buffers: shared hit=1
Planning Time: 0.142 ms
Execution Time: 0.084 ms
```

## Statement 2

select "followee_id" from "follows" where ("follows"."follower_id" = $1 and "follows"."state" = $2)

```
Index Only Scan using follows_follower_list_idx on follows  (cost=0.42..95.22 rows=1074 width=16) (actual time=0.083..0.280 rows=1158.00 loops=1)
  Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
  Heap Fetches: 0
  Index Searches: 1
  Buffers: shared hit=13
Planning Time: 0.163 ms
Execution Time: 0.390 ms
```

## Statement 3

SELECT count(*)::int AS n 
      FROM reviews rv
      JOIN reads r ON r.id = rv.read_id
      LEFT JOIN profiles p ON p.user_id = rv.user_id
      WHERE rv.work_id = $1::uuid
        AND rv.deleted_at IS NULL
        
        AND (EXISTS (SELECT 1 FROM users du WHERE du.id = rv.user_id AND du.deleted_at IS NULL AND (du.email_verified_at IS NOT NULL OR du.id = $2::uuid)) AND (
    rv.user_id = $3::uuid
    OR (
      -- The viewer's blocks either way, as one uncorrelated set the planner
      -- hashes once. The correlated form scanned blocks once per candidate
      -- row: 10,364 scans on the 5,300-review bench work (audit 09). Block
      -- ids are NOT NULL primary-key columns, so NOT IN is exact here.
      rv.user_id NOT IN (
        SELECT cb.blocked_id FROM blocks cb WHERE cb.blocker_id = $4::uuid
        UNION ALL
        SELECT cb.blocker_id FROM blocks cb WHERE cb.blocked_id = $5::uuid
      )
      AND (CASE
    WHEN rv.visibility = 'private' OR r.visibility = 'private' THEN 'private'
    WHEN rv.visibility = 'followers' OR r.visibility = 'followers' THEN 'followers'
    ELSE 'public' END) <> 'private'
      AND (
        ((CASE
    WHEN rv.visibility = 'private' OR r.visibility = 'private' THEN 'private'
    WHEN rv.visibility = 'followers' OR r.visibility = 'followers' THEN 'followers'
    ELSE 'public' END) = 'public' AND NOT COALESCE(p.is_private, true))
        OR EXISTS (
          SELECT 1 FROM follows cf
          WHERE cf.follower_id = $6::uuid AND cf.followee_id = rv.user_id AND cf.state = 'accepted'
        )
      )
    )
  ))

```
Aggregate  (cost=3865.44..3865.45 rows=1 width=4) (actual time=40.246..40.252 rows=1.00 loops=1)
  Buffers: shared hit=2653
  ->  Hash Join  (cost=1641.37..3863.81 rows=650 width=0) (actual time=9.266..39.866 rows=3885.00 loops=1)
        Hash Cond: (rv.user_id = du.id)
        Buffers: shared hit=2653
        ->  Hash Left Join  (cost=1484.34..3705.08 rows=650 width=16) (actual time=7.774..37.096 rows=3885.00 loops=1)
              Hash Cond: (rv.user_id = p.user_id)
              Filter: ((rv.user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR ((NOT (ANY (rv.user_id = (hashed SubPlan 1).col1))) AND (CASE WHEN ((rv.visibility = 'private'::text) OR (r.visibility = 'private'::text)) THEN 'private'::text WHEN ((rv.visibility = 'followers'::text) OR (r.visibility = 'followers'::text)) THEN 'followers'::text ELSE 'public'::text END <> 'private'::text) AND (((CASE WHEN ((rv.visibility = 'private'::text) OR (r.visibility = 'private'::text)) THEN 'private'::text WHEN ((rv.visibility = 'followers'::text) OR (r.visibility = 'followers'::text)) THEN 'followers'::text ELSE 'public'::text END = 'public'::text) AND (NOT COALESCE(p.is_private, true))) OR (ANY (rv.user_id = (hashed SubPlan 3).col1)))))
              Rows Removed by Filter: 1298
              Buffers: shared hit=2571
              ->  Hash Join  (cost=1276.33..3481.75 rows=2604 width=30) (actual time=6.296..31.388 rows=5183.00 loops=1)
                    Hash Cond: (r.id = rv.read_id)
                    Buffers: shared hit=2431
                    ->  Seq Scan on reads r  (cost=0.00..2041.69 rows=62369 width=23) (actual time=0.010..13.931 rows=62369.00 loops=1)
                          Buffers: shared hit=1418
                    ->  Hash  (cost=1243.78..1243.78 rows=2604 width=39) (actual time=6.238..6.240 rows=5183.00 loops=1)
                          Buckets: 8192 (originally 4096)  Batches: 1 (originally 1)  Memory Usage: 427kB
                          Buffers: shared hit=1013
                          ->  Seq Scan on reviews rv  (cost=16.46..1243.78 rows=2604 width=39) (actual time=0.085..4.314 rows=5183.00 loops=1)
                                Filter: ((deleted_at IS NULL) AND (work_id = '6ddee7fc-a0cc-4bd0-a981-db72ec1a9768'::uuid) AND ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (NOT (ANY (user_id = (hashed SubPlan 1).col1)))))
                                Rows Removed by Filter: 6817
                                Buffers: shared hit=1013
                                SubPlan 1
                                  ->  Append  (cost=0.27..16.46 rows=2 width=16) (actual time=0.035..0.036 rows=0.00 loops=2)
                                        Buffers: shared hit=6
                                        ->  Index Only Scan using blocks_pkey on blocks cb  (cost=0.27..8.29 rows=1 width=16) (actual time=0.023..0.023 rows=0.00 loops=2)
                                              Index Cond: (blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                              Heap Fetches: 0
                                              Index Searches: 2
                                              Buffers: shared hit=4
                                        ->  Index Scan using blocks_blocked_idx on blocks cb_1  (cost=0.14..8.16 rows=1 width=16) (actual time=0.011..0.011 rows=0.00 loops=2)
                                              Index Cond: (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                              Index Searches: 2
                                              Buffers: shared hit=2
              ->  Hash  (cost=154.02..154.02 rows=3002 width=17) (actual time=1.390..1.390 rows=3002.00 loops=1)
                    Buckets: 4096  Batches: 1  Memory Usage: 176kB
                    Buffers: shared hit=124
                    ->  Seq Scan on profiles p  (cost=0.00..154.02 rows=3002 width=17) (actual time=0.024..0.583 rows=3002.00 loops=1)
                          Buffers: shared hit=124
              SubPlan 3
                ->  Index Only Scan using follows_follower_list_idx on follows cf  (cost=0.42..95.22 rows=1074 width=16) (actual time=0.041..0.311 rows=1158.00 loops=1)
                      Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                      Heap Fetches: 0
                      Index Searches: 1
                      Buffers: shared hit=13
        ->  Hash  (cost=119.53..119.53 rows=3000 width=16) (actual time=1.436..1.437 rows=3000.00 loops=1)
              Buckets: 4096  Batches: 1  Memory Usage: 173kB
              Buffers: shared hit=82
              ->  Seq Scan on users du  (cost=0.00..119.53 rows=3000 width=16) (actual time=0.020..0.631 rows=3000.00 loops=1)
                    Filter: ((deleted_at IS NULL) AND ((email_verified_at IS NOT NULL) OR (id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                    Rows Removed by Filter: 2
                    Buffers: shared hit=82
Planning:
  Buffers: shared hit=39
Planning Time: 2.093 ms
Execution Time: 41.068 ms
```

## Statement 4

SELECT c.* FROM (SELECT rv.id, rv.user_id, rv.published_at, r.like_count, r.comment_count,
  char_length(rv.body) AS body_length, (rv.user_id = $1::uuid OR rv.user_id IN (
      SELECT f.followee_id FROM follows f WHERE f.follower_id = $2::uuid AND f.state = 'accepted')) AS friend 
      FROM reviews rv
      JOIN reads r ON r.id = rv.read_id
      LEFT JOIN profiles p ON p.user_id = rv.user_id
      WHERE rv.work_id = $3::uuid
        AND rv.deleted_at IS NULL
        
        AND (EXISTS (SELECT 1 FROM users du WHERE du.id = rv.user_id AND du.deleted_at IS NULL AND (du.email_verified_at IS NOT NULL OR du.id = $4::uuid)) AND (
    rv.user_id = $5::uuid
    OR (
      -- The viewer's blocks either way, as one uncorrelated set the planner
      -- hashes once. The correlated form scanned blocks once per candidate
      -- row: 10,364 scans on the 5,300-review bench work (audit 09). Block
      -- ids are NOT NULL primary-key columns, so NOT IN is exact here.
      rv.user_id NOT IN (
        SELECT cb.blocked_id FROM blocks cb WHERE cb.blocker_id = $6::uuid
        UNION ALL
        SELECT cb.blocker_id FROM blocks cb WHERE cb.blocked_id = $7::uuid
      )
      AND (CASE
    WHEN rv.visibility = 'private' OR r.visibility = 'private' THEN 'private'
    WHEN rv.visibility = 'followers' OR r.visibility = 'followers' THEN 'followers'
    ELSE 'public' END) <> 'private'
      AND (
        ((CASE
    WHEN rv.visibility = 'private' OR r.visibility = 'private' THEN 'private'
    WHEN rv.visibility = 'followers' OR r.visibility = 'followers' THEN 'followers'
    ELSE 'public' END) = 'public' AND NOT COALESCE(p.is_private, true))
        OR EXISTS (
          SELECT 1 FROM follows cf
          WHERE cf.follower_id = $8::uuid AND cf.followee_id = rv.user_id AND cf.state = 'accepted'
        )
      )
    )
  ))) c
        WHERE NOT c.friend AND c.like_count < $9 AND c.published_at >= $10::timestamptz

```
Nested Loop  (cost=229.99..270.57 rows=1 width=53) (actual time=0.035..0.037 rows=0.00 loops=1)
  Buffers: shared hit=2
  ->  Nested Loop Left Join  (cost=131.81..164.36 rows=1 width=572) (actual time=0.034..0.036 rows=0.00 loops=1)
        Filter: ((rv.user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR ((NOT (ANY (rv.user_id = (hashed SubPlan 2).col1))) AND (CASE WHEN ((rv.visibility = 'private'::text) OR (r.visibility = 'private'::text)) THEN 'private'::text WHEN ((rv.visibility = 'followers'::text) OR (r.visibility = 'followers'::text)) THEN 'followers'::text ELSE 'public'::text END <> 'private'::text) AND (((CASE WHEN ((rv.visibility = 'private'::text) OR (r.visibility = 'private'::text)) THEN 'private'::text WHEN ((rv.visibility = 'followers'::text) OR (r.visibility = 'followers'::text)) THEN 'followers'::text ELSE 'public'::text END = 'public'::text) AND (NOT COALESCE(p.is_private, true))) OR EXISTS(SubPlan 3))))
        Buffers: shared hit=2
        ->  Nested Loop  (cost=115.07..131.12 rows=1 width=586) (actual time=0.034..0.035 rows=0.00 loops=1)
              Buffers: shared hit=2
              ->  Index Scan using reviews_work_idx on reviews rv  (cost=114.65..122.68 rows=1 width=587) (actual time=0.033..0.034 rows=0.00 loops=1)
                    Index Cond: ((work_id = '6ddee7fc-a0cc-4bd0-a981-db72ec1a9768'::uuid) AND (published_at >= '2026-09-27 09:49:29.12+00'::timestamp with time zone))
                    Filter: ((deleted_at IS NULL) AND (user_id <> 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (NOT (ANY (user_id = (hashed SubPlan 5).col1))) AND ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (NOT (ANY (user_id = (hashed SubPlan 2).col1)))))
                    Index Searches: 1
                    Buffers: shared hit=2
                    SubPlan 5
                      ->  Index Only Scan using follows_follower_list_idx on follows f_1  (cost=0.42..95.22 rows=1074 width=16) (never executed)
                            Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                            Heap Fetches: 0
                            Index Searches: 0
                    SubPlan 2
                      ->  Append  (cost=0.27..16.46 rows=2 width=16) (never executed)
                            ->  Index Only Scan using blocks_pkey on blocks cb  (cost=0.27..8.29 rows=1 width=16) (never executed)
                                  Index Cond: (blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                  Heap Fetches: 0
                                  Index Searches: 0
                            ->  Index Scan using blocks_blocked_idx on blocks cb_1  (cost=0.14..8.16 rows=1 width=16) (never executed)
                                  Index Cond: (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                  Index Searches: 0
              ->  Index Scan using reads_pkey on reads r  (cost=0.41..8.43 rows=1 width=31) (never executed)
                    Index Cond: (id = rv.read_id)
                    Filter: (like_count < 5)
                    Index Searches: 0
        ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..8.30 rows=1 width=17) (never executed)
              Index Cond: (user_id = rv.user_id)
              Index Searches: 0
        SubPlan 3
          ->  Index Scan using follows_pkey on follows cf  (cost=0.42..8.44 rows=1 width=0) (never executed)
                Index Cond: ((follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) AND (followee_id = rv.user_id))
                Filter: (state = 'accepted'::text)
                Index Searches: 0
  ->  Index Scan using users_pkey on users du  (cost=0.28..8.30 rows=1 width=16) (never executed)
        Index Cond: (id = rv.user_id)
        Filter: ((deleted_at IS NULL) AND ((email_verified_at IS NOT NULL) OR (id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
        Index Searches: 0
  SubPlan 1
    ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..95.22 rows=1074 width=16) (never executed)
          Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
          Heap Fetches: 0
          Index Searches: 0
Planning:
  Buffers: shared hit=39
Planning Time: 2.378 ms
Execution Time: 0.375 ms
```

## Statement 5

SELECT c.*, (
      $1::float8 * CASE WHEN c.friend THEN $2::float8 ELSE $3::float8 END
      + $4::float8 * LEAST(1, log(1 + GREATEST(0, c.like_count)::float8) / 2)
      + $5::float8 * LEAST(1, log(1 + GREATEST(0, c.comment_count)::float8) / 1.5)
      + $6::float8 * exp(-GREATEST(0, extract(epoch FROM ($7::timestamptz - c.published_at))::float8) / 86400 / 45)
      + $8::float8 * CASE WHEN c.body_length BETWEEN 80 AND 600 THEN 1
          ELSE GREATEST(0.1, 1 - abs(c.body_length - 340)::float8 / 1200) END) AS lb FROM (SELECT rv.id, rv.user_id, rv.published_at, r.like_count, r.comment_count,
  char_length(rv.body) AS body_length, (rv.user_id = $9::uuid OR rv.user_id IN (
      SELECT f.followee_id FROM follows f WHERE f.follower_id = $10::uuid AND f.state = 'accepted')) AS friend 
      FROM reviews rv
      JOIN reads r ON r.id = rv.read_id
      LEFT JOIN profiles p ON p.user_id = rv.user_id
      WHERE rv.work_id = $11::uuid
        AND rv.deleted_at IS NULL
        
        AND (EXISTS (SELECT 1 FROM users du WHERE du.id = rv.user_id AND du.deleted_at IS NULL AND (du.email_verified_at IS NOT NULL OR du.id = $12::uuid)) AND (
    rv.user_id = $13::uuid
    OR (
      -- The viewer's blocks either way, as one uncorrelated set the planner
      -- hashes once. The correlated form scanned blocks once per candidate
      -- row: 10,364 scans on the 5,300-review bench work (audit 09). Block
      -- ids are NOT NULL primary-key columns, so NOT IN is exact here.
      rv.user_id NOT IN (
        SELECT cb.blocked_id FROM blocks cb WHERE cb.blocker_id = $14::uuid
        UNION ALL
        SELECT cb.blocker_id FROM blocks cb WHERE cb.blocked_id = $15::uuid
      )
      AND (CASE
    WHEN rv.visibility = 'private' OR r.visibility = 'private' THEN 'private'
    WHEN rv.visibility = 'followers' OR r.visibility = 'followers' THEN 'followers'
    ELSE 'public' END) <> 'private'
      AND (
        ((CASE
    WHEN rv.visibility = 'private' OR r.visibility = 'private' THEN 'private'
    WHEN rv.visibility = 'followers' OR r.visibility = 'followers' THEN 'followers'
    ELSE 'public' END) = 'public' AND NOT COALESCE(p.is_private, true))
        OR EXISTS (
          SELECT 1 FROM follows cf
          WHERE cf.follower_id = $16::uuid AND cf.followee_id = rv.user_id AND cf.state = 'accepted'
        )
      )
    )
  ))) c
      ORDER BY c.friend DESC, lb DESC, c.id LIMIT $17

```
Limit  (cost=4160.83..4161.33 rows=200 width=61) (actual time=122.751..122.799 rows=200.00 loops=1)
  Buffers: shared hit=2823
  ->  Sort  (cost=4160.83..4162.45 rows=650 width=61) (actual time=122.749..122.771 rows=200.00 loops=1)
        Sort Key: (((rv.user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (ANY (rv.user_id = (hashed SubPlan 1).col1)))) DESC, (((((('0.35'::double precision * CASE WHEN ((rv.user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (ANY (rv.user_id = (hashed SubPlan 2).col1))) THEN '1'::double precision ELSE '0.2'::double precision END) + ('0.2'::double precision * LEAST('1'::double precision, (log(('1'::double precision + (GREATEST(0, r.like_count))::double precision)) / '2'::double precision)))) + ('0.1'::double precision * LEAST('1'::double precision, (log(('1'::double precision + (GREATEST(0, r.comment_count))::double precision)) / '1.5'::double precision)))) + ('0.15'::double precision * exp((((- GREATEST('0'::double precision, (EXTRACT(epoch FROM ('2026-10-11 09:50:29.12+00'::timestamp with time zone - rv.published_at)))::double precision)) / '86400'::double precision) / '45'::double precision)))) + ('0.1'::double precision * CASE WHEN ((char_length(rv.body) >= 80) AND (char_length(rv.body) <= 600)) THEN '1'::double precision ELSE GREATEST('0.1'::double precision, ('1'::double precision - ((abs((char_length(rv.body) - 340)))::double precision / '1200'::double precision))) END))) DESC, rv.id
        Sort Method: top-N heapsort  Memory: 70kB
        Buffers: shared hit=2823
        ->  Hash Join  (cost=1837.16..4132.74 rows=650 width=61) (actual time=17.165..120.242 rows=3885.00 loops=1)
              Hash Cond: (rv.user_id = du.id)
              Buffers: shared hit=2823
              ->  Hash Left Join  (cost=1484.34..3705.08 rows=650 width=572) (actual time=13.921..50.250 rows=3885.00 loops=1)
                    Hash Cond: (rv.user_id = p.user_id)
                    Filter: ((rv.user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR ((NOT (ANY (rv.user_id = (hashed SubPlan 3).col1))) AND (CASE WHEN ((rv.visibility = 'private'::text) OR (r.visibility = 'private'::text)) THEN 'private'::text WHEN ((rv.visibility = 'followers'::text) OR (r.visibility = 'followers'::text)) THEN 'followers'::text ELSE 'public'::text END <> 'private'::text) AND (((CASE WHEN ((rv.visibility = 'private'::text) OR (r.visibility = 'private'::text)) THEN 'private'::text WHEN ((rv.visibility = 'followers'::text) OR (r.visibility = 'followers'::text)) THEN 'followers'::text ELSE 'public'::text END = 'public'::text) AND (NOT COALESCE(p.is_private, true))) OR (ANY (rv.user_id = (hashed SubPlan 5).col1)))))
                    Rows Removed by Filter: 1298
                    Buffers: shared hit=2571
                    ->  Hash Join  (cost=1276.33..3481.75 rows=2604 width=586) (actual time=12.180..42.937 rows=5183.00 loops=1)
                          Hash Cond: (r.id = rv.read_id)
                          Buffers: shared hit=2431
                          ->  Seq Scan on reads r  (cost=0.00..2041.69 rows=62369 width=31) (actual time=0.012..17.356 rows=62369.00 loops=1)
                                Buffers: shared hit=1418
                          ->  Hash  (cost=1243.78..1243.78 rows=2604 width=587) (actual time=12.114..12.117 rows=5183.00 loops=1)
                                Buckets: 8192 (originally 4096)  Batches: 1 (originally 1)  Memory Usage: 3314kB
                                Buffers: shared hit=1013
                                ->  Seq Scan on reviews rv  (cost=16.46..1243.78 rows=2604 width=587) (actual time=0.125..4.463 rows=5183.00 loops=1)
                                      Filter: ((deleted_at IS NULL) AND (work_id = '6ddee7fc-a0cc-4bd0-a981-db72ec1a9768'::uuid) AND ((user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid) OR (NOT (ANY (user_id = (hashed SubPlan 3).col1)))))
                                      Rows Removed by Filter: 6817
                                      Buffers: shared hit=1013
                                      SubPlan 3
                                        ->  Append  (cost=0.27..16.46 rows=2 width=16) (actual time=0.035..0.036 rows=0.00 loops=2)
                                              Buffers: shared hit=6
                                              ->  Index Only Scan using blocks_pkey on blocks cb  (cost=0.27..8.29 rows=1 width=16) (actual time=0.022..0.023 rows=0.00 loops=2)
                                                    Index Cond: (blocker_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                                    Heap Fetches: 0
                                                    Index Searches: 2
                                                    Buffers: shared hit=4
                                              ->  Index Scan using blocks_blocked_idx on blocks cb_1  (cost=0.14..8.16 rows=1 width=16) (actual time=0.012..0.012 rows=0.00 loops=2)
                                                    Index Cond: (blocked_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                                                    Index Searches: 2
                                                    Buffers: shared hit=2
                    ->  Hash  (cost=154.02..154.02 rows=3002 width=17) (actual time=1.662..1.662 rows=3002.00 loops=1)
                          Buckets: 4096  Batches: 1  Memory Usage: 176kB
                          Buffers: shared hit=124
                          ->  Seq Scan on profiles p  (cost=0.00..154.02 rows=3002 width=17) (actual time=0.017..0.590 rows=3002.00 loops=1)
                                Buffers: shared hit=124
                    SubPlan 5
                      ->  Index Only Scan using follows_follower_list_idx on follows cf  (cost=0.42..95.22 rows=1074 width=16) (actual time=0.041..0.226 rows=1158.00 loops=1)
                            Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                            Heap Fetches: 0
                            Index Searches: 1
                            Buffers: shared hit=13
              ->  Hash  (cost=119.53..119.53 rows=3000 width=16) (actual time=1.554..1.554 rows=3000.00 loops=1)
                    Buckets: 4096  Batches: 1  Memory Usage: 173kB
                    Buffers: shared hit=82
                    ->  Seq Scan on users du  (cost=0.00..119.53 rows=3000 width=16) (actual time=0.014..0.689 rows=3000.00 loops=1)
                          Filter: ((deleted_at IS NULL) AND ((email_verified_at IS NOT NULL) OR (id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)))
                          Rows Removed by Filter: 2
                          Buffers: shared hit=82
              SubPlan 1
                ->  Index Only Scan using follows_follower_list_idx on follows f  (cost=0.42..95.22 rows=1074 width=16) (actual time=0.046..0.311 rows=1158.00 loops=1)
                      Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                      Heap Fetches: 0
                      Index Searches: 1
                      Buffers: shared hit=13
              SubPlan 2
                ->  Index Only Scan using follows_follower_list_idx on follows f_1  (cost=0.42..95.22 rows=1074 width=16) (actual time=0.045..0.237 rows=1158.00 loops=1)
                      Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                      Heap Fetches: 0
                      Index Searches: 1
                      Buffers: shared hit=13
Planning:
  Buffers: shared hit=39
Planning Time: 3.144 ms
Execution Time: 124.773 ms
```

## Statement 6

SELECT DISTINCT f2.followee_id AS id
        FROM follows f1
        JOIN follows f2 ON f2.follower_id = f1.followee_id AND f2.state = 'accepted'
        WHERE f1.follower_id = $1::uuid
          AND f1.state = 'accepted'
          AND f2.followee_id IN ($2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14::uuid, $15::uuid, $16::uuid, $17::uuid, $18::uuid, $19::uuid, $20::uuid, $21::uuid, $22::uuid, $23::uuid, $24::uuid, $25::uuid, $26::uuid, $27::uuid, $28::uuid, $29::uuid, $30::uuid, $31::uuid, $32::uuid, $33::uuid, $34::uuid, $35::uuid, $36::uuid, $37::uuid, $38::uuid, $39::uuid, $40::uuid, $41::uuid, $42::uuid, $43::uuid, $44::uuid, $45::uuid, $46::uuid, $47::uuid, $48::uuid, $49::uuid, $50::uuid, $51::uuid, $52::uuid, $53::uuid, $54::uuid, $55::uuid, $56::uuid, $57::uuid, $58::uuid, $59::uuid, $60::uuid, $61::uuid, $62::uuid, $63::uuid, $64::uuid, $65::uuid, $66::uuid, $67::uuid, $68::uuid, $69::uuid, $70::uuid, $71::uuid, $72::uuid, $73::uuid, $74::uuid, $75::uuid, $76::uuid, $77::uuid, $78::uuid, $79::uuid, $80::uuid, $81::uuid, $82::uuid, $83::uuid, $84::uuid, $85::uuid, $86::uuid, $87::uuid, $88::uuid, $89::uuid, $90::uuid, $91::uuid, $92::uuid, $93::uuid, $94::uuid, $95::uuid, $96::uuid, $97::uuid, $98::uuid, $99::uuid, $100::uuid, $101::uuid, $102::uuid, $103::uuid, $104::uuid, $105::uuid, $106::uuid, $107::uuid, $108::uuid, $109::uuid, $110::uuid, $111::uuid, $112::uuid, $113::uuid, $114::uuid, $115::uuid, $116::uuid, $117::uuid, $118::uuid, $119::uuid, $120::uuid, $121::uuid, $122::uuid, $123::uuid, $124::uuid, $125::uuid, $126::uuid, $127::uuid, $128::uuid, $129::uuid, $130::uuid, $131::uuid, $132::uuid, $133::uuid, $134::uuid, $135::uuid, $136::uuid, $137::uuid, $138::uuid, $139::uuid, $140::uuid, $141::uuid, $142::uuid, $143::uuid, $144::uuid, $145::uuid, $146::uuid, $147::uuid, $148::uuid, $149::uuid, $150::uuid, $151::uuid, $152::uuid, $153::uuid, $154::uuid, $155::uuid, $156::uuid, $157::uuid, $158::uuid, $159::uuid, $160::uuid, $161::uuid, $162::uuid, $163::uuid, $164::uuid, $165::uuid, $166::uuid, $167::uuid, $168::uuid, $169::uuid, $170::uuid, $171::uuid, $172::uuid, $173::uuid, $174::uuid, $175::uuid, $176::uuid, $177::uuid, $178::uuid, $179::uuid, $180::uuid, $181::uuid, $182::uuid, $183::uuid, $184::uuid, $185::uuid)

```
HashAggregate  (cost=3841.73..3871.33 rows=2960 width=16) (actual time=26.897..26.933 rows=184.00 loops=1)
  Group Key: f2.followee_id
  Batches: 1  Memory Usage: 97kB
  Buffers: shared hit=2358
  ->  Hash Join  (cost=1048.09..3803.59 rows=15256 width=16) (actual time=4.669..23.151 rows=17927.00 loops=1)
        Hash Cond: (f2.follower_id = f1.followee_id)
        Buffers: shared hit=2358
        ->  Bitmap Heap Scan on follows f2  (cost=939.45..3585.30 rows=41706 width=32) (actual time=4.061..13.754 rows=48500.00 loops=1)
              Recheck Cond: ((followee_id = ANY ('{214c1d5d-aaab-410d-8286-7b014a74d557,45561da0-1c93-421d-a952-b46a520414fb,8d3359c1-6b80-4ed8-a1ac-e35bc96c9303,fdd4eab3-bd23-46a1-89e1-1040363dcd05,3ce32eae-16dc-44c6-91ba-8a2f52ba0d18,22e5d9f7-d34d-4b72-a696-0615d67af029,9d4d1b72-db4a-48e7-a9e0-655a1e5f9ee1,1c20f956-4b58-46e7-b8ed-b22fcbc90443,eb28397b-186b-40fd-9a17-6b5ce5e5560d,b39d3129-1391-40c1-97c7-d8070af442e8,e1bbb30c-bc62-4784-8c73-ee5bcde3f27e,d078cdb8-57c0-4c1a-9c87-0d34e6b78111,2c381454-e893-434e-9462-d1529f3813c9,28533879-2a02-456e-ad90-276ee298195a,fd715fb4-72e6-4a31-af38-9cf367cd2a6b,d9ef8fef-5f7f-4cc6-8705-3c8ceb96be5c,efa00403-c603-4e53-a2b5-f882f071835e,3399b4ee-0e5c-41bd-baee-a3f5aed8e61b,5783cd3c-fb2e-473b-baa7-aff8713f0381,fc0b21e7-4a18-4834-9242-ea3a77b0c326,5ea33872-5761-4042-8ef0-9a2e794a7471,a3bd8448-6c7d-4992-90db-cac61a31dcaf,55ae21e5-9eb2-4d3e-b3b7-e499d9eff3bf,4d655021-dbc2-40a0-b105-37febb68ef68,fe167aa1-36bf-4c8a-b69a-f6fce6fd7d6b,eb0a2381-1e39-43b7-9df2-bc170013e83d,be120559-89c0-4f56-84cd-c07872e58280,cdd3a31a-188b-4925-ab7b-9743939d0eac,a32e9dbc-c845-47f4-bc91-2b244c0c8582,616f1b7e-8729-43bd-9742-dc51aa9e4755,4c3cdd07-3de5-490f-8615-183d797d2671,a55f5488-ca02-4f68-bc34-70e256f8994e,0056a40c-7117-4491-9fe4-5ef1a1a9f1d9,91e46a6b-34a0-488d-8bc2-0c6297d12986,cbc46daa-5050-48bf-9499-45e5414ebc15,0a01f650-718c-4a45-98c1-d48d56737049,1e77e840-f656-43ec-b813-4cd3a4e243da,07f7cdab-16fd-4b8a-83f1-2d74dc1a46d7,5d0a5e38-daf9-4497-84b0-edcb530b2c6a,8db20c69-09f4-4c92-9642-6e336da99a6a,76fc005c-12f5-42af-9d9f-ae6d3cd2bde9,ff34cc42-ed79-41e2-9b65-a46e3f25938c,16c6a34d-c3bc-4b22-b50c-d9704046bec0,4ba91a9a-6856-4092-a279-f5e5caf97250,f484eb30-af75-4b61-b025-b01a11ad7250,faf12123-2ebf-4ac2-92d2-c75326d7c3e8,d911d2ba-e464-4918-ba14-129549e703a0,b66cd52d-ba03-47d7-bfac-79235151be52,ed72dd18-5f98-4392-9e31-9f80183749e7,3471878a-3ff2-423a-8f29-03cb3ae690b0,4f9d7e88-732f-4d98-be9a-5140671f6ac9,743648cd-6bf8-4792-8c9e-ed98641cca19,0903036b-cfae-4130-8286-573e6269486f,be82feff-bfee-43e3-9b18-8b9ee0ba6a99,79a8eea4-fa7e-4dd1-a09c-2509f6dd3196,05de0ec3-f7e2-4fa6-922a-680254696255,e67964a4-8140-4051-8483-b0fab2773495,3032193b-27a5-43b9-8fc8-2d421864d898,c121cace-b8ce-4d6f-b46d-7214f1f43cea,62a2dd2a-e4ac-4de4-ba08-e9e2897ffd9a,5372a5b6-a4bb-4871-8c37-7ea1ff481d79,b5660cb0-58b4-4b92-b13d-e7df1e6f8ae2,fca06d6b-3e07-42fe-bae9-3e5e81a2c971,2620786d-3efc-46a9-a611-d83a27a7d2e8,e66d507d-ca57-446d-af81-dbc21a05851a,155b9469-ebf7-4392-89be-17bba8f9696d,3b1829f1-90c1-435d-8dca-9d19dd9b29fb,c903278c-f8c4-44be-93c6-e01348667537,37ad19bf-a270-45c7-b5e2-484e2e156f7a,aace0231-8c2d-4f6e-ba39-7596fc0776bb,d27b7bfd-ffef-4bbc-babc-f1f74e4a0056,34f7b6d1-b115-4d39-bbea-2cc335c08b30,fb26613a-8dcd-40c2-9a00-f01da7305972,af857dab-a803-470f-80f0-b30913abed2c,76ed22c1-bebd-4767-b2d8-b06a1c0369f8,ff0c83ea-006b-49c0-aaf4-532603e7a697,dddc51dd-94e9-4ccb-9375-d0bf49b117b4,72be8eaf-0171-465c-a085-db4d4222837e,d234f3f7-0429-4c07-854b-d57019bfcd30,0476d37b-fa18-408f-815b-94dd7a2abba1,7603d41a-8df8-46c1-b73f-1187dd0f474c,c013f5f2-ef2e-42a8-b1a9-98a9e41568dd,a384304b-adb6-4cc5-a9c6-ccd7d7a00301,211fc0c9-df07-4f96-80dc-62a674c38ae6,e163faf2-e348-4c3f-92f2-112467795f10,b49e4b60-7d94-44fa-bc4d-ecd88c2ddf88,b1f9d83d-198f-47fa-9e74-8b262e490813,fadeb7a3-c15b-4f77-a839-72f8390a2e8d,e9c0bfd1-e8ec-41d7-bb50-6d21260783a5,24415e70-0c39-4e11-988e-696691025e04,e8d2c9b0-635c-400a-8f56-4e0ddf65eb1b,4d761b83-1884-4551-a36e-1fe50465cdd8,48729804-3ca3-485b-9014-63ace6721277,ac3016a6-dc11-4de8-aaf9-a4748b1a3787,e805fd07-be36-4fb2-885a-f5a026c6be23,e4d01bc7-77d8-4cac-a513-6830d14a2304,9b2c3c42-8562-41ac-b237-405df11b086f,3445dcde-bff7-4fbe-9abb-8798f4061aa0,bb3a8cb0-823e-465c-8db5-21785f4cecb9,f01b5209-8f80-4ca3-b63c-4b07621ff4d4,f9335598-e77d-411b-988e-a4a646b3cd68,c0b1d7a2-bb98-46bf-b91b-d8dff5405363,6eb2bd4d-f0b8-4c95-ad98-87f73522cd8e,68ff139e-8faf-475d-add2-dca7d710b9f1,6e19f7c7-a0cc-414b-bbca-7c8c868c1664,685ffc74-7ca2-4140-9f35-3d2055e23443,4f527913-44ba-49d4-b5f6-e277c8ca4d99,5fc7f3f4-8b44-4c85-b6fe-ebfcec255f58,bee4a0f7-48fd-4454-9f31-d9510eed6c91,77ababb9-d9fd-496b-849c-3545a4e7a209,2f3f7bdd-e1c0-4478-9cee-ad2d8f877a3b,ad934b04-9639-431a-b7a8-7d0679c5131b,a78ec6c9-54ec-4f04-9b3c-8500dbf3f17f,6e4ebf1c-99b8-409c-a4de-130b4f3a5bbc,57fae3c6-5df6-41c4-bf4c-53e3691da109,79335f92-0d9b-4558-9710-d64cb56adcda,b99e9404-8592-4d6e-9822-f0d92b45f9e3,4085fe38-1eb2-4117-afe9-2fda09e7cf46,7085790f-7cc3-4238-a1c6-d048edbfcb70,fe181c3b-65a7-4041-b08a-c71a0daaeed5,167605c3-5631-441a-bf4f-9fbfca12fd1d,fcdf4110-c848-4a0a-8fec-bf82ec7d7a3f,087c3daa-eb6d-44a2-8c8a-c1fa21f3ad57,6e490a82-0f2d-49e3-ac4c-0d874ed4bbb8,6c7597ad-3541-4771-837b-a559ccc6da7c,443ec79e-1706-4d1d-a265-58ff91b384ab,a8297085-96d7-4f12-a107-ee08c0e1ace8,13638871-bb1c-4cea-bcc5-aa06a37b9dc2,03de223b-6f50-43e9-9a72-d88fdbb365e2,5bf100ff-f548-47e9-a612-6cdaeadd15df,27c9e50a-5918-402c-a969-52aff9efc2f1,0c22f5aa-ffa4-4622-9916-ee8b867c6019,264151ca-fe25-4a50-a658-37d14d9d2c45,70369812-080d-45cf-8a43-8467314f10a2,3c7a52c1-bda4-43c7-bb01-b281e143ece4,c10a2759-45c8-4670-b817-0a7036045e8d,b9dce150-cae5-477f-bc5e-b892997ba29a,c4b8e8f9-2c86-4b94-bcbd-57bc0e36ad2f,0e3bdb77-ffba-4e3e-954a-56f50df0142e,bafebc68-39ef-45f2-8a37-cf11e294f6b2,2c4214d3-eb00-446a-947e-29a156168b0b,1a3763e7-62f5-4453-bab6-f04af0d6e70f,dfd95a4c-4528-41fb-8b4c-2e61dc62f503,61e8be2f-cabc-445c-a1f4-03325594fb5e,118082dc-43c6-4589-bb84-40b953985ddf,701e4c4b-5ebc-4ab5-9056-3b4aa92a07f5,4ff0bb64-1664-488e-965f-de0591e1f425,41515aa0-d186-4df0-9a22-06f03aa8cfb0,736fec43-6d38-4fe8-b332-8f03b898d0c2,1176c1ae-fd23-43d0-96ba-6184bb566646,8374bbda-4592-499c-9db4-7e5af4124c73,f35462dd-8209-4675-a3e7-b9baba3cbff5,1579e376-c6b8-4a94-a0c4-e47ce0225f60,c01da7e8-dd49-47ef-8a4c-8f98f83eaa8b,ac4a02b6-48fa-4180-bf8d-21d71acb1513,e4105b86-c923-4e69-b3de-f6c4cf5b5f29,daa5fded-d74c-4eec-b559-ffae23cd1a48,85ae4585-f587-4c30-a4f8-2fd632d69016,fda9c097-f810-4e01-9e03-2fe40f76eb16,afc5b1fd-0058-464b-80c1-187a0a63c382,f4f2da1c-e615-4275-b4d5-7baa3df39151,044b0d59-a10e-46a1-bf56-5f9b027a59cb,76253305-14ed-44b8-ac6a-7c2104bea6a0,301df0ab-ba95-4c1a-a80e-5c51e7cbaa7f,9b589cc6-1ea2-4ddf-ae22-69d998c73198,a9f10a87-94ca-4cd0-9ffe-1777682013a3,0bc3fa18-f6eb-4898-83ef-f83ca65521af,4b15d472-ac19-46b6-9e16-aa12a85eeab5,8d0650d8-e13f-4547-8d02-198e7055edba,a5fc1739-0dd8-49ce-ae3a-caae1a995e17,db12ada2-b44f-4ff8-9043-9649f9272ceb,d1b40bc4-5198-4140-9534-264a254630f5,a7191786-a75b-48b4-9469-5186713f600c,b82aa5dd-3467-4e93-8098-7cd1af266985,1bed09fe-5f8b-4d6f-8702-9bdf62bc5e08,0d7d069c-41e4-4713-ab44-28962408c08d,1e4af2a3-ff83-46bc-8a23-1a6e118361c3,edc60b4d-e27c-48e7-a831-a4dd205cb6d0,69dd1b7f-363e-4dfd-be18-15a2dc8e234f,546006ed-0651-4f88-9512-a2554732800f,f3970d51-0d4b-4858-9cab-a476723d4eea,fc2526a1-d776-482d-8c31-71ea719b721b,777d39a5-4980-40ab-8a28-a7adb570614b,c4969b1a-6b1f-4c26-9202-91f69138497a}'::uuid[])) AND (state = 'accepted'::text))
              Heap Blocks: exact=1916
              Buffers: shared hit=2345
              ->  Bitmap Index Scan on follows_followee_idx  (cost=0.00..928.56 rows=41706 width=0) (actual time=3.609..3.610 rows=48500.00 loops=1)
                    Index Cond: ((followee_id = ANY ('{214c1d5d-aaab-410d-8286-7b014a74d557,45561da0-1c93-421d-a952-b46a520414fb,8d3359c1-6b80-4ed8-a1ac-e35bc96c9303,fdd4eab3-bd23-46a1-89e1-1040363dcd05,3ce32eae-16dc-44c6-91ba-8a2f52ba0d18,22e5d9f7-d34d-4b72-a696-0615d67af029,9d4d1b72-db4a-48e7-a9e0-655a1e5f9ee1,1c20f956-4b58-46e7-b8ed-b22fcbc90443,eb28397b-186b-40fd-9a17-6b5ce5e5560d,b39d3129-1391-40c1-97c7-d8070af442e8,e1bbb30c-bc62-4784-8c73-ee5bcde3f27e,d078cdb8-57c0-4c1a-9c87-0d34e6b78111,2c381454-e893-434e-9462-d1529f3813c9,28533879-2a02-456e-ad90-276ee298195a,fd715fb4-72e6-4a31-af38-9cf367cd2a6b,d9ef8fef-5f7f-4cc6-8705-3c8ceb96be5c,efa00403-c603-4e53-a2b5-f882f071835e,3399b4ee-0e5c-41bd-baee-a3f5aed8e61b,5783cd3c-fb2e-473b-baa7-aff8713f0381,fc0b21e7-4a18-4834-9242-ea3a77b0c326,5ea33872-5761-4042-8ef0-9a2e794a7471,a3bd8448-6c7d-4992-90db-cac61a31dcaf,55ae21e5-9eb2-4d3e-b3b7-e499d9eff3bf,4d655021-dbc2-40a0-b105-37febb68ef68,fe167aa1-36bf-4c8a-b69a-f6fce6fd7d6b,eb0a2381-1e39-43b7-9df2-bc170013e83d,be120559-89c0-4f56-84cd-c07872e58280,cdd3a31a-188b-4925-ab7b-9743939d0eac,a32e9dbc-c845-47f4-bc91-2b244c0c8582,616f1b7e-8729-43bd-9742-dc51aa9e4755,4c3cdd07-3de5-490f-8615-183d797d2671,a55f5488-ca02-4f68-bc34-70e256f8994e,0056a40c-7117-4491-9fe4-5ef1a1a9f1d9,91e46a6b-34a0-488d-8bc2-0c6297d12986,cbc46daa-5050-48bf-9499-45e5414ebc15,0a01f650-718c-4a45-98c1-d48d56737049,1e77e840-f656-43ec-b813-4cd3a4e243da,07f7cdab-16fd-4b8a-83f1-2d74dc1a46d7,5d0a5e38-daf9-4497-84b0-edcb530b2c6a,8db20c69-09f4-4c92-9642-6e336da99a6a,76fc005c-12f5-42af-9d9f-ae6d3cd2bde9,ff34cc42-ed79-41e2-9b65-a46e3f25938c,16c6a34d-c3bc-4b22-b50c-d9704046bec0,4ba91a9a-6856-4092-a279-f5e5caf97250,f484eb30-af75-4b61-b025-b01a11ad7250,faf12123-2ebf-4ac2-92d2-c75326d7c3e8,d911d2ba-e464-4918-ba14-129549e703a0,b66cd52d-ba03-47d7-bfac-79235151be52,ed72dd18-5f98-4392-9e31-9f80183749e7,3471878a-3ff2-423a-8f29-03cb3ae690b0,4f9d7e88-732f-4d98-be9a-5140671f6ac9,743648cd-6bf8-4792-8c9e-ed98641cca19,0903036b-cfae-4130-8286-573e6269486f,be82feff-bfee-43e3-9b18-8b9ee0ba6a99,79a8eea4-fa7e-4dd1-a09c-2509f6dd3196,05de0ec3-f7e2-4fa6-922a-680254696255,e67964a4-8140-4051-8483-b0fab2773495,3032193b-27a5-43b9-8fc8-2d421864d898,c121cace-b8ce-4d6f-b46d-7214f1f43cea,62a2dd2a-e4ac-4de4-ba08-e9e2897ffd9a,5372a5b6-a4bb-4871-8c37-7ea1ff481d79,b5660cb0-58b4-4b92-b13d-e7df1e6f8ae2,fca06d6b-3e07-42fe-bae9-3e5e81a2c971,2620786d-3efc-46a9-a611-d83a27a7d2e8,e66d507d-ca57-446d-af81-dbc21a05851a,155b9469-ebf7-4392-89be-17bba8f9696d,3b1829f1-90c1-435d-8dca-9d19dd9b29fb,c903278c-f8c4-44be-93c6-e01348667537,37ad19bf-a270-45c7-b5e2-484e2e156f7a,aace0231-8c2d-4f6e-ba39-7596fc0776bb,d27b7bfd-ffef-4bbc-babc-f1f74e4a0056,34f7b6d1-b115-4d39-bbea-2cc335c08b30,fb26613a-8dcd-40c2-9a00-f01da7305972,af857dab-a803-470f-80f0-b30913abed2c,76ed22c1-bebd-4767-b2d8-b06a1c0369f8,ff0c83ea-006b-49c0-aaf4-532603e7a697,dddc51dd-94e9-4ccb-9375-d0bf49b117b4,72be8eaf-0171-465c-a085-db4d4222837e,d234f3f7-0429-4c07-854b-d57019bfcd30,0476d37b-fa18-408f-815b-94dd7a2abba1,7603d41a-8df8-46c1-b73f-1187dd0f474c,c013f5f2-ef2e-42a8-b1a9-98a9e41568dd,a384304b-adb6-4cc5-a9c6-ccd7d7a00301,211fc0c9-df07-4f96-80dc-62a674c38ae6,e163faf2-e348-4c3f-92f2-112467795f10,b49e4b60-7d94-44fa-bc4d-ecd88c2ddf88,b1f9d83d-198f-47fa-9e74-8b262e490813,fadeb7a3-c15b-4f77-a839-72f8390a2e8d,e9c0bfd1-e8ec-41d7-bb50-6d21260783a5,24415e70-0c39-4e11-988e-696691025e04,e8d2c9b0-635c-400a-8f56-4e0ddf65eb1b,4d761b83-1884-4551-a36e-1fe50465cdd8,48729804-3ca3-485b-9014-63ace6721277,ac3016a6-dc11-4de8-aaf9-a4748b1a3787,e805fd07-be36-4fb2-885a-f5a026c6be23,e4d01bc7-77d8-4cac-a513-6830d14a2304,9b2c3c42-8562-41ac-b237-405df11b086f,3445dcde-bff7-4fbe-9abb-8798f4061aa0,bb3a8cb0-823e-465c-8db5-21785f4cecb9,f01b5209-8f80-4ca3-b63c-4b07621ff4d4,f9335598-e77d-411b-988e-a4a646b3cd68,c0b1d7a2-bb98-46bf-b91b-d8dff5405363,6eb2bd4d-f0b8-4c95-ad98-87f73522cd8e,68ff139e-8faf-475d-add2-dca7d710b9f1,6e19f7c7-a0cc-414b-bbca-7c8c868c1664,685ffc74-7ca2-4140-9f35-3d2055e23443,4f527913-44ba-49d4-b5f6-e277c8ca4d99,5fc7f3f4-8b44-4c85-b6fe-ebfcec255f58,bee4a0f7-48fd-4454-9f31-d9510eed6c91,77ababb9-d9fd-496b-849c-3545a4e7a209,2f3f7bdd-e1c0-4478-9cee-ad2d8f877a3b,ad934b04-9639-431a-b7a8-7d0679c5131b,a78ec6c9-54ec-4f04-9b3c-8500dbf3f17f,6e4ebf1c-99b8-409c-a4de-130b4f3a5bbc,57fae3c6-5df6-41c4-bf4c-53e3691da109,79335f92-0d9b-4558-9710-d64cb56adcda,b99e9404-8592-4d6e-9822-f0d92b45f9e3,4085fe38-1eb2-4117-afe9-2fda09e7cf46,7085790f-7cc3-4238-a1c6-d048edbfcb70,fe181c3b-65a7-4041-b08a-c71a0daaeed5,167605c3-5631-441a-bf4f-9fbfca12fd1d,fcdf4110-c848-4a0a-8fec-bf82ec7d7a3f,087c3daa-eb6d-44a2-8c8a-c1fa21f3ad57,6e490a82-0f2d-49e3-ac4c-0d874ed4bbb8,6c7597ad-3541-4771-837b-a559ccc6da7c,443ec79e-1706-4d1d-a265-58ff91b384ab,a8297085-96d7-4f12-a107-ee08c0e1ace8,13638871-bb1c-4cea-bcc5-aa06a37b9dc2,03de223b-6f50-43e9-9a72-d88fdbb365e2,5bf100ff-f548-47e9-a612-6cdaeadd15df,27c9e50a-5918-402c-a969-52aff9efc2f1,0c22f5aa-ffa4-4622-9916-ee8b867c6019,264151ca-fe25-4a50-a658-37d14d9d2c45,70369812-080d-45cf-8a43-8467314f10a2,3c7a52c1-bda4-43c7-bb01-b281e143ece4,c10a2759-45c8-4670-b817-0a7036045e8d,b9dce150-cae5-477f-bc5e-b892997ba29a,c4b8e8f9-2c86-4b94-bcbd-57bc0e36ad2f,0e3bdb77-ffba-4e3e-954a-56f50df0142e,bafebc68-39ef-45f2-8a37-cf11e294f6b2,2c4214d3-eb00-446a-947e-29a156168b0b,1a3763e7-62f5-4453-bab6-f04af0d6e70f,dfd95a4c-4528-41fb-8b4c-2e61dc62f503,61e8be2f-cabc-445c-a1f4-03325594fb5e,118082dc-43c6-4589-bb84-40b953985ddf,701e4c4b-5ebc-4ab5-9056-3b4aa92a07f5,4ff0bb64-1664-488e-965f-de0591e1f425,41515aa0-d186-4df0-9a22-06f03aa8cfb0,736fec43-6d38-4fe8-b332-8f03b898d0c2,1176c1ae-fd23-43d0-96ba-6184bb566646,8374bbda-4592-499c-9db4-7e5af4124c73,f35462dd-8209-4675-a3e7-b9baba3cbff5,1579e376-c6b8-4a94-a0c4-e47ce0225f60,c01da7e8-dd49-47ef-8a4c-8f98f83eaa8b,ac4a02b6-48fa-4180-bf8d-21d71acb1513,e4105b86-c923-4e69-b3de-f6c4cf5b5f29,daa5fded-d74c-4eec-b559-ffae23cd1a48,85ae4585-f587-4c30-a4f8-2fd632d69016,fda9c097-f810-4e01-9e03-2fe40f76eb16,afc5b1fd-0058-464b-80c1-187a0a63c382,f4f2da1c-e615-4275-b4d5-7baa3df39151,044b0d59-a10e-46a1-bf56-5f9b027a59cb,76253305-14ed-44b8-ac6a-7c2104bea6a0,301df0ab-ba95-4c1a-a80e-5c51e7cbaa7f,9b589cc6-1ea2-4ddf-ae22-69d998c73198,a9f10a87-94ca-4cd0-9ffe-1777682013a3,0bc3fa18-f6eb-4898-83ef-f83ca65521af,4b15d472-ac19-46b6-9e16-aa12a85eeab5,8d0650d8-e13f-4547-8d02-198e7055edba,a5fc1739-0dd8-49ce-ae3a-caae1a995e17,db12ada2-b44f-4ff8-9043-9649f9272ceb,d1b40bc4-5198-4140-9534-264a254630f5,a7191786-a75b-48b4-9469-5186713f600c,b82aa5dd-3467-4e93-8098-7cd1af266985,1bed09fe-5f8b-4d6f-8702-9bdf62bc5e08,0d7d069c-41e4-4713-ab44-28962408c08d,1e4af2a3-ff83-46bc-8a23-1a6e118361c3,edc60b4d-e27c-48e7-a831-a4dd205cb6d0,69dd1b7f-363e-4dfd-be18-15a2dc8e234f,546006ed-0651-4f88-9512-a2554732800f,f3970d51-0d4b-4858-9cab-a476723d4eea,fc2526a1-d776-482d-8c31-71ea719b721b,777d39a5-4980-40ab-8a28-a7adb570614b,c4969b1a-6b1f-4c26-9202-91f69138497a}'::uuid[])) AND (state = 'accepted'::text))
                    Index Searches: 124
                    Buffers: shared hit=429
        ->  Hash  (cost=95.22..95.22 rows=1074 width=16) (actual time=0.579..0.580 rows=1158.00 loops=1)
              Buckets: 2048  Batches: 1  Memory Usage: 71kB
              Buffers: shared hit=13
              ->  Index Only Scan using follows_follower_list_idx on follows f1  (cost=0.42..95.22 rows=1074 width=16) (actual time=0.080..0.282 rows=1158.00 loops=1)
                    Index Cond: (follower_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid)
                    Heap Fetches: 0
                    Index Searches: 1
                    Buffers: shared hit=13
Planning:
  Buffers: shared hit=16
Planning Time: 1.380 ms
Execution Time: 27.275 ms
```

## Statement 7

SELECT rv.user_id,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY r.like_count) AS median
      FROM reviews rv
      JOIN reads r ON r.id = rv.read_id
      WHERE rv.user_id IN ($1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6::uuid, $7::uuid, $8::uuid, $9::uuid, $10::uuid, $11::uuid, $12::uuid, $13::uuid, $14::uuid, $15::uuid, $16::uuid, $17::uuid, $18::uuid, $19::uuid, $20::uuid, $21::uuid, $22::uuid, $23::uuid, $24::uuid, $25::uuid, $26::uuid, $27::uuid, $28::uuid, $29::uuid, $30::uuid, $31::uuid, $32::uuid, $33::uuid, $34::uuid, $35::uuid, $36::uuid, $37::uuid, $38::uuid, $39::uuid, $40::uuid, $41::uuid, $42::uuid, $43::uuid, $44::uuid, $45::uuid, $46::uuid, $47::uuid, $48::uuid, $49::uuid, $50::uuid, $51::uuid, $52::uuid, $53::uuid, $54::uuid, $55::uuid, $56::uuid, $57::uuid, $58::uuid, $59::uuid, $60::uuid, $61::uuid, $62::uuid, $63::uuid, $64::uuid, $65::uuid, $66::uuid, $67::uuid, $68::uuid, $69::uuid, $70::uuid, $71::uuid, $72::uuid, $73::uuid, $74::uuid, $75::uuid, $76::uuid, $77::uuid, $78::uuid, $79::uuid, $80::uuid, $81::uuid, $82::uuid, $83::uuid, $84::uuid, $85::uuid, $86::uuid, $87::uuid, $88::uuid, $89::uuid, $90::uuid, $91::uuid, $92::uuid, $93::uuid, $94::uuid, $95::uuid, $96::uuid, $97::uuid, $98::uuid, $99::uuid, $100::uuid, $101::uuid, $102::uuid, $103::uuid, $104::uuid, $105::uuid, $106::uuid, $107::uuid, $108::uuid, $109::uuid, $110::uuid, $111::uuid, $112::uuid, $113::uuid, $114::uuid, $115::uuid, $116::uuid, $117::uuid, $118::uuid, $119::uuid, $120::uuid, $121::uuid, $122::uuid, $123::uuid, $124::uuid, $125::uuid, $126::uuid, $127::uuid, $128::uuid, $129::uuid, $130::uuid, $131::uuid, $132::uuid, $133::uuid, $134::uuid, $135::uuid, $136::uuid, $137::uuid, $138::uuid, $139::uuid, $140::uuid, $141::uuid, $142::uuid, $143::uuid, $144::uuid, $145::uuid, $146::uuid, $147::uuid, $148::uuid, $149::uuid, $150::uuid, $151::uuid, $152::uuid, $153::uuid, $154::uuid, $155::uuid, $156::uuid, $157::uuid, $158::uuid, $159::uuid, $160::uuid, $161::uuid, $162::uuid, $163::uuid, $164::uuid, $165::uuid, $166::uuid, $167::uuid, $168::uuid, $169::uuid, $170::uuid, $171::uuid, $172::uuid, $173::uuid, $174::uuid, $175::uuid, $176::uuid, $177::uuid, $178::uuid, $179::uuid, $180::uuid, $181::uuid, $182::uuid, $183::uuid, $184::uuid) AND rv.deleted_at IS NULL
      GROUP BY rv.user_id

```
GroupAggregate  (cost=3394.10..3410.57 rows=700 width=24) (actual time=26.610..27.363 rows=184.00 loops=1)
  Group Key: rv.user_id
  Buffers: shared hit=2111
  ->  Sort  (cost=3394.10..3396.03 rows=772 width=20) (actual time=26.589..26.660 rows=796.00 loops=1)
        Sort Key: rv.user_id
        Sort Method: quicksort  Memory: 56kB
        Buffers: shared hit=2111
        ->  Hash Join  (cost=1151.65..3357.07 rows=772 width=20) (actual time=1.806..26.215 rows=796.00 loops=1)
              Hash Cond: (r.id = rv.read_id)
              Buffers: shared hit=2111
              ->  Seq Scan on reads r  (cost=0.00..2041.69 rows=62369 width=20) (actual time=0.035..15.342 rows=62369.00 loops=1)
                    Buffers: shared hit=1418
              ->  Hash  (cost=1142.00..1142.00 rows=772 width=32) (actual time=1.755..1.757 rows=796.00 loops=1)
                    Buckets: 1024  Batches: 1  Memory Usage: 58kB
                    Buffers: shared hit=693
                    ->  Bitmap Heap Scan on reviews rv  (cost=136.67..1142.00 rows=772 width=32) (actual time=0.713..1.489 rows=796.00 loops=1)
                          Recheck Cond: (user_id = ANY ('{214c1d5d-aaab-410d-8286-7b014a74d557,45561da0-1c93-421d-a952-b46a520414fb,8d3359c1-6b80-4ed8-a1ac-e35bc96c9303,fdd4eab3-bd23-46a1-89e1-1040363dcd05,3ce32eae-16dc-44c6-91ba-8a2f52ba0d18,22e5d9f7-d34d-4b72-a696-0615d67af029,9d4d1b72-db4a-48e7-a9e0-655a1e5f9ee1,1c20f956-4b58-46e7-b8ed-b22fcbc90443,eb28397b-186b-40fd-9a17-6b5ce5e5560d,b39d3129-1391-40c1-97c7-d8070af442e8,e1bbb30c-bc62-4784-8c73-ee5bcde3f27e,d078cdb8-57c0-4c1a-9c87-0d34e6b78111,2c381454-e893-434e-9462-d1529f3813c9,28533879-2a02-456e-ad90-276ee298195a,fd715fb4-72e6-4a31-af38-9cf367cd2a6b,d9ef8fef-5f7f-4cc6-8705-3c8ceb96be5c,efa00403-c603-4e53-a2b5-f882f071835e,3399b4ee-0e5c-41bd-baee-a3f5aed8e61b,5783cd3c-fb2e-473b-baa7-aff8713f0381,fc0b21e7-4a18-4834-9242-ea3a77b0c326,5ea33872-5761-4042-8ef0-9a2e794a7471,a3bd8448-6c7d-4992-90db-cac61a31dcaf,55ae21e5-9eb2-4d3e-b3b7-e499d9eff3bf,4d655021-dbc2-40a0-b105-37febb68ef68,fe167aa1-36bf-4c8a-b69a-f6fce6fd7d6b,eb0a2381-1e39-43b7-9df2-bc170013e83d,be120559-89c0-4f56-84cd-c07872e58280,cdd3a31a-188b-4925-ab7b-9743939d0eac,a32e9dbc-c845-47f4-bc91-2b244c0c8582,616f1b7e-8729-43bd-9742-dc51aa9e4755,4c3cdd07-3de5-490f-8615-183d797d2671,a55f5488-ca02-4f68-bc34-70e256f8994e,0056a40c-7117-4491-9fe4-5ef1a1a9f1d9,91e46a6b-34a0-488d-8bc2-0c6297d12986,cbc46daa-5050-48bf-9499-45e5414ebc15,0a01f650-718c-4a45-98c1-d48d56737049,1e77e840-f656-43ec-b813-4cd3a4e243da,07f7cdab-16fd-4b8a-83f1-2d74dc1a46d7,5d0a5e38-daf9-4497-84b0-edcb530b2c6a,8db20c69-09f4-4c92-9642-6e336da99a6a,76fc005c-12f5-42af-9d9f-ae6d3cd2bde9,ff34cc42-ed79-41e2-9b65-a46e3f25938c,16c6a34d-c3bc-4b22-b50c-d9704046bec0,4ba91a9a-6856-4092-a279-f5e5caf97250,f484eb30-af75-4b61-b025-b01a11ad7250,faf12123-2ebf-4ac2-92d2-c75326d7c3e8,d911d2ba-e464-4918-ba14-129549e703a0,b66cd52d-ba03-47d7-bfac-79235151be52,ed72dd18-5f98-4392-9e31-9f80183749e7,3471878a-3ff2-423a-8f29-03cb3ae690b0,4f9d7e88-732f-4d98-be9a-5140671f6ac9,743648cd-6bf8-4792-8c9e-ed98641cca19,0903036b-cfae-4130-8286-573e6269486f,be82feff-bfee-43e3-9b18-8b9ee0ba6a99,79a8eea4-fa7e-4dd1-a09c-2509f6dd3196,05de0ec3-f7e2-4fa6-922a-680254696255,e67964a4-8140-4051-8483-b0fab2773495,3032193b-27a5-43b9-8fc8-2d421864d898,c121cace-b8ce-4d6f-b46d-7214f1f43cea,62a2dd2a-e4ac-4de4-ba08-e9e2897ffd9a,5372a5b6-a4bb-4871-8c37-7ea1ff481d79,b5660cb0-58b4-4b92-b13d-e7df1e6f8ae2,fca06d6b-3e07-42fe-bae9-3e5e81a2c971,2620786d-3efc-46a9-a611-d83a27a7d2e8,e66d507d-ca57-446d-af81-dbc21a05851a,155b9469-ebf7-4392-89be-17bba8f9696d,3b1829f1-90c1-435d-8dca-9d19dd9b29fb,c903278c-f8c4-44be-93c6-e01348667537,37ad19bf-a270-45c7-b5e2-484e2e156f7a,aace0231-8c2d-4f6e-ba39-7596fc0776bb,d27b7bfd-ffef-4bbc-babc-f1f74e4a0056,34f7b6d1-b115-4d39-bbea-2cc335c08b30,fb26613a-8dcd-40c2-9a00-f01da7305972,af857dab-a803-470f-80f0-b30913abed2c,76ed22c1-bebd-4767-b2d8-b06a1c0369f8,ff0c83ea-006b-49c0-aaf4-532603e7a697,dddc51dd-94e9-4ccb-9375-d0bf49b117b4,72be8eaf-0171-465c-a085-db4d4222837e,d234f3f7-0429-4c07-854b-d57019bfcd30,0476d37b-fa18-408f-815b-94dd7a2abba1,7603d41a-8df8-46c1-b73f-1187dd0f474c,c013f5f2-ef2e-42a8-b1a9-98a9e41568dd,a384304b-adb6-4cc5-a9c6-ccd7d7a00301,211fc0c9-df07-4f96-80dc-62a674c38ae6,e163faf2-e348-4c3f-92f2-112467795f10,b49e4b60-7d94-44fa-bc4d-ecd88c2ddf88,b1f9d83d-198f-47fa-9e74-8b262e490813,fadeb7a3-c15b-4f77-a839-72f8390a2e8d,e9c0bfd1-e8ec-41d7-bb50-6d21260783a5,24415e70-0c39-4e11-988e-696691025e04,e8d2c9b0-635c-400a-8f56-4e0ddf65eb1b,4d761b83-1884-4551-a36e-1fe50465cdd8,48729804-3ca3-485b-9014-63ace6721277,ac3016a6-dc11-4de8-aaf9-a4748b1a3787,e805fd07-be36-4fb2-885a-f5a026c6be23,e4d01bc7-77d8-4cac-a513-6830d14a2304,9b2c3c42-8562-41ac-b237-405df11b086f,3445dcde-bff7-4fbe-9abb-8798f4061aa0,bb3a8cb0-823e-465c-8db5-21785f4cecb9,f01b5209-8f80-4ca3-b63c-4b07621ff4d4,f9335598-e77d-411b-988e-a4a646b3cd68,c0b1d7a2-bb98-46bf-b91b-d8dff5405363,6eb2bd4d-f0b8-4c95-ad98-87f73522cd8e,68ff139e-8faf-475d-add2-dca7d710b9f1,6e19f7c7-a0cc-414b-bbca-7c8c868c1664,685ffc74-7ca2-4140-9f35-3d2055e23443,4f527913-44ba-49d4-b5f6-e277c8ca4d99,5fc7f3f4-8b44-4c85-b6fe-ebfcec255f58,bee4a0f7-48fd-4454-9f31-d9510eed6c91,77ababb9-d9fd-496b-849c-3545a4e7a209,2f3f7bdd-e1c0-4478-9cee-ad2d8f877a3b,ad934b04-9639-431a-b7a8-7d0679c5131b,a78ec6c9-54ec-4f04-9b3c-8500dbf3f17f,6e4ebf1c-99b8-409c-a4de-130b4f3a5bbc,57fae3c6-5df6-41c4-bf4c-53e3691da109,79335f92-0d9b-4558-9710-d64cb56adcda,b99e9404-8592-4d6e-9822-f0d92b45f9e3,4085fe38-1eb2-4117-afe9-2fda09e7cf46,7085790f-7cc3-4238-a1c6-d048edbfcb70,fe181c3b-65a7-4041-b08a-c71a0daaeed5,167605c3-5631-441a-bf4f-9fbfca12fd1d,fcdf4110-c848-4a0a-8fec-bf82ec7d7a3f,087c3daa-eb6d-44a2-8c8a-c1fa21f3ad57,6e490a82-0f2d-49e3-ac4c-0d874ed4bbb8,6c7597ad-3541-4771-837b-a559ccc6da7c,443ec79e-1706-4d1d-a265-58ff91b384ab,a8297085-96d7-4f12-a107-ee08c0e1ace8,13638871-bb1c-4cea-bcc5-aa06a37b9dc2,03de223b-6f50-43e9-9a72-d88fdbb365e2,5bf100ff-f548-47e9-a612-6cdaeadd15df,27c9e50a-5918-402c-a969-52aff9efc2f1,0c22f5aa-ffa4-4622-9916-ee8b867c6019,264151ca-fe25-4a50-a658-37d14d9d2c45,70369812-080d-45cf-8a43-8467314f10a2,3c7a52c1-bda4-43c7-bb01-b281e143ece4,c10a2759-45c8-4670-b817-0a7036045e8d,b9dce150-cae5-477f-bc5e-b892997ba29a,c4b8e8f9-2c86-4b94-bcbd-57bc0e36ad2f,0e3bdb77-ffba-4e3e-954a-56f50df0142e,bafebc68-39ef-45f2-8a37-cf11e294f6b2,2c4214d3-eb00-446a-947e-29a156168b0b,1a3763e7-62f5-4453-bab6-f04af0d6e70f,dfd95a4c-4528-41fb-8b4c-2e61dc62f503,61e8be2f-cabc-445c-a1f4-03325594fb5e,118082dc-43c6-4589-bb84-40b953985ddf,701e4c4b-5ebc-4ab5-9056-3b4aa92a07f5,4ff0bb64-1664-488e-965f-de0591e1f425,41515aa0-d186-4df0-9a22-06f03aa8cfb0,736fec43-6d38-4fe8-b332-8f03b898d0c2,1176c1ae-fd23-43d0-96ba-6184bb566646,8374bbda-4592-499c-9db4-7e5af4124c73,f35462dd-8209-4675-a3e7-b9baba3cbff5,1579e376-c6b8-4a94-a0c4-e47ce0225f60,c01da7e8-dd49-47ef-8a4c-8f98f83eaa8b,ac4a02b6-48fa-4180-bf8d-21d71acb1513,e4105b86-c923-4e69-b3de-f6c4cf5b5f29,daa5fded-d74c-4eec-b559-ffae23cd1a48,85ae4585-f587-4c30-a4f8-2fd632d69016,fda9c097-f810-4e01-9e03-2fe40f76eb16,afc5b1fd-0058-464b-80c1-187a0a63c382,f4f2da1c-e615-4275-b4d5-7baa3df39151,044b0d59-a10e-46a1-bf56-5f9b027a59cb,76253305-14ed-44b8-ac6a-7c2104bea6a0,301df0ab-ba95-4c1a-a80e-5c51e7cbaa7f,9b589cc6-1ea2-4ddf-ae22-69d998c73198,a9f10a87-94ca-4cd0-9ffe-1777682013a3,0bc3fa18-f6eb-4898-83ef-f83ca65521af,4b15d472-ac19-46b6-9e16-aa12a85eeab5,8d0650d8-e13f-4547-8d02-198e7055edba,a5fc1739-0dd8-49ce-ae3a-caae1a995e17,db12ada2-b44f-4ff8-9043-9649f9272ceb,d1b40bc4-5198-4140-9534-264a254630f5,a7191786-a75b-48b4-9469-5186713f600c,b82aa5dd-3467-4e93-8098-7cd1af266985,1bed09fe-5f8b-4d6f-8702-9bdf62bc5e08,0d7d069c-41e4-4713-ab44-28962408c08d,1e4af2a3-ff83-46bc-8a23-1a6e118361c3,edc60b4d-e27c-48e7-a831-a4dd205cb6d0,69dd1b7f-363e-4dfd-be18-15a2dc8e234f,546006ed-0651-4f88-9512-a2554732800f,f3970d51-0d4b-4858-9cab-a476723d4eea,fc2526a1-d776-482d-8c31-71ea719b721b,777d39a5-4980-40ab-8a28-a7adb570614b,c4969b1a-6b1f-4c26-9202-91f69138497a}'::uuid[]))
                          Filter: (deleted_at IS NULL)
                          Rows Removed by Filter: 14
                          Heap Blocks: exact=547
                          Buffers: shared hit=693
                          ->  Bitmap Index Scan on reviews_user_idx  (cost=0.00..136.01 rows=788 width=0) (actual time=0.599..0.599 rows=810.00 loops=1)
                                Index Cond: (user_id = ANY ('{214c1d5d-aaab-410d-8286-7b014a74d557,45561da0-1c93-421d-a952-b46a520414fb,8d3359c1-6b80-4ed8-a1ac-e35bc96c9303,fdd4eab3-bd23-46a1-89e1-1040363dcd05,3ce32eae-16dc-44c6-91ba-8a2f52ba0d18,22e5d9f7-d34d-4b72-a696-0615d67af029,9d4d1b72-db4a-48e7-a9e0-655a1e5f9ee1,1c20f956-4b58-46e7-b8ed-b22fcbc90443,eb28397b-186b-40fd-9a17-6b5ce5e5560d,b39d3129-1391-40c1-97c7-d8070af442e8,e1bbb30c-bc62-4784-8c73-ee5bcde3f27e,d078cdb8-57c0-4c1a-9c87-0d34e6b78111,2c381454-e893-434e-9462-d1529f3813c9,28533879-2a02-456e-ad90-276ee298195a,fd715fb4-72e6-4a31-af38-9cf367cd2a6b,d9ef8fef-5f7f-4cc6-8705-3c8ceb96be5c,efa00403-c603-4e53-a2b5-f882f071835e,3399b4ee-0e5c-41bd-baee-a3f5aed8e61b,5783cd3c-fb2e-473b-baa7-aff8713f0381,fc0b21e7-4a18-4834-9242-ea3a77b0c326,5ea33872-5761-4042-8ef0-9a2e794a7471,a3bd8448-6c7d-4992-90db-cac61a31dcaf,55ae21e5-9eb2-4d3e-b3b7-e499d9eff3bf,4d655021-dbc2-40a0-b105-37febb68ef68,fe167aa1-36bf-4c8a-b69a-f6fce6fd7d6b,eb0a2381-1e39-43b7-9df2-bc170013e83d,be120559-89c0-4f56-84cd-c07872e58280,cdd3a31a-188b-4925-ab7b-9743939d0eac,a32e9dbc-c845-47f4-bc91-2b244c0c8582,616f1b7e-8729-43bd-9742-dc51aa9e4755,4c3cdd07-3de5-490f-8615-183d797d2671,a55f5488-ca02-4f68-bc34-70e256f8994e,0056a40c-7117-4491-9fe4-5ef1a1a9f1d9,91e46a6b-34a0-488d-8bc2-0c6297d12986,cbc46daa-5050-48bf-9499-45e5414ebc15,0a01f650-718c-4a45-98c1-d48d56737049,1e77e840-f656-43ec-b813-4cd3a4e243da,07f7cdab-16fd-4b8a-83f1-2d74dc1a46d7,5d0a5e38-daf9-4497-84b0-edcb530b2c6a,8db20c69-09f4-4c92-9642-6e336da99a6a,76fc005c-12f5-42af-9d9f-ae6d3cd2bde9,ff34cc42-ed79-41e2-9b65-a46e3f25938c,16c6a34d-c3bc-4b22-b50c-d9704046bec0,4ba91a9a-6856-4092-a279-f5e5caf97250,f484eb30-af75-4b61-b025-b01a11ad7250,faf12123-2ebf-4ac2-92d2-c75326d7c3e8,d911d2ba-e464-4918-ba14-129549e703a0,b66cd52d-ba03-47d7-bfac-79235151be52,ed72dd18-5f98-4392-9e31-9f80183749e7,3471878a-3ff2-423a-8f29-03cb3ae690b0,4f9d7e88-732f-4d98-be9a-5140671f6ac9,743648cd-6bf8-4792-8c9e-ed98641cca19,0903036b-cfae-4130-8286-573e6269486f,be82feff-bfee-43e3-9b18-8b9ee0ba6a99,79a8eea4-fa7e-4dd1-a09c-2509f6dd3196,05de0ec3-f7e2-4fa6-922a-680254696255,e67964a4-8140-4051-8483-b0fab2773495,3032193b-27a5-43b9-8fc8-2d421864d898,c121cace-b8ce-4d6f-b46d-7214f1f43cea,62a2dd2a-e4ac-4de4-ba08-e9e2897ffd9a,5372a5b6-a4bb-4871-8c37-7ea1ff481d79,b5660cb0-58b4-4b92-b13d-e7df1e6f8ae2,fca06d6b-3e07-42fe-bae9-3e5e81a2c971,2620786d-3efc-46a9-a611-d83a27a7d2e8,e66d507d-ca57-446d-af81-dbc21a05851a,155b9469-ebf7-4392-89be-17bba8f9696d,3b1829f1-90c1-435d-8dca-9d19dd9b29fb,c903278c-f8c4-44be-93c6-e01348667537,37ad19bf-a270-45c7-b5e2-484e2e156f7a,aace0231-8c2d-4f6e-ba39-7596fc0776bb,d27b7bfd-ffef-4bbc-babc-f1f74e4a0056,34f7b6d1-b115-4d39-bbea-2cc335c08b30,fb26613a-8dcd-40c2-9a00-f01da7305972,af857dab-a803-470f-80f0-b30913abed2c,76ed22c1-bebd-4767-b2d8-b06a1c0369f8,ff0c83ea-006b-49c0-aaf4-532603e7a697,dddc51dd-94e9-4ccb-9375-d0bf49b117b4,72be8eaf-0171-465c-a085-db4d4222837e,d234f3f7-0429-4c07-854b-d57019bfcd30,0476d37b-fa18-408f-815b-94dd7a2abba1,7603d41a-8df8-46c1-b73f-1187dd0f474c,c013f5f2-ef2e-42a8-b1a9-98a9e41568dd,a384304b-adb6-4cc5-a9c6-ccd7d7a00301,211fc0c9-df07-4f96-80dc-62a674c38ae6,e163faf2-e348-4c3f-92f2-112467795f10,b49e4b60-7d94-44fa-bc4d-ecd88c2ddf88,b1f9d83d-198f-47fa-9e74-8b262e490813,fadeb7a3-c15b-4f77-a839-72f8390a2e8d,e9c0bfd1-e8ec-41d7-bb50-6d21260783a5,24415e70-0c39-4e11-988e-696691025e04,e8d2c9b0-635c-400a-8f56-4e0ddf65eb1b,4d761b83-1884-4551-a36e-1fe50465cdd8,48729804-3ca3-485b-9014-63ace6721277,ac3016a6-dc11-4de8-aaf9-a4748b1a3787,e805fd07-be36-4fb2-885a-f5a026c6be23,e4d01bc7-77d8-4cac-a513-6830d14a2304,9b2c3c42-8562-41ac-b237-405df11b086f,3445dcde-bff7-4fbe-9abb-8798f4061aa0,bb3a8cb0-823e-465c-8db5-21785f4cecb9,f01b5209-8f80-4ca3-b63c-4b07621ff4d4,f9335598-e77d-411b-988e-a4a646b3cd68,c0b1d7a2-bb98-46bf-b91b-d8dff5405363,6eb2bd4d-f0b8-4c95-ad98-87f73522cd8e,68ff139e-8faf-475d-add2-dca7d710b9f1,6e19f7c7-a0cc-414b-bbca-7c8c868c1664,685ffc74-7ca2-4140-9f35-3d2055e23443,4f527913-44ba-49d4-b5f6-e277c8ca4d99,5fc7f3f4-8b44-4c85-b6fe-ebfcec255f58,bee4a0f7-48fd-4454-9f31-d9510eed6c91,77ababb9-d9fd-496b-849c-3545a4e7a209,2f3f7bdd-e1c0-4478-9cee-ad2d8f877a3b,ad934b04-9639-431a-b7a8-7d0679c5131b,a78ec6c9-54ec-4f04-9b3c-8500dbf3f17f,6e4ebf1c-99b8-409c-a4de-130b4f3a5bbc,57fae3c6-5df6-41c4-bf4c-53e3691da109,79335f92-0d9b-4558-9710-d64cb56adcda,b99e9404-8592-4d6e-9822-f0d92b45f9e3,4085fe38-1eb2-4117-afe9-2fda09e7cf46,7085790f-7cc3-4238-a1c6-d048edbfcb70,fe181c3b-65a7-4041-b08a-c71a0daaeed5,167605c3-5631-441a-bf4f-9fbfca12fd1d,fcdf4110-c848-4a0a-8fec-bf82ec7d7a3f,087c3daa-eb6d-44a2-8c8a-c1fa21f3ad57,6e490a82-0f2d-49e3-ac4c-0d874ed4bbb8,6c7597ad-3541-4771-837b-a559ccc6da7c,443ec79e-1706-4d1d-a265-58ff91b384ab,a8297085-96d7-4f12-a107-ee08c0e1ace8,13638871-bb1c-4cea-bcc5-aa06a37b9dc2,03de223b-6f50-43e9-9a72-d88fdbb365e2,5bf100ff-f548-47e9-a612-6cdaeadd15df,27c9e50a-5918-402c-a969-52aff9efc2f1,0c22f5aa-ffa4-4622-9916-ee8b867c6019,264151ca-fe25-4a50-a658-37d14d9d2c45,70369812-080d-45cf-8a43-8467314f10a2,3c7a52c1-bda4-43c7-bb01-b281e143ece4,c10a2759-45c8-4670-b817-0a7036045e8d,b9dce150-cae5-477f-bc5e-b892997ba29a,c4b8e8f9-2c86-4b94-bcbd-57bc0e36ad2f,0e3bdb77-ffba-4e3e-954a-56f50df0142e,bafebc68-39ef-45f2-8a37-cf11e294f6b2,2c4214d3-eb00-446a-947e-29a156168b0b,1a3763e7-62f5-4453-bab6-f04af0d6e70f,dfd95a4c-4528-41fb-8b4c-2e61dc62f503,61e8be2f-cabc-445c-a1f4-03325594fb5e,118082dc-43c6-4589-bb84-40b953985ddf,701e4c4b-5ebc-4ab5-9056-3b4aa92a07f5,4ff0bb64-1664-488e-965f-de0591e1f425,41515aa0-d186-4df0-9a22-06f03aa8cfb0,736fec43-6d38-4fe8-b332-8f03b898d0c2,1176c1ae-fd23-43d0-96ba-6184bb566646,8374bbda-4592-499c-9db4-7e5af4124c73,f35462dd-8209-4675-a3e7-b9baba3cbff5,1579e376-c6b8-4a94-a0c4-e47ce0225f60,c01da7e8-dd49-47ef-8a4c-8f98f83eaa8b,ac4a02b6-48fa-4180-bf8d-21d71acb1513,e4105b86-c923-4e69-b3de-f6c4cf5b5f29,daa5fded-d74c-4eec-b559-ffae23cd1a48,85ae4585-f587-4c30-a4f8-2fd632d69016,fda9c097-f810-4e01-9e03-2fe40f76eb16,afc5b1fd-0058-464b-80c1-187a0a63c382,f4f2da1c-e615-4275-b4d5-7baa3df39151,044b0d59-a10e-46a1-bf56-5f9b027a59cb,76253305-14ed-44b8-ac6a-7c2104bea6a0,301df0ab-ba95-4c1a-a80e-5c51e7cbaa7f,9b589cc6-1ea2-4ddf-ae22-69d998c73198,a9f10a87-94ca-4cd0-9ffe-1777682013a3,0bc3fa18-f6eb-4898-83ef-f83ca65521af,4b15d472-ac19-46b6-9e16-aa12a85eeab5,8d0650d8-e13f-4547-8d02-198e7055edba,a5fc1739-0dd8-49ce-ae3a-caae1a995e17,db12ada2-b44f-4ff8-9043-9649f9272ceb,d1b40bc4-5198-4140-9534-264a254630f5,a7191786-a75b-48b4-9469-5186713f600c,b82aa5dd-3467-4e93-8098-7cd1af266985,1bed09fe-5f8b-4d6f-8702-9bdf62bc5e08,0d7d069c-41e4-4713-ab44-28962408c08d,1e4af2a3-ff83-46bc-8a23-1a6e118361c3,edc60b4d-e27c-48e7-a831-a4dd205cb6d0,69dd1b7f-363e-4dfd-be18-15a2dc8e234f,546006ed-0651-4f88-9512-a2554732800f,f3970d51-0d4b-4858-9cab-a476723d4eea,fc2526a1-d776-482d-8c31-71ea719b721b,777d39a5-4980-40ab-8a28-a7adb570614b,c4969b1a-6b1f-4c26-9202-91f69138497a}'::uuid[]))
                                Index Searches: 63
                                Buffers: shared hit=146
Planning:
  Buffers: shared hit=14
Planning Time: 1.452 ms
Execution Time: 27.552 ms
```

## Statement 8

select "reviews"."id", "reviews"."read_id", "reviews"."user_id", "reviews"."work_id", "reviews"."body", "reviews"."has_spoilers", "reviews"."spoiler_after_page", "reviews"."visibility", "reviews"."published_at", "reviews"."edited_at", "reads"."rating", "reads"."hearted", "reads"."format_override", "reads"."like_count", "reads"."comment_count", "works"."title", "works"."ol_cover_id", "profiles"."username", "profiles"."display_name", "profiles"."avatar_key", EXISTS (SELECT 1 FROM read_likes l WHERE l.read_id = "reviews"."read_id" AND l.user_id = $1::uuid) from "reviews" inner join "reads" on "reads"."id" = "reviews"."read_id" inner join "works" on "works"."id" = "reviews"."work_id" left join "profiles" on "profiles"."user_id" = "reviews"."user_id" where "reviews"."id" in ($2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21)

```
Nested Loop Left Join  (cost=79.02..729.82 rows=20 width=746) (actual time=0.336..0.682 rows=20.00 loops=1)
  Buffers: shared hit=336
  ->  Nested Loop  (cost=78.74..487.16 rows=20 width=690) (actual time=0.272..0.469 rows=20.00 loops=1)
        Buffers: shared hit=215
        ->  Nested Loop  (cost=78.32..318.41 rows=20 width=662) (actual time=0.211..0.353 rows=20.00 loops=1)
              Buffers: shared hit=135
              ->  Bitmap Heap Scan on reviews  (cost=77.91..149.76 rows=20 width=616) (actual time=0.171..0.198 rows=20.00 loops=1)
                    Recheck Cond: (id = ANY ('{731dab14-1e7a-4e84-88d6-8195fe78e40d,a0a2cb24-aeb2-4743-9ffd-aa8cef513f5e,59fc8ae1-a209-4576-ae81-ad9937675187,55300c09-97bd-4e03-8fba-13d159b62ebe,25a9c0bd-61ee-4971-a714-b0f7ac63f4e2,fd33e510-6c56-45d1-9438-7c01dfba1ae6,cd3b266e-c8a8-4625-b374-f4827a02e21d,4e14c5af-d56b-4285-9c24-288f941538ae,23f5414b-008c-45f7-868d-6b85f6fc7857,c4513d16-c34b-42d4-bc3b-d334cbb93afb,9ad0e860-ae43-4b58-8406-1304435c0f92,a89fcff3-c4af-40e2-8a20-b75ba3474fe2,6db9fcde-a1cb-46d8-8131-a672dd9ee0d6,b40d38b3-227d-4bcd-88a0-1efbf445d735,3b1f12a6-d593-41ab-9f14-b699c50f4158,33c2ad07-f91e-4358-805c-3c3c41a99bc4,607c8403-4fc2-4e6c-958a-dd31d228530c,8fbcbcfa-5717-4583-b997-ada57f5afd3e,a2f7ea47-428a-4037-8972-b3dfa40a7318,3a3dd044-66ce-4283-a810-91f0f6772dfa}'::uuid[]))
                    Heap Blocks: exact=17
                    Buffers: shared hit=55
                    ->  Bitmap Index Scan on reviews_pkey  (cost=0.00..77.85 rows=20 width=0) (actual time=0.135..0.135 rows=20.00 loops=1)
                          Index Cond: (id = ANY ('{731dab14-1e7a-4e84-88d6-8195fe78e40d,a0a2cb24-aeb2-4743-9ffd-aa8cef513f5e,59fc8ae1-a209-4576-ae81-ad9937675187,55300c09-97bd-4e03-8fba-13d159b62ebe,25a9c0bd-61ee-4971-a714-b0f7ac63f4e2,fd33e510-6c56-45d1-9438-7c01dfba1ae6,cd3b266e-c8a8-4625-b374-f4827a02e21d,4e14c5af-d56b-4285-9c24-288f941538ae,23f5414b-008c-45f7-868d-6b85f6fc7857,c4513d16-c34b-42d4-bc3b-d334cbb93afb,9ad0e860-ae43-4b58-8406-1304435c0f92,a89fcff3-c4af-40e2-8a20-b75ba3474fe2,6db9fcde-a1cb-46d8-8131-a672dd9ee0d6,b40d38b3-227d-4bcd-88a0-1efbf445d735,3b1f12a6-d593-41ab-9f14-b699c50f4158,33c2ad07-f91e-4358-805c-3c3c41a99bc4,607c8403-4fc2-4e6c-958a-dd31d228530c,8fbcbcfa-5717-4583-b997-ada57f5afd3e,a2f7ea47-428a-4037-8972-b3dfa40a7318,3a3dd044-66ce-4283-a810-91f0f6772dfa}'::uuid[]))
                          Index Searches: 19
                          Buffers: shared hit=38
              ->  Index Scan using reads_pkey on reads  (cost=0.41..8.43 rows=1 width=62) (actual time=0.007..0.007 rows=1.00 loops=20)
                    Index Cond: (id = reviews.read_id)
                    Index Searches: 20
                    Buffers: shared hit=80
        ->  Index Scan using works_pkey on works  (cost=0.42..8.44 rows=1 width=44) (actual time=0.005..0.005 rows=1.00 loops=20)
              Index Cond: (id = reviews.work_id)
              Index Searches: 20
              Buffers: shared hit=80
  ->  Index Scan using profiles_pkey on profiles  (cost=0.28..7.70 rows=1 width=71) (actual time=0.004..0.004 rows=1.00 loops=20)
        Index Cond: (user_id = reviews.user_id)
        Index Searches: 20
        Buffers: shared hit=60
  SubPlan 1
    ->  Index Only Scan using read_likes_pkey on read_likes l  (cost=0.41..4.43 rows=1 width=0) (actual time=0.005..0.005 rows=0.05 loops=20)
          Index Cond: ((read_id = reviews.read_id) AND (user_id = 'bbe6dd12-05d0-461d-8a43-07ebffcf8bab'::uuid))
          Heap Fetches: 0
          Index Searches: 20
          Buffers: shared hit=61
Planning:
  Buffers: shared hit=43
Planning Time: 2.031 ms
Execution Time: 1.088 ms
```


---
# GET /v1/works/6ddee7fc-a0cc-4bd0-a981-db72ec1a9768/reviews?sort=newest as guest: 200, 101.1 ms, 4 statements

## Statement 1

SELECT merged_into_id FROM works WHERE id = $1

```
Index Scan using works_pkey on works  (cost=0.42..8.44 rows=1 width=16) (actual time=0.048..0.049 rows=1.00 loops=1)
  Index Cond: (id = '6ddee7fc-a0cc-4bd0-a981-db72ec1a9768'::uuid)
  Index Searches: 1
  Buffers: shared hit=4
Planning:
  Buffers: shared hit=1
Planning Time: 0.146 ms
Execution Time: 0.092 ms
```

## Statement 2

SELECT rv.id 
      FROM reviews rv
      JOIN reads r ON r.id = rv.read_id
      LEFT JOIN profiles p ON p.user_id = rv.user_id
      WHERE rv.work_id = $1::uuid
        AND rv.deleted_at IS NULL
        
        AND (EXISTS (SELECT 1 FROM users du WHERE du.id = rv.user_id AND du.deleted_at IS NULL AND du.email_verified_at IS NOT NULL) AND (CASE
    WHEN rv.visibility = 'private' OR r.visibility = 'private' THEN 'private'
    WHEN rv.visibility = 'followers' OR r.visibility = 'followers' THEN 'followers'
    ELSE 'public' END) = 'public' AND NOT COALESCE(p.is_private, true)) ORDER BY rv.published_at DESC, rv.id DESC LIMIT $2 OFFSET $3

```
Limit  (cost=3453.21..3453.24 rows=13 width=24) (actual time=87.518..87.529 rows=20.00 loops=1)
  Buffers: shared hit=24274
  ->  Sort  (cost=3453.21..3453.24 rows=13 width=24) (actual time=87.514..87.522 rows=20.00 loops=1)
        Sort Key: rv.published_at DESC, rv.id DESC
        Sort Method: top-N heapsort  Memory: 27kB
        Buffers: shared hit=24274
        ->  Nested Loop  (cost=1230.86..3452.96 rows=13 width=24) (actual time=11.463..85.582 rows=3451.00 loops=1)
              Buffers: shared hit=24268
              ->  Nested Loop Left Join  (cost=1230.58..3447.68 rows=13 width=40) (actual time=11.417..69.808 rows=3451.00 loops=1)
                    Filter: (NOT COALESCE(p.is_private, true))
                    Rows Removed by Filter: 378
                    Buffers: shared hit=13915
                    ->  Hash Join  (cost=1230.30..3435.71 rows=26 width=40) (actual time=11.259..52.294 rows=3829.00 loops=1)
                          Hash Cond: (r.id = rv.read_id)
                          Join Filter: (CASE WHEN ((rv.visibility = 'private'::text) OR (r.visibility = 'private'::text)) THEN 'private'::text WHEN ((rv.visibility = 'followers'::text) OR (r.visibility = 'followers'::text)) THEN 'followers'::text ELSE 'public'::text END = 'public'::text)
                          Rows Removed by Join Filter: 1354
                          Buffers: shared hit=2428
                          ->  Seq Scan on reads r  (cost=0.00..2041.69 rows=62369 width=23) (actual time=0.018..22.760 rows=62369.00 loops=1)
                                Buffers: shared hit=1418
                          ->  Hash  (cost=1165.22..1165.22 rows=5206 width=63) (actual time=11.128..11.129 rows=5183.00 loops=1)
                                Buckets: 8192  Batches: 1  Memory Usage: 548kB
                                Buffers: shared hit=1010
                                ->  Seq Scan on reviews rv  (cost=0.00..1165.22 rows=5206 width=63) (actual time=0.015..7.322 rows=5183.00 loops=1)
                                      Filter: ((deleted_at IS NULL) AND (work_id = '6ddee7fc-a0cc-4bd0-a981-db72ec1a9768'::uuid))
                                      Rows Removed by Filter: 6817
                                      Buffers: shared hit=1010
                    ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..0.45 rows=1 width=17) (actual time=0.003..0.003 rows=1.00 loops=3829)
                          Index Cond: (user_id = rv.user_id)
                          Index Searches: 3829
                          Buffers: shared hit=11487
              ->  Index Scan using users_pkey on users du  (cost=0.28..0.41 rows=1 width=16) (actual time=0.004..0.004 rows=1.00 loops=3451)
                    Index Cond: (id = rv.user_id)
                    Filter: ((deleted_at IS NULL) AND (email_verified_at IS NOT NULL))
                    Index Searches: 3451
                    Buffers: shared hit=10353
Planning:
  Buffers: shared hit=49
Planning Time: 2.548 ms
Execution Time: 88.317 ms
```

## Statement 3

SELECT count(*)::int AS n 
      FROM reviews rv
      JOIN reads r ON r.id = rv.read_id
      LEFT JOIN profiles p ON p.user_id = rv.user_id
      WHERE rv.work_id = $1::uuid
        AND rv.deleted_at IS NULL
        
        AND (EXISTS (SELECT 1 FROM users du WHERE du.id = rv.user_id AND du.deleted_at IS NULL AND du.email_verified_at IS NOT NULL) AND (CASE
    WHEN rv.visibility = 'private' OR r.visibility = 'private' THEN 'private'
    WHEN rv.visibility = 'followers' OR r.visibility = 'followers' THEN 'followers'
    ELSE 'public' END) = 'public' AND NOT COALESCE(p.is_private, true))

```
Aggregate  (cost=3453.00..3453.01 rows=1 width=4) (actual time=106.205..106.210 rows=1.00 loops=1)
  Buffers: shared hit=24268
  ->  Nested Loop  (cost=1230.86..3452.96 rows=13 width=0) (actual time=8.515..105.300 rows=3451.00 loops=1)
        Buffers: shared hit=24268
        ->  Nested Loop Left Join  (cost=1230.58..3447.68 rows=13 width=16) (actual time=8.461..86.265 rows=3451.00 loops=1)
              Filter: (NOT COALESCE(p.is_private, true))
              Rows Removed by Filter: 378
              Buffers: shared hit=13915
              ->  Hash Join  (cost=1230.30..3435.71 rows=26 width=16) (actual time=8.280..63.995 rows=3829.00 loops=1)
                    Hash Cond: (r.id = rv.read_id)
                    Join Filter: (CASE WHEN ((rv.visibility = 'private'::text) OR (r.visibility = 'private'::text)) THEN 'private'::text WHEN ((rv.visibility = 'followers'::text) OR (r.visibility = 'followers'::text)) THEN 'followers'::text ELSE 'public'::text END = 'public'::text)
                    Rows Removed by Join Filter: 1354
                    Buffers: shared hit=2428
                    ->  Seq Scan on reads r  (cost=0.00..2041.69 rows=62369 width=23) (actual time=0.025..30.992 rows=62369.00 loops=1)
                          Buffers: shared hit=1418
                    ->  Hash  (cost=1165.22..1165.22 rows=5206 width=39) (actual time=8.121..8.122 rows=5183.00 loops=1)
                          Buckets: 8192  Batches: 1  Memory Usage: 427kB
                          Buffers: shared hit=1010
                          ->  Seq Scan on reviews rv  (cost=0.00..1165.22 rows=5206 width=39) (actual time=0.015..5.636 rows=5183.00 loops=1)
                                Filter: ((deleted_at IS NULL) AND (work_id = '6ddee7fc-a0cc-4bd0-a981-db72ec1a9768'::uuid))
                                Rows Removed by Filter: 6817
                                Buffers: shared hit=1010
              ->  Index Scan using profiles_pkey on profiles p  (cost=0.28..0.45 rows=1 width=17) (actual time=0.004..0.004 rows=1.00 loops=3829)
                    Index Cond: (user_id = rv.user_id)
                    Index Searches: 3829
                    Buffers: shared hit=11487
        ->  Index Scan using users_pkey on users du  (cost=0.28..0.41 rows=1 width=16) (actual time=0.004..0.004 rows=1.00 loops=3451)
              Index Cond: (id = rv.user_id)
              Filter: ((deleted_at IS NULL) AND (email_verified_at IS NOT NULL))
              Index Searches: 3451
              Buffers: shared hit=10353
Planning:
  Buffers: shared hit=45
Planning Time: 3.442 ms
Execution Time: 106.849 ms
```

## Statement 4

select "reviews"."id", "reviews"."read_id", "reviews"."user_id", "reviews"."work_id", "reviews"."body", "reviews"."has_spoilers", "reviews"."spoiler_after_page", "reviews"."visibility", "reviews"."published_at", "reviews"."edited_at", "reads"."rating", "reads"."hearted", "reads"."format_override", "reads"."like_count", "reads"."comment_count", "works"."title", "works"."ol_cover_id", "profiles"."username", "profiles"."display_name", "profiles"."avatar_key", false from "reviews" inner join "reads" on "reads"."id" = "reviews"."read_id" inner join "works" on "works"."id" = "reviews"."work_id" left join "profiles" on "profiles"."user_id" = "reviews"."user_id" where "reviews"."id" in ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20)

```
Nested Loop Left Join  (cost=79.02..641.12 rows=20 width=746) (actual time=0.321..0.892 rows=20.00 loops=1)
  Buffers: shared hit=255
  ->  Nested Loop  (cost=78.74..487.16 rows=20 width=690) (actual time=0.265..0.682 rows=20.00 loops=1)
        Buffers: shared hit=195
        ->  Nested Loop  (cost=78.32..318.41 rows=20 width=662) (actual time=0.191..0.482 rows=20.00 loops=1)
              Buffers: shared hit=115
              ->  Bitmap Heap Scan on reviews  (cost=77.91..149.76 rows=20 width=616) (actual time=0.103..0.155 rows=20.00 loops=1)
                    Recheck Cond: (id = ANY ('{ffcd1ceb-74f5-4c99-8e97-6d22dc5ba254,ffb306fc-cee5-4bfc-8a5f-7ec24b2bc018,fe6bc0ab-da8b-4ef6-b938-e9b394986930,fca62630-69bc-4a93-8c94-41ba971f13ba,fc65a38e-7665-4ea6-a19f-8bc170f24b06,fc1fe7db-1928-4b36-9362-3b6e26c33029,fbc97a6d-e449-43f5-bbc1-df1aa228d7a5,fb7a7820-f4f3-4228-a3b8-078e68683227,fa6d3058-0a2e-4027-a801-bd0bae699f31,fa356e74-9a4f-448e-8b9c-7df1a1b7b307,f841c282-bb10-40bf-9852-f794a96b9faa,f3bc5b26-4f3e-4ef4-a3fa-beabbcb5d413,f3b9c394-dec0-4c70-99db-b373ec72fc39,f2fbbfd8-b97f-4056-bc68-6deb5503ad44,f294d162-6417-462a-ae22-0e11dc846bf4,f216711b-af71-4e6c-a08e-638a45f3ee57,f209f252-2656-49e3-9ed5-9674df056c9f,f183bcac-b65d-4bd2-9344-ba01154fc5d2,efb00e32-5bd7-4b1c-bde7-6214fafa5bfc,edce2d2f-a41a-44ed-aa94-653e9548b538}'::uuid[]))
                    Heap Blocks: exact=19
                    Buffers: shared hit=35
                    ->  Bitmap Index Scan on reviews_pkey  (cost=0.00..77.85 rows=20 width=0) (actual time=0.080..0.080 rows=20.00 loops=1)
                          Index Cond: (id = ANY ('{ffcd1ceb-74f5-4c99-8e97-6d22dc5ba254,ffb306fc-cee5-4bfc-8a5f-7ec24b2bc018,fe6bc0ab-da8b-4ef6-b938-e9b394986930,fca62630-69bc-4a93-8c94-41ba971f13ba,fc65a38e-7665-4ea6-a19f-8bc170f24b06,fc1fe7db-1928-4b36-9362-3b6e26c33029,fbc97a6d-e449-43f5-bbc1-df1aa228d7a5,fb7a7820-f4f3-4228-a3b8-078e68683227,fa6d3058-0a2e-4027-a801-bd0bae699f31,fa356e74-9a4f-448e-8b9c-7df1a1b7b307,f841c282-bb10-40bf-9852-f794a96b9faa,f3bc5b26-4f3e-4ef4-a3fa-beabbcb5d413,f3b9c394-dec0-4c70-99db-b373ec72fc39,f2fbbfd8-b97f-4056-bc68-6deb5503ad44,f294d162-6417-462a-ae22-0e11dc846bf4,f216711b-af71-4e6c-a08e-638a45f3ee57,f209f252-2656-49e3-9ed5-9674df056c9f,f183bcac-b65d-4bd2-9344-ba01154fc5d2,efb00e32-5bd7-4b1c-bde7-6214fafa5bfc,edce2d2f-a41a-44ed-aa94-653e9548b538}'::uuid[]))
                          Index Searches: 8
                          Buffers: shared hit=16
              ->  Index Scan using reads_pkey on reads  (cost=0.41..8.43 rows=1 width=62) (actual time=0.014..0.014 rows=1.00 loops=20)
                    Index Cond: (id = reviews.read_id)
                    Index Searches: 20
                    Buffers: shared hit=80
        ->  Index Scan using works_pkey on works  (cost=0.42..8.44 rows=1 width=44) (actual time=0.008..0.008 rows=1.00 loops=20)
              Index Cond: (id = reviews.work_id)
              Index Searches: 20
              Buffers: shared hit=80
  ->  Index Scan using profiles_pkey on profiles  (cost=0.28..7.70 rows=1 width=71) (actual time=0.008..0.008 rows=1.00 loops=20)
        Index Cond: (user_id = reviews.user_id)
        Index Searches: 20
        Buffers: shared hit=60
Planning:
  Buffers: shared hit=43
Planning Time: 2.812 ms
Execution Time: 1.128 ms
```

