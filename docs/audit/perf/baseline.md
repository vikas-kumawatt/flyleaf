# Bench: baseline

2026-09-24T14:53:13.592Z · commit `664a811` (working tree dirty) · http://localhost:3000 · Node v22.20.0

Load pass: autocannon, 10 connections × 10 s per scenario (login: 2 connections × 40 requests), 10 s request timeout. **A timed-out request is counted in the percentiles at 10000 ms**, so a percentile equal to that value means "at least". Sequential pass: up to 15 requests one at a time (30 s timeout each, 60 s budget per scenario), for status codes, unloaded p50 and SQL statement counts.
Between scenarios the runner waits for Postgres to have no active statement (the server keeps executing requests their clients abandoned); **Drain** is how long that took after the load pass. A large drain means the scenario left a backlog. Requests still in flight when the duration ends are dropped by autocannon (one per connection is normal). A duration scenario that completed fewer than 3 requests per connection is marked **saturated**: most of its requests never finished inside the window, so its percentiles describe only the few that did and the unloaded p50 is the better guide.
Query counts: from `x-bench-query-count` (API started with `BENCH_COUNT_QUERIES=1`), median of the sequential pass, includes BEGIN/COMMIT.
Budgets (PRD §43): p95 < 300 ms overall, feed p95 < 200 ms, search p95 < 300 ms; p50 < 100, p99 < 800. ⚠ marks a breach **under this load**, which is 10 concurrent connections on one local process, not a production traffic model.

| Scenario | As | Load p50 | p95 | p99 | max | req/s | Completed | Non-2xx / timeouts (load) | Drain s | Unloaded p50 | Queries/req | Sequential statuses |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search:prefix ⚠ saturated/p50/p95/p99 | guest | 6400 | 10000 | 10000 | 10000 | 1.1 | 13 | **timeouts×5 unfinished×10** | 29.4 | 5832 | 1 (0–1) | 200×9 |
| search:common ⚠ saturated/p50/p95/p99 | guest | 10000 | 10000 | 10000 | 10000 | 0 | 0 | **timeouts×10 unfinished×10** | 46.4 | 19328 | 1 (1–1) | 200×1 timeout×1 |
| search:author ⚠ p50/p95/p99 | guest | 416 | 785 | 836 | 961 | 21.6 | 218 | 0 | 2.3 | 456 | 1 (1–1) | 200×15 |
| search:cjk ⚠ saturated/p50/p95/p99 | guest | 3219 | 10000 | 10000 | 10000 | 0.7 | 10 | **timeouts×5 unfinished×10** | 158.2 | 30000 | — | timeout×1 |
| search:typo ⚠ saturated/p50/p95/p99 | guest | 1301 | 10000 | 10000 | 10000 | 0.6 | 6 | **timeouts×6 unfinished×10** | 87.5 | 7185 | 1 (1–1) | 200×2 timeout×1 |
| work:guest | guest | 1.2 | 2.1 | 4.1 | 1748 | 4404.2 | 47345 | 0 | 1.9 | 0.9 | 0 (0–3) | 200×15 |
| work:signed-in | typical | 9.7 | 16 | 99 | 606 | 813.3 | 8182 | 0 | 1.9 | 5.4 | 2 (2–2) | 200×15 |
| work-reviews:friends:heavy ⚠ saturated/p50/p95/p99 | heavy | 7455 | 10000 | 10000 | 10000 | 0.7 | 7 | **timeouts×3 unfinished×10** | 7.7 | 460 | 5 (5–5) | 200×15 |
| work-reviews:friends:guest ⚠ p50/p95/p99 | guest | 742 | 2163 | 2467 | 2467 | 7.4 | 75 | 0 | 4.7 | 429 | 2 (2–2) | 200×15 |
| review:get | typical | 14 | 131 | 198 | 366 | 421.4 | 4281 | 0 | 1.9 | 7.3 | 2 (2–2) | 200×15 |
| reads:mine:reading | heavy | 11 | 13 | 15 | 73 | 907.3 | 9100 | 0 | 1.9 | 6.0 | 2 (2–2) | 200×15 |
| reads:user | heavy | 24 | 29 | 34 | 57 | 409.4 | 4114 | 0 | 1.9 | 13 | 4 (4–4) | 200×15 |
| progress:post | typical | 19 | 27 | 38 | 86 | 493.1 | 4936 | 0 | 2.1 | 14 | 4 (4–4) | 200×15 |
| stats:me | heavy | 20 | 23 | 26 | 38 | 495 | 4955 | 0 | 2.1 | 10 | 4 (4–4) | 200×15 |
| stats:user | typical | 26 | 31 | 35 | 59 | 383 | 3841 | 0 | 2.1 | 11 | 6 (6–6) | 200×15 |
| feed:friends:heavy ⚠ p50/p95/p99 | heavy | 182 | 283 | 899 | 1038 | 49.8 | 502 | 0 | 2.7 | 92 | 3 (3–3) | 200×15 |
| feed:friends:heavy:page2 ⚠ p50/p95 | heavy | 168 | 229 | 276 | 321 | 58.7 | 591 | 0 | 2.1 | 56 | 3 (3–3) | 200×15 |
| feed:friends:typical | typical | 72 | 96 | 118 | 237 | 134.4 | 1355 | 0 | 2.1 | 33 | 3 (3–3) | 200×15 |
| feed:friends:typical:page2 | typical | 77 | 116 | 135 | 184 | 121.5 | 1224 | 0 | 2.1 | 33 | 3 (3–3) | 200×15 |
| feed:friends:new | new | 77 | 87 | 93 | 100 | 127.8 | 1291 | 0 | 2.1 | 44 | 3 (3–3) | 200×15 |
| feed:friends:new:page2 | new | 35 | 41 | 46 | 52 | 279.6 | 2821 | 0 | 1.8 | 16 | 3 (3–3) | 200×15 |
| feed:popular:guest | guest | 35 | 40 | 48 | 251 | 277.8 | 2792 | 0 | 2.1 | 17 | 2 (2–2) | 200×15 |
| followers:celebrity | typical | 99 | 115 | 125 | 150 | 99 | 999 | 0 | 2.1 | 21 | 6 (6–6) | 200×15 |
| shelves:browse ⚠ p50/p95/p99 | typical | 503 | 600 | 822 | 839 | 18.9 | 191 | 0 | 2.1 | 228 | 26 (26–26) | 200×15 |
| shelves:big:items ⚠ p50/p95 | typical | 395 | 419 | 459 | 639 | 24.7 | 249 | 0 | 2.4 | 299 | 6 (6–6) | 200×15 |
| shelves:saved ⚠ p50 | heavy | 206 | 231 | 243 | 247 | 47.6 | 480 | 0 | 2.1 | 78 | 56 (56–56) | 200×15 |
| comments:thread | typical | 23 | 27 | 30 | 38 | 422.6 | 4243 | 0 | 2.1 | 9.2 | 5 (5–5) | 200×15 |
| imports:list | heavy | 6.5 | 8.1 | 9.2 | 15 | 1498.6 | 15001 | 0 | 1.8 | 3.8 | 1 (1–1) | 200×15 |
| exports:list | heavy | 6.4 | 7.9 | 9.1 | 14 | 1519.1 | 15221 | 0 | 1.8 | 3.2 | 1 (1–1) | 200×15 |
| auth:login | guest | 30 | 34 | 36 | 36 | 39.6 | 40 | 0 | 1.9 | 23 | 3 (3–3) | 200×15 |

## Notes

- `search:isbn` is missing from this run: the preflight wrongly dropped the ISBN queries (an ISBN that resolves never reaches gap-fill). Fixed in run.ts and measured separately with the same method: **[baseline-search-isbn.md](baseline-search-isbn.md)**, p50 172 / p95 1,325 / p99 1,667 ms, 2 queries per request.
- Corrected after the run: autocannon counts a timeout as an error too, so the raw figures showed each timeout twice (as errors and timeouts) and under-counted unfinished requests by the timeout count. Fixed from the stored raw counts for: search:prefix, search:common, search:cjk, search:typo, work-reviews:friends:heavy. Percentiles were unaffected (each timeout had entered them once). run.ts is fixed for future runs.
- search:cjk dropped "ハリー" (1 local results; would trigger live gap-fill)
- search:isbn dropped "9780593189641" (1 local results; would trigger live gap-fill)
- search:isbn dropped "978-0-5931-8964-1" (1 local results; would trigger live gap-fill)
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
