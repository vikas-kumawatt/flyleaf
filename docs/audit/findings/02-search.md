# Audit 02 — Search (FN-40, FN-41, FN-42, FN-43)

2026-09-25 · CI: see *CI after* at the end · tests **740 API + 100 mobile → 819 API + 100 mobile** (+45 `search.test.ts`, +23 new `search-route.test.ts`, +11 `isbn.test.ts`; no test weakened or removed)

Databases: every plan and latency below is from the **full catalog** (`flyleaf`, 3.2M works, 15.4M authors) unless marked `flyleaf_dev`. PGlite was used only for correctness tests. Machine: 8 GB total, Postgres VM 3.8 GB, `shared_buffers` 128 MB, `work_mem` 4 MB, so **latencies are indicative only**; buffer counts are the hardware-independent evidence.

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| FN-40 | Four independent indexed arms; merged/provisional excluded; LIKE escaped; tsquery sanitised | ⚠️ partial: matching correct, but no maturity filter, exclusions applied only after each arm's LIMIT, arms unindexed or scanning ⅓ of the catalog for short queries, non-Latin letters dropped, NUL → 500 | A-02-001 … A-02-010, A-02-012, A-02-016 |
| FN-41 | Weights 0.30/0.20/0.20/0.10/0.35; popularity loaded | ⚠️ partial: weights as claimed, but diverge from PRD §14.3 / arch §5.4; `log_count` has no trigger, decrement, import increment or reconcile | A-02-013, A-02-014 |
| FN-42 | ISBN detection → exact edition path | ⚠️ partial: detection/conversion correct incl. `x`, spaces, 979; search and scan disagreed on a shared ISBN; no `maturity` for the §7.8 interstitial | A-02-011, A-02-019 |
| FN-43 | 217-query panel, position-based, in CI | ✅ correct: runs the exported `SEARCH_SQL` (weight experiment below), floor 0.98, in `api · tests`, `1984` gap test present in both suites; 216/217 before and after | A-02-015 |

## Findings

### A-02-001 · P1 · Search ignored maturity entirely (PRD §7.8 [LOCKED], §4.2)
- **Where:** `apps/api/src/catalog/index.ts` `SEARCH_SQL`, `CatalogService.search`; `profiles.show_explicit` existed but nothing read it.
- **Evidence:** the full catalog holds **10,127 `explicit` works**. `GET /v1/search?q=velvet` as a guest returned the explicit fixture work (`search-route.test.ts`, red on HEAD).
- **Spec:** §7.8 Search: "`explicit` works excluded unless the user has enabled the setting **and** is 18+"; §4.2: the filter is on for guests and cannot be disabled.
- **Fix:** `search(viewer, q, limit)`. `#allowsExplicit(viewer)` = `profiles.show_explicit AND date_of_birth <= today − 18 years` (guest → false; age rechecked at read time, so a stale flag cannot expose a minor). `$6` in `SEARCH_SQL` filters `maturity <> 'explicit'` **inside every arm** and in the final select. `mature` and `unclassified` stay visible (§7.8 table). An **exact ISBN still resolves** whatever the maturity, like a scan (§7.8 "Direct link or ISBN scan: resolves"); see Decisions. One extra query per signed-in search (0 for guests); it runs in parallel with the ISBN lookup.
- **Test:** `search-route.test.ts` › maturity (guest, adult not opted in, adult opted in, minor with the flag set); `search.test.ts` › maturity; `search.test.ts` › "320 popular explicit works cannot push a live work out". Seen failing before the fix: **yes** (all).
- **Not done here:** nothing can set `show_explicit` yet (no route or settings screen); cover blurring and the interstitial need a `maturity` field (A-02-019).

### A-02-002 · P1 · Trigram arm scanned ~⅓ of the catalog for queries under 4 characters
- **Where:** `SEARCH_SQL` `title_fuzzy`.
- **Evidence (before, `EXPLAIN (ANALYZE, BUFFERS)`):**
  ```
  "th":  Bitmap Index Scan on works_title_trgm_idx  rows=1,129,223
         Bitmap Heap Scan  Rows Removed by Index Recheck: 2,793,950  Heap Blocks: exact=60,848 lossy=131,723
         → 11 rows kept · arm 20,979 ms of 23,405 ms · Buffers shared hit=331 read=193,377
  "the": index rows=1,119,247 · rechecked 2,790,972 · 150 kept · arm 21,001 ms of 26,502 ms
  "a":   index rows=1,305,185 · rechecked 2,806,414 · 48 kept  · arm 51,191 ms of 54,146 ms
  "pir": index rows=57,327 · rechecked 44,806 · 3 kept · 3,508 ms (arm run alone)
  ```
  A query shorter than 4 characters has 2–4 trigrams, and at threshold 0.45 sharing one or two of them makes a title a candidate, so the candidate count grows with the table, not with the result.
- **Fix:** `AND char_length($1::text) >= 4` in the arm. With a custom plan it folds to `One-Time Filter: false` and the arm never runs (after-plan for `th`, `the`, `pir`, `村上`). The prefix arm still serves these queries.
- **Test:** `search.test.ts` › "skips the trigram arm below 4 characters, keeps it from 4" (plan shape, not timing). Seen failing before the fix: **yes**. The existing search-as-you-type prefix cases (`U`, `Ur`, `pir`, `hob`, `dun`…) and the panel still pass.
- **Behaviour change:** 2–3 character queries no longer fuzzy-match short titles (e.g. `pir` → a 3-letter title similar to "pir"). Prefix and substring matches are unchanged.

### A-02-003 · P1 · Two-character title matching was not indexable (CJK seq scan)
- **Where:** `buildSearchParams` `like`, `SEARCH_SQL` `title_like`.
- **Evidence (before):** `title ILIKE '%村上%'` → **Parallel Seq Scan on works**, Rows Removed by Filter 1,067,857 × 3 workers, 25,236 ms. A 2-character `'%q%'` has no complete trigram, so `works_title_trgm_idx` cannot serve it. Latin pairs hid this because they are dense: the planner walked `works_log_count_idx` and found 300 matches quickly. A rare pair has no such bound.
- **Fix:** for a query under 3 characters the title pattern is anchored (`'q%'`), which does have trigrams (`title ~~* '村上%'` → Bitmap Index Scan). After: `村上` title arm 1.1 ms, 8 index rows.
- **Test:** `search.test.ts` › "anchors the title substring arm for a 2-character query" (plan text). Seen failing before the fix: **yes**.
- **Behaviour change:** a 2-character query matches titles that **start** with it (or contain a word starting with it, via the prefix arm), no longer a pair in the middle of a word ("rt" no longer finds "Earthsea").
- **Not fixed:** the author arm, see A-02-012.

### A-02-004 · P3 · SEARCH_SQL's generic plan is the 40 s query again (latent, guarded)
- **Evidence:** with `plan_cache_mode = force_generic_plan`, every arm becomes `Index Scan Backward using works_log_count_idx … Filter: (title ~~* $3)`, a row-by-row walk of 3.2M works per arm. `murakami` generic: 6.8 s to plan+run versus 0.7–1.0 s custom.
- **Hypothesis tested and refuted for live code:** postgres.js `sql.unsafe()` defaults to `prepare: false` (`node_modules/postgres/src/index.js:119-125`), so each search is an unnamed statement planned with its real parameters. `generic-plan-probe.ts` ran 8 searches on one connection: `pg_prepared_statements` stayed empty; warm timings 130–408 ms.
- **Fix:** comment at `#localSearch` explaining why the statement must stay unnamed. No behaviour change.

### A-02-005 · P2 · Query length unbounded; one-letter prefix terms
- **Evidence (before, per arm, a 200-character random-word string):** prefix arm 12,332 ms (3,325 GIN pages: every 1-letter word becomes `c:*`, a scan of every lexeme starting with c), trigram arm 11,825 ms. The same `x:*` expansion happens mid-typing: "harry potter and the p".
- **Fix:** input capped at `MAX_QUERY_CHARS = 100` code points (cut, not rejected: search runs per keystroke and prefix semantics make a cut harmless). One-letter tokens are dropped when a longer token exists (`a` alone is still `a:*`).
- **After:** the same string (cut to 100): 5,757 buffers vs ~14,400 before (per-arm sum), but still **18.8 s**, almost all in the trigram index's key evaluation. See A-02-016.
- **Test:** `search.test.ts` › "drops one-letter prefix terms…", "bounds the query length and strips NUL"; `search-route.test.ts` › "survives a 5,000-character query". Seen failing before the fix: **yes** (unit tests).
- **Behaviour change:** characters after the 100th are ignored; one-letter words are ignored when the query has a longer word.

### A-02-006 · P2 · A NUL byte in `q` was a 500
- **Evidence:** `GET /v1/search?q=a%00b` → Postgres `22021 invalid byte sequence for encoding "UTF8": 0x00` → 500 (red in `search.test.ts` and `search-route.test.ts` on HEAD).
- **Fix:** `cleanQuery` strips `\u0000` before anything else.
- **Test:** `search.test.ts` › hostile input `a\u0000b`, `\u0000`; `search-route.test.ts` › `q=%00`, `q=a%00b`. Seen failing before the fix: **yes**.

### A-02-007 · P2 · Exclusions applied after each arm's LIMIT
- **Evidence:** 320 popular merged (or provisional, or explicit) works titled "Quasar Chronicle N" filled the `fts` and `title_like` arms' 300 slots; the live "The Quasar Omnibus…" was never a candidate and the search returned `[]`. On the real catalog today 0 works are merged or provisional, so this is latent until dedupe (Part 03) runs.
- **Spec:** FN-40's own bullet, and 00-method "Merged works… excluded from every arm, not only from the final select".
- **Fix:** the three exclusions in every arm.
- **Test:** `search.test.ts` › "320 popular merged/provisional/explicit works cannot push a live work out". Seen failing before the fix: **yes** (all three).

### A-02-008 · P2 · Prefix arm dropped non-Latin letters and folded accents differently from the index
- **Evidence:** `buildSearchParams` removed everything outside `[a-z0-9]`, so `Толстой`, `村上`, `हिन्दी` produced no prefix term, although the `simple` vector indexes them (`to_tsvector('simple', flyleaf_unaccent('Лев Толстой'))` = `'лев' 'толстой'`). `o'brien` became `obrien:*`, which matches nothing (the vector stores `o` + `brien`). JS accent folding also disagreed with `flyleaf_unaccent`: `ł`, `ß` were not folded (`łodz` could not find "Łódź"). Architecture §3.8 requires query-time folding through the same wrapper.
- **Fix:** split on `[^\p{L}\p{M}\p{N}]` (every script; marks kept inside words), NFC, lowercase; the tsquery is folded in SQL with `flyleaf_unaccent($2)`, the function that built the vector. A first attempt folded in JS with NFD and turned `толстой` into `толстои`, which `unaccent` does not do; caught by the unit test, reverted.
- **Test:** `search.test.ts` › "keeps letters from every script…", "splits on punctuation the way the tsvector parser does", "diacritics are stripped on both sides" (`łodz` → "Łódź Stories", `straße` → "Strasse der Sieger"). Seen failing before the fix: **yes**. (A PGlite behaviour test for Cyrillic passed without the fix because another arm matched; it was removed as tautological and the case verified on the real DB instead: `村上` prefix arm now 6 rows in 4 ms.)

### A-02-009 · P2 · `pg_trgm.similarity_threshold` depended on `ALTER DATABASE` alone
- **Evidence:** `SHOW pg_trgm.similarity_threshold` on a new connection: **0.45** on `flyleaf` and `flyleaf_dev`. On a database without the setting (`postgres`), a plain connection reports it unrecognised (default 0.3 once pg_trgm loads). A restore or recreate loses it silently, and at 0.3 "murakami" alone rechecks ~13,500 titles (tasks.md FN-41). No readiness check or warning existed.
- **Fix:** `makeDb` sends `pg_trgm.similarity_threshold=0.45` in every connection's startup packet. Verified on real Postgres against the `postgres` database: plain connection → unrecognised parameter; `makeDb` connection → `0.45`. The `ALTER DATABASE` stays as a second layer. `TRIGRAM_THRESHOLD` moved to `platform/index.ts` (`migrate.ts` re-exports it) to avoid an import cycle.
- **Test:** `search-route.test.ts` › "is sent on every pooled connection, not left to ALTER DATABASE". Seen failing before the fix: **yes**.

### A-02-010 · P2 · `limit` documented in OpenAPI, validated, then ignored
- **Evidence:** `searchQuerySchema` declares `limit` 1–100 (default 20); the handler parsed only `q` and always used 20. `?limit=2` returned 4 rows (red on HEAD).
- **Fix:** handler passes the validated `limit`. Bounds come from the schema (0, −1, 101, `abc`, 2.5 → 422 `invalid_field`, already the case).
- **Test:** `search-route.test.ts` › "honours limit", "rejects limit=… with 422". Seen failing before the fix: **yes** (honours limit).
- **Behaviour change:** `limit` now works. The shipped client always sends 20, so the mobile app sees no difference.

### A-02-011 · P2 · Search and the scan endpoint resolved a shared ISBN to different works
- **Evidence:** two works carrying one ISBN (pre-dedupe duplicates): search picked the more-logged work (`ORDER BY w.log_count DESC`), `GET /v1/editions/isbn/:isbn` the newest edition (`ORDER BY e.publish_year DESC`), i.e. the less-logged duplicate. Neither broke ties deterministically. Demonstrated on HEAD with a throwaway test: `search -> popular  scan -> dup`.
- **Fix:** one `ISBN_ORDER` (`w.log_count DESC, e.publish_year DESC NULLS LAST, e.id`) for both paths.
- **Test:** `isbn.test.ts` › "the scan endpoint and search resolve a shared ISBN to the same work, every time". Seen failing before the fix: **yes**.
- **Verified, no change needed:** merged works: `mergeWorks` repoints editions (`dedupe.ts:245`), so a loser's ISBN resolves to the survivor on both paths (new test). Lowercase `x`, spaces, 979 (no ISBN-10 form), 9/11/12/14 digits, invalid checksum → text search (new tests). 404 for a provisional work's ISBN is byte-identical to an unknown ISBN's (new test). Guest-readable. `1984` is not detected as an ISBN.

### A-02-012 · P1 · DEFERRED + DECISION NEEDED · The author arm's cost grows with the authors table
- **Evidence:**
  - `authors` has **15,385,548 rows; only 1,661,138 (10.8%) are referenced by any work.** The author arm matches over all of them, then probes `work_authors` once per match: `pir` 16,771 authors → 16,507 probes → 5,147 links, 9.0 s (92k buffers); `harry` 18,916 authors, 6.2–9.8 s.
  - `村上` (2 characters): `'%村上%'` has no trigram → **Parallel Seq Scan on authors** (5.1M rows removed per worker), 36–53 s. This is the remaining cost of CJK 2-character search.
  - Anchoring the author pattern for 2 characters (tried) fixed CJK (`村上` author arm 193 ms) but made the planner walk works by popularity for Latin pairs: `th` 61k works walked vs 3.6k (2.2 s → 32 s here). A 2-character author gate breaks the existing search-as-you-type tests `U`/`Ur` → A Wizard of Earthsea (via Ursula K. Le Guin).
- **What was done:** nothing user-visible. The author predicate is written `ILIKE ('%' || $4)`, which equals the pre-audit `$3` at every length, and a comment points here.
- **Decision needed:** 2-character author matching. (a) Titles only below 3 characters (PRD §14.4: autocomplete starts at 3). This changes the `U`/`Ur` tests deliberately. (b) Anchored author prefix: fast for CJK, a long walk for Latin pairs. (c) Keep as is. **Recommendation: fix the structure first (below), then (b) becomes cheap for both.**
- **Proposed fix (≈ 1 day, needs a migration on a 15M-row table, so not done here):** a partial trigram index `ON authors USING gin (flyleaf_author_names(name, alternate_names) gin_trgm_ops) WHERE is_referenced`, with `authors.is_referenced` maintained by a trigger on `work_authors` (or a `search_authors` table of the 1.66M referenced authors). That cuts the candidate set ~9× before any join, and makes an author trigram arm affordable, which AC-7 needs (A-02-015).

### A-02-013 · P2 · DECISION NEEDED · `works.log_count` has no trigger, decrement or reconcile
- **Evidence:** the only writer is `ReadingService.setStatus` (`reading/index.ts:179`, +1 per new attempt, so a re-read counts twice). `imports/committer.ts:154` inserts reads without incrementing. Nothing decrements (account deletion cascades reads away). `mergeWorks` moves reads but not the count. Architecture §3.9 specifies "trigger on reads insert, reconciled nightly"; neither exists. (Part 01 L-08.)
- **Why not fixed here:** `log_count` is the **Open Library popularity baseline plus** Flyleaf's increments, in one column. A reconcile job cannot recompute it from `reads` without destroying the baseline for 3.2M works. And a delete trigger added now would decrement for the 62k bench reads (and any earlier reads) that were never counted. The fix needs: a separate `works.ol_log_count` baseline, a trigger on `reads` INSERT/DELETE/UPDATE OF `work_id`, a nightly `works.reconcile` in the `reads.reconcile` pattern, and a product rule for re-reads (count per attempt or per reader).
- **Decision needed:** does a re-read count twice, and does an imported read count? Recommendation: count distinct readers (`log_count = ol_log_count + count(DISTINCT user_id)`), which also makes merges and deletes self-correcting on reconcile. Owner: Part 08 (reading core; L-08) with Part 03 for merges.

### A-02-014 · P2 · DECISION NEEDED · Ranking diverges from PRD §14.3 / architecture §5.4
- **Evidence:** the spec is `0.45 ts_rank_cd + 0.25 ln(1+log_count) + 0.15 has_cover_and_metadata + 0.10 library_boost + 0.05 recency`. The code (and FN-41's bullet) is title-prefix 0.30 + exact 0.20 + author 0.20 + trigram 0.10 + capped popularity 0.35: no cover, no library boost, no recency, no `ts_rank_cd`. The `alternate_titles` weight-C term of the vector is structurally 0 (the column is never populated; FN-43 note), as is `subtitle` for gap-filled works.
- **Recommendation:** keep the code's weights, which the panel validates (216/217), and update PRD §14.3 and architecture §5.4 to match. Add a cover term only if the panel shows a win.

### A-02-015 · P1 · DEFERRED · AC-7 fails: author typos, viewer status, spelling suggestion
- **Evidence:** `ishigoro` on the full catalog: prefix 0, substring 0, trigram 0 (48 index candidates, all rechecked away), author 0 → **no local result**; AC-7 requires Kazuo Ishiguro via trigram. The trigram arm covers titles only. Results carry no viewer status (AC-7 "my status if any"). No spelling suggestion (§14.7 step 1) or `search_zero_results` log (§14.7) exists.
- **Plan:** an author trigram arm (`flyleaf_author_names(...) % $1`) only after A-02-012's partial index, since on 15.4M authors it has the same growth problem; `your_status` via one batched `reads` lookup for the ≤ 20 result ids (schema + client + Part 08 UI); suggestion and zero-result logging with telemetry (Part 10). Add `ishigoro` to the panel's hard cases when it passes. Not added now, to keep the pass rate honest.

### A-02-016 · P1 · DEFERRED → Part 15 · Residual trigram-arm cost (over budget); no search rate limit (RL)
- **Evidence (after):** `the hobit` trigram arm: 167,552 index candidates, **1,337,114 rows rechecked** (lossy bitmap at 4 MB `work_mem`), 88 kept, 9.9 s; the common word "the" shares enough trigrams with ~5% of titles. `harry` 32,938 candidates, 3.7 s. A 100-character nonsense query: 18 s evaluating trigram keys (5.7k buffers, CPU-bound).
- **Proposal:** match typos per word (`strict_word_similarity` / `<<%` on the longest token) so common words stop generating candidates; validate on the panel. Search has **no rate limit** (PRD §24.4: 20/min anonymous, 60/min signed in), and these are the most expensive requests a guest can send. Tag **RL** → Part 15.

### A-02-017 · P2 · DEFERRED → Part 08 · Discover screen races and recents
- **Where:** `apps/mobile/app/(tabs)/discover.tsx:117-168`.
- **Evidence (code reading):** the effect cancels only the debounce timer, not the request, so a slow response for "ha" can land after "harry" and overwrite it. Every debounced keystroke is saved as a recent search ("ha", "har", "harr"…).

### A-02-018 · P3 · Gap-fill: claims verified; one false comment
- **Verified:** a miss uses `tryAcquire()` and never queues (empty bucket → returns in < 500 ms without calling fetch); a hung Open Library costs one 2.5 s timeout, after which the open breaker short-circuits (next miss < 500 ms, fetch not called). Tests in `search-route.test.ts` › "gap-fill when Open Library is down".
- **Fixed:** `GapFillService.persist` said it "runs after the response has gone out". It runs inside the request (`search` awaits `fill()`, then re-queries). Comment corrected.
- **Note:** search is **not cached** (only `getWork` is), so there is no cross-viewer cache leak and nothing to invalidate after gap-fill.

### A-02-019 · P2 · DEFERRED → Part 08 · No `maturity` in search or ISBN responses
- The client cannot show §7.8's one-time interstitial for an explicit work opened by ISBN or direct link, nor blur explicit covers for filtered users. It needs a `maturity` (or `is_explicit`) field on `Work`; schema + client change, UI in Part 08.

### A-02-021 · P2 · DEFERRED → Part 10 · Flaky mobile test (SL-52), not search
- **Where:** `apps/mobile/src/lib/__tests__/readingVelocity.test.ts:36` › "predicts finish from recent progress events slope"; `apps/mobile/src/lib/readingVelocity.ts:80`.
- **Evidence:** failed CI run 1 of this part (`Estimated finish: in 3 days`, expected 2); passed on re-run (100/100) with no mobile change. The test builds its two timestamps from two separate `Date.now()` calls, so the span is 2 days plus the milliseconds between the calls; line 80's `Math.ceil(pagesLeft / speed)` turns 2.00001 into 3. Line 101 (percent path) already rounds before `ceil`; line 80 does not.
- **Why not fixed here:** not search, and fixing it changes SL-52 code. It belongs to its own audit. A one-line fix (round before `ceil`, as line 101 does) plus a test pinning `Date.now()`.

### A-02-020 · P3 · Part 01 L-06 closed
- `GET /v1/search` now has HTTP-level tests (`search-route.test.ts`: 23 tests, through `buildApp` with real auth).

## FN-43 panel checks

| Check | Result |
|---|---|
| Executes the exported `SEARCH_SQL`, not a copy | ✅ popularity weight 0.35 → 0: **205/217 (94.5%)**, floor failed (prefix 54/61, author 33/38); restored |
| Measures position (exact #1, others top 5) | ✅ `within` 1 / 5 |
| Runs in CI | ✅ `scripts/ci.mjs:53` `api · tests` runs `npm test` (all of `src/test`) |
| `1984` gap test still asserts the gap | ✅ `search.test.ts` and `relevance.test.ts` |
| Pass rate | 216/217 before and after this part; the one miss is `king` (documented product decision) |

## Performance

Full catalog, guest. Before = HEAD `664a811` + Part 01 tree; after = this part. **Indicative only (8 GB dev machine).**

### Plans (EXPLAIN ANALYZE, BUFFERS; top-level shared hit+read, 8 kB pages)

| Query | Before: buffers · ms · dominant node | After: buffers · ms · dominant node |
|---|---|---|
| `a` (1 char; the API returns [] without querying) | 205,101 · 54,146 · trigram arm, 1.3M candidates | 17,956 · 4,051 · (not reachable from the API) |
| `th` | 229,058 · 23,405 · trigram arm 1.13M candidates, 2.79M rechecked | **36,228 · 1,346** · trigram skipped; author arm 1.1 s |
| `the` | 298,809 · 26,502 · trigram arm 1.12M candidates | **~100,000 · 478–6,130** · trigram skipped; author walk (cache-dependent) |
| `harry` | 157,426 · 9,067 · author 18.9k authors; trigram 32.9k | 156,709 · 13,355–17,070 · unchanged (A-02-012, A-02-016) |
| `murakami` | 11,360 · 992 | 11,363 · 688–860 · unchanged |
| `村上` | 462,777 · 80,297 · **seq scan works** (25 s) + **seq scan authors** (53 s) | 254,202 · 39,796 · works seq scan gone (title arm 1.1 ms); authors seq scan remains (A-02-012) |
| `村上春樹` | not measured (run order) | 5,640 · 264 · all arms indexed |
| `the hobit` | timed out (180 s) in sequence; trigram arm alone 112,838 buffers · 16,313 | 117,934 · 11,118 · trigram arm 1.34M rechecked (A-02-016) |
| `pir` | timed out in sequence; trigram arm alone 49,608 · 3,508; author arm alone 91,990 · 9,018 | 134,665 · 24,854 · trigram skipped; author 16.8k authors (A-02-012) |
| `9780441478125` | 1,552 ms when run alone | 599 · 419 |
| 200-char nonsense | per-arm sum ≈14,400 · ≈28,000 | 5,757 · 18,768 · cut to 100 chars; trigram key evaluation (A-02-016) |
| `ishigoro` | — | 1,837 · 368 · **0 results** (A-02-015) |

Sequential runs on this machine are not independent: a seq scan of `authors` (5.4 GB) evicts the 3.4 GB page cache and the next queries stall on I/O (`/proc/pressure/io` full avg300 = 1.30). Queries that timed out in sequence were measured per arm in isolation; the ≥3-character after-plans come from the first after-run, whose SQL is identical to the final one for those lengths.

### Bench (autocannon, 10 connections × 10 s, `search` scenarios)

Before = `perf/02-search-before.md` (this part, same code as `perf/baseline.md`, run back to back with after); after = `perf/02-search-after.md`. Load p50 / p95 / p99 ms; "≥10 s" = timed out; unloaded p50 from the sequential pass.

| Scenario | `baseline.md` (Part 01) | Before (this part) | After | Queries/req |
|---|---|---|---|---|
| search:prefix (`h ha th st a lo`) | 6,400 / ≥10 s / ≥10 s, saturated; unloaded 5,832 | 86 / ≥10 s / ≥10 s, saturated; unloaded 26,977 | **298 / 1,018 / 1,091**, 22 req/s; unloaded 271 | 1 (0 for 1-char) |
| search:common (`the love war night house girl`) | all timed out; unloaded 19,328 | all timed out; unloaded 30,000 | all timed out; unloaded 26,246 | 1 |
| search:author | 416 / 785 / 836 | 414 / 757 / 836 | 441 / 840 / 1,262 | 1 |
| search:cjk (`村上 村上春樹`) | 3,219 / ≥10 s, saturated | 4,267 / ≥10 s, saturated | 1,195 / ≥10 s, saturated | 1 (+1 signed in) |
| search:typo | 1,301 / ≥10 s, saturated | 6,536 / ≥10 s, saturated | 2,842 / ≥10 s, saturated | 1 |
| search:isbn | 172 / 1,325 / 1,667 (`baseline-search-isbn.md`) | 261 / 457 / 855 | **159 / 219 / 469**, 69 req/s | 2 |

Reading it: prefix search went from saturated to answering (a ≥10× change, and the plans show why: the 1.1M-candidate trigram arm no longer runs). `common`, `cjk` and `typo` are still saturated **under 10-way load on this machine**. Their remaining cost is the author arm over 15.4M authors (`村上` still seq-scans authors) and the trigram arm on 4+ character common words and multi-word typos: A-02-012, A-02-016. Author and ISBN are within noise. **Search p95 < 300 ms is not met here for 4 of 6 scenarios** (indicative only; buffer counts above are the portable evidence). Queries per request: 1 for guests (2 with an ISBN hit), +1 for a signed-in viewer (the §7.8 age/opt-in lookup, run in parallel with the ISBN lookup).

- Warm driver-path timings (`generic-plan-probe.ts`, one connection, custom plans): `murakami` 130–388 ms, `tolkien` 191–408 ms (first `tolkien` cold: 40.8 s).
- `pg_trgm.similarity_threshold` on a new connection: **0.45** (`flyleaf`, `flyleaf_dev`).

**Cold cache** (after `docker restart flyleaf-pg`, API stopped; the WSL VM's page cache is not dropped by a container restart, so this is cold `shared_buffers`, possibly warm OS cache):

| Query | Cold | Warm (immediately after) | Buffers cold → warm |
|---|---|---|---|
| `murakami` | 927 ms | 128 ms | hit 6,856 read 4,493 → hit 11,237 read 24 |
| `tolkien` | 925 ms | 167 ms | hit 7,210 read 4,503 → hit 11,628 |

Documented in tasks.md: 430–815 ms cold, 47–85 ms warm, on other hardware. The buffer count for `murakami` is the same before and after this part (11,360 vs 11,363), so this is no regression; the difference from the documented figures is this machine.

## Behaviour changes

1. **Explicit works are hidden from search** for guests, minors and adults who have not opted in (PRD §7.8). An exact ISBN still resolves them (search and scan).
2. **2–3 character queries skip the typo (trigram) arm.**
3. **2-character queries match titles by prefix, not by substring** ("rt" no longer finds "Earthsea"; "ha" still finds "Harry…"). Author matching is unchanged.
4. **Query input:** NUL removed; anything past 100 characters ignored; one-letter words ignored when a longer word is present.
5. **Non-Latin prefix search works** (Cyrillic, CJK, Devanagari…), and accents fold on both sides (`łodz` finds "Łódź"). `o'brien` now matches through the prefix arm too.
6. **`limit` is honoured** (1–100). The shipped client sends 20.
7. **A shared ISBN resolves to the more-logged work** on the scan endpoint too (was: the newest edition's work).
8. Every pooled connection sets `pg_trgm.similarity_threshold = 0.45` itself.

## Decisions needed

1. **A-02-012:** 2-character author matching: titles only below 3 characters, anchored author prefix, or keep. Recommendation: build the referenced-authors partial index first, then anchor.
2. **A-02-013:** what `log_count` counts (re-reads, imports) and a separate OL baseline column. Recommendation: `ol_log_count + distinct readers`, trigger + nightly reconcile.
3. **A-02-014:** make PRD §14.3 / architecture §5.4 match the panel-validated weights, or change the code. Recommendation: update the docs.
4. **A-02-001:** an exact ISBN typed into search resolves explicit works for everyone (like a scan). Recommendation: keep, and add the interstitial (A-02-019). The alternative is to filter it for filtered viewers in search only.

## Deferred (with reason and owner part)

| Finding | Owner | Reason |
|---|---|---|
| A-02-012 author-arm growth, 2-char CJK authors | Part 02 follow-up / Part 15 | migration on 15.4M authors + trigger; decision 1 |
| A-02-013 `log_count` maintenance | Part 08 (+ Part 03 merges) | schema split + product rule; decision 2 |
| A-02-015 AC-7 (author typos, status, suggestion) | Part 08 (UI), Part 10 (zero-result log), after A-02-012 | depends on A-02-012; schema + client + UI |
| A-02-016 residual trigram cost; search rate limit (RL) | Part 15 | ranking change needs panel work; limiter layer is Part 15's |
| A-02-017 Discover race and recents | Part 08 | mobile screen audit |
| A-02-019 `maturity` in responses | Part 08 | schema + client + UI |
| Cursor pagination (PRD §14.4 "20, cursor-paginated", arch §6 "cursor only"): search has only `limit` | Part 15 | the candidate set is bounded (≤ 1,050), so a cursor over it is cheap, but no client pages today |
| Box sets excluded from default search (§34.1) | Part 08 | the catalog has no box-set flag |
| Setting `show_explicit` (§7.8 Settings → Content, DOB re-entry) | Part 10 | no route or screen exists |
| A-02-021 flaky SL-52 mobile test | Part 10 | not search; pre-existing |

## Tooling added

- `apps/api/src/bench/explain-search.ts`: emits a psql script that EXPLAINs the real `SEARCH_SQL` with `searchArgs` (custom or forced-generic plan).
- `apps/api/src/bench/generic-plan-probe.ts`: runs `CatalogService.search` on one pooled connection and reads `pg_prepared_statements`.
- Bench reports: `docs/audit/perf/02-search-before.md`, `02-search-after.md`.

## CI after

| Run | Result |
|---|---|
| 1 | ✗ after 459 s: everything green up to **mobile · offline tests**, 1 failure in `readingVelocity.test.ts` (A-02-021, pre-existing timing flake, no mobile file changed); API 819/819 |
| 2 (no changes in between, apart from a comment) | ✓ **green in 424 s**: api-client build, api typecheck, spec check (OpenAPI drift 0; descriptions of `GET /v1/search` and `q` updated), api tests **819 passed** (48 files), api build, audit, mobile typecheck, mobile offline tests **100 passed**, migrations on a real Postgres |

`npm run migrate` against the full catalog: `migrations applied` (this part adds no migration).
