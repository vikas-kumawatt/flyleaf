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
| feed:friends:new:page2 | new | 200 | 72 / 81 / 92 | – | – | 3 → – | 0 | TBD in 15b |
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

**24 pass, 11 over budget, 1 TBD.** Each scenario still over budget needs its own entry below with its EXPLAIN evidence and a plan.

## Still over budget

(one entry per ❌ row: EXPLAIN (ANALYZE, BUFFERS), cause, concrete plan)
