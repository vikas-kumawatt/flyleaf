# Bench: 15-after

2026-10-11T07:44:20.781Z · commit `0b20fc1` (working tree dirty) · http://localhost:3000 · Node v22.20.0

Load pass: autocannon, 10 connections × 10 s per scenario (login: 2 connections × 40 requests), 10 s request timeout. **A timed-out request is counted in the percentiles at 10000 ms**, so a percentile equal to that value means "at least". Sequential pass: up to 15 requests one at a time (30 s timeout each, 60 s budget per scenario), for status codes, unloaded p50 and SQL statement counts.
Between scenarios the runner waits for Postgres to have no active statement (the server keeps executing requests their clients abandoned); **Drain** is how long that took after the load pass. A large drain means the scenario left a backlog. Requests still in flight when the duration ends are dropped by autocannon (one per connection is normal). A duration scenario that completed fewer than 3 requests per connection is marked **saturated**: most of its requests never finished inside the window, so its percentiles describe only the few that did and the unloaded p50 is the better guide.
Query counts: from `x-bench-query-count` (API started with `BENCH_COUNT_QUERIES=1`), median of the sequential pass, includes BEGIN/COMMIT.
Budgets (PRD §43): p95 < 300 ms overall, feed p95 < 200 ms, search p95 < 300 ms; p50 < 100, p99 < 800. ⚠ marks a breach **under this load**, which is 10 concurrent connections on one local process, not a production traffic model.

| Scenario | As | Load p50 | p95 | p99 | max | req/s | Completed | Non-2xx / timeouts (load) | Drain s | Unloaded p50 | Queries/req | Sequential statuses |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search:prefix ⚠ p50/p95 | guest | 175 | 455 | 519 | 638 | 53.2 | 537 | 0 | 2.1 | 141 | 1 (0–1) | 200×15 |
| search:common ⚠ p50/p95 | guest | 262 | 528 | 738 | 934 | 33.2 | 335 | 0 | 2.1 | 220 | 1 (1–1) | 200×15 |
| search:author | guest | 61 | 85 | 104 | 133 | 164 | 1650 | 0 | 2.1 | 41 | 1 (1–1) | 200×15 |
| search:cjk | guest | 34 | 44 | 57 | 79 | 282.3 | 2831 | 0 | 2.1 | 25 | 1 (1–1) | 200×15 |
| search:typo ⚠ p50 | guest | 111 | 180 | 211 | 260 | 83.7 | 841 | 0 | 2.1 | 76 | 1 (1–1) | 200×15 |
| search:isbn | guest | 58 | 70 | 92 | 139 | 173.5 | 1742 | 0 | 2.1 | 41 | 2 (2–2) | 200×15 |
| work:guest | guest | 4.3 | 5.4 | 7.2 | 24 | 2260.9 | 24892 | 0 | 1.9 | 1.7 | 0 (0–5) | 200×15 |
| work:signed-in | typical | 25 | 31 | 36 | 66 | 386.9 | 3888 | 0 | 2.1 | 11 | 2 (2–2) | 200×15 |
| work-reviews:friends:heavy ⚠ p50/p95 | heavy | 408 | 469 | 618 | 655 | 23.7 | 239 | 0 | 2.1 | 225 | 8 (8–8) | 200×15 |
| work-reviews:friends:guest | guest | 50 | 60 | 65 | 74 | 197.7 | 1989 | 0 | 1.8 | 21 | 3 (3–5) | 200×15 |
| review:get | typical | 33 | 42 | 53 | 66 | 295.1 | 2966 | 0 | 2.1 | 16 | 2 (2–2) | 200×15 |
| work-reviews:newest:guest ⚠ p50 | guest | 178 | 243 | 267 | 326 | 54.2 | 547 | 0 | 2.1 | 72 | 4 (4–4) | 200×15 |
| review:post ⚠ p50/p95/p99 | reviewer_of_hot_work | 186 | 1366 | 10000 | 10000 | 16.5 | 166 | ** timeouts×4** | 2.7 | 103 | 10 (10–10) | 200×15 |
| read:get | typical | 26 | 33 | 40 | 48 | 369.7 | 3723 | 0 | 2.1 | 12 | 2 (2–2) | 200×15 |
| user:get | typical | 25 | 29 | 34 | 40 | 397.3 | 3989 | 0 | 2.1 | 12 | 2 (2–2) | 200×15 |
| reads:mine:reading | heavy | 24 | 29 | 33 | 51 | 410.4 | 4129 | 0 | 1.8 | 15 | 2 (2–2) | 200×15 |
| reads:user | heavy | 45 | 57 | 65 | 82 | 219 | 2205 | 0 | 2.1 | 26 | 2 (2–2) | 200×15 |
| progress:post | typical | 48 | 57 | 67 | 96 | 204.9 | 2055 | 0 | 2.1 | 29 | 5 (5–5) | 200×15 |
| rate:post ⚠ p95/p99 | reviewer_of_hot_work | 94 | 479 | 5637 | 10000 | 34.3 | 345 | ** timeouts×3** | 2.4 | 39 | 6 (6–6) | 200×15 |
| stats:me | heavy | 45 | 55 | 65 | 83 | 215.9 | 2168 | 0 | 2.1 | 18 | 4 (4–4) | 200×15 |
| stats:user | typical | 45 | 54 | 76 | 101 | 217.6 | 2180 | 0 | 2.1 | 17 | 4 (4–4) | 200×15 |
| feed:friends:heavy ⚠ p50/p95 | heavy | 446 | 518 | 589 | 630 | 21.8 | 220 | 0 | 2.4 | 300 | 6 (6–6) | 200×15 |
| feed:friends:heavy:page2 ⚠ p50 | heavy | 147 | 168 | 207 | 228 | 67.2 | 679 | 0 | 2.1 | 85 | 5 (5–5) | 200×15 |
| feed:friends:typical ⚠ p50 | typical | 109 | 122 | 139 | 144 | 90.3 | 913 | 0 | 2.1 | 59 | 4 (4–4) | 200×15 |
| feed:friends:typical:page2 ⚠ p50 | typical | 126 | 144 | 163 | 173 | 78.7 | 794 | 0 | 1.9 | 72 | 5 (5–5) | 200×15 |
| feed:friends:new | new | 26 | 30 | 34 | 53 | 386.3 | 3875 | 0 | 1.8 | 15 | 2 (2–2) | 200×15 |
| feed:friends:new:page2 | new | — | — | — | — | — | — | — | — | — | — | SKIPPED: page 1 returned no next_cursor |
| feed:popular:guest | guest | 14 | 17 | 21 | 35 | 714.7 | 7154 | 0 | 1.9 | 9.9 | 1 (1–1) | 200×15 |
| followers:celebrity | typical | 34 | 42 | 50 | 72 | 288.1 | 2887 | 0 | 2.1 | 16 | 3 (3–3) | 200×15 |
| shelves:browse | typical | 70 | 82 | 97 | 112 | 140.7 | 1415 | 0 | 2.1 | 52 | 1 (1–1) | 200×15 |
| shelves:big:items | typical | 52 | 62 | 71 | 101 | 190.1 | 1914 | 0 | 1.8 | 24 | 4 (4–4) | 200×15 |
| shelves:saved | heavy | 39 | 51 | 57 | 71 | 251.1 | 2524 | 0 | 2.1 | 17 | 1 (1–1) | 200×15 |
| comments:thread | typical | 52 | 60 | 67 | 79 | 189.7 | 1908 | 0 | 2.1 | 22 | 4 (4–4) | 200×15 |
| imports:list | heavy | 16 | 20 | 22 | 32 | 608.1 | 6099 | 0 | 1.8 | 8.2 | 1 (1–1) | 200×15 |
| exports:list | heavy | 16 | 20 | 22 | 36 | 620.3 | 6215 | 0 | 1.9 | 7.5 | 1 (1–1) | 200×15 |
| auth:login | guest | 55 | 65 | 78 | 78 | 19.9 | 40 | 0 | 1.9 | 52 | 3 (3–3) | 200×15 |

## Notes

- search:cjk dropped "ハリー" (0 local results; would trigger live gap-fill)
- `work:guest`: served from a 60 s in-process cache after the first request
- `work:signed-in`: served from a 60 s in-process cache after the first request
- `review:post`: edits the hot review (bench data) and its read's rating; writes no new rows
- `progress:post`: writes a progress_events row per request to a bench read (removed by --clean)
- `rate:post`: finishes the hot review's read with a changing rating; rewrites that bench read and adds an activity row per request (removed by --clean)
- `feed:friends:new:page2`: SKIPPED: page 1 returned no next_cursor
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
