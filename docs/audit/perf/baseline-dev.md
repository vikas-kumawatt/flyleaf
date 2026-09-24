# Bench: baseline-dev

2026-09-24T17:08:21.517Z · commit `664a811` (working tree dirty) · http://localhost:3000 · Node v22.20.0

Load pass: autocannon, 10 connections × 10 s per scenario (login: 2 connections × 40 requests), 10 s request timeout. **A timed-out request is counted in the percentiles at 10000 ms**, so a percentile equal to that value means "at least". Sequential pass: up to 15 requests one at a time (30 s timeout each, 60 s budget per scenario), for status codes, unloaded p50 and SQL statement counts.
Between scenarios the runner waits for Postgres to have no active statement (the server keeps executing requests their clients abandoned); **Drain** is how long that took after the load pass. A large drain means the scenario left a backlog. Requests still in flight when the duration ends are dropped by autocannon (one per connection is normal). A duration scenario that completed fewer than 3 requests per connection is marked **saturated**: most of its requests never finished inside the window, so its percentiles describe only the few that did and the unloaded p50 is the better guide.
Query counts: from `x-bench-query-count` (API started with `BENCH_COUNT_QUERIES=1`), median of the sequential pass, includes BEGIN/COMMIT.
Budgets (PRD §43): p95 < 300 ms overall, feed p95 < 200 ms, search p95 < 300 ms; p50 < 100, p99 < 800. ⚠ marks a breach **under this load**, which is 10 concurrent connections on one local process, not a production traffic model.

| Scenario | As | Load p50 | p95 | p99 | max | req/s | Completed | Non-2xx / timeouts (load) | Drain s | Unloaded p50 | Queries/req | Sequential statuses |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search:prefix ⚠ p50/p95/p99 | guest | 206 | 729 | 804 | 983 | 41.7 | 421 | 0 | 2.4 | 181 | 1 (0–1) | 200×15 |
| search:common ⚠ p50/p95/p99 | guest | 236 | 1204 | 1267 | 1315 | 24.4 | 246 | 0 | 2.7 | 201 | 1 (1–1) | 200×15 |
| search:author | guest | 43 | 80 | 91 | 123 | 199.6 | 2002 | 0 | 2.1 | 30 | 1 (1–1) | 200×15 |
| search:cjk ⚠ p95/p99 | guest | 77 | 2002 | 2277 | 2315 | 14.1 | 142 | 0 | 2.7 | 430 | 1 (1–1) | 200×15 |
| search:typo | guest | 61 | 224 | 269 | 303 | 97.7 | 983 | 0 | 2.1 | 54 | 1 (1–1) | 200×15 |
| search:isbn | guest | 30 | 41 | 49 | 70 | 319.7 | 3207 | 0 | 2.1 | 25 | 2 (2–2) | 200×15 |
| work:guest | guest | 3.4 | 5.5 | 7.0 | 23 | 2699 | 27017 | 0 | 1.9 | 1.6 | 0 (0–3) | 200×15 |
| work:signed-in | typical | 25 | 32 | 37 | 65 | 392.5 | 3941 | 0 | 2.1 | 12 | 2 (2–2) | 200×15 |
| work-reviews:friends:heavy ⚠ p50/p95/p99 | heavy | 2046 | 2666 | 2779 | 2779 | 4.2 | 43 | 0 | 2.9 | 619 | 5 (5–5) | 200×15 |
| work-reviews:friends:guest ⚠ p50/p95/p99 | guest | 1275 | 1667 | 2423 | 2423 | 7.4 | 74 | 0 | 2.9 | 279 | 2 (2–2) | 200×15 |
| review:get | typical | 30 | 37 | 44 | 65 | 321.5 | 3238 | 0 | 2.1 | 17 | 2 (2–2) | 200×15 |
| reads:mine:reading | heavy | 24 | 29 | 34 | 54 | 401.6 | 4032 | 0 | 1.9 | 16 | 2 (2–2) | 200×15 |
| reads:user | heavy | 52 | 61 | 67 | 82 | 189.8 | 1911 | 0 | 1.9 | 32 | 4 (4–4) | 200×15 |
| progress:post | typical | 62 | 115 | 165 | 2075 | 114.3 | 1153 | 0 | 2.9 | 29 | 4 (4–4) | 200×15 |
| stats:me | heavy | 45 | 53 | 60 | 72 | 218.7 | 2194 | 0 | 1.9 | 24 | 4 (4–4) | 200×15 |
| stats:user | typical | 57 | 65 | 71 | 83 | 172.1 | 1726 | 0 | 2.1 | 32 | 6 (6–6) | 200×15 |
| feed:friends:heavy ⚠ p50/p95 | heavy | 277 | 402 | 467 | 536 | 34.1 | 343 | 0 | 2.1 | 129 | 3 (3–3) | 200×15 |
| feed:friends:heavy:page2 ⚠ p50/p95 | heavy | 279 | 415 | 487 | 497 | 34 | 342 | 0 | 2.1 | 113 | 3 (3–3) | 200×15 |
| feed:friends:typical | typical | 81 | 93 | 99 | 105 | 121.7 | 1230 | 0 | 2.1 | 44 | 3 (3–3) | 200×15 |
| feed:friends:typical:page2 | typical | 73 | 84 | 96 | 123 | 134.7 | 1360 | 0 | 2.1 | 39 | 3 (3–3) | 200×15 |
| feed:friends:new ⚠ p50 | new | 148 | 165 | 237 | 249 | 66.3 | 667 | 0 | 2.1 | 91 | 3 (3–3) | 200×15 |
| feed:friends:new:page2 | new | 72 | 81 | 92 | 119 | 136 | 1370 | 0 | 2.1 | 36 | 3 (3–3) | 200×15 |
| feed:popular:guest | guest | 69 | 81 | 90 | 124 | 141 | 1420 | 0 | 1.9 | 37 | 2 (2–2) | 200×15 |
| followers:celebrity ⚠ p50 | typical | 199 | 229 | 263 | 271 | 48.5 | 490 | 0 | 2.1 | 55 | 6 (6–6) | 200×15 |
| shelves:browse ⚠ p50/p95/p99 | typical | 1042 | 1162 | 1432 | 1432 | 9.2 | 93 | 0 | 2.4 | 358 | 26 (26–26) | 200×15 |
| shelves:big:items ⚠ p50/p95/p99 | typical | 719 | 843 | 885 | 932 | 13.1 | 132 | 0 | 2.4 | 478 | 6 (6–6) | 200×15 |
| shelves:saved ⚠ p50/p95 | heavy | 457 | 510 | 525 | 537 | 20.9 | 210 | 0 | 2.1 | 218 | 56 (56–56) | 200×15 |
| comments:thread | typical | 57 | 68 | 74 | 80 | 171.8 | 1732 | 0 | 2.1 | 26 | 5 (5–5) | 200×15 |
| imports:list | heavy | 17 | 22 | 25 | 35 | 557.1 | 5588 | 0 | 2.1 | 8.7 | 1 (1–1) | 200×15 |
| exports:list | heavy | 17 | 22 | 27 | 42 | 562.5 | 5636 | 0 | 2.1 | 8.9 | 1 (1–1) | 200×15 |
| auth:login | guest | 46 | 64 | 78 | 78 | 39.6 | 40 | 0 | 1.9 | 55 | 3 (3–3) | 200×15 |

## Notes

- search:cjk dropped "ハリー" (0 local results; would trigger live gap-fill)
- `work:guest`: served from a 60 s in-process cache after the first request
- `work:signed-in`: served from a 60 s in-process cache after the first request
- `progress:post`: writes a progress_events row per request to a bench read (removed by --clean)
- `auth:login`: 2 connections, 40 requests, one per account (limit is 10/min per email); creates refresh_tokens rows for bench users (removed by --clean)

## Personas

| Persona | Username | Following | Followers |
|---|---|---|---|
| heavy | bench_u00006 | 1158 | 141 |
| typical | bench_u00182 | 40 | 22 |
| new | bench_u00011 | 0 | 0 |
| private_owner | bench_u00012 | 40 | 5 |
| blocked_pair_a | bench_u00013 | 379 | 36 |
| blocked_pair_b | bench_u00014 | 28 | 41 |
| celebrity | bench_u00001 | 48 | 2577 |
| reviewer_of_hot_work | bench_u00015 | 32 | 161 |

Seed: users 3000, private_users 300, follows 186014, pending_follows 9259, blocks 150, mutes 300, reads 62365, import_reads 9425, rereads 5156, progress_events 220584, reviews 12000, likes 40000, comments 8000, shelves 4005, shelf_items 79251, saves 1500, activity 142152 (generated 2026-09-24T13:46:15.893Z).
