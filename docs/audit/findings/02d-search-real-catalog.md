# Audit 02d — Search on the real catalog (FN-40 … FN-43)

2026-09-29 · CI **green in 1,427 s** (owner's run, `FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`, all 9 steps) · tests **API 1,355 → 1,356** (67 files; +1 `search.test.ts` › "an author surname against obscure books titled with it"), **mobile 147**, unchanged; `relevance.test.ts` panel now queries the API's page size and its floor rose 0.98 → 0.99; nothing weakened, skipped or removed. Targeted files run here at `--maxWorkers=1`: `search`, `relevance`, `isbn`, `schema` (155/155), `search-route`, `isbn`, `ingest` (129/129); API typecheck clean.

Databases: every plan and timing is from the **full catalog `flyleaf`** unless marked `flyleaf_dev`. Machine: 8 GB, Postgres VM 3.8 GB, `shared_buffers` 128 MB, `work_mem` 4 MB (every hand-run query also had `statement_timeout`). **Latencies are indicative only (8 GB dev machine)**; buffer counts are the portable evidence. Timings are warm: one untimed warm-up, then 5 runs per query (p50 / p95, nearest rank, so p95 of 5 = the slowest run). Nothing else ran on the database during timing (`pg_stat_activity` empty, VM pressure ~0).

## Verdict per task

| Task | Claimed (after 02–08) | Verified | Findings |
|---|---|---|---|
| FN-40 | indexed arms, bounded; `pir` 11–16 s open (A-08-025) | ⚠️ title/prefix arms fixed (index-only walk); author arm still over budget and plan-unstable | A-02d-001, A-02d-002 |
| FN-41 | weights 0.30/0.20/0.20/0.10/0.35, panel 216/217 | ❌ → ✅ real catalog 198/214 → 214/214 (popularity 0.60) | A-02d-003 |
| FN-42 | ISBN exact path | ✅ no regression | — |
| FN-43 | panel measures position like the API | ⚠️ → ✅ limit ≠ API page; explicit cases scored as misses; unguarded runner | A-02d-004, A-02d-005, A-02d-006 |

## Step 0 — state left by the interrupted 27 Sep session

Checked read-only on both databases: non-default `attstattarget` on works/authors/work_authors/editions (none), `pg_statistic_ext` (one object), table reloptions (none), every index on the four tables against `drizzle/*.sql` and `migrate.ts` (all 17 accounted for, none invalid), `postgresql.auto.conf` (empty), database-level settings (only `pg_trgm.similarity_threshold`), and an md5 of every `public` function body (identical across both databases).

**One unexplained object: `authors_names_expr_stats`** (`CREATE STATISTICS … ON flyleaf_author_names(name, alternate_names) FROM authors`), on `flyleaf` only, with data (so `authors` was analysed after it). No migration creates it. Evidence it is not worth keeping: with it dropped inside a rolled-back transaction, the author-arm estimates for `%pir%`, `%tolkien%` and `th%`/`% th%` are identical (169 / 169 / 17,210), because the planner reads the same expression's statistics from the two author trigram indexes first. → **revert.** `DROP STATISTICS` was refused by the permission classifier, so it is an **owner action** (below). It changes no plan either way, so the baseline was not affected.

Leftover tools, reviewed and kept: `src/bench/search-latency.ts` (sound: runs `SEARCH_SQL` as an unnamed statement like `#localSearch`, guarded session, per-arm plan shape) and `src/bench/ranking-features.ts` (sound: `SEARCH_SQL` cut at its final SELECT so the candidate set is the real one; offline re-ranking reproduced the live panel's 198 exactly, see A-02d-003). Both, and `bench:relevance` / `bench:search-latency` in `package.json`, are part of this part's tooling. `ranking-features.ts` changed to limit 20 (A-02d-004).

## Findings

### A-02d-001 · P1 · FIXED (partly) · Title and prefix arms: the plan flipped with ANALYZE, and the popularity walk read a heap page per row (A-08-025)
- **Where:** `SEARCH_SQL` `fts`, `title_like` (and the works side of `by_author`); index `works_log_count_idx`.
- **Mechanism (evidence, not inference):** for `title ILIKE '%q%'` Postgres estimates the share of the 101 histogram bounds that match, clamped below at 0.0001. The estimates seen were only ever ~320, ~32k, ~64k, ~97k, ~129k: 0, 1, 2, 3, 4 bounds of 101 on 3.2M rows. `pir` (true 23,152) got 319 or 32,318 depending on ANALYZE's 30k-row sample. At ≥ 1 bound the planner walks `works_log_count_idx` in popularity order and filters, each row a heap fetch.
- **Before (3 ANALYZE rounds at the default target, rolled back; EXPLAIN ANALYZE):** `pir` walk in all 3 rounds (48,625 rows filtered, 48k buffers, 0.4–16.2 s), `ur` walk 715k rows filtered / 542k buffers / 12.9 s in one round and a bitmap (6k buffers) in the others, `har`/`king`/`love` flipping between walk and bitmap; baseline `harry` walked 403,234 rows for 1,472 matches (356k buffers, 2.8 s p50).
- **Options measured (all on `flyleaf`, in transactions that were rolled back):**

  | Option | Result | Verdict |
  |---|---|---|
  | Statistics target 1000 on `works.title`, `works.search_vector`, author index expressions | estimates right (`pir` 16–22k), plan **stable on the walk**: `pir` walk ×3, 48k buffers, 9–14 s after ANALYZE; ANALYZE 33–91 s | rejected alone |
  | `log_count + 0` in the arms (always collect) | `the` would sort ~840k titles | rejected (depth table) |
  | Bounded branches in SQL: walk the top 100k (then 25k + 100k), else collect | exact results, estimate-free; but each walk costs ~0.8 µs of CPU per entry, and gated-off branches still launch parallel workers (110–250 ms each): `murakami` 13 → 48–207 ms, `th` 53 ms → 5.5 s | rejected (regresses specific queries; brief forbids regressing `murakami`) |
  | **Covering index** `works_popularity_idx` (same key, INCLUDE every column the arms read) | walk is index-only (heap fetches 0), ~100 rows per page | **chosen** |
  | Covering index + target 1000 | middle band always walks (cheap), but sparse patterns that draw 1 of 1,001 bounds now walk 193k–332k entries (`smith`, `report`, `harr`: 4.5–13 s cold) | rejected: trades one tail for another |

- **Fix:** `migrate.ts` `ONLINE_SQL` builds `works_popularity_idx ON works ((ol_log_count + reader_count)) INCLUDE (id, title, search_vector, merged_into_id, is_provisional, maturity, ol_log_count, reader_count)` **concurrently**, then drops `works_log_count_idx` concurrently (search always has one). Same DDL in `ingest.ts` `WORKS_INDEXES` (dropped/rebuilt around a bulk load); `schema.ts` declares the key (drizzle cannot spell INCLUDE; the comment says so). 567 MB on `flyleaf`. Applied with `npm run migrate`: `flyleaf_dev` 4 s, `flyleaf` 2 min 19 s; valid on both, old index gone. `works` is 100 % all-visible (208,675 / 208,675 pages), which an index-only scan needs.
- **After:** see Performance. The walk for `pir` costs 2.8k buffers instead of 48k; for `harry`'s title arm the planner still collects (1.8k buffers). Worst title/prefix arm over 3 committed ANALYZE rounds: **71k buffers** (`lo`, a 2-character pattern collected on an estimate of 317 for 27,773 matches), was 356k–541k.
- **Not achieved, stated plainly:** the plan is still chosen from ANALYZE's sample. What changed is the price of the wrong choice. Remaining title/prefix tail: a dense pattern estimated at ~320 is collected (`lo` 71k, `king` 46k, `love` 27k buffers). A sparse pattern estimated high would walk the whole index (3.2M entries, index-only); in 3 default-target rounds × 17 queries no sparse query walked.
- **Test:** no PGlite test can pin a planner choice on a 3.2M-row table (PGlite never walks). The plan evidence is above. The index's existence is exercised by every test through the migration list (`schema.test.ts` replays `ONLINE_SQL`; passes).
- **Gotcha recorded in `schema.ts`:** the index INCLUDEs `search_vector`, so a future migration that drops that generated column drops this index too (the same trap as `works_search_idx`, `schema.test.ts`).

### A-02d-002 · P1 · DEFERRED (plan below) · The author arm dominates short and common queries, and its plan flips too
- **Evidence:** `by_author` estimates `flyleaf_author_names(...) ILIKE '%q%'` at the same floor (~169 of 1.66M credited authors) for almost every pattern. True counts: `the` 30,135 authors, `war` 24,527, `lo` 27,103, `james` 18,773, `smith` 8,355, `king` 4,028. Collecting every matching author's works costs `the` 567k buffers, `war` 441k, `smith` 154k, `king` 76k. After other ANALYZE samples the planner hash-joins over a seq scan of `authors` instead (`har` 851k buffers and one 60 s timeout, round 1 after the fix; `the` 421k). The alternative walk probes `work_authors` + `authors` per work (~8 random pages).
- **Measured and rejected here:** (a) counting matching authors to 15,000 first to choose the plan: the count alone takes 188–826 ms (lossy trigram recheck on common patterns); (b) forcing the walk with a per-work scalar probe: 1.87 s for `the` (4.7k random reads into a 2 GB table). No works index can cover a column of another table.
- **Proposed fix (≈ 1–2 days, a 3.2M-row backfill; over the half-day rule):** denormalise `works.author_names text` (the `flyleaf_author_names` of every credited author, joined by a separator a query cannot contain), maintained by a statement-level trigger on `work_authors` INSERT/DELETE and on `authors` UPDATE OF name, alternate_names, bypassed by `flyleaf.bulk_load` and set in `--finalise` like `has_works` (A-02-029); a trigram GIN on it; add it to `works_popularity_idx`'s INCLUDE list. `by_author` and the ranking author term then become works-only: the dense case is an index-only walk (`the`: 300th match at rank ~4,700), the sparse case a bitmap on one table. Rollout: the backfill rewrites every `works` row (0026 measured ~1 ms/row, ~55 min and ~1.6 GB of bloat on `flyleaf`), so it needs the batched online path of LA-05. Owner: a Part 02 follow-up or Part 15.
- **Consequence for the goal:** `the` and `war` stay at 0.25–2.1 s p50 here (their cost is almost all this arm), `smith`/`james` ~0.5–0.8 s.

### A-02d-003 · P1 · FIXED · Real-catalog relevance 198/214: an obscure book titled with a surname always beat the author's books
- **Evidence:** `npm run bench:relevance` on `flyleaf`: 198/217, 14 of the misses author surnames (`orwell` → *Orwell* (12 logs) | *Orwell* (5 logs); `murphy`, `grace`, `meyer`, `glasgow`, `carnegie`, `jackson`…), plus `sapiens` and `pride` (a less-logged duplicate title first). The candidates were all there (`ranking-features.ts`: 0 "not a candidate"); the ranking put them below. An exact title earns 0.30 + 0.20 + 0.10 = 0.60, an author match 0.20; the popularity term's whole range was 0.35 < 0.40, so a 12-log exact title outranked a 41k-log novel by the author. The corpus never showed it: it holds only popular works.
- **Offline evaluation** (`ranking-features.ts` dumps; the evaluator reproduced the live 198 before being trusted): popularity weight 0.40 → 204, 0.45 → 206, 0.50 → 212, **0.55–1.0 → 214/214** on `flyleaf`; `flyleaf_dev` 0.50–1.0 → 214/214; corpus 0.50–1.0 → 217/217. Raising the author weight instead (0.40) scored **188** (prefix cases collapse); an author-whole-word bonus 195–197.
- **Oracle caveat and the counter-check:** every panel expectation is the most-logged work, so the panel cannot see harm from over-weighting popularity. Counter-panel (full catalog, deterministic sample of works with 1–100 logs, queried by their own exact title): multi-word titles: exact title #1 150/150 at 0.35–0.70, 147/150 at 1.0. Single-word titles (the collision case): exact title #1 98/100 at 0.35, **97/100 at 0.55–0.60**, 95 at 0.70, 87 at 1.0; the sampled work on the 20-row page 73/100 at every weight ≤ 0.70 (22 are never candidates at any weight: 300 more-logged works share their one-word title; pre-existing).
- **Fix:** popularity weight **0.60** (one step inside the plateau's lower edge on `flyleaf`), `SEARCH_SQL` final ORDER BY, with the reasoning in the comment. PRD §14.3 updated (decision 3: the PRD follows the code); tasks.md FN-41 corrected.
- **After (real runs, final code):** `flyleaf` **214/214**, `flyleaf_dev` **214/214**, corpus **217/217** (`king` now passes as a side effect: *It* in the top 5, the title prefixes still first).
- **Test:** `search.test.ts` › "ranks the popular novel above five little-read books called "Orwell"", five works titled *Orwell* with the logs seen on the full catalog (2–12). **Seen failing before the fix: yes** (at 0.35 *Orwell* ranks first); passes at 0.60. A first version with 5–40 logs failed at 0.60 too, correctly (a 40-log exact title scores 0.823 > 0.80); the fixture was set to the observed data, not to make it pass.

### A-02d-004 · P2 · FIXED · The panel scored candidate sets the API never produces
- **Where:** `relevance.test.ts` (and `bench/relevance-panel.ts`, `bench/ranking-features.ts`) passed `within` (1 or 5) as `$5`. `$5` is also the typo arms' gate (`count(exact) < $5`) and the two-character author LIMIT's context; the API always sends 20.
- **Fix:** all three query with 20 and judge `slice(0, within)`. Strictly more faithful; the position rule is unchanged.
- **Impact measured:** corpus 216/217 at the old weight either way, so no change hid or caused a pass here; the real-catalog numbers above use the fixed runner.

### A-02d-005 · P3 · FIXED · The real-catalog panel counted three unwinnable cases as misses
- `fifty shades of grey`, `fifty`, `james` expect an **explicit** work, which PRD §7.8 hides from a guest, and the panel searches as one. `bench/relevance-panel.ts` now reports them separately ("3 explicit (hidden from guests, not scored)"); the denominator on both real catalogs is 214. Counted the old way the result is 214/217 = 98.6 %.

### A-02d-006 · P3 · FIXED · `bench/relevance-panel.ts` opened an unguarded connection
- No `statement_timeout`, no `work_mem`, and it relied on `ALTER DATABASE` for the trigram threshold. Now the same connection settings as the other search benches.

### A-02d-007 · P3 · Recorded · `flyleaf_dev` `the` ~1.3× slower with the covering index
- Six runs each, index swapped back inside a rolled-back transaction: median ~103 ms (old) vs ~135 ms (new). The slice fits in RAM, so the old walk's heap fetches were already cheap and the wider index costs a little more. Every other dev query within noise (`har` 363 → 162 ms; ISBN 5.8 → 5.3 ms; `U`/`Ur`/`urs`/`ursu` unchanged). Under the method's 2× bar; recorded, not acted on.

## Performance

`flyleaf`, guest, `src/bench/search-latency.ts` (5 runs after 1 warm-up), buffers from one EXPLAIN (ANALYZE, BUFFERS) of the same statement. **Indicative only (8 GB dev machine).** "Same stats" = no ANALYZE in between (every experiment was rolled back), so this is a like-for-like before/after.

| Query | Before p50 / p95 · buffers | After, same stats | After ANALYZE #1 | #2 | #3 | Dominant cost after |
|---|---|---|---|---|---|---|
| `a` (API returns [] under 2 chars) | 39 / 42 · 17.6k | 38 / 60 · 11.7k | — | — | — | |
| `lo` | 221 / 324 · 92k | 117 / 243 · 56k | 3,389 / 12,848 · 125k | 111 / 275 | 2,599 / 2,705 · 534k | author arm (#3: 27k authors, 454k buf); title bitmap 71k (#1) |
| `pir` | 408 / 412 · 69k | 444 / 466 · 69k | 427 / 440 | 421 / 457 | **218 / 224 · 50k** | author arm 33k |
| `the` | 1,820 / 8,051 · 577k | 2,097 / 3,008 · 576k | **266 / 405 · 108k** | 249 / 256 | 249 / 252 | author arm (walk 100k or bitmap 567k) |
| `har` | 475 / 8,223 · 106k | 479 / 819 · 77k | 1,505 / **timeout** · 879k | 371 / 410 | 367 / 372 | author arm (#1: seq-scan hash join, 851k) |
| `king` | 660 / 4,980 · 162k | 514 / 5,733 · 93k | 883 / 912 · 137k | 503 / 517 | 720 / 2,194 | author 76k |
| `th` | 70 / 82 · 27k | 96 / 433 · 23k | 66 / 74 | 62 / 63 | 63 / 66 | |
| `le` | 214 / 228 · 70k | **83 / 86 · 23k** | 83 / 141 | 80 / 85 | 89 / 298 | |
| `ur` | 272 / 334 · 60k | 269 / 1,541 · 60k | 267 / 294 | 262 / 283 | 276 / 281 | author 40k |
| `war` | 1,603 / 4,484 · 508k | 1,575 / 5,621 · 455k | 1,871 / 1,905 · 491k | 1,457 / 1,469 | 1,896 / 2,075 | author arm 441k |
| `love` | 302 / 312 · 72k | 227 / 274 · 44k | 469 / 495 · 69k | 221 / 251 | 461 / 470 | title bitmap 27k (#1, #3) |
| `harry` | 2,847 / 4,818 · 416k | **696 / 748 · 70k** | **248 / 266 · 61k** | 237 / 274 | 389 / 417 | author 48k |
| `tolk` | 24 / 26 · 8.3k | 21 / 23 · 8.3k | 88 / 106 | 20 / 27 | 20 / 26 | |
| `murakami` | — | 21 / 30 · 7.4k | 22 / 23 | 22 / 24 | 20 / 23 | |
| `smith` | — | 504 / 661 · 154k | 489 / 498 | 482 / 616 | 502 / 523 | author arm 141–155k |

Reading it:
- **Title/prefix walks are fixed:** the heap-walk plans that cost 356k–541k buffers (`harry`, `ur`, `pir` 48k) are gone; the worst title/prefix arm in any round is a 71k-buffer bitmap.
- **p95 < 300 ms is met here for** `a`, `th`, `le`, `tolk`, `murakami` in every round, `pir`/`the`/`harry`/`ur`/`love` in most. **Not met** for `war`, `smith`, `king`, and after some ANALYZE samples `lo`, `har`, `the`: in every such row the cost is the author arm (A-02d-002). Warm p95 outliers with unchanged buffers (`king` 5.7 s, `ur` 1.5 s, `war` 5.6 s in the same-stats pass) are single-run I/O stalls on this machine.
- **Production hardware:** the title/prefix arms now read 0.1k–3k index pages when they walk, so they are CPU-bound and scale with the CPU. The author arm's 100k–850k buffers are ~0.8–6.8 GB of page touches per query; no plausible cache makes that 300 ms. It needs A-02d-002's schema change, not hardware.
- **ANALYZE cost:** `ANALYZE works` + `authors` 4–13 s at the default target (1000 took 33–91 s and was rejected).

## Relevance

| Catalog | Before | After |
|---|---|---|
| corpus (PGlite, CI) | 216/217 | **217/217**, floor 0.98 → 0.99 |
| `flyleaf_dev` | 209/217 (Part 08; 209/214 offline, 3 explicit) | **214/214** (+3 explicit, not scored) |
| `flyleaf` | 198/217 (198/214 + 3 explicit) | **214/214** (+3 explicit, not scored) |

The real-catalog panel is **not in CI**: it needs the full or dev catalog, which CI's fresh Postgres does not have. It is a documented manual step: `npm run bench:relevance` (170 s on `flyleaf`, 20 s on `flyleaf_dev`), last result above.

## Behaviour changes

1. **Ranking:** popularity weighs 0.60 instead of 0.35. A surname query now puts the author's well-read books above little-read books titled with the surname (`orwell`, `murphy`, `grace`…); `king` shows Stephen King's *It* in the top 5 under the title prefixes. An obscure book searched by its exact multi-word title stays first; for one-word titles 1 in 100 sampled lost first place to a popular author match (still on the page).
2. **Index:** `works_log_count_idx` replaced by `works_popularity_idx` (same key, INCLUDE list), 567 MB on `flyleaf`. Operators: `ingest` rebuilds it under the new name.
3. No API contract change (no route, schema or OpenAPI change).

## Decisions

1. **A-02d-002, the author arm: APPROVED by the owner (2026-09-29), not in this part.** Scheduled post-audit with LA-05, after Part 15 and before launch (row in `PENDING.md`): copy author names onto `works` (column + trigram index built concurrently), batched backfill of the 3.2M rows, kept in sync by trigger on `work_authors` and on author name changes, correct under author and work merges, repaired by a nightly reconcile job like the other counters. **Acceptance test:** the 02d latency set, p95 < 300 ms for `war`, `smith`, `king`, `lo`, `har`, `the` across 3 ANALYZE rounds on `flyleaf`.

## Deferred

| Item | Owner | Reason |
|---|---|---|
| A-02d-002 author arm (author names on `works`) | post-audit, with LA-05 (`PENDING.md`) | approved; > half a day, 3.2M-row backfill |
| Title/prefix plan still sample-dependent (dense pattern collected on a low estimate, ≤ 71k buffers) | with A-02d-002 | once `by_author` is a works-only arm, all three arms can share one estimate-free walk-then-collect shape; alone it did not pay (A-02d-001 table) |

## Owner actions

- **Done by the owner (2026-09-29):** dropped `authors_names_expr_stats` (`IF EXISTS`) on `flyleaf` and `flyleaf_dev`. My attempt had been refused by the permission classifier; it changed no estimate (Step 0).

## Tooling

- Kept from the 27 Sep session: `src/bench/search-latency.ts` (`npm run bench:search-latency [runs] [query…]`), `src/bench/ranking-features.ts` (now limit 20).
- `src/bench/relevance-panel.ts`: guarded connection; explicit cases reported, not scored; limit 20.
- Experiment scripts (rolled-back ANALYZE rounds, covering-index prototype, match-depth table, obscure-title counter-panel) were scratch and are deleted; their outputs are the tables above.

## CI

| Run | Result |
|---|---|
| 1 (owner, `FLYLEAF_TEST_WORKERS=2`) | ✓ **green in 1,427 s**: api-client build, api typecheck, spec check (no route change), api tests **1,356 passed** (67 files), api build, audit, mobile typecheck, mobile offline tests **147 passed**, migrations on a real Postgres (`migrations applied`, which builds `works_popularity_idx`) |

`npm run migrate` here: `flyleaf_dev` 4 s, `flyleaf` 2 min 19 s; a re-run prints `migrations applied`.
