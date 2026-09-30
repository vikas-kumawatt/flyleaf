# Bench: 09b-after-5

2026-09-30T11:56:25.107Z · commit `745a51d` (working tree dirty) · http://localhost:3000 · Node v22.20.0

Load pass: autocannon, 10 connections × 10 s per scenario (login: 2 connections × 40 requests), 10 s request timeout. **A timed-out request is counted in the percentiles at 10000 ms**, so a percentile equal to that value means "at least". Sequential pass: up to 15 requests one at a time (30 s timeout each, 60 s budget per scenario), for status codes, unloaded p50 and SQL statement counts.
Between scenarios the runner waits for Postgres to have no active statement (the server keeps executing requests their clients abandoned); **Drain** is how long that took after the load pass. A large drain means the scenario left a backlog. Requests still in flight when the duration ends are dropped by autocannon (one per connection is normal). A duration scenario that completed fewer than 3 requests per connection is marked **saturated**: most of its requests never finished inside the window, so its percentiles describe only the few that did and the unloaded p50 is the better guide.
Query counts: from `x-bench-query-count` (API started with `BENCH_COUNT_QUERIES=1`), median of the sequential pass, includes BEGIN/COMMIT.
Budgets (PRD §43): p95 < 300 ms overall, feed p95 < 200 ms, search p95 < 300 ms; p50 < 100, p99 < 800. ⚠ marks a breach **under this load**, which is 10 concurrent connections on one local process, not a production traffic model.

| Scenario | As | Load p50 | p95 | p99 | max | req/s | Completed | Non-2xx / timeouts (load) | Drain s | Unloaded p50 | Queries/req | Sequential statuses |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| work-reviews:friends:heavy ⚠ p50/p95 | heavy | 413 | 475 | 601 | 673 | 23.6 | 238 | 0 | 2.4 | 207 | 8 (8–11) | 200×15 |
| work-reviews:friends:guest | guest | 44 | 54 | 60 | 68 | 221.8 | 2229 | 0 | 1.9 | 23 | 3 (3–5) | 200×15 |

## Notes

- search:cjk dropped "ハリー" (0 local results; would trigger live gap-fill)

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
