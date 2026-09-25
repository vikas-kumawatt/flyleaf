# Bench: 02-search-before

2026-09-25T03:49:54.490Z · commit `1e1bf50` (working tree dirty) · http://localhost:3000 · Node v22.20.0

Load pass: autocannon, 10 connections × 10 s per scenario (login: 2 connections × 40 requests), 10 s request timeout. **A timed-out request is counted in the percentiles at 10000 ms**, so a percentile equal to that value means "at least". Sequential pass: up to 15 requests one at a time (30 s timeout each, 60 s budget per scenario), for status codes, unloaded p50 and SQL statement counts.
Between scenarios the runner waits for Postgres to have no active statement (the server keeps executing requests their clients abandoned); **Drain** is how long that took after the load pass. A large drain means the scenario left a backlog. Requests still in flight when the duration ends are dropped by autocannon (one per connection is normal). A duration scenario that completed fewer than 3 requests per connection is marked **saturated**: most of its requests never finished inside the window, so its percentiles describe only the few that did and the unloaded p50 is the better guide.
Query counts: from `x-bench-query-count` (API started with `BENCH_COUNT_QUERIES=1`), median of the sequential pass, includes BEGIN/COMMIT.
Budgets (PRD §43): p95 < 300 ms overall, feed p95 < 200 ms, search p95 < 300 ms; p50 < 100, p99 < 800. ⚠ marks a breach **under this load**, which is 10 concurrent connections on one local process, not a production traffic model.

| Scenario | As | Load p50 | p95 | p99 | max | req/s | Completed | Non-2xx / timeouts (load) | Drain s | Unloaded p50 | Queries/req | Sequential statuses |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| search:prefix ⚠ saturated/p95/p99 | guest | 86 | 10000 | 10000 | 10000 | 1 | 10 | ** timeouts×10 unfinished×10** | 42.3 | 26977 | 0 (0–1) | 200×2 timeout×1 |
| search:common ⚠ saturated/p50/p95/p99 | guest | 10000 | 10000 | 10000 | 10000 | 0 | 0 | ** timeouts×5 unfinished×10** | 171.0 | 30000 | — | timeout×2 |
| search:author ⚠ p50/p95/p99 | guest | 414 | 757 | 836 | 961 | 21.2 | 215 | 0 | 2.4 | 608 | 1 (1–1) | 200×15 |
| search:cjk ⚠ saturated/p50/p95/p99 | guest | 4267 | 10000 | 10000 | 10000 | 0.7 | 10 | ** timeouts×5 unfinished×10** | 300.1 | 30000 | — | timeout×1 |
| search:typo ⚠ saturated/p50/p95/p99 | guest | 6536 | 10000 | 10000 | 10000 | 0.9 | 11 | ** timeouts×4 unfinished×10** | 59.1 | 2372 | 1 (1–1) | 200×2 timeout×2 |
| search:isbn ⚠ p50/p95/p99 | guest | 261 | 457 | 855 | 901 | 33.9 | 343 | 0 | 2.1 | 144 | 2 (2–2) | 200×15 |

## Notes

- search:cjk dropped "ハリー" (1 local results; would trigger live gap-fill)

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
