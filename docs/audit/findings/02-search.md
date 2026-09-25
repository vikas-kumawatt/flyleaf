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

---

# Part 02b — deferred search P1s (A-02-012, A-02-015, A-02-016) and decisions 1–4

2026-09-25 · CI: see *Part 02b CI* at the end · tests **819 API + 100 mobile → 837 API + 100 mobile** (+6 `search.test.ts`, +9 `search-route.test.ts`, +3 `relevance.test.ts`: 1 hard case and 2 rows in its typo `it.each`; one plan-text assertion updated for the new operator, see A-02-023; no test weakened or removed)

Decisions taken as given by the reviewer: (1) build the credited-authors partial index, then anchor 2-character author matching to name/word prefixes; (2) fix the typo arm by EXPLAIN evidence, the rate limit stays with Part 15; (3) PRD §14.3 follows the code; (4) an exact ISBN on search **and** on the scan endpoint follows the search maturity filter, with a distinguishable "restricted" response.

Databases: plans from the full catalog `flyleaf` unless marked; relevance on PGlite with the committed corpus. **Baseline = the Part 02 "after" table above.** Re-captured at the start of this part with the unchanged SQL: `th` 36,234 buffers, `pir` 134,639, `harry` 156,747, `村上` 254,203, `the hobit` 117,934. `ishigoro`, `harry potter`, `murakami` and `lord of the rings` hit the 180 s timeout in that sequence, because the `村上` authors seq scan evicted the page cache first (the effect Part 02 documented).

## Verdict per finding

| Finding | Part 02 | Part 02b |
|---|---|---|
| A-02-012 author arm grows with the authors table; 2-char CJK authors seq-scan | P1 deferred | ✅ fixed (A-02-022) |
| A-02-016 typo arm rechecks 1.3M rows on "the hobit" | P1 deferred | ✅ fixed (A-02-023); rate limit still Part 15 (RL) |
| A-02-015 AC-7: `ishigoro`, "my status", spelling suggestion | P1 deferred | ⚠️ `ishigoro` ✅, `your_read` ✅ (API; UI → Part 08), suggestion deferred (A-02-024) |
| A-02-014 ranking vs PRD §14.3 | decision needed | ✅ decided: PRD §14.3 updated to the code's weights (decision 3) |
| A-02-001 opt-in to explicit | not done | ❌ confirmed: no way to opt in exists (A-02-026) |
| Decision 4 ISBN maturity | decision needed | ✅ implemented (A-02-025); ⚠️ conflicts with PRD §7.8 [LOCKED] wording |

## Findings

### A-02-022 · P1 · FIXED · Author arm over credited authors only; 2-character author matching anchored (A-02-012)
- **Where:** `apps/api/drizzle/0019_credited_authors.sql` (new), `src/db/schema.ts` `authors.hasWorks`, `SEARCH_SQL` `by_author` and the ranking author term, `buildSearchParams().authorLike`.
- **Evidence (before):** 15,385,548 authors, 1,661,138 credited. `pir`: 16,771 authors matched, 16,507 `work_authors` probes, 134,639 buffers for the whole query. `村上`: `'%村上%'` has no trigram, so a Parallel Seq Scan on authors (254,203 buffers).
- **Fix:**
  - `authors.has_works boolean NOT NULL DEFAULT false`, set by a **statement-level** `AFTER INSERT` trigger on `work_authors` over its transition table (a bulk ingest is one UPDATE, not 3.8M), backfilled in the migration. New index `authors_credited_trgm_idx` = `gin (flyleaf_author_names(name, alternate_names) gin_trgm_ops) WHERE has_works`.
  - **Set-only by design.** Nothing clears the flag. A stale TRUE costs index space only, because the arm still joins `work_authors`. A delete trigger that cleared it would race a concurrent insert (its `NOT EXISTS` cannot see the other transaction's link) and could hide a credited author from search. INSERT is the only event: nothing updates `work_authors.author_id` (dedupe repoints by insert + delete; checked by grep).
  - `by_author` and the ranking author term: `a.has_works AND flyleaf_author_names(...) ILIKE ANY ($7)`. `$7` = `['%q%']` from 3 characters. For 2 characters it is `['q%', '% q%']`: the name, or a later word in it, starts with q.
- **Two characters: the anchoring cost, measured, and the LIMIT that fixes it.** Anchoring did what Part 02 predicted: CJK became cheap and dense Latin pairs became a long walk. A sparse anchored pattern makes the planner walk `works_log_count_idx` further before 300 matches turn up (`th`: 14,204 works walked, 11,878 author probes; whole query **144,882 buffers vs 36,228** before). Author arm alone on the full catalog:

  | Variant (2 characters) | `th` | `le` | `ur` | `村上` |
  |---|---|---|---|---|
  | name or word prefix, LIMIT 300 | 122k buf | 87k | 40k (bitmap) | 1.5k |
  | name prefix only (`'q%'`) | 252k | 208k | 14k | 1.3k |
  | either, with `+ 0` (force bitmap) | 249–452k | 205–555k | 14–40k | 1.3–1.5k |
  | bounded walk of the top 5,000 / 10,000 works | 54k / 67k | 50k / 50k | 54k / 80k | 54k / 45k |
  | **chosen: name or word prefix, LIMIT 50** | **16.7k** | **11.7k** | 40k | 1.5k |
  | pre-audit `'%th%'` over all authors (baseline) | 26.6k | — | — | 254k (seq scan) |

  A guard (skip the 2-character author arm when the title arms fill the page) was rejected on results rather than cost. On the full catalog `ur` now returns Le Guin at ranks 2, 3, 6, 12, 13 and *A Wizard of Earthsea* at #19; HEAD returned ranks 4, 5, 13 and no Earthsea. "Ur…" titles fill the page, so a guard would lose Earthsea again. With LIMIT 50 the `ur` ranking is identical to LIMIT 300 (Earthsea still #19). `LIMIT CASE WHEN char_length($1) < 3 THEN 50 ELSE 300 END` folds to a constant under the custom plan (plan shows `Limit … rows=50`). No PGlite test pins the 50: a tiny table never chooses the walk, and asserting the SQL text would be tautological. The evidence is the full-catalog plan above.
- **Test:** `search.test.ts` › "matches author names only among credited authors", "two characters match the start of a name or of a word in it, not the middle of a word" (`le` → Le Guin; `rs` no longer reaches Ursula), "keeps a substring from three characters", and `authors.has_works` › "is set by a single insert and by a multi-row insert, and not cleared by a delete". Seen failing before the fix: **yes** (all four). "keeps a substring from three characters" was red only because the pattern changed form; behaviour at ≥ 3 characters is unchanged. The `U`/`Ur` search-as-you-type tests pass **unchanged**.
- **`flyleaf_dev`:** 114,390 of 114,390 authors flagged, equal to `count(DISTINCT author_id)` in `work_authors`. `devdb.ts` copies every shared column with triggers off, so a rebuilt slice inherits the flag from the full catalog.
- **Migration cost, measured (full catalog):** the backfill rewrites 1.66M rows of a 1.9 GB table with four indexes. A 5,000-row sample (inside a rolled-back transaction) took 20.3 s and 35.2k block reads; about 4.5 random reads per row are the update itself. The migration holds `ACCESS EXCLUSIVE` on `authors` for its whole run, so search's author arms block. The first attempt ran at ~15 reads/s under concurrent EXPLAIN load and was cancelled after 47 min (clean rollback, nothing committed). The second run: see *Part 02b CI*. **On a production database this needs a maintenance window or a batched online backfill.** It is a one-off.
- **Not done:** `authors_search_trgm_idx` (938 MB, full table) has no user after this change. Dropping it gave no measurable gain for the backfill (35.0k vs 35.2k reads on the same sample), so it stays; see A-02-027.

### A-02-023 · P1 · FIXED · Typo arm cost on multi-word queries with common words (A-02-016)
- **Where:** `SEARCH_SQL` `title_fuzzy`, the new `author_fuzzy` and `exact` CTEs.
- **Evidence (before):** `title % 'the hobit'`: 167,552 index candidates, **1,337,114 rows rechecked** (lossy bitmap), 112,838 buffers for the arm. "the" is 4 of the query's 10 trigrams, and at 0.45 any title with "the" and an h-word qualified.
- **Options measured on the full catalog** (title arm alone, `EXPLAIN (ANALYZE, BUFFERS)`; "cand." = trigram index candidates):

  | Option | `the hobit` | `lord of the rngs` | `war and peice` | `harry` | Relevance (PGlite panel) |
  |---|---|---|---|---|---|
  | before: `title % q` | 167,552 cand. · 1.34M rechecked · 112.8k buf | — | — | 32,938 cand. (Part 02) | 216/217 |
  | long words only: `title %> 'hobit'` + whole-string recheck | **403** cand. · ~1.0k buf | 737 · 1.8k buf | 1,832 · 2.6k buf | **walks `works_log_count_idx`: 2.8M rows filtered, 993k buf, 98 s** | **213/217**; `war and peice`, `lord of the rngs` lost |
  | long words at word threshold 0.5 | not measured | | | | 215/217, but the author arm floods (`remains of the dy` → *Atomic Habits*) |
  | long words, strict `%>>` (title arm) | not measured | | | | 215/217; `war and peice`, `can't urt me` lost |
  | **chosen: whole query, `title %> q` + `similarity ≥ 0.45` recheck, `ORDER BY log_count + 0`** | **46,101 cand. · 25,327 rechecked · 43.6k buf** (no lossy pages) | 3,333 · 8.0k buf | 2,398 · 5.3k buf | arm not run (guard) | **216/217**, same single miss (`king`) |

  Measured word similarity of the long-words key was lower than trigram arithmetic suggested: `endswith`/"It Ends With Us" 0.58, `diary awimpy` 0.58, `lord rngs` 0.50, `peice` 0.33, against a threshold of 0.6. The whole query scores 0.71–0.78 on all of them. So the arm keeps judging the whole query and only its candidate generation changes: `%>` (word similarity ≥ 0.6) needs 6 of 10 trigrams where `%` at 0.45 needed 5. Since `word_similarity ≥ similarity` always, the new arm's result is the old arm's narrowed, never widened.
- **Two protections, each from a measured failure:**
  1. `ORDER BY log_count + 0 DESC`. With a common word the planner estimates `%>` at 12–37k rows (`matchingsel` evaluates the MCVs) and walks `works_log_count_idx`, filtering row by row: `harry` removed 2,823,807 rows, read 993,122 buffers, 98 s. `+ 0` makes the index unusable for the ORDER BY, so the arm is always bitmap candidates plus a top-N sort, bounded by the trigram index.
  2. **The typo arms run only when the exact arms (prefix, substring, author) hold fewer than `limit` candidates** (`(SELECT count(*) FROM exact) < $5`, an InitPlan; otherwise the plan shows the arms as `never executed`). This is a heuristic. A typo candidate carries no prefix or exact-title score, so on a query the exact arms fill, it ranks below them in all but rare cases (a very popular fuzzy match against weak exact matches). The panel is the check: 216/217, and all 29 generated typo cases pass.
- **Test:** `search.test.ts` › "the typo arms find candidates by word similarity of the whole query, not by %", "the typo arms do not run when the exact arms already fill the page", and "skips the trigram arm below 4 characters, keeps it from 4" (**updated**: it matched the operator text `title % `, now `title %> `; the rule it pins is unchanged). `relevance.test.ts` › typo hard cases `war and peice` and `lord of the rngs`, added because they pass before and after but fail under the cheaper long-words design, which is the regression they guard against. Seen failing before the fix: **yes** for the two plan tests. The `+ 0` walk cannot be reproduced on PGlite (tiny tables never choose the walk); its evidence is the full-catalog plan above.
- **Behaviour change:** typo tolerance is skipped when the exact arms already return at least `limit` candidates.

### A-02-024 · P1 · PARTLY FIXED · AC-7 (A-02-015)
- **`ishigoro` → Kazuo Ishiguro:** new `author_fuzzy` arm, `flyleaf_author_names(...) %> $1` over credited authors (same partial index, same guard, same `+ 0`). On the PGlite corpus it returns *Never Let Me Go*, *Klara and the Sun* and *The Remains of the Day*. It also fixes `murakmi` → Murakami and `atwod` → Atwood (probed, not asserted). Full catalog: see Performance. **Test:** `relevance.test.ts` › "ishigoro finds works by Kazuo Ishiguro" (a hard case, as Part 02 planned). Seen failing before: **yes** (0 results on HEAD).
- **"my status if any":** search results now carry `your_read`, the same shape as `GET /works/:id` (id, status, rating, hearted, page, percent of the latest attempt). It comes from **one** query for the page (`DISTINCT ON (work_id)` plus a `LATERAL` last progress event; `reads_user_work_attempt` serves it). Guests cost no query. **Test:** `search-route.test.ts` › "carries the viewer's latest attempt…" and "costs one query for the whole page, not one per row" (a spy on `db.execute` sees 2 calls when signed in, `#allowsExplicit` + `#yourReads`, and 0 for a guest, with a read on every row). Seen failing before: **yes**. No schema or client change: `Work.your_read` already existed in `workSchema` and `@flyleaf/api-client`. Showing it in the Discover list is UI → Part 08.
- **Spelling suggestion: DEFERRED → Part 10**, together with `search_zero_results` logging. The spec asks for it (AC-7, §14.7 step 1), but it is not cheap here. A zero-result query has already failed both typo arms at their thresholds, so a suggestion needs a second, looser trigram pass over titles and credited authors, which is the very cost A-02-023 removed. Proposal: suggest only from credited-author names and popular titles (a small table), and log zero results first to learn whether it is worth building.
- **Known misses (not fixed, recorded):** `tolkein` (word similarity to "Tolkien" 0.50, under 0.6) and `harry pottr` (whole-string similarity to the long Harry Potter titles is under 0.45) return nothing, before and after this part. Lowering the thresholds floods the author arm (measured above).

### A-02-025 · P1 · FIXED · Decision 4: exact ISBN follows the search maturity filter, on search and on the scan
- **Where:** `CatalogService.#findWorkByIsbn`, `getEditionByIsbn`, `isbnOrder()`, `GET /v1/editions/isbn/:isbn` (403 added to the route schema), `apps/mobile/app/scanner.tsx`.
- **Before:** both paths resolved an explicit work for everyone. Part 02 had kept §7.8's "Direct link or ISBN scan: resolves".
- **Fix:** both ISBN queries order by `(explicit AND NOT allowed)` first, then by the shared order (log_count, newest edition, id). A shared ISBN therefore resolves to an allowed work when one exists, and **identically on both paths**, which keeps A-02-011's invariant. On search, an explicit match the viewer may not see counts as no match, and text search runs filtered as usual. On the scan, the answer is **403 `content_restricted`** ("This book is hidden by your content settings.") with no work data; an unknown ISBN is still 404 `not_found`. 403 rather than 404 because the catalog is public, so existence hides nothing, and the scanner has to say why nothing opened; the 00-method 404-not-403 rule is about other users' resources. The scanner now shows that message instead of "No edition found".
- **Test:** `search-route.test.ts` › "exact ISBN follows the maturity filter (decision 4)": the scan returns 403 for a guest, an adult not opted in, and an under-18 account with the flag set; an unknown ISBN returns 404; an opted-in adult gets 200; search surfaces the work only for the opted-in adult; a shared ISBN resolves to the allowed work for a guest on both paths, and to the explicit one for the opted-in adult. Seen failing before: **yes** (5 of 6; the 404 test passed before, as it should). Mobile: typecheck only, since no scanner test harness exists.
- **Query count:** the maturity lookup now runs before the ISBN lookup, because it decides the order. A signed-in ISBN search is therefore sequential: allowsExplicit → ISBN → SEARCH_SQL → your_read (4 queries); a guest's is 2. The scan endpoint costs +1 query for a signed-in viewer (0 for a guest).
- **⚠️ Spec conflict:** PRD §7.8 [LOCKED] says a direct link or ISBN scan "resolves and is loggable, with a one-time interstitial. **A user is never blocked from recording a book they actually read**." Decision 4 blocks the scan for filtered viewers. Direct links (`GET /works/:id`) still resolve. §7.8 was **not** edited because it is LOCKED; see Decisions needed.

### A-02-026 · P1 · CONFIRMED, NOT FIXED · No way for an adult to opt in to explicit content (A-02-001)
- **Evidence:** the only writer of `profiles` is `IdentityService.updateProfile` (`identity/index.ts:545-556`), which copies an explicit allowlist (`displayName`, `bio`, `isPrivate`, `favouriteWorkIds`). Apart from `#allowsExplicit`, nothing in `apps/api/src` or `apps/mobile` reads or writes `show_explicit`. LA-02 (Settings → Content) is `[ ]` in tasks.md.
- **Behaviour change, stated explicitly:** since Part 02 no account can see explicit works in search. Since this part, none can open one by ISBN scan either; only a direct link resolves. **No UI until LA-02.** The §7.8 setting (18+ only, date of birth re-entered to change it) belongs to LA-02 / Part 10.

### A-02-027 · P3 · Unused author trigram indexes
- `authors_search_trgm_idx` (938 MB, all 15.4M authors) lost its only user (`by_author`) in this part. `authors_name_trgm_idx` (936 MB) already appears unused: the admin and import queries match `a.name` per work through `work_authors`, never through an author trigram index (grep of `apps/api/src`). Both cost something on every author write. Dropping them is a schema change with no measured benefit for this part's backfill. Recommendation: drop both after confirming `pg_stat_user_indexes.idx_scan` on a production-like run. Owner: Part 15.

## Decision 3 (A-02-014)
PRD §14.3 now states the code's formula (0.30 prefix · 0.20 exact · 0.20 author · 0.10 trigram · 0.35 capped popularity) and marks the old formula as never built. Architecture §5.4 now points to it, and tasks.md FN-41 records it as decided.

## Performance (Part 02b)

Full catalog, guest, final SQL, `EXPLAIN (ANALYZE, BUFFERS)` of the real `SEARCH_SQL` via `src/bench/explain-search.ts`. Buffers = top-level shared hit + read (8 kB pages). **Indicative only (8 GB dev machine).** The after-run started right after the 65-minute migration, so its first queries ran cold; `pir`, `harry` and `the hobit` were re-timed warm (second of two runs, same buffers).

| Query | Part 02 after: buffers · ms | Part 02b after: buffers · ms | Plan notes |
|---|---|---|---|
| `th` | 36,228 · 1,346 | **24,068** · 216–353 | author arm LIMIT 50 at 2 chars (walk of 0.4k works, not 14k) |
| `ur` | not measured | 63,617 · 2,512 | author arm is a bitmap on `authors_credited_trgm_idx` (5,340 candidates → 2,434 authors) |
| `le` | not measured | 85,056 · 6,070 | 65k of it in the **title** arms (`title_like 'le%'` walk 49k, `fts` 16.5k), untouched here; author arm 11.7k |
| `村上` | 254,202 · 39,796 | **2,844** · 376 | authors seq scan gone: bitmap on the partial index |
| `pir` | 134,665 · 24,854 | **76,363** · 1,023 warm (40,169 cold) | author arm over 1.66M credited authors, not 15.4M |
| `harry` | 156,709 · 13,355–17,070 | **62,660** · 745 warm (63,185 cold) | typo arms `never executed` (guard) |
| `the hobit` | 117,934 · 11,118 (arm: 1.34M rechecked) | **51,126** · 2,186 warm | typo arm 46k candidates, 25k rechecked, no lossy pages |
| `ishigoro` | 1,837 · 368 · **0 results** | 1,864 · 704 · **20 results, all Kazuo Ishiguro** | author typo arm |
| `murakami` | 11,363 · 688–860 | **7,624** · 680 | |
| `harry potter` | not measured (timed out at the start of this part) | 7,340 · 1,846 | |
| `lord of the rings` | not measured (timed out at the start of this part) | 7,800 · 4,423 | |
| `war and peice` | — | 9,887 · 3,345 | finds *War and Peace* (PGlite probe) |
| `tolkien` | — | 8,014 · 2,196 | |

Reading it: every query measured in both parts reads fewer buffers, from 1.5× (`murakami`, `th`) to 89× (`村上`), except `ishigoro` (+1.5%, the author typo arm it now needs to return anything). None grows with the authors table any more. Warm latencies for the formerly slow shapes are 0.2–2.2 s here. **Search p95 < 300 ms is still not demonstrated on this machine** (indicative only; the buffer counts are the portable evidence). The autocannon bench was not re-run this part: the database was I/O-starved for most of it (migration, cold cache), and back-to-back ratios would not have been clean.

**Queries per request:** guest search 1 (2 with an ISBN hit); signed-in search 3 (`#allowsExplicit`, `SEARCH_SQL`, `#yourReads`), 4 with an ISBN, now sequential; scan endpoint +1 for a signed-in viewer.

## Behaviour changes (Part 02b)

1. **Exact ISBN follows the maturity filter.** For guests, minors and adults who have not opted in, `GET /v1/editions/isbn/:isbn` answers **403 `content_restricted`** for an explicit work (it was 200), and search no longer puts it first (it was #1). A shared ISBN resolves to the allowed work for a filtered viewer, on both paths. The scanner says "This book is hidden by your content settings."
2. **Nobody can opt in yet** (A-02-026), so explicit works are reachable only by direct link. **No UI until LA-02.**
3. **2-character author matching is anchored** to the start of the name or of a later word in it: `le` finds Le Guin, `rs` no longer matches "Ursula". At 2 characters the author arm takes the 50 most-logged matching works, not 300.
4. **Typo tolerance for author names** (`ishigoro`, `murakmi`, `atwod`), new.
5. **Typo arms are skipped when the exact arms already fill the page**, and their candidates need word similarity ≥ 0.6 on top of the old similarity ≥ 0.45 (never wider than before).
6. **Search results carry `your_read`** for a signed-in viewer, as `GET /works/:id` does.
7. Matching now covers credited authors only. No visible change, because an uncredited author has no works to return.

## Decisions needed (Part 02b)

1. **PRD §7.8 [LOCKED] vs decision 4.** §7.8 says an ISBN scan "resolves and is loggable… a user is never blocked from recording a book they actually read". Decision 4 blocks the scan for filtered viewers. Implemented as decided; §7.8 not edited. Options: (a) amend §7.8's "Direct link or ISBN scan" row to "direct link resolves with the interstitial; ISBN scan follows the search filter"; (b) revert the scan half of decision 4 and keep only search's. **Recommendation: (a), and once LA-02 exists, make the 403's copy point to the setting**, so a reader of explicit material has a way in.
2. **Rolling 0019 out on a production-size database.** It took 64 min 41 s here under an `ACCESS EXCLUSIVE` lock on `authors`. Options: a maintenance window, or split the backfill into batches outside the migration (and build the index `CONCURRENTLY`, which cannot run inside drizzle's migration transaction). Recommendation: decide before the first production deploy; for dev and CI it is fine.
3. **A-02-027:** drop `authors_search_trgm_idx` and `authors_name_trgm_idx` (1.9 GB, now unused)?
4. **Author-typo threshold:** `tolkein` misses at word similarity 0.6. Lowering the threshold flooded results (measured at 0.5). Accept, or feed common misspellings in as author aliases? Recommendation: accept, and revisit with the zero-result log (Part 10).

## Deferred (Part 02b)

| Item | Owner | Reason |
|---|---|---|
| Spelling suggestion (AC-7, §14.7 step 1) + `search_zero_results` log | Part 10 | not cheap: a looser second trigram pass is the cost A-02-023 removed; A-02-024 has a proposal |
| `your_read` shown in the Discover list | Part 08 | UI |
| Search rate limit (RL, A-02-016) | Part 15 | limiter layer |
| 2-character **title** arm walk (`le`: `title_like` 49k buffers) | Part 15 | Part 02's A-02-003 arm, untouched here; same LIMIT-by-length idea applies |
| A-02-027 unused author trigram indexes | Part 15 | needs `idx_scan` evidence on a production-like run |
| `tolkein`, `harry pottr` | Part 10 | with the suggestion work |

## Tooling (Part 02b)

- `src/bench/explain-search.ts`: PREPARE signature follows `searchArgs` (7 parameters); array parameters are emitted as `ARRAY[...]::text[]`.

## Part 02b CI

| Run | Result |
|---|---|
| 1 | ✗ after 909 s at **api · audit**: the npm registry answered `400 Bad Request … Invalid package tree` ("This endpoint is being retired"). Everything before it was green (api-client build, api typecheck, spec check, api tests **837/837**, api build). No dependency file changed in this part; `npm ls` reports no invalid tree, and the same `npm audit --audit-level=high` exited 0 minutes later. Transient, registry-side. (It now reports 7 moderate advisories where the `ci.mjs` comment says 4: pre-existing drift, not from this part.) |
| 2 (no changes in between) | ✓ **green in 743 s**: api-client build, api typecheck, spec check (OpenAPI drift 0; `GET /v1/editions/isbn/:isbn` gained 403 and a description), api tests **837 passed** (48 files), api build, audit, mobile typecheck, mobile offline tests **100 passed**, migrations on a real Postgres |

`npm run migrate`: `flyleaf_dev` applied 0019 in 17 s (114,390 authors flagged); full catalog `flyleaf` applied it in **64 min 41 s** (second attempt; the first was cancelled after 47 min and rolled back cleanly), **1,661,138 authors flagged = `count(DISTINCT author_id)` in `work_authors`**, `authors_credited_trgm_idx` 81 MB; a re-run prints `migrations applied`.

---

# Part 02c — scan maturity reverted to PRD §7.8, ingest cost of `has_works`, rollout notes

2026-09-25 · CI: see *Part 02c CI* at the end · tests **837 API + 100 mobile → 840 API + 100 mobile** (+2 `ingest.test.ts`; `search-route.test.ts`'s decision-4 block rewritten, 7 → 8 tests, see A-02-028; no test weakened, skipped or removed for any other reason)

Decisions taken as given by the reviewer: (1) revert decision 4 on the scan endpoint to honour PRD §7.8 [LOCKED]: it always resolves; search results, an ISBN typed into search included, keep the filter; §7.8 not edited. (2) Measure the `has_works` trigger on the ingest; if bulk writes update authors row by row, bypass it during the load and set the flag in `--finalise`. (3) Record 0019's rollout needs (LA-05) and the condition for dropping the author trigram indexes (Part 15). (4) Record `tolkein` as a required case for Part 10's spelling suggestion.

## Verdict per finding

| Finding | Part 02b | Part 02c |
|---|---|---|
| A-02-025 decision 4: the scan answered 403 for filtered viewers | implemented, ⚠️ conflicted with §7.8 | ✅ scan half reverted (A-02-028); search half kept |
| A-02-019 no `maturity` for the §7.8 interstitial | deferred → Part 08 | ⚠️ done for the scan (`maturity` + `content_warning`, scanner interstitial); `GET /works/:id` and search results still carry none → Part 08 |
| A-02-022 `has_works` trigger on `work_authors` | fixed | ✅ the ingest no longer pays for it inside every batch (A-02-029) |
| 02b decision 2: rolling out 0019 | decision needed | recorded under LA-05 in tasks.md |
| A-02-027 unused author trigram indexes | Part 15 | precondition added: only after Parts 03 and 12 confirm (below) |
| 02b decision 4: `tolkein` | decision needed | accepted as a miss for search; **required test case** for Part 10's suggestion |

## Findings

### A-02-028 · P1 · FIXED · The scan endpoint blocked filtered viewers from a book they read (PRD §7.8 [LOCKED])
- **Where:** `apps/api/src/catalog/index.ts` `getEditionByIsbn` and the `GET /v1/editions/isbn/:isbn` route schema; `src/contract/schemas.ts` `editionLookupResponseSchema`; `packages/api-client/src/types.ts` `EditionLookupResponse`; `apps/mobile/app/scanner.tsx`.
- **Evidence:** A-02-025 (Part 02b, decision 4) made the scan answer **403 `content_restricted`** for an explicit work when the viewer was a guest, a minor or an adult who had not opted in. Since nobody can opt in yet (A-02-026), that was every account. §7.8 [LOCKED]: "Direct link or ISBN scan: resolves and is loggable, with a one-time interstitial. **A user is never blocked from recording a book they actually read**."
- **Fix:** the scan always resolves: 200 with the work and edition, plus two new fields. `maturity` is the work's rating. `content_warning` is true when `maturity = 'explicit'` and the viewer is one search hides it from (the same `#allowsExplicit` rule: a guest always gets true, and the age is re-checked at read time). The shared-ISBN order still depends on the viewer, so a filtered viewer's scan and search pick the same allowed work (A-02-011's invariant kept). Search is unchanged: explicit works, an exact ISBN included, stay hidden from filtered viewers. The scanner's 403 branch is gone. When `content_warning` is true it shows an interstitial ("Explicit content… Your content settings hide it from search, but you can still open it and log it") with **Continue to book** (opens `/work/:id`, where a signed-in user logs it as usual) and **Scan another**.
- **Why `content_warning` and not only `maturity`:** the client cannot tell whether a viewer is filtered (`show_explicit` and the date of birth are not exposed), so it cannot decide on its own whether §7.8's interstitial applies. The server already computes that rule for search, so it answers here.
- **Tests (`search-route.test.ts` › "exact ISBN and maturity (PRD §7.8; audit 02c)"):**
  - For a guest, an adult not opted in, and an under-18 account with the flag set, the scan resolves the explicit work with `maturity: 'explicit'` and `content_warning: true`.
  - For an opted-in adult, `content_warning` is false.
  - **A filtered adult can `POST /v1/reads` the work the scan opened** (the app under test now registers `ReadingService`).
  - An unknown ISBN is 404 `not_found`.
  - Search still hides the work from filtered viewers and ranks it first for the opted-in adult.
  - A shared ISBN resolves to the allowed work on both paths (with `maturity: 'general'`, no warning).
- **Deliberate change of expectation, stated:** four of Part 02b's tests asserted decision 4, which this part reverses on the reviewer's instruction: "the scan answers %s with 403 content_restricted and no work data" (×3) and "an unknown ISBN is still a 404, so the two are distinguishable". They were **rewritten to assert §7.8, not weakened**: each now checks more than before (status, work, `maturity`, `content_warning`), and the logging test is new. Seen failing before the fix: **yes**. With the 403 put back temporarily, 4 fail (the three scan cases and the logging case); the file was restored afterwards.
- **Mobile:** typecheck only; there is still no scanner test harness (as in 02b). **Not built:** "one-time" is per scan. The interstitial shows each time an explicit, filtered work is scanned, and no acknowledgement is stored. Remembering it per work, and showing it on a direct link (`GET /works/:id` carries no `maturity`), go to Part 08 with A-02-019.
- **Query count:** unchanged from 02b. The scan still costs +1 query for a signed-in viewer (`#allowsExplicit`, needed for the order and for `content_warning`), 0 for a guest.

### A-02-029 · P2 · FIXED · The `has_works` trigger rewrote authors row by row inside every ingest batch
- **Where:** `apps/api/drizzle/0019_credited_authors.sql` (trigger), `src/catalog/ingest/writer.ts` `MERGE_WORK_AUTHORS`, `src/ingest.ts` (works pass, `--finalise`).
- **Measured on the real ingest code** in a scratch database, `flyleaf_ingest_probe` on `flyleaf-pg`, since dropped; `flyleaf` and `flyleaf_dev` were not touched. Setup: 200,000 works from the real dump, and the 200,993 authors they credit, copied from the full catalog. Before each run: `has_works` reset, links truncated, `VACUUM ANALYZE`, `pg_stat_reset()`. Then the works pass (`--limit 200000 --restart`: 10 batches of 20k, 226,524 links):

  | Run (back to back) | Works pass | In the trigger (`pg_stat_user_functions`) | Set-based UPDATE after | `authors` row updates (`n_tup_upd` / HOT) |
  |---|---|---|---|---|
  | trigger on (1) | 190.1 s | 10 calls · 49.9 s | — | 200,993 / 0 |
  | trigger off | 131.1 s | — | 37.8 s | 200,993 / 0 |
  | trigger on (2) | 357.4 s | 10 calls · 131.6 s | — | 200,993 / 0 |
  | **after the fix (bypass)** | 147.6 s | 10 calls · **0.01 s** (early return) | in `--finalise` | **0** during the pass |

- **Reading it:** the trigger does **not** fire per row. It is statement-level, one call per batch. But each call rewrote every author the batch credited for the first time: one row update each, never HOT, because `has_works` is in `authors_credited_trgm_idx`'s predicate. Each of those updates also inserts into all five `authors` indexes, interleaved with the load's own random I/O. The number of row writes is the same either way (200,993), since the flag has to be set once per credited author. What changes is how: 50–132 s spread over the batches, against 38 s in one pass (1.3×–3.5× on this machine, noisy). The two trigger-on runs differ 2.6× doing the same work, which is this machine (see 00-method), so only the counts are portable. On the full catalog this is ~1.66M rewrites, the same rows 0019's backfill wrote (65 min under an exclusive lock).
- **Fix:**
  - Migration **`0020_has_works_bulk_bypass.sql`** replaces the function body only; no table is touched. `authors_has_works_fn()` returns immediately when `current_setting('flyleaf.bulk_load', true) = 'on'`.
  - `ingest.ts` `BULK_LOAD_SETTINGS` gains `SET flyleaf.bulk_load = 'on'`. The ingest pins a pool of one, so the setting applies to that session only. Every other writer of `work_authors` (gap-fill, dedupe, imports, the API) keeps the trigger.
  - `--finalise` sets the same flag for its own session, so resolving parked links doesn't pay the trigger either. Then it runs **`MARK_CREDITED_AUTHORS`** (new in `writer.ts`, the same statement as 0019's backfill) with `work_mem = 256MB`, and prints how many authors it flagged. Idempotent.
  - **Rejected:** `ALTER TABLE work_authors DISABLE TRIGGER`: it is global, takes a lock, turns the trigger off for the app's concurrent writes, and stays off if the ingest dies. `session_replication_role = replica`: it also disables the FK triggers on `work_authors`.
- **Verified end to end on real Postgres:** after the bypassed works pass, 0 authors were flagged. The real `npm run ingest -- --finalise` then printed "200,993 authors newly credited". Result: `flagged = 200,993 = count(DISTINCT author_id) FROM work_authors`, **0 mismatches** (`has_works <> EXISTS(link)`). `--finalise` took 126.8 s in total, most of it in the existing cover, default-edition, index and ANALYZE steps.
- **Test:** `ingest.test.ts` › `merge statements › authors.has_works` has two tests:
  - "outside a bulk load, the trigger flags every author the merge credited";
  - "in a bulk-load session the trigger is skipped, and MARK_CREDITED_AUTHORS sets it": the flag is false after the bypassed merge with exactly one mismatch, then 0 mismatches after the statement and after running it again.

  Both assert `has_works = EXISTS(work_authors link)` for every author. Seen failing before the fix: **yes**. With 0020 left out of the journal, the second test failed (`expected true to be false`); with it, 67/67. `finalise()` itself is not unit-tested, because it needs a postgres.js pool and runs ANALYZE and index DDL; the real-Postgres run above is its evidence.
- **Behaviour change (operators only):** between a works pass and `--finalise`, authors first credited by that load are missing from author search, like the links still parked for it. `--finalise` was already required. Migration 0020 was applied with `npm run migrate` to `flyleaf_dev` and `flyleaf` (function body confirmed on `flyleaf`).

## Recorded, not changed

- **0019 rollout (02b decision 2) → LA-05 in tasks.md:** before the first production deploy, split 0019 into a batched backfill of `has_works` plus `CREATE INDEX CONCURRENTLY` for `authors_credited_trgm_idx`, both outside the migration transaction. Here it held `ACCESS EXCLUSIVE` on `authors` for ~65 min (64 min 41 s). 0019 was **not** edited: it is applied on both local databases.
- **A-02-027 → Part 15, with a precondition:** `authors_search_trgm_idx` (938 MB) and `authors_name_trgm_idx` (936 MB) may be dropped **only after Part 03 (dedupe stage 3) and Part 12 (import matcher) confirm they don't use them**. Both parts do fuzzy author-name matching, and a grep of today's code is not proof of what they will need. The `idx_scan` check on a production-like run still applies.
- **`tolkein` → Part 10:** a **required test case** for the spelling suggestion (`tolkein` must suggest "Tolkien"). It is recorded in `docs/audit/10-profile-stats-telemetry.md`, together with the suggestion and `search_zero_results` work routed from A-02-024. Search itself keeps missing it (word similarity 0.50 < 0.6); 02b decision 4 is accepted.

## Behaviour changes (Part 02c)

1. **`GET /v1/editions/isbn/:isbn` resolves explicit works for everyone again** (200, not 403 `content_restricted`), and every response carries `maturity` and `content_warning`. The 403 response is gone from the route schema and the OpenAPI spec.
2. **The scanner shows an explicit-content interstitial** when `content_warning` is true, then opens the book on "Continue to book". The message "This book is hidden by your content settings" is gone.
3. `GET /v1/search`'s description now says an exact ISBN follows the maturity filter. It had said "an exact ISBN still resolves", which has been false since 02b. Behaviour unchanged.
4. Ingest (operators only): new authors are flagged for author search by `--finalise`, not during the load.

## Decisions needed (Part 02c)

None new. Still open from 02b: A-02-026 (no opt-in exists until LA-02). 02b's decisions 1, 2 and 4 are settled as above; 02b decision 3 has its precondition.

## Deferred (Part 02c)

| Item | Owner | Reason |
|---|---|---|
| Interstitial remembered per work ("one-time") and shown on direct links; `maturity` on `Work` (rest of A-02-019) | Part 08 | UI + `GET /works/:id` schema |
| Spelling suggestion, with `tolkein` required | Part 10 | recorded in its brief |
| Drop the two unused author trigram indexes | Part 15, **after Parts 03 and 12 confirm** | see above |
| 0019 batched backfill + concurrent index | LA-05 | before the first production deploy |

## Part 02c CI

| Run | Result |
|---|---|
| 1 | ✓ **green in 467 s**: api-client build, api typecheck, spec check (OpenAPI drift 0; the scan route lost 403 and gained `maturity` and `content_warning`; the search description was corrected), api tests **840 passed** (48 files), api build, audit, mobile typecheck, mobile offline tests **100 passed**, migrations on a real Postgres |

`npm run migrate`: 0020 applied to `flyleaf_dev` and `flyleaf` in seconds (function body only); a re-run prints `migrations applied`.
