# Performance: baseline-dev vs 15-after

Before: `baseline-dev` (2026-09-24T17:08:21.517Z, commit `664a811`, dirty). After: `15-after` (2026-10-11T07:44:20.781Z, commit `0b20fc1`, dirty).

Load pass: 10 connections × 10 s per scenario on one local process (the Part 01 runner). Budgets (PRD §43): p50 < 100 ms, p95 < 300 ms (feed < 200, search < 300), p99 < 800 ms. **Pass** means the *after* run meets all three under that load. Queries are the median statements per request from the sequential pass (`BENCH_COUNT_QUERIES=1`).

| Scenario | As | p95 budget | Before p50 / p95 / p99 ms | After p50 / p95 / p99 ms | p95 change | Queries before → after | After non-2xx | Result |
|---|---|---|---|---|---|---|---|---|
| search:prefix | guest | 300 | 206 / 729 / 804 | 175 / 455 / 519 | -38 % | 1 → 1 | 0 | ❌ p50, p95 |
| search:common | guest | 300 | 236 / 1204 / 1267 | 262 / 528 / 738 | -56 % | 1 → 1 | 0 | ❌ p50, p95 |
| search:author | guest | 300 | 43 / 80 / 91 | 61 / 85 / 104 | +6 % | 1 → 1 | 0 | ✅ |
| search:cjk | guest | 300 | 77 / 2002 / 2277 | 34 / 44 / 57 | -98 % | 1 → 1 | 0 | ✅ |
| search:typo | guest | 300 | 61 / 224 / 269 | 111 / 180 / 211 | -19 % | 1 → 1 | 0 | ❌ p50 |
| search:isbn | guest | 300 | 30 / 41 / 49 | 58 / 70 / 92 | +73 % | 2 → 2 | 0 | ✅ |
| work:guest | guest | 300 | 3.4 / 5.5 / 7.0 | 4.3 / 5.4 / 7.2 | -2 % | 0 → 0 | 0 | ✅ |
| work:signed-in | typical | 300 | 25 / 32 / 37 | 25 / 31 / 36 | -2 % | 2 → 2 | 0 | ✅ |
| work-reviews:friends:heavy | heavy | 300 | 2046 / 2666 / 2779 | 408 / 469 / 618 | -82 % | 5 → 8 | 0 | ❌ p50, p95 |
| work-reviews:friends:guest | guest | 300 | 1275 / 1667 / 2423 | 50 / 60 / 65 | -96 % | 2 → 3 | 0 | ✅ |
| review:get | typical | 300 | 30 / 37 / 44 | 33 / 42 / 53 | +12 % | 2 → 2 | 0 | ✅ |
| reads:mine:reading | heavy | 300 | 24 / 29 / 34 | 24 / 29 / 33 | -0 % | 2 → 2 | 0 | ✅ |
| reads:user | heavy | 300 | 52 / 61 / 67 | 45 / 57 / 65 | -7 % | 4 → 2 | 0 | ✅ |
| progress:post | typical | 300 | 62 / 115 / 165 | 48 / 57 / 67 | -50 % | 4 → 5 | 0 | ✅ |
| stats:me | heavy | 300 | 45 / 53 / 60 | 45 / 55 / 65 | +4 % | 4 → 4 | 0 | ✅ |
| stats:user | typical | 300 | 57 / 65 / 71 | 45 / 54 / 76 | -18 % | 6 → 4 | 0 | ✅ |
| feed:friends:heavy | heavy | 200 | 277 / 402 / 467 | 446 / 518 / 589 | +29 % | 3 → 6 | 0 | ❌ p50, p95 |
| feed:friends:heavy:page2 | heavy | 200 | 279 / 415 / 487 | 147 / 168 / 207 | -60 % | 3 → 5 | 0 | ❌ p50 |
| feed:friends:typical | typical | 200 | 81 / 93 / 99 | 109 / 122 / 139 | +32 % | 3 → 4 | 0 | ❌ p50 |
| feed:friends:typical:page2 | typical | 200 | 73 / 84 / 96 | 126 / 144 / 163 | +72 % | 3 → 5 | 0 | ❌ p50 |
| feed:friends:new | new | 200 | 148 / 165 / 237 | 26 / 30 / 34 | -82 % | 3 → 2 | 0 | ✅ |
| feed:friends:new:page2 | new | 200 | 72 / 81 / 92 | – | – | 3 → – | 0 | not measured: page 1 returned no next_cursor (the `new` persona's friends feed now fits on one page) |
| feed:popular:guest | guest | 200 | 69 / 81 / 90 | 14 / 17 / 21 | -79 % | 2 → 1 | 0 | ✅ |
| followers:celebrity | typical | 300 | 199 / 229 / 263 | 34 / 42 / 50 | -82 % | 6 → 3 | 0 | ✅ |
| shelves:browse | typical | 300 | 1042 / 1162 / 1432 | 70 / 82 / 97 | -93 % | 26 → 1 | 0 | ✅ |
| shelves:big:items | typical | 300 | 719 / 843 / 885 | 52 / 62 / 71 | -93 % | 6 → 4 | 0 | ✅ |
| shelves:saved | heavy | 300 | 457 / 510 / 525 | 39 / 51 / 57 | -90 % | 56 → 1 | 0 | ✅ |
| comments:thread | typical | 300 | 57 / 68 / 74 | 52 / 60 / 67 | -12 % | 5 → 4 | 0 | ✅ |
| imports:list | heavy | 300 | 17 / 22 / 25 | 16 / 20 / 22 | -10 % | 1 → 1 | 0 | ✅ |
| exports:list | heavy | 300 | 17 / 22 / 27 | 16 / 20 / 22 | -8 % | 1 → 1 | 0 | ✅ |
| auth:login | guest | 300 | 46 / 64 / 78 | 55 / 65 / 78 | +0 % | 3 → 3 | 0 | ✅ |
| work-reviews:newest:guest (new) | guest | 300 | – | 178 / 243 / 267 | – | – → 4 | 0 | ❌ p50 |
| review:post (new) | reviewer_of_hot_work | 300 | – | 186 / 1366 / 10000 | – | – → 10 | 4 | ❌ p50, p95, p99 |
| read:get (new) | typical | 300 | – | 26 / 33 / 40 | – | – → 2 | 0 | ✅ |
| user:get (new) | typical | 300 | – | 25 / 29 / 34 | – | – → 2 | 0 | ✅ |
| rate:post (new) | reviewer_of_hot_work | 300 | – | 94 / 479 / 5637 | – | – → 6 | 3 | ❌ p95, p99 |

**24 pass, 11 over budget, 1 not measured** (`feed:friends:new:page2`: no page 2 exists). Both runs: `flyleaf_dev`, same seed, same runner. The "after" ran with the limits added in 15a switched off (`BENCH_RATE_LIMITS=legacy`), after the A-15-024 fix (the first after-run had 500s on both shelf lists), with the container still unlimited (step 12 came later). **Budgets are indicative only on this 8 GB machine** (`00-method.md`): the entries below judge each row by its plan, not by the millisecond.

## Still over budget


Evidence files are in `perf/15b/`, all on `flyleaf_dev` (2026-10-11). Latencies above are under load (10 connections); the EXPLAIN times are single requests.

### search:prefix, search:common (p50 and p95), search:typo (p50 only)
- **EXPLAIN:** `explain-search-over-budget-dev.txt` (`th`, `the`, `war`, `harry pottr`; cold cache after a page-cache drop). `th` 1,785 ms, of which the `by_author` arm 696 ms; `the` 1,059 ms, `by_author` 860 ms; `war` 3,242 ms, `by_author` 1,895 ms; each also seq-scans `work_authors` (248k rows) for the ranking's author term. `harry pottr` 148 ms: the typo arms are cheap once warm; its ❌ is p50 under load only.
- **Cause:** the author arm and the ranking's author term join through `authors`/`work_authors` per candidate, and a common word matches thousands of authors. Step 9 counts it: `work_authors` 1,639 seq scans, 228M rows read in this session.
- **Plan:** A-02d-002, approved 29 Sep and in `PENDING.md`: copy credited author names onto `works` (trigram-indexed, kept by trigger and nightly reconcile), so `by_author` and the author term read `works` only. Acceptance there: p95 < 300 ms for `war`, `smith`, `king`, `lo`, `har`, `the` on `flyleaf`.

### work-reviews:friends:heavy (p50, p95), work-reviews:newest:guest (p50)
- **EXPLAIN:** `explain-work-reviews-dev.md`. Friends as heavy: 8 statements, 220 ms single request; three of them (41, 125 and 28 ms; the 125 ms one is the ranking) hash-join a **seq scan of all of `reads`** (62,369 rows) to filter the hot work's reviews. Newest as guest: 4 statements, 101 ms; the page (88 ms) and a separate `count(*)` (107 ms) each run the same `reviews ⋈ reads` join with the same seq scan.
- **Cause:** `visibleReviews()` filters on `rv.work_id` but joins `reads` for the read's visibility and rating; for a work with many reviews the planner hashes all of `reads`. The cost grows with the whole `reads` table, not with the work's reviews. The newest sort pays it twice (page + total).
- **Plan (≈ half a day):** select the page's review ids from `reviews` alone on an index `(work_id, published_at DESC, id)` with the visibility test as a semi-join probe per candidate, then join `reads` by primary key for the page only; take the total from a counter (or drop it for a cursor) instead of `count(*)`. Measure before/after on `flyleaf_dev`.

### feed:friends:heavy (p50, p95), feed:friends:heavy:page2 (p50)
- **EXPLAIN:** `feed-explain-heavy.md`: 6 statements, 144 ms single request; statement 4 (101 ms, 26k buffer hits) walks `activity_actor_idx` once per followed account (1,158 follows → 9,195 candidates, mutes as a join filter removing 116,539 rows) and top-N sorts to 76. Page 2 (`feed-explain-heavy-p2.md`): 5 statements, 95 ms; the same walk bounded by the cursor (20 ms).
- **Cause:** pull-model fan-in: cost grows with the number of follows. This is the §12.7 trigger (feed p95 > 200 ms), now **hit for `heavy`** (p95 518 ms; indicative on this machine).
- **Plan:** PRD §12.7's own: fan-out on write (a per-follower inbox of activity ids) for accounts above a follow threshold, the pull query kept for the rest. A design task with the owner, not an audit fix.

### feed:friends:typical, feed:friends:typical:page2 (p50 only)
- **EXPLAIN:** `feed-explain-typical.md` and `-p2.md`: 4 and 5 statements; planning 7.9 / 12.1 ms and execution 19.6 / 19.1 ms in total, against 55 / 124 ms per request.
- **Cause:** most of the time is outside SQL (round trips, hydration, the affinity step): 25–90 ms per request. Not profiled here. The planning share is the prepared-statements item 15a deferred.
- **Plan:** profile one typical request in process (`--cpu-prof`) before changing anything; then prepared statements (15a's Deferred) if planning is still a large share.

### review:post, rate:post (p95, p99; timeouts)
- **Evidence:** A-15-025 (`post-rerun-locks.txt`, `post-blocking-pids.txt`): all 10 connections write one `reads` row; holders take 0.05–0.3 s each, up to 9 queue, the unluckiest wait ~10 s. A-15-029: each holder also seq-scans `activity` (142k rows) inside the lock.
- **Plan:** ~~A-15-029's index (DECISION NEEDED)~~ built in 15c (`0042`). In the sandbox, on synthetic data with 1.14M activity rows, three runs each: `review:post` timeouts went from 4/4/3 to 0, p95 from 10,000/10,000/7,186 ms to 676/667/603 ms, throughput from ~6 to ~73 rps (`perf/15c/`). Not re-measured on `flyleaf_dev` (owner: no bench runs in 15c's laptop session). Then spread the scenario over one read per connection and re-measure (post-audit).
