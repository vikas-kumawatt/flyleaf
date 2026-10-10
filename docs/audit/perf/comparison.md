# Performance: baseline-dev vs 15-after

Before: `baseline-dev` (2026-09-24T17:08:21.517Z, commit `664a811`, dirty). After: **TBD in 15b** (`15-after.json` not found).

Load pass: 10 connections × 10 s per scenario on one local process (the Part 01 runner). Budgets (PRD §43): p50 < 100 ms, p95 < 300 ms (feed < 200, search < 300), p99 < 800 ms. **Pass** means the *after* run meets all three under that load. Queries are the median statements per request from the sequential pass (`BENCH_COUNT_QUERIES=1`).

| Scenario | As | p95 budget | Before p50 / p95 / p99 ms | After p50 / p95 / p99 ms | p95 change | Queries before → after | After non-2xx | Result |
|---|---|---|---|---|---|---|---|---|
| search:prefix | guest | 300 | 206 / 729 / 804 | TBD in 15b | – | 1 → TBD | – | TBD in 15b |
| search:common | guest | 300 | 236 / 1204 / 1267 | TBD in 15b | – | 1 → TBD | – | TBD in 15b |
| search:author | guest | 300 | 43 / 80 / 91 | TBD in 15b | – | 1 → TBD | – | TBD in 15b |
| search:cjk | guest | 300 | 77 / 2002 / 2277 | TBD in 15b | – | 1 → TBD | – | TBD in 15b |
| search:typo | guest | 300 | 61 / 224 / 269 | TBD in 15b | – | 1 → TBD | – | TBD in 15b |
| search:isbn | guest | 300 | 30 / 41 / 49 | TBD in 15b | – | 2 → TBD | – | TBD in 15b |
| work:guest | guest | 300 | 3.4 / 5.5 / 7.0 | TBD in 15b | – | 0 → TBD | – | TBD in 15b |
| work:signed-in | typical | 300 | 25 / 32 / 37 | TBD in 15b | – | 2 → TBD | – | TBD in 15b |
| work-reviews:friends:heavy | heavy | 300 | 2046 / 2666 / 2779 | TBD in 15b | – | 5 → TBD | – | TBD in 15b |
| work-reviews:friends:guest | guest | 300 | 1275 / 1667 / 2423 | TBD in 15b | – | 2 → TBD | – | TBD in 15b |
| review:get | typical | 300 | 30 / 37 / 44 | TBD in 15b | – | 2 → TBD | – | TBD in 15b |
| reads:mine:reading | heavy | 300 | 24 / 29 / 34 | TBD in 15b | – | 2 → TBD | – | TBD in 15b |
| reads:user | heavy | 300 | 52 / 61 / 67 | TBD in 15b | – | 4 → TBD | – | TBD in 15b |
| progress:post | typical | 300 | 62 / 115 / 165 | TBD in 15b | – | 4 → TBD | – | TBD in 15b |
| stats:me | heavy | 300 | 45 / 53 / 60 | TBD in 15b | – | 4 → TBD | – | TBD in 15b |
| stats:user | typical | 300 | 57 / 65 / 71 | TBD in 15b | – | 6 → TBD | – | TBD in 15b |
| feed:friends:heavy | heavy | 200 | 277 / 402 / 467 | TBD in 15b | – | 3 → TBD | – | TBD in 15b |
| feed:friends:heavy:page2 | heavy | 200 | 279 / 415 / 487 | TBD in 15b | – | 3 → TBD | – | TBD in 15b |
| feed:friends:typical | typical | 200 | 81 / 93 / 99 | TBD in 15b | – | 3 → TBD | – | TBD in 15b |
| feed:friends:typical:page2 | typical | 200 | 73 / 84 / 96 | TBD in 15b | – | 3 → TBD | – | TBD in 15b |
| feed:friends:new | new | 200 | 148 / 165 / 237 | TBD in 15b | – | 3 → TBD | – | TBD in 15b |
| feed:friends:new:page2 | new | 200 | 72 / 81 / 92 | TBD in 15b | – | 3 → TBD | – | TBD in 15b |
| feed:popular:guest | guest | 200 | 69 / 81 / 90 | TBD in 15b | – | 2 → TBD | – | TBD in 15b |
| followers:celebrity | typical | 300 | 199 / 229 / 263 | TBD in 15b | – | 6 → TBD | – | TBD in 15b |
| shelves:browse | typical | 300 | 1042 / 1162 / 1432 | TBD in 15b | – | 26 → TBD | – | TBD in 15b |
| shelves:big:items | typical | 300 | 719 / 843 / 885 | TBD in 15b | – | 6 → TBD | – | TBD in 15b |
| shelves:saved | heavy | 300 | 457 / 510 / 525 | TBD in 15b | – | 56 → TBD | – | TBD in 15b |
| comments:thread | typical | 300 | 57 / 68 / 74 | TBD in 15b | – | 5 → TBD | – | TBD in 15b |
| imports:list | heavy | 300 | 17 / 22 / 25 | TBD in 15b | – | 1 → TBD | – | TBD in 15b |
| exports:list | heavy | 300 | 17 / 22 / 27 | TBD in 15b | – | 1 → TBD | – | TBD in 15b |
| auth:login | guest | 300 | 46 / 64 / 78 | TBD in 15b | – | 3 → TBD | – | TBD in 15b |

**0 pass, 0 over budget, 31 TBD.** Each scenario still over budget needs its own entry below with its EXPLAIN evidence and a plan.

## Still over budget

TBD in 15b.
