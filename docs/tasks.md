# Flyleaf — Task Breakdown

**Companion to:** `PRD.md`, `architecture.md`, `phases.md`, `design.md`

**Conventions**
- IDs are stable. Never renumber; mark cancelled tasks `~~SK-03~~ cancelled` instead.
- `d` = ideal developer days, one person. Add your own multiplier.
- **Bold** tasks are on the critical path — everything after them waits.
- ⚠️ marks a task that is cheap now and expensive or impossible later.
- Blocked-by is listed only where it is not simply "the previous task".

---

## Phase −1 — Walking skeleton · `SK` · 5d

> **SK-01 → SK-08 complete.** API: tsc clean under TS 7 strict, 23 unit tests, **36/36 smoke assertions against a real Postgres**. Full path verified **on a physical Android device**, 3 Sep 2026. Surprises list written: **`surprises.md`**. Remaining: **SK-09** (second person walks it unaided).

> Ugly on purpose. Throw away the shortcuts, keep the decisions.

- [x] **SK-01** Docker Compose: Postgres 17 + MinIO. `make up` works — 0.5d
- [x] **SK-02** Node + TypeScript, Fastify app, `/healthz` — 0.5d
- [x] **SK-03** Six tables by hand (users, works, editions, reads, progress_events, sessions). No migrations tool yet — 0.5d
- [x] **SK-04** Load 100 books from a hand-made CSV — 0.5d
- [x] **SK-05** Six endpoints: register, login, search, book, log, progress — 1d
- [x] **SK-05b** `scripts/smoke.ps1` — 35 assertions over the whole path, including offline idempotency, optional rating, half-step validation, re-read attempts, and cross-user 404. Run before every phase closes — 0.25d
- [x] **SK-06** Expo app: 4 screens (auth, search, book, profile), design tokens only — 1.5d
- [x] **SK-07a** Android SDK without Android Studio: `.\scripts\setup-android.ps1` (~3–4 GB, one time, unlimited local builds thereafter) — 0.5d
- [x] **SK-07b** `.\scripts\fix-gradle.ps1` — RN's generated wrapper allows 10s to connect before a 130 MB download. Raises the timeout and pre-seeds the wrapper cache with a checksum-verified zip — 0.25d
- [x] **SK-07** ⚠️ **Development build** on a **physical Android device**. Local build: 36 min first, 1–2 min after. The EAS free-tier queue hit 47 min with a growing estimate and is not an inner loop. Expo Go cannot open an SDK 57 project — it supports one SDK version only — 0.5d
- [x] **SK-08** Walked the whole path on device; **surprises list written → `surprises.md`**. Found 3 client bugs invisible to tsc and to all 59 automated assertions: `<Link asChild>` rejecting array styles, a two-layer star control using a glyph absent from the Android font, and `ListHeaderComponent` remounting the search field on every keystroke — 0.5d
- [x] **SK-09** Have one other person complete the path unaided — 0.25d

**Exit:** full path works on a real phone · surprises list written and acted on.

---

## Phase 0 — Foundation · `FN` · 15d accelerated / 35d full

### Infrastructure — `FN-0x` · 3d
- [x] **FN-01** drizzle-kit wired; `npm run migrate`; migrations applied and asserted **on an empty database inside the test suite** (PGlite — real Postgres, no Docker) — 0.5d
- [x] **FN-02** Drizzle schema is the source of truth; `npm run db:generate`. Postgres 16 → **18**; the container init-dir mount is gone — 0.5d
- [x] **FN-03** `platform/`: Pino with redacted auth headers, request IDs, `trustProxy`, pool close, **ordered graceful shutdown with a 10s force timer**; `readyz` now fails honestly when migrations are pending — 1d
- [x] **FN-04** pg-boss 12.30, `worker.ts` process, `smoke.ping` — 0.5d
  - `src/jobs/` owns the queue names and handlers; `worker.ts` owns the process. Splitting them is what lets the tests run the real handlers against a real engine without starting a process. Shutdown mirrors `server.ts` — stop taking work, let in-flight jobs finish, then close the pool — with a 30s budget rather than the API's 10s, because a job killed mid-flight is retried and finishing beats duplicating.
  - **pg-boss owns the `pgboss` schema and migrates it itself.** A deliberate exception to "drizzle is the source of truth": those tables are library internals versioned by the library, and hand-managing them turns every pg-boss upgrade into a migration we have to get right — where getting it wrong loses jobs. Cost: the worker's role needs DDL at startup. Fine on one VM; when API and worker split roles, migrate once at deploy and run with `migrate: false`.
  - ⚠️ **The transactional property is now a test, not a claim.** architecture.md §9 says pg-boss is in the stack *because* jobs commit with the data that created them — `sendInTx` is that, and a test asserts a rolled-back transaction leaves no job. Nothing else in the codebase would have noticed if it stopped being true.
  - `make ping` enqueues one `smoke.ping`. A smoke job nobody can trigger is not a smoke test, and "is anything consuming?" is otherwise a surprisingly hard question to answer.
  - Note for future job tests: on PGlite the FIRST `send` to a queue resolves queue metadata on pg-boss's own connection, which deadlocks against an open transaction because PGlite has exactly one. One prior send warms the cache. Production pools, so it never happens there.
- [x] **FN-06** ⚠️ `RateLimiter` / `Cache` interfaces + `PgRateLimiter` and `MemoryCache` — carried from Phase −1 — 0.5d
  - **Audit 15a (2026-10-10):** ✅ the `RateLimiter` interface now backs one layer for every limit (`platform/rate-limits.ts`: one table with PRD refs, route groups + a hook, `enforce()` in services, 429 + `Retry-After`); exact limits through `PgRateLimiter`, per-request ones in process (measured; A-15-002). `rate_limits` rows expire and are swept (0038).
- [x] **FN-05** CI: vitest, `tsc --noEmit`, `npm audit --audit-level=high`, migrations on a real Postgres 18 service, build, **plus the mobile typecheck** — 0.5d
  - The checks live in `scripts/ci.mjs`, and `.github/workflows/ci.yml` calls it rather than restating them in YAML. `make ci` therefore runs exactly what Actions runs; the two cannot drift. `--strict` (CI only) makes the migration step mandatory instead of skipping it when no database is up.
  - `--audit-level=high`, not `moderate`: the tree carries 4 moderates, all one esbuild dev-server advisory reached through drizzle-kit's loader — a devDependency that never reaches `dist/`. A check that is always red is a check nobody reads.
  - ⚠️ **Found by running it twice, which a first run cannot tell you.** `npm run build` emits `dist/test/*.test.js`, and vitest's default include collected those too — 283 tests instead of 174, with `outbound.test.ts` failing in its duplicate because it reads its own `.ts` source relative to itself and that file does not exist under `dist/`. `vitest.config.ts` now excludes `**/dist/**`.

### Catalog schema — `FN-1x` · 2d
- [x] **FN-10** Drizzle schema + migration: works, editions, authors, work_authors, series, series_entries, subjects, work_subjects, work_stats — **17 tables, applied clean on an empty database** — 1d
- [x] **FN-11** ⚠️ `external_ids`, `field_provenance` **with the CHECK that omits `google_books`**, `raw_payloads`. Now proven by test: `field_provenance` rejects `google_books`; `external_ids` accepts it (recording an ID is not caching data); `raw_payloads` accepts `open_library` and nothing else — 0.5d
- [x] **FN-12** Search vector column, GIN + trigram indexes, `unaccent` — ⚠️ **architecture.md §3.8's DDL did not run.** `unaccent(text)` is STABLE, so Postgres refuses it in a generated column. Fixed with an IMMUTABLE `flyleaf_unaccent()` wrapper created before the journal; doc corrected — 0.5d

> ⚠️ **The author-name gap, confirmed on the real catalog.** Searching `murakami` never returns *Norwegian Wood*, and no query change can fix it. The work is there with **1,351 logs**, but its author record is named **村上春樹** — `'村上春樹' ILIKE '%murakami%'` is false, and `sort_name` is empty. A separate "Haruki Murakami" record exists with 5 works and 7 logs; the real catalog hangs off the Japanese one.
>
> Open Library carries the answer in the author record's **`alternate_names`** (Tolkien has 10 variants there, Roald Dahl has ロアルド・ダール). **The ingest does not read that field.** The fix is `authors.alternate_names text[]`, a trigram index over it, an extra `OR` in the author arm — and a re-run of the authors pass. That pass took 4.5 hours; filtering it to only the ~1M authors actually referenced by `work_authors` (the same trick `--seed` and the editions filter already use) should bring it under an hour.

> **Open relevance gap, found while porting search to the new schema.** Searching `1984` returns nothing: the work is titled *Nineteen Eighty-Four* and nothing maps the numeric alias. That is a data gap, not a query bug. **FN-21** must ingest Open Library's `alternate_titles`, and **FN-43** must carry `1984`, `LOTR` and `Hitchhiker's` as hard cases in the relevance panel. There is a test asserting the gap, so the day it starts working someone has to delete that test deliberately.

> ⚠️ **Regression shipped and caught on device: search-as-you-type was dead.** Replacing Phase −1's `ILIKE '%q%'` with tsvector + trigram broke every incomplete query — `plainto_tsquery('ursu')` seeks the exact lexeme `ursu` and never matches `ursula`, and trigram similarity between a 4-character prefix and a full name is far below threshold. Typing `Ha`, `Urs` or `orw` returned nothing.
>
> It passed my verification because **I only tested whole words** — `piranesi`, `tolkien`, `dune` — and those match on both the broken and the fixed query. Every keystroke but the last is a prefix, so the test inputs have to be prefixes. `src/test/search.test.ts` is now mostly prefix cases, plus hostile input, and it executes the exported `SEARCH_SQL` rather than a copy.

### Ingest — `FN-2x` · 5d
- [x] **FN-20** Dump downloader (`npm run ingest:fetch`, resumable via HTTP Range, verifies gzip magic bytes) + gzip streaming line reader + checkpointing to `ingest_runs`; Ctrl+C leaves a resumable run. Checkpoint is a LINE COUNT, not a byte offset — you cannot seek into a gzip member. Verified against the live dumps: OL serves `206 Partial Content`, so resume genuinely works — 1d
- [x] **FN-21** JSON → row normaliser for works, editions, authors. Tested against **ten real OL records**, not imagined ones — `parseYear` handles `c1999`, `[1999]`, `June 1999`, `{type,value}`; ISBNs de-hyphenated; 99,999-page OCR errors rejected — 1d
- [x] **FN-22** ⚠️ Filter rule: title AND author at the work level, (ISBN OR cover ID) at the edition level — ISBNs live on editions, so the rule splits across the two passes — 0.5d
- [x] **FN-23** `COPY` batch writer, 5k batches, staging table + `ON CONFLICT` merge on the OL key. **DEVIATION:** no `pg-copy-streams` — that is a `pg` package and postgres.js has COPY FROM STDIN built in — 0.5d
  - **Audit 15a (2026-10-10):** ✅ the merge no longer credits a work twice under one author name (A-03-027 → A-15-006); existing duplicates: `DECISIONS.md` 4.
- [x] **FN-24** ⚠️ Maturity classification from subjects + imprints. `unclassified` is never treated as a synonym for `general`; children's classification beats a mature keyword — 1d
- [x] **FN-25** ⚠️ Raw payload persistence + hash-skip, so the monthly re-ingest does not rewrite unchanged rows and a classifier fix is a reprocess rather than a 12 GB re-download — 0.5d
- [x] **FN-26** `--finalise` pass: cover backfill, default editions, ANALYZE. `--seed` takes the popularity slice from the **reading-log dump (65 MB)** rather than guessing from edition counts — 0.5d
  - **Audit 15a (2026-10-10):** ⚠️ `--finalise` no longer sets `work_mem = 256MB` or runs `MARK_CREDITED_AUTHORS` over 15.4M authors in one statement: it walks author ranges with `repair_author_has_works` (0040), under the ingest profile (64 MB, 1 h) (A-15-004, -005, -007). Full-catalog timing: 15b.
  - **Audit 15a:** every finished pass (works, editions, authors) now ANALYZEs the tables it loaded, `raw_payloads` included (A-15-021).

> ⚠️ **Correction, FN-43:** `works.alternate_titles` is never populated by the works pass — OL work records carry none of the three source fields (0 in 1,053,422 sampled records). The column and its weight-C term are sound; their source has to be **edition titles**, not the works dump. See FN-43 below.
>
> **Two schema additions the ingest forced, both justified.** `works.alternate_titles text[]` — the fix for the `1984` gap, weighted C in the search vector. And `works.ol_cover_id` — covers belong to editions and still do, but OL's *work* records carry their own cover list, so a works-only seed would otherwise have no cover art at all; it also removes a correlated subquery from every search row.
>
> ⚠️ **`drizzle-kit generate` produced a migration that could not run, and silently dropped an index.** It ordered `ADD COLUMN search_vector` (which references `alternate_titles`) *before* adding `alternate_titles`; and dropping the generated column dropped `works_search_idx` with it, which drizzle does not recreate because its snapshot says the index never changed. Search would have kept working while sequential-scanning the whole catalog. `0001_ingest.sql` is hand-edited, says so at the top, and there is now a test asserting both indexes exist.
>
> ⚠️ **The immutability trap, twice.** `array_to_string(anyarray, text)` is STABLE for the same reason bare `unaccent()` is, so the first version of the generated column was rejected identically. Fixed with `flyleaf_unaccent_array(text[])` — pinning the signature to `text[]` is what makes the IMMUTABLE claim honest.

### Outbound + gap-fill — `FN-3x` · 3d
- [x] **FN-30** ⚠️ **One global rate limiter** — token bucket, 3/s sustained, burst 5, with an identified User-Agent. Two methods on purpose: `wait()` for background work, `tryAcquire()` on a request path so a search never queues behind a backlog of stale look-ups — 1d
- [x] **FN-31** Circuit breaker: 5 consecutive failures → open 60s → half-open trial. A 4xx does NOT trip it (our bug, not their outage); 429 and 5xx do. A failed trial re-opens immediately rather than needing five more — 0.5d
- [x] **FN-32** OL live search → returns to the caller AND persists (CC0), with `external_ids` and `field_provenance` written. The caller then re-runs its LOCAL query, so every result has a real `works.id` and there is one ranking implementation rather than two — 1d
- [ ] **FN-33** Google Books pass-through, **never persisted** — 0.5d — **deferred deliberately.** A pass-through result has no local `works.id`, so nothing in the client can open it; it needs the user-created-work flow (`is_provisional`) to be worth anything. Building it now would be a code path with no caller.

> **Documented behaviour, not a leak:** Open Library's search is fuzzier than ours, so gap-fill **stores everything OL returned but shows only what matches the current query**. The catalog grows faster than any one result list, and the extras are findable on the next search. There is a test asserting exactly this.
>
> Gap-filled works stay `maturity = 'unclassified'` because `search.json` carries no subjects. Guessing `general` to make the catalog look tidier is precisely the App Store §1.2 mistake.

### Search — `FN-4x` · 3d
- [x] **FN-40** Search query: **prefix** tsvector (`token:*`) + ILIKE substring + trigram + author, as four INDEPENDENT indexed arms unioned into a small candidate set. ~~Merged and provisional works excluded~~ Excluded only in the final select, after every arm had spent its LIMIT on them (fixed in audit 02: filters in every arm); LIKE metacharacters escaped; `to_tsquery` input sanitised ~~(complete)~~ except NUL, which was a 500. `SEARCH_SQL` is exported so the tests run the real query, not a copy — 1d
  - **Audit (2026-09-25):** ⚠️ — correct matching, but no PRD §7.8 maturity filter at all, arms that were not indexed for 2-character queries and scanned ~⅓ of the catalog for queries under 4 characters, and non-Latin letters dropped from the prefix arm; fixed except the author-arm costs (DECISION NEEDED / deferred); see A-02-001…A-02-010, A-02-012.
  - **Audit 02b (2026-09-25):** ✅ — the author arm now matches only the 1.66M credited authors through a partial trigram index (`authors.has_works`, migration 0019), 2-character author queries match a name/word prefix (CJK authors no longer seq-scan), and the typo arm finds candidates by word similarity with a popularity-walk guard (`the hobit`: 1.34M rows rechecked → 25k). Results carry the viewer's `your_read` from one query per page (AC-7); `ishigoro` finds Ishiguro; the spelling suggestion is deferred to Part 10; see A-02-022, A-02-023, A-02-024.
  - **Audit 02c (2026-09-25):** ✅ — the catalog ingest no longer maintains `authors.has_works` during the load: measured on a 200k-work pass, the 0019 trigger rewrote each newly credited author (200,993 non-HOT updates) inside every batch, 50–132 s, where one set-based UPDATE takes 38 s. The ingest session now skips the trigger (`flyleaf.bulk_load`, migration 0020) and `--finalise` flags credited authors in one statement; every other writer keeps the trigger; see A-02-029.
  - **Audit 02d (2026-09-29):** ⚠️ — on the full catalog each arm's plan flipped with ANALYZE between a popularity walk and collecting every match (the estimate for `ILIKE '%q%'` moves in steps of ~1 % of the table), and the walk read a heap page per row (`harry` 403k rows, 2.8 s; `pir` 0.4–16 s). `works_popularity_idx` now covers every column the arms read, so the walk is index-only: worst title/prefix arm across 3 ANALYZE rounds 71k buffers, was 356k–541k. The plan still depends on ANALYZE, and the author arm, which no works index can cover, still flips to 450k–850k buffers for common patterns (`the`, `war`, `lo`, `har`): fix approved (author names copied onto `works`), scheduled post-audit with LA-05 (`docs/audit/PENDING.md`); see A-02d-001, A-02d-002.
- [x] **FN-41** Popularity (`--popularity`) + ranking: title prefix 0.30 · exact title 0.20 · author match 0.20 · trigram 0.10 · `ln(1+log_count)` capped, ~~0.35~~ 0.60 since audit 02d. **3,203,476 works scored**; most-logged is Atomic Habits at 64,006 — 0.5d
  - **Audit (2026-09-25):** ⚠️ — the weights match this bullet and the panel, but not PRD §14.3 / architecture §5.4 (no cover, library-boost or recency term; `alternate_titles` weight-C term structurally 0), and `works.log_count` has no trigger, no decrement, no import increment and no reconcile; DECISION NEEDED; see A-02-013, A-02-014.
  - **Audit 02b (2026-09-25):** ✅ **Decided (decision 3):** the weights in this bullet are the spec; PRD §14.3 now states them and architecture §5.4 points there. `log_count` maintenance (A-02-013) is still open; see A-02-014.
  - **Audit 08 (2026-09-27):** ✅ A-02-013 implemented: `log_count` is now a virtual `ol_log_count` (the OL baseline this pass writes) + `reader_count` (distinct Flyleaf readers, trigger-maintained, reconciled nightly by `works.reconcile`); the relevance panel is unchanged on the corpus and both real catalogs; see A-08-002.
  - **Audit 02d (2026-09-29):** ✅ — popularity weight 0.35 → 0.60 (PRD §14.3 updated): at 0.35 an obscure book titled with an author's surname always outranked the author's books, so the full catalog scored 198/214 with 14 surname misses; now 214/214 on `flyleaf` and `flyleaf_dev`, 217/217 on the corpus, and obscure exact titles stay first; see A-02d-003.

> ### Search on 3.2M works: 40s → 47ms
>
> ⚠️ **Audit 02 correction:** 47 ms is `murakami`, warm. Short and common queries were never measured: on the same catalog `th`, `the` and `a` took 23–54 s, spent in the trigram arm (1.1–1.3M index candidates, 2.8M rows rechecked), and `村上` took 80 s in two sequential scans. See `docs/audit/findings/02-search.md`.
>
> Measured warm, on the real catalog. Four separate causes, in the order they were found — the first three were my guesses and only the last two came from evidence:
>
> 1. **Parameters in a CTE cross-joined to `works`.** `FROM works w, p WHERE w.title ILIKE p.esc` — Postgres cannot use an index when the comparison value is a column from another relation, so it sequential-scanned 3.2M rows and ran the author `EXISTS` once per row. Every index we had built was decorative. Fixed by building the tsquery and LIKE pattern in TypeScript and passing bound parameters. **32s → 2s.**
> 2. **`log_count` was 0 for all 3.2M works**, so the popularity term contributed nothing and a 1910 monograph outranked Susanna Clarke. Fixed by `--popularity`.
> 3. **The author-match scoring term was dropped** during the restructure — Norwegian Wood was *found* by the author arm and then scored zero for it.
> 4. ⚠️ **The fuzzy-title arm was 87% of the query.** From `EXPLAIN (ANALYZE, BUFFERS)`: at pg_trgm's default 0.3 threshold, "murakami" matched **13,545** titles in the index, Postgres read **~100 MB of heap** to recheck them, and discarded 13,497. Raising the threshold to **0.45** cuts it at the index. **2s → 47ms.** 0.45 was chosen by measuring: it keeps `piranese`/Piranesi (0.636) and `the hobit`/The Hobbit (0.750) while dropping Piranha (0.417) and Pirate (0.333).
>
> **The lesson worth keeping:** three guesses, three wrong. The `EXPLAIN` found it in one pass. Profile before touching a query on a table this size.

> ⚠️ **An unordered `LIMIT` is a silent quality bug.** The `by_author` arm took an arbitrary 300 rows with no `ORDER BY`, so it discarded the best results while looking perfectly correct. Every arm now orders by `log_count` before truncating.

> **Settings that must be set on the DATABASE, not the session.** `pg_trgm.similarity_threshold` via `ALTER DATABASE`, because a plain `SET` lands on one pooled connection out of ten. It reaches NEW connections only, so the API needs a restart — and the test harness sets it explicitly, or tests would quietly run at 0.3 while production runs at 0.45. **Audit 02:** a restored or recreated database loses an `ALTER DATABASE` setting silently, so `makeDb` now also sends it in every connection's startup packet (A-02-009).
- [x] **FN-42** ISBN detection → exact edition path — 0.5d
  - Added `apps/api/src/catalog/isbn.ts`: `cleanIsbn`, `isValidIsbn10` (mod-11), `isValidIsbn13` (mod-10), `isbn10ToIsbn13`, `isbn13ToIsbn10`, and `detectIsbn` with bidirectional 10↔13 checksum cross-conversion.
  - Added exact edition resolver `CatalogService.getEditionByIsbn(viewer, isbn)` and updated `search(q, limit)` to prioritize exact ISBN matches as result #1 (PRD §1013, §14.2). ~~The same ISBN resolves the same way on both paths~~ (never claimed, and false: with a pre-dedupe duplicate, search picked the more-logged work and the scan endpoint the newest edition; fixed in audit 02). `search` is now `search(viewer, q, limit)`, and the route's `limit` was ignored until audit 02.
  - **Audit (2026-09-25):** ⚠️ — detection, conversion and 979 handling are correct; search and the scan endpoint disagreed on shared ISBNs (fixed), merged works resolve to the survivor (proven by test), and responses carry no `maturity` for the §7.8 interstitial (deferred → Part 08); see A-02-011, A-02-019.
  - **Audit 02b (2026-09-25):** ✅ — an exact ISBN now follows the search maturity filter on search ~~and on `GET /v1/editions/isbn/:isbn` (decision 4): filtered viewers get `403 content_restricted` from the scan, not 404~~ (the scan half was reverted in audit 02c, below), and a shared ISBN resolves to the allowed work on both paths. Conflicts with PRD §7.8's "never blocked" wording (decision needed); see A-02-025, A-02-026.
  - **Audit 02c (2026-09-25):** ✅ — decision 4's scan half reverted to honour PRD §7.8 [LOCKED]: `GET /v1/editions/isbn/:isbn` always resolves and returns `maturity` plus `content_warning` (explicit and hidden from this viewer's search); the scanner shows an interstitial and still opens the book, and a filtered adult can log it (tested). Search results, an ISBN typed into search included, keep the filter; see A-02-028.
  - **Audit 02d (2026-09-29):** ✅ — no regression from the 02d changes: `isbn.test.ts` and `search-route.test.ts` (ISBN, maturity, as-you-type) pass unchanged, and on `flyleaf_dev` an ISBN search plans and runs as before (5.3 vs 5.8 ms); see findings/02d.
  - Added `GET /v1/editions/isbn/:isbn` endpoint (guest-readable barcode scan path, PRD §3374) with `editionLookupResponseSchema` and `isbnParamSchema`.
  - Regenerated `openapi.yaml` with 0 drift and added typed `getEditionByIsbn` to `@flyleaf/api-client`.
  - 18 tests in `apps/api/src/test/isbn.test.ts`; 217-query relevance panel holds 99.5% (216/217); full CI suite green (313 tests across 11 test suites).
- [x] **FN-43** ⚠️ **217-query relevance panel**, hard cases included, runs in CI — 1d
  - **Audit (2026-09-25):** ✅ — runs the exported `SEARCH_SQL` (zeroing the popularity weight dropped it to 205/217 and failed the floor), measures position, runs in `api · tests`, keeps the `1984` gap test; 216/217 before and after audit 02's changes. It does not cover PRD §14.6's top-3 metric on real queries, AC-7's `ishigoro` (author typo) or planner behaviour; see A-02-015.
  - **Audit 02b (2026-09-25):** ✅ — 216/217 before and after the typo-arm rewrite, which was chosen over a cheaper design that measured 213/217; `ishigoro` (AC-7), `war and peice` and `lord of the rngs` added as hard cases; see A-02-023, A-02-024.
  - **Audit 02d (2026-09-29):** ⚠️ → ✅ — the panel passed `within` (1 or 5) as the SQL limit, which also moved the typo arms' gate, so it scored candidate sets the API (limit 20) never produces: now 20 and judged by position; the real-catalog runner counted 3 explicit-only cases (hidden from guests by §7.8) as misses and opened an unguarded connection. Now 217/217 corpus (floor 0.98 → 0.99), 214/214 `flyleaf` and `flyleaf_dev`. The real-catalog panel is a manual step (`npm run bench:relevance`, 170 s on `flyleaf`), not CI: it needs the real catalog; see A-02d-003 … A-02d-006.
      Hard cases, all confirmed against the real catalog and now all asserted individually:
      `murakami` (author is 村上春樹), `piranesi` (novel vs. the architect),
      `the hobit` and `piranese` (typos), `guin` (a later part of a name),
      `pir` / `hobb` / `orwel` (prefixes), `1984` (still an open gap — see below).

> **The corpus is the real catalog, not a fixture I invented.** 2,071 works exported from the live database as ingested — titles, authors, `alternate_names`, log counts — committed at `src/test/fixtures/relevance-corpus.json` (880 KB). A hand-written fixture cannot express the cases that actually broke: `piranesi` needs Susanna Clarke's novel (561 logs) sitting alongside nine works about Giovanni Battista Piranesi (1–5 logs each), and `murakami` needs an author record named 村上春樹 carrying Latin aliases. The corpus contains 38 duplicate titles, which is the point.
>
> **It measures POSITION, not membership.** The first version asked only "is the right answer in the top ten" and scored 217/217 — which proves almost nothing, because *both* ranking regressions this project shipped (the dropped author-scoring term, the unordered `by_author` LIMIT) left the right answer inside the top ten and merely put something worse above it. An exact title must now rank **#1**; prefix, author and typo queries must make the **top 5**. Measured: **216/217 (99.5%)**, floor set at 0.98. The corpus is committed and the queries are generated deterministically, so identical results on Windows and Linux — the floor is tight because there is no noise to absorb.
>
> ⚠️ **`works.alternate_titles` is always empty, and no ingest change will fix it.** Measured against the dump: across **1,053,422 sampled work records, `alternate_titles`, `other_titles` and `alternative_title` appear ZERO times**, while `subtitle` appears 15,434 times in the same sample. Open Library's *work* records do not carry alternate titles. So FN-21's alternate-title extraction is dead code, the weight-C term in the search vector contributes nothing, and **the `1984` gap cannot be closed by re-running the works pass**. That string exists only on *edition* records. This promotes the editions pass from "optional, we only have 102" to the prerequisite for a whole class of title aliases — and gives `works.alternate_titles` a real source: distinct edition titles that differ from the work title.
>
> **One honest miss, deliberately not fixed:** `king` returns *King of Wrath / Pride / Greed* above Stephen King's *It* (12,372 logs), because a title beginning with the query scores 0.30 against an author match's 0.20 and popularity does not close the gap. Whether an author surname should beat a title prefix is a product decision. Tuning weights to fix one query is precisely the overfitting the panel exists to prevent — the panel is the instrument for deciding it, not a reason to change ranking as a side effect of writing a test.
>
> **What it does NOT catch:** it runs on PGlite over 2,071 rows, so it validates ranking, not planner behaviour. None of the 40s → 47ms work would have shown up here. Query *performance* on 3.2M rows still needs `EXPLAIN` against the real catalog.

### Dedupe — `FN-5x` · 2d
- [x] **FN-50** Stage 1–2 auto-merge (ISBN13; normalised title + shared author) — 1d
  - `src/catalog/dedupe.ts` + `npm run dedupe -- --dry-run`. 27 tests.
  - ~~⚠️ **A merge is seven repoints, and four of them collide.** `reads` has `UNIQUE (user_id, work_id, attempt_no)`, so a user who logged **both** duplicates breaks the naive `UPDATE reads SET work_id = survivor`. Attempts are renumbered to continue after that user's existing ones — which is also the semantically right answer, since they did read it twice. `work_authors`, `work_subjects` and `series_entries` collide on their primary keys (insert-then-delete with `ON CONFLICT DO NOTHING`); `work_stats` is keyed on `work_id` alone and is dropped rather than merged, because summing it would double-count anyone who logged both copies — `stats.workstats` recomputes from the reads that just moved.~~ Audit 03: the database holds 22 references to works/editions (17 foreign keys + 5 without one), not seven; reviews, shelf items, activity, mutes, favourites, import rows and `log_count` were not moved (fixed, A-03-001), and there is no `stats.workstats` job — the `reads` trigger recomputes. Merge **chains** are flattened, or resolving an old id takes two hops and the next merge makes it three.
  - ⚠️ **`work_merges` is written by the merge, not by the undo.** PRD §40.3 wants 30-day reversibility; once a merge has renumbered `attempt_no` and forgotten the old values, the undo is not deferred work, it is impossible. The prior attempt numbers go into `moved` jsonb at merge time. A partial unique index on `loser_id WHERE undone_at IS NULL` makes merging the same work twice an error — it would mean it came back from the dead.
  - ~~**Stage 1 is written and inert.** ISBNs live on editions and the catalog has 102 of them, so it finds nothing until the editions pass runs. It is here rather than deferred because the merge machinery is identical and writing it later means re-deriving all of the collision handling above.~~ Audit 03: stage 1 is live — 4.9M ISBN-13s, 30,240 pairs on the full catalog, some of them unrelated books sharing a re-used ISBN; pairs with differing titles are now held (A-03-005, DECISION NEEDED).
  - The normalisation rule exists **twice** — TypeScript for callers, SQL for the 3.2M-row scan — so there is a test asserting the two agree on 15 titles. Two implementations of one rule is how a dedupe pass starts merging the wrong things, and the divergence would surface as books quietly disappearing.
  - Not accent-folded, deliberately: `flyleaf_unaccent` is for search, where a false match costs a slightly wrong result. Here a false match destroys a book, and folding would collide distinct translations.
  - **Audit (2026-09-25):** ❌ — merge skipped 7 of the columns that reference a work today and had no lock or liveness check (fixed); stage 1 is live and stages 1–2 auto-merged thousands of distinct books on the real catalog (interim hold, DECISION NEEDED); TS/SQL normalisation drift on the real locale (deferred); see A-03-001, A-03-003, A-03-004, A-03-005, A-03-014, A-03-015.
  - **Decision D1 (2026-09-25, Audit 03b):** only unambiguous pairs auto-merge. Stage 1: same ISBN-13 **and** same normalised title **and** a shared author. Stage 2: same normalised title and a shared author **and** matching subtitles (both absent, or both present and equal). Everything else goes to the review queue (migration `0021`: `dedupe_queue` takes stages 1–4 and gains `impact`), highest impact first: pairs where either work has reads, reviews, shelf items or favourites. At most 200 merges per run. Dismissed pairs are never re-queued or merged; a pair whose merge was undone is never auto-merged again. PRD §40.3 amended with the evidence.
  - **Audit 03b (2026-09-25):** ✅ — D1 implemented; auto-merge is **off by default** (`DEDUPE_AUTO_MERGE=true` / `--auto-merge`); TS and SQL normalisation are locale-independent and agree on all 3,203,575 catalog titles and every code point of planes 0–3 on the real server (was 50,622 disagreements); see A-03-004, A-03-005, A-03-014, A-03-021, A-03-022.
  - **Audit 03c (2026-09-27):** ✅ — D5 implemented (auto-merge only groups of exactly two, no series-position, volume-marker or >25% page-count difference; mutation-checked): full catalog 283,908 → 94,086 auto pairs, samples 25/25 and 25/25 the same book; the D6 backlog command (`--backlog`, batches of 5,000 with a 25-pair sample) walks authors in batches after the first version's whole-catalog query was OOM-killed on the full database; see A-03-025, A-03-026.
  - **Audit 15a (2026-10-10):** ⚠️ stages 1–2 run in ISBN ranges and author batches, stage 3 in peer chunks, with the same output (equivalence test); the dedupe process has its own `work_mem`/`statement_timeout` (A-03-026 → A-15-004, -005). Full-catalog dry run under the new container limit: 15b.
- [x] **FN-51** Stage 3–4 queue; 30-day undo; admin review UI — 1d
  - Migration `0008_dedupe_queue.sql` introduces `dedupe_queue` table with foreign keys, checks, and unique indexes preventing duplicate reviews.
  - Stage 3 detection (`findStage3Candidates` / `queueStage3Candidates`): Trigram title similarity > 0.85 (~~on the raw title~~ now the normalised title, A-03-007; cannot run on the full catalog, A-03-006), author similarity > 0.9, first publication year ±2. Never auto-merges; always enqueues for human review (PRD §40.3).
  - Stage 4 reporting (`queueReportedDuplicate`): Accepts user and admin duplicate reports with validation and collision checks.
  - 30-day reversible undo engine (`undoMerge`): Enforces `merged_at >= now() - interval '30 days'` window and restores loser work, reclaims moved reads to exact prior attempt numbers, ~~un-merges authors, subjects, and editions~~ (the survivor kept the authors/subjects/series it gained, and the loser's OL key never moved back — fixed, A-03-002), and marks merge record `undone_at`.
  - Preview & collision forecasting (`previewMerge`): Queries survivor and loser side-by-side to forecast colliding reads (user read both), moved reads, and merged metadata prior to applying changes.
  - Admin dedupe REST endpoints (`/v1/admin/dedupe/queue`, `/v1/admin/dedupe/preview/:survivorId/:loserId`, `/v1/admin/dedupe/queue/:id/resolve`, `/v1/admin/dedupe/report`, `/v1/admin/merges`, `/v1/admin/merges/:id/undo`) and server-rendered HTML review UI (`/admin/merges`) with confidence badges, side-by-side cards, and 1-click undo.
  - Complete OpenAPI spec synchronization (`openapi.yaml`) with 0 contract drift, plus typed `@flyleaf/api-client` methods (`getDedupeQueue`, `previewDedupeMerge`, `resolveDedupeQueueItem`, `reportDuplicate`, `getRecentMerges`, `undoMerge`).
  - 38 unit & route tests in `apps/api/src/test/dedupe.test.ts` passing.
  - **Audit (2026-09-25):** ⚠️ — undo was neither exact nor race-safe and stage 3 compared raw titles (fixed); stage 3 is a 3.65M × 3.65M nested loop and uses no author trigram index (deferred, DECISION NEEDED); guests could file reports (fixed); role gating, audit log and HTML escaping verified; see A-03-002, A-03-003, A-03-006, A-03-007, A-03-009, A-03-013.
  - **Audit 03b (2026-09-25):** ⚠️ — stage 3 redesigned per D2 (titles compared only within an author's works; duplicate author records matched through `authors_name_trgm_idx`, which is now used and must not be dropped) and it runs on the full catalog; cross-record duplicates are looked for from popular works, works with user data and works created since the previous finished pass (`dedupe_runs`, migration `0022`); the rest of the long tail is left to user reports (decided scope limit); the queue is ordered by impact; moderators cannot dismiss (D4, test mutation-checked); see A-03-006, A-03-023, A-03-024.
  - **Audit 03c (2026-09-27):** ✅ — D7 implemented: review pairs are queued only when either work has user data or 100+ logs, stage 3 gets ≤ 20% of a run's new entries, queueing stops at 500 open; the other 325,292 detected pairs are recorded as candidates against the run (full-catalog dry run: 400 + 100 would be queued); see Part 03c in findings/03-dedupe.md.
- [x] **FN-52** Register `catalog.dedupe` as the monthly pg-boss job — 0.5d
  - Registered `QUEUES.catalogDedupe = 'catalog.dedupe'` in `apps/api/src/jobs/index.ts`.
  - Added pure `dedupeJobHandler` wrapping `runDedupe(db, opts)` and worker event logging.
  - Scheduled monthly cron (`0 0 1 * *`) in `apps/api/src/worker.ts` with `--dedupe` standalone worker runner.
  - Verified job registration, handler execution, and full lifecycle in `apps/api/src/test/jobs.test.ts`. Complete monorepo CI green.
  - **Audit (2026-09-25):** ⚠️ — scheduled and registered as claimed, and `--dry-run` writes nothing (counter diff on the full catalog); but the 15-minute pg-boss expiry was shorter than one pass (7.5 min of detection alone) and stage 3 ran before the merges (both fixed); see A-03-011, A-03-012.
  - **Audit 03b (2026-09-25):** ✅ — the scheduled job no longer merges unless the worker runs with `DEDUPE_AUTO_MERGE=true` (the job payload cannot switch it on); off, it detects and queues; tested both ways; see A-03-021.
  - **Audit 15a (2026-10-10):** ✅ the monthly job runs on its own one-connection pool with the dedupe profile (64 MB, 30 min).

### Auth — `FN-6x` · 5d
  - **Audit 03c (2026-09-27):** ✅ — the monthly job's 200-merge cap is documented as for NEW duplicates; the backlog is cleared by hand with `npm run dedupe -- --backlog` (README §2d); the monthly pass itself still runs the whole-catalog stage 1–2 query (→ Part 15, A-03-026).
- [x] **FN-60** users, refresh_tokens, profiles migrations — 0.5d
  - Migration `0005_auth.sql` applies cleanly on an empty database and live database. `users` gained `date_of_birth` (13+ age gate), `email_verified_at`, `role`, and `deleted_at`. `username` lives on `profiles`. `sessions` replaced by `refresh_tokens`.
  - **Audit (2026-09-25):** ⚠️ — tables and indexes as claimed; `email`/`username` are `text` with app-side lowercasing rather than the `citext` architecture §3.3 names (no case duplicates in dev data), and no path honoured `deleted_at` until this audit; see A-04-007, A-04-011.
- [x] **FN-61** argon2id (`@node-rs/argon2`); common-password list; 10-char minimum — 0.5d
  - `isCommonPassword` check rejects top dictionary passwords regardless of length. `passwordSchema` enforces 10-character minimum without entropy-reducing composition rules.
  - **Audit (2026-09-25):** ⚠️ — argon2id at the OWASP minimum, but the "top dictionary" list is 32 entries (D-04-2), passwords were not NFC-normalised and had no maximum (both fixed; the 1 MB-password DoS premise was measured false); see A-04-009, A-04-015.
  - **Audit (2026-09-26, Part 06):** ✅ D-04-2 — the list is now SecLists' top-100k (MIT, pinned commit + SHA-256) filtered to ≥ 10 characters, 2,309 entries plus the original 31 (2,327 distinct), loaded once into a `Set` (≈1.3 ms, ≈150 KB); signup, reset and admin accounts all use it; see A-06-024.
- [x] **FN-62** Register, login, DOB age gate — 1d
  - `isAtLeast13` rejects registration for users under 13 years old per PRD §26.6. `IdentityService.register` and `login` return full user + profile context with ~~rate-limited login~~ login limited per email only (10/min; no per-IP limit, A-04-017).
  - **Audit (2026-09-25):** ⚠️ — the gate let impossible dates through to a 500 and accepted pre-1900 and server-time-zone-dependent ages (fixed), login timing revealed whether an email had an account (fixed with a dummy verify), deleted users could log in (fixed), reserved usernames were mobile-only (fixed); see A-04-006, A-04-007, A-04-008, A-04-010.
  - **Audit 15a (2026-10-10):** ✅ register and login are in the PRD §24.4 auth tier (30/min per IP, 20/min anonymous IP); login keeps 10/min per email (A-04-017, -018).
- [x] **FN-63** **JWT 15m (`jose`) + opaque rotating refresh, hashed, `family_id`** — 1d
  - 15-minute HS256 JWT evaluated statelessly by Fastify's `onRequest` hook. 256-bit cryptographically secure opaque refresh tokens stored as SHA-256 hashes with 60-day expiry.
  - **Audit (2026-09-25):** ❌ — an admin JWT authenticated app routes, `alg` was not pinned and a token without `exp` was accepted (all fixed: `aud`/`iss` required, HS256 pinned); the hook also runs an admin verify on every bearer token (~119 µs, left as is); see A-04-003, A-04-004, A-04-023.
- [x] **FN-64** ⚠️ **Reuse detection: used token → revoke whole family** — 0.5d
  - Presenting an already-consumed refresh token immediately revokes all tokens matching its `family_id` and rejects with 403 `token_reused`. ~~All 35 identity tests pass in 2.8s.~~ (stale count)
  - **Audit (2026-09-25):** ⚠️ — sequential reuse revoked the family as claimed, but two concurrent refreshes with one token both succeeded and forked the family; rotation is now one conditional `UPDATE … RETURNING` (strict, no grace window); see A-04-005.
- [x] **FN-65** Email verification + password reset behind a sender interface — 1d
  - ~~Defined swap-ready `EmailSender` interface, `ConsoleEmailSender`, and `MemoryEmailSender` in `platform/mail.ts`.~~ Moved to `providers/email/` with an SMTP adapter (PV-04).
  - Added `email_verification_tokens` and `password_reset_tokens` tables (SHA-256 hashed, short-lived, single-use) with migration `0007_auth_tokens.sql` applied to live PostgreSQL.
  - Implemented `POST /v1/auth/verify-email` (burns token, marks `users.email_verified_at`), `POST /v1/auth/resend-verification` (authenticated `Bearer`, 1/60s rate limit, no-op when verified), `POST /v1/auth/forgot-password` (unauthenticated, always 200 without email enumeration), and `POST /v1/auth/reset-password` (argon2id update, burns token, **revokes all active refresh token families** for user).
  - Registration automatically dispatches a 24-hour verification token.
  - Updated Fastify route schemas, regenerated `openapi.yaml` with 0 drift, and added typed methods to `@flyleaf/api-client`. ~~42 tests in `identity.test.ts`, 289 tests passing across full suite in CI.~~ (stale counts)
  - **Audit (2026-09-25):** ⚠️ — tokens, expiry, single use, supersession and family revocation on reset verified by test; links were hard-coded to `https://flyleaf.app` (now `APP_BASE_URL`), a reset token could be spent twice concurrently (fixed), forgot-password is limited per email only (A-04-020); unverified accounts are not restricted (D-04-1); see A-04-013, A-04-014, A-04-016, A-04-024.
  - **Audit 15a (2026-10-10):** ✅ verify, reset and the emailed-link pages are in the auth tier; resend and forgot keep their numbers; every 429 has `Retry-After` (A-04-019 … -021, A-07-037) Forgot-password no longer waits for the mail, so with SMTP its timing does not reveal a registered email (A-04-024 → A-15-023).
- [x] **FN-66** Session list + per-device revoke — 0.5d
  - Added `sessionSchema`, `sessionListResponseSchema`, and `revokeSessionResponseSchema` in `apps/api/src/contract/schemas.ts`.
  - Device info captured via `User-Agent` request header on register/login and preserved during refresh token rotation.
  - Implemented `IdentityService.listSessions(userId)` grouping unrevoked, unexpired tokens by `family_id` and device, returning `id`, `device`, `createdAt`, `lastUsedAt`.
  - Implemented `IdentityService.revokeSession(userId, familyId)` revoking the entire token family (returns 404 `not_found` if not owned by caller or already revoked).
  - Implemented `IdentityService.logoutAll(userId)` revoking all active sessions for the user.
  - Added endpoints `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`, and `POST /v1/auth/logout-all` with Bearer auth.
  - Updated `@flyleaf/api-client` with typed `Session` interfaces and `getSessions()`, `revokeSession()`, `logoutAll()` methods; fixed request helper so empty body DELETE/POST does not attach content-type.
  - 47 unit/HTTP tests in `identity.test.ts` and contract tests in `contract.test.ts`; 295 tests passing across full CI suite with 0 OpenAPI drift.
  - **Audit (2026-09-25):** ✅ — 404 (not 403) for another user's family, `lastUsedAt` advances on rotation, revoking the current session ends refresh while the live access token lasts ≤ 15 min by design; the device label is now sanitised and capped at 200 characters; see A-04-012.

### Authorization — `FN-7x` · 3d
- [x] **FN-70** ⚠️ Repository layer: **viewer ID a required argument everywhere** — 1d
  - Enforced `viewer: string | null` (or `viewer: string` for authenticated operations) as the required first argument across `ReadingService` (`get`, `list`, `upsert`, `addProgress`), `CatalogService` (`getWork`), and `IdentityService` (`getProfile`). No method reading user-scoped data can be queried without a viewer argument.
  - **Audit (2026-09-25):** ⚠️ — the viewer argument is present, but five services ran their own profile/block/follow lookups and several ignored parts of them (blocks in review detail and saved shelves, follows in lists, `deleted_at` everywhere); now one `loadRelationship` query shared by all; see A-05-001, A-05-005, A-05-008, A-05-009, A-05-020.
  - Added `visibility` column to `reads` table with migration `0006_reads_visibility.sql` (`CHECK IN ('public', 'followers', 'private')`, default `'public'`).
  - Added `GET /v1/reads/:id` and `GET /v1/users/:id/reads` endpoints supporting guest (`req.viewer === null`) and authenticated callers.
- [x] **FN-71** ⚠️ Single `canView()`: public/followers/private/blocked/guest — 0.5d
  - Implemented centralized `canView()` and `assertCanView()` in `src/authorization/index.ts` covering complete bidirectional block invisibility, owner access, private item visibility, private account visibility, followers-only items, and guest access.
  - **Audit (2026-09-25):** ❌ — `canView()` itself was correct, but the SQL list filters beside it disagreed (work reviews, reads list, stats, saved shelves); added `canViewSql`, `visibleLevels` and `mostRestrictive`, proven equivalent to `canView()` over 63 cells in `authorization-equivalence.test.ts`; see A-05-002, A-05-005, A-05-008.
- [x] **FN-72** ⚠️ **Cross-user access test suite — 404 not 403, every private type** — 1.5d
  - Implemented comprehensive unit matrix and HTTP injection test suite in `src/test/authorization.test.ts` (43 tests).
  - Asserts that guest callers, non-followers, and blocked callers attempting to view another user's private reads, followers-only reads, private accounts, or add progress to another user's read receive **404 Not Found** with error code `'not_found'` — **never 403 Forbidden**.
  - **Audit (2026-09-25):** ❌ — covered reads only; review PATCH/DELETE answered 403, review detail and list leaked blocked and private accounts' reviews (P0), three routes' 404 body differed from a random id's; now `authorization-matrix.test.ts` (9 viewer states incl. unverified × public/private/deleted accounts × 3 visibilities, 17 single resources, 7 lists, 20 write routes); see A-05-001 … A-05-006.


### API contract — `FN-8x` · 2d
- [x] **FN-80** Fastify route schemas for the Phase 0–1 surface; `openapi.yaml` generated from them — 1d
  - Defined Fastify route schemas (`schema: { params, querystring, body, response }`) and reusable JSON schemas in `apps/api/src/contract/schemas.ts` for all Phase 0–1 endpoints across `Auth`, `Catalog`, `Reading`, and `System`.
  - Integrated `@fastify/swagger` and `yaml` with OpenAPI 3.1.0 specifications and BearerAuth security scheme.
  - Implemented `npm run spec:generate` and `npm run spec:check` in `src/contract/generate.ts`, generating `openapi.yaml` at repo root ~~with zero schema drift~~ — the generator kept its own plugin list and omitted the four export routes; it now reads the spec off `buildApp()` (Audit 05, A-05-014).
  - **Audit (2026-09-25):** ⚠️ — exports missing from the spec; `profileSchema` stripped `followStatus`/`followedBy`/`isRestricted` that mobile reads; a contract test now fails if any served route is missing from the spec; see A-05-007, A-05-014.
- [x] **FN-81** Typed client ~~generated~~ **hand-written** (Audit 05) into `packages/api-client`, CI-enforced — 0.5d
  - Created `packages/api-client` containing TypeScript interfaces and typed `FlyleafClient` with full endpoint coverage and standard error parsing (`FlyleafApiError`).
  - Connected `apps/mobile/src/lib/api.ts` to `@flyleaf/api-client`, replacing hand-written endpoint types and contracts with Fastify route schema bindings.
  - Added `api-client · build` and `api · spec check` to `scripts/ci.mjs`, ensuring CI breaks if schemas, `openapi.yaml`, ~~or `@flyleaf/api-client` drift~~ drift (CI compiles the client but cannot detect client/spec drift: Audit 05, A-05-021). 282 tests passing across 10 test suites in CI.
  - **Audit (2026-09-25):** ❌ — `types.ts` is hand-written and said "generated, do not edit"; spot check of three routes found the profile fields stripped server-side and two required/optional mismatches; recommend `openapi-typescript` in CI; see A-05-021.
- [x] **FN-82** Hook chain incl. the auth hook that never rejects (guests) — 0.5d
  - Centralized Fastify hook chain and app factory in `apps/api/src/app.ts` (`registerCoreHooks` & `buildApp`).
  - **Auth hook that never rejects (PRD §4.2, Architecture §3.3 & §7)**: Statelessly extracts Bearer token, populates `req.viewer` when valid, and falls back to `req.viewer = null` for guests. Never throws 401/500 on expired, forged, malformed, or missing tokens; protected endpoints enforce authentication explicitly via `requireViewer(req)`.
  - **Correlation & defensive headers**: Injected `X-Request-Id` (propagating `req.id`, ~~taken verbatim from the client~~ now validated, A-05-015), `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY` on every response via `onSend` hook.
  - **Error envelope & not found**: Centralized `setErrorHandler` mapping `ApiError` status/envelope, Fastify schema validation to 422 `invalid_field`, malformed JSON to 400 `invalid_json`, and unhandled errors to 500 `internal`. Uniform 404 handler.
  - **Audit (2026-09-25):** ⚠️ — auth hook verified against real forged, `alg:none`, expired, malformed and 6 KB tokens; `X-Request-Id` was unvalidated, DB constraint errors were 500s, no CSP on HTML, export download tokens reached logs; all fixed; the feed was also registered twice; see A-05-013, A-05-015 … A-05-019.
  - Refactored `server.ts` and test harnesses (`identity.test.ts`, `contract.test.ts`, `isbn.test.ts`, `authorization.test.ts`) to use shared core hooks.
  - Dedicated 17-test suite in `apps/api/src/test/hooks.test.ts`; 330 tests passing across 12 test suites in full CI. All tasks in **API contract `FN-8x`** are now complete.

### Admin (early slice) — `FN-9x` · 2d
- [x] **FN-90** Admin auth, separate from app accounts, 2FA — 0.5d
  - Migration `0009_admin_auth.sql` introduces isolated `admin_credentials` table storing RFC 6238 TOTP secrets and SHA-256 backup codes.
  - Zero-dependency RFC 6238 TOTP engine in `apps/api/src/admin/totp.ts` with ±1 step clock drift tolerance, base32 encoding/decoding, and backup code hashing.
  - Role-based token isolation with `aud: 'flyleaf-admin'` and `scope: 'admin'`. Regular app tokens rejected immediately on admin routes (`admin_auth_required`).
  - Role separation: `moderator` (read-only review access to queue & audit trail) vs `admin` (can execute and undo catalog merges).
  - Admin login (`POST /v1/admin/auth/login`) requires valid password AND TOTP (or backup code).
  - Server-rendered admin web console at `/admin/login`, `/admin/merges`, and `/admin/audit-log` with ~~secure session cookies (`flyleaf_admin_session`)~~ a session cookie that page JavaScript set from the login response: not HttpOnly, not Secure, `SameSite=Lax`, `Path=/admin` only (A-06-002). Now set by the server on a form `POST /admin/login`: HttpOnly, Secure, SameSite=Strict, one cookie each for `/admin` and `/v1/admin`.
  - **Audit (2026-09-26):** ❌ — TOTP codes could be replayed, backup codes double-spent, app accounts were revealed, failed logins went unaudited, a demoted or deleted admin kept access for 2 h, 2FA setup replaced the live secret before verification, and there was no way to create the first admin; all fixed (admin login still has no rate limit → Part 15); staff accounts are now refused by the app login and refresh (D-06-2); see A-06-002, A-06-005 … A-06-011, A-06-016, A-06-020, A-06-030, A-06-RL1.
- [x] **FN-91** Merge review UI + undo — 0.75d
  - Delivered with FN-51 & FN-90: Server-rendered dashboard (`/admin/merges`), side-by-side work comparison cards, collision forecasting, and ~~1-click reversible 30-day undo~~ undo/merge/dismiss buttons that could never authenticate: they call `/v1/admin/…` and the cookie was scoped to `/admin` (A-06-004). The REST routes worked; the buttons now do too.
  - **Audit (2026-09-26):** ⚠️ — role gating correct on every route (now a 4-role × 15-route matrix); the UI's actions were broken and the page carried inline handlers; merge, dismiss and undo now require a reason stored in the audit row (D-06-1: rule-queued pairs default to the rule, typed reasons 10+ characters); see A-06-004, A-06-015, A-06-019, A-06-029.
- [x] **FN-92** Maturity override; ingestion status dashboard — 0.75d
  - Catalog works inspection & review API (`GET /v1/admin/catalog/works`, `GET /v1/admin/catalog/works/:id`) with maturity filter (`unclassified`, `general`, `mature`, `explicit`) and text search.
  - Non-negotiable maturity override (`POST /v1/admin/catalog/works/:id/maturity`): Updates `works.maturity`, locks `field_provenance` (`is_locked = true`, `provider = 'user'`) ~~to protect human overrides from dump re-ingests~~ — which no ingest path read: the next dump merge overwrote the override (A-06-003, P0 against §7.9); `MERGE_WORKS` and gap-fill now keep every locked field — and logs to `admin_audit_log` with action `catalog.maturity_override` and mandatory human reason.
  - Role gating: `requireModerator` for reading works and status; `requireAdmin` for maturity mutations (moderator receives 403 `insufficient_role`).
  - Ingestion status dashboard (`GET /v1/admin/ingest/status`): Ingest runs history (`ingest_runs`), catalog breakdown (works, editions, authors, covers, raw payloads, maturity distribution), pending authorship queue depth, dedupe queue depth, and `outboundBreaker` state (`closed`, `open`, `half-open`) with rate limiter headroom.
  - Server-rendered HTML console views at `/admin/catalog/maturity` and `/admin/ingest` with shared navigation bar, role badges, and interactive override modal. ~~(values escaped)~~ The maturity page rendered titles, subtitles, author names, the admin's email and the `q` search string unescaped: stored and reflected XSS (A-06-001). Escaped now, with nonced scripts only.
  - ~~Zero-drift OpenAPI 3.1.0 specifications~~ The HTML `GET /admin/audit-log` and `GET /admin/merges` collided with the REST `/v1/admin/…` routes in `openapi.yaml` (the spec strips `/v1`), so both REST schemas were missing (A-06-019); HTML routes are now hidden. Typed client methods in `@flyleaf/api-client` (`adminGetCatalogWorks`, `adminGetCatalogWork`, `adminOverrideMaturity`, `adminGetIngestStatus`).
  - **Audit (2026-09-26):** ❌ — locked overrides were overwritten by the next ingest (P0), the maturity page was open to XSS (P0), and the ingestion status ran six full-table counts (152 s on the full catalog, now 16–22 ms from planner statistics); see A-06-001, A-06-003, A-06-013, A-06-025.
  - 7 dedicated test cases in `apps/api/src/test/admin-catalog.test.ts`. 100% test pass rate across 14 test suites in CI. Phase 0 Foundation is now complete.
- [x] **FN-93** ⚠️ `admin_audit_log` on every action — 0.25d
  - Migration `0009_admin_auth.sql` introduces `admin_audit_log` with indexes on ~~`(created_at desc)`~~ `(action, created_at)`, `(subject_type, subject_id)` and `(actor_id, created_at desc)`; there was no `created_at` index, so the console listing sorted the whole table (A-06-018). Added in `0023` with `(created_at desc, id desc)`.
  - Non-negotiable audit logging (`logAdminAction`) automatically records every admin action: logins (`admin.login`), dedupe merges (`catalog.merge`), undos (~~`catalog.undo`~~ `catalog.undo_merge`), and dismissals (~~`catalog.dismiss`~~ `catalog.dismiss_duplicate`). ~~every~~ Failed logins, 2FA failures and denied actions were not recorded (A-06-008); they are now (`admin.login_failed`, `admin.2fa_verify_failed`, `admin.denied`).
  - Enriched audit log entries capture actor ID, email, role, target resource/subject, reason, ~~IP address, user agent~~ (IP and user agent only inside the login payload; now columns on every entry, 0023), and contextual payload diffs.
  - **Audit (2026-09-26):** ⚠️ — the table was not append-only and missed every failure; now a trigger refuses UPDATE/DELETE, failures and denials are audited with IP and UA, and no entry carries a secret (tested); writes after a merge/undo are not yet in the same transaction (A-06-026 → Part 15); see A-06-008, A-06-017, A-06-018.
  - Audit log query API (`GET /v1/admin/audit-log`) with filtering by `action`, `actorId`, and pagination.
  - HTML audit trail viewer at `/admin/audit-log` with formatted JSON payloads and chronological history.
  - 22 dedicated test cases in `apps/api/src/test/admin.test.ts`. 100% test coverage for 2FA, token isolation, role enforcement, and audit recording.
  - **Audit 15a (2026-10-10):** ✅ merge, dismiss and undo now write their audit row in the same transaction as the action; a failed audit insert rolls the action back (A-06-026 → A-15-020).

### Providers — `PV-0x` · 5d
- [x] **PV-01** ⚠️ **Object-storage port.** `ObjectStorage` in `src/providers/storage/`: `createUpload({key, contentType, maxBytes, expiresIn})` → `{url, method, headers, fields?}` (covers S3 PUT, S3 POST policy and Cloudinary-style signed form posts), `createDownloadUrl(key, {expiresIn, filename})`, `head(key)` → `{size, contentType, etag} | null`, `getStream(key)`, `put(key, body, contentType)` (server-generated files only), `delete(key)`. Adapters: `disk` (dev: HMAC-signed local URLs served by a small route, so the presigned flow is exercised locally), `memory` (tests), `s3` (any S3-compatible: AWS, R2, B2, MinIO). One shared contract test suite runs against every adapter. `FileStorage` is deleted — 1.5d
  - `src/providers/storage/`: `ObjectStorage` (`types.ts`), `disk` + `memory` (`local.ts`, sharing one HMAC-SHA256 signed-URL scheme and the dev route `local-routes.ts` at `/v1/storage/object`, hidden from the spec), `s3` (`s3.ts`, `@aws-sdk/client-s3` + `s3-request-presigner` 3.1141.0).
  - ~~`createUpload({key, contentType, maxBytes, expiresIn})`~~ `createUpload({key, contentType, contentLength, expiresIn})`: a presigned **PUT** binds the exact declared length and type (`signableHeaders`), and the policy maximum is checked before signing. A range needs a POST policy, and R2 (the production target) does not implement POST Object. The `{url, method, headers, fields?}` shape still allows a POST adapter.
  - One key rule for every adapter (`assertValidKey`: no `..`, empty or absolute segments). `put()` is used only for exports.
  - Contract suite `src/test/storage-contract.test.ts`: 10 cases × memory, disk, s3 with a mocked client (the fake re-signs every presigned URL with the SDK, so a wrong type, length, key or expiry is refused as S3 would), and s3 against the local MinIO when `flyleaf-minio` is reachable. Removing `signableHeaders` makes the MinIO wrong-type case fail (checked).
  - `FileStorage` (`imports/storage.ts`) deleted; imports, exports and the job handlers use `ObjectStorage`.
  - **Audit PV (2026-09-26):** ✅ built; contract suite runs memory, disk, s3 (mocked) and s3 against MinIO (`findings/PV-providers.md`). **Audit 15a:** deleted accounts' objects are removed by the retention sweep before the account (A-PV-008 → A-15-008).

- [x] **PV-02** ⚠️ **Presigned upload flow.** `uploads` table (id, user_id, purpose, key, content_type, max_bytes, status `pending|uploaded|consumed|expired`, expires_at). `POST /v1/uploads` {purpose, content_type, size} → upload id + presigned target, limits per purpose from one policy table (PRD numbers with section refs). Client uploads directly. `POST /v1/uploads/:id/complete` → server `head()`s the object, checks owner, size, declared type and magic bytes (ranged read), marks `uploaded`. Consumers take `upload_id` (imports first), mark it `consumed` in the same transaction as the job enqueue. Exports: worker `put()`s, client downloads via short-lived `createDownloadUrl`. Daily cleanup job deletes expired/unconsumed uploads and their objects. Remove `@fastify/multipart` and the multipart route. Idempotent `complete`; another user's upload id → 404 — 1.5d
  - Migration `0024_uploads.sql` (+ `uploads` in `schema.ts`): `size` (declared, exact), `max_bytes`, `filename`, `sha256`, `completed_at`, `consumed_at`; the cleanup index is partial on live rows.
  - `src/uploads/index.ts`: `UPLOAD_POLICIES` (import: 10 MB, CSV/text types, PRD §6.8 + §42 #11), `POST /v1/uploads` (415 wrong type, 413 over the limit, the target lives 15 min and the upload 1 h), `POST /v1/uploads/:id/complete` (404 for someone else's id with the same body as a random one; 409 `upload_missing`; 410 expired; 422 size, type or content mismatch, after which the object is deleted and the same target can be retried; idempotent and race-safe).
  - ~~magic bytes (ranged read)~~ `complete` streams the object once (≤ 10 MB) to sniff it (binary signatures, NUL bytes) **and** hash it, so duplicate detection (PRD §34.4) stays a synchronous 409. The API never receives the bytes in a request. The worker re-checks the SHA-256 before processing, because the PUT target stays valid after `complete` (see Audit PV, D-PV-2).
  - `POST /v1/imports {upload_id, source, force?}` (JSON). It row-locks the upload, checks for duplicates, inserts the import, marks the upload consumed and enqueues through `sendInTx`, all in one transaction: a failed enqueue leaves no import and a reusable upload. Replaying the same upload returns the same import with 200.
  - Exports: the worker `put()`s; `GET /v1/exports/:id/download` authorizes by the emailed token or the owner, then **302**s to a 5-minute storage URL (`no-store`, `no-referrer`). Emailed links keep working.
  - Daily `storage.cleanup` (03:45): expired uploads that were never consumed, and export files past their 48 h window, are deleted from storage (the object first, then the row).
  - Import files are deleted 30 days after the import finishes (D-PV-3; there is no undo window to wait for). A deleted account's files → Part 15 retention sweep (account deletion is not built). `complete` hashes while streaming; the disk adapter now streams too (D-PV-2).
  - `@fastify/multipart` removed. An unparseable Content-Type is now 415 `unsupported_media_type` (it was an unhandled 500).
  - Tests: `uploads.test.ts` (17) and `imports.test.ts`, `import-duplicate.test.ts`, `export.test.ts`, `import-real-library.test.ts`, `server-wiring.test.ts` rewritten for the flow. Seen failing with the guard removed: PDF-as-CSV, NUL bytes, and a file replaced after `complete`.
  - **Audit 15a (2026-10-10):** ✅ upload intents limited to 10/day per account (A-PV-007, D-15-2); orphaned avatar uploads deleted a day later (A-10-016).

- [x] **PV-03** api-client + mobile: `uploadFile(purpose, file, {onProgress})` does intent → direct upload → complete, with retry of the upload step only; import screen switched; export download uses the presigned URL; pending uploads cleared per user on logout — 0.5d
  - api-client: `createUpload`, `completeUpload`, `uploadFile(purpose, body, {contentType, filename?, onProgress?, attempts?})` (intent, then the direct PUT/POST, retried up to 3 times only on a network error, 408, 429 or 5xx, then complete), `createImport({upload_id, source, force?})`, `cancelPendingUploads()`. ~~`uploadImport`~~ is removed. Sizes are counted in UTF-8 bytes. Progress uses XHR where it exists.
  - The direct upload uses `ClientConfig.uploadFetch` (the global fetch by default), never the API fetch. The mobile interceptor re-sends a 401 with the bearer token, and the token must not reach a storage host (the test checks the PUT carries no `Authorization`).
  - Mobile: the import screen uploads the pasted CSV with progress (`Uploading N%`), then calls `createImport`. "Import anyway" after a 409 duplicate reuses the same upload with `force: true`, so nothing is sent again. `api.logout()` calls `cancelPendingUploads()` first.
  - Export download: `download_url` is still the emailed API link, which now 302s to the short-lived storage URL, so `Linking.openURL` ends at the presigned URL with no mobile change.
  - Tests: `apps/api/src/test/api-client-upload.test.ts` (6) runs the built client against the real app: call order, no token to storage, 503 retried and 403 not, a 415 surfaced before any upload, cancel-on-logout. Mobile typecheck and 100 offline tests green.
  - **Audit PV (2026-09-26):** ✅ built; the client is tested against the real app (`findings/PV-providers.md`).
- [x] **PV-04** Email port: `EmailSender` moves to `src/providers/email/`, adds one real adapter (SMTP via nodemailer, or Resend/SES/Postmark) selected by `EMAIL_DRIVER`; templates stay in app code — 0.25d
  - `platform/mail.ts` moved to `src/providers/email/local.ts` (`EmailSender`, `console`, `memory`), with no re-export left in `platform`; all 18 importers now point at `providers/email/index.js`. New `smtp.ts`: `SmtpEmailSender` on nodemailer 10.0.10 (it ships its own types, so no `@types/nodemailer`). Any vendor with an SMTP relay (Postmark, SES, Resend, Mailgun) is a `SMTP_URL`, not code.
  - `EMAIL_DRIVER=console|memory|smtp` (+ `SMTP_URL`, `EMAIL_FROM`) through `createMailer()`. The API and the worker both use it (the worker used a console mailer of its own before). Templates stay in `identity/` and `exports/`.
  - Contract suite `src/test/email-contract.test.ts`: memory, console and smtp (nodemailer's real message builder over its JSON transport, no network); a provider refusal rejects; a CR/LF in the subject adds no header on the wire.
  - **Audit PV (2026-09-26):** ✅ SMTP adapter (nodemailer); fail-fast in production (A-PV-001).
- [x] **PV-05** Push port: `PushSender` interface + Expo push adapter + memory adapter, so SO-30 builds on it — 0.25d
  - `src/providers/push/index.ts`: `PushSender.send(messages)` returns one `PushResult` per message, in order, and never throws for a single bad message. Failures are named for what SO-30 must do: `device_not_registered` (delete the token), `invalid_token`, `message_too_big`, `rate_limited`, `provider_error`.
  - Adapters: `memory` (tests and development) and `expo`, which is Expo's push HTTPS API through `fetch` with a 10 s timeout, batches of 100 and an optional `EXPO_ACCESS_TOKEN`. There is no `expo-server-sdk` dependency. `PUSH_DRIVER=memory|expo` via `createPush()`; production requires `expo`.
  - Only push *tickets*: reading Expo's delivery *receipts* (a second call, minutes later) is left to SO-30, which owns the token table it would update.
  - Contract suite `src/test/push-contract.test.ts` (12): memory, and expo against a fake of Expo's API (the documented ticket shapes, DeviceNotRegistered, the 100-per-request limit); a 503 or 429 or an unreachable host marks the batch instead of throwing.
  - **Audit PV (2026-09-26):** ✅ send only (tickets); delivery receipts are SO-30's.
- [x] **PV-06** Error-reporting port: `ErrorReporter` interface; Sentry becomes one adapter; `noop` default; PII scrubbing (`sanitizeContext`) stays outside the adapter — 0.25d
  - `src/providers/errors/index.ts`: `ErrorReporter.capture(error, context)` returns an event id or null and never throws. Adapters: `noop` (the default, allowed in production), `memory` (tests), and `sentry` (the existing store-endpoint call moved into an adapter, now with a 5 s timeout, `environment` and `release`, and the DSN validated at startup). `ERROR_DRIVER=noop|memory|sentry` + `SENTRY_DSN`, `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`.
  - `telemetry/sentry.ts` renamed to `telemetry/errors.ts`: `sanitizeContext` stays there, and `reportApiError(reporter, …)` scrubs *before* any adapter sees the context. The 500 handler (`registerCoreHooks`) reports through the injected reporter.
  - ~~Sentry reporting (SL-82)~~ **was never on:** `initSentry()` had no caller, so `captureApiException` was a no-op whatever `SENTRY_DSN` said (see Audit PV, A-PV-003). The factory now builds the reporter that `serverDependencies()` hands the app.
  - Tests: `error-reporter-contract.test.ts` (10) runs noop, memory, and sentry against a fake store endpoint (payload, key, no headers or body sent, failure returns null, a bad DSN is refused). `telemetry.test.ts`: a thrown 500 reaches the reporter with authorization, query token and password redacted, and the client body has no detail. The `initSentry` no-op test is replaced.
- [x] **PV-07** Catalog-source port: Open Library access behind `CatalogSource` (lookup by ISBN / work / author, cover URL); `OutboundClient` rate limit + breaker stay shared — 0.25d
  - `src/providers/catalog/`: `CatalogSource` with `search(q, limit)`, `lookupIsbn`, `lookupWork`, `lookupAuthor` and `coverUrl(id, S|M|L)`, and the `OpenLibrarySource` adapter. The lookups return the **same rows as the dump ingest** by running `normaliseEdition` / `normaliseWork` / `normaliseAuthor`, so there is one parser for OL records. An invalid ISBN or a malformed key is refused before any request (no path injection); every method returns null / [] instead of throwing.
  - All requests go through the one shared `OutboundClient` (limiter and breaker unchanged). The search keeps its 2.5 s timeout. `createCatalogSource()` has no driver variable, because Open Library is the only source we may store (CC0).
  - `GapFillService(db, source)`: the OL search, `parseOlSearch` and the URL moved into the adapter. `persist()` and its licensing rule stay in `catalog/gapfill.ts` (the licensing test still reads that file).
  - Only `search` has a production caller today; the lookups exist for the declared scope and are exercised by the contract suite only.
  - Contract suite `catalog-source-contract.test.ts` (9): a fake openlibrary.org serving the real fixture records, a real `OutboundClient`, ISBN-10/13/hyphenated, full and bare keys, source down, and a drained limiter means no request.
  - **Audit PV (2026-09-26):** ✅ built; only `search` has a production caller, the lookups are exercised by the contract suite.
- [x] **PV-08** Wiring + guard rails: one `providers/index.ts` factory reads `STORAGE_DRIVER`, `EMAIL_DRIVER`, `PUSH_DRIVER`, `ERROR_DRIVER` and fails fast on missing credentials in production; `serverDependencies()` and the worker both use it; ESLint `no-restricted-imports` forbids vendor SDKs (`@aws-sdk/*`, `@sentry/*`, `nodemailer`, `expo-server-sdk`, …) outside `src/providers/`; README gets a "Swapping a provider" section; architecture.md updated — 0.5d
  - `providers/index.ts`: `createProviders(env)` → `{storage, mailer, push, errors, catalog}`, built from `createStorage`, `createMailer`, `createPush`, `createErrorReporter` and `createCatalogSource`. An unset driver in production is a refusal (`ERROR_DRIVER` falls back to `noop`), as are a dev adapter (`disk`, `memory`, `console`), a missing or blank credential (every missing variable is named), an invalid Sentry DSN, and an unknown driver. Credentials are also required outside production (`s3` without a bucket is a mistake anywhere).
  - `server.ts` and `worker.ts` call it **first, before the database**, so a bad config exits at once instead of after 15 s of DB retries. `serverDependencies(db, boss, providers)` hands the app storage, mailer, the error reporter and the catalog source. The worker's handlers get the same storage and mailer: they used to default to a local disk and a console mailer of their own.
  - ~~ESLint `no-restricted-imports`~~ The repository has no ESLint, so the rule is a test: `src/test/providers.test.ts` scans every import outside `src/providers/` (tests excepted) for `@aws-sdk/*`, `@smithy/*`, `@sentry/*`, `nodemailer`, `expo-server-sdk`, `@google-cloud/*`, `@azure/*`, `firebase-admin`, `cloudinary`, `resend`, `postmark`, `@sendgrid/*` and `mailgun*`, and the checker is tested on a sample. Adding ESLint for one rule was rejected (a new toolchain and CI step); see Audit PV, D-PV-4.
  - Tests: `providers.test.ts` (14) covers the factory rules, spawns `server.ts` and `worker.ts` with `NODE_ENV=production` and a dead database (both exit naming the variable in under 14 s), and the boundary check. `server-wiring.test.ts` builds the app from `createProviders()`.
  - Docs: README §3d "Swapping a provider"; architecture §4.2 (ports, rules, the presigned flow diagram), §3.7 `uploads` DDL, §9 `storage.cleanup`; `.env.example`; phases.md.

**Exit:** 50 owned books findable · panel ≥90% · cross-user suite green · migrations clean in CI.

---

## Phase 1 — Solo loop · `SL` · 40d

### Client foundation — `SL-0x` · 6d
- [x] **SL-00** ⚠️ Run `npx expo install --check` and `npx expo-doctor` before adding any mobile dependency. Expo Go rejects a project whose native module versions differ from what it ships — pin from `bundledNativeModules.json`, never npm `latest` — 0.25d
  - **Audit (2026-09-26):** ⚠️ — no npm `latest` versions, but 6 packages are now patch releases behind SDK 57 (`expo-doctor` 20/21); `expo install --fix` left to the owner (native rebuild); see A-07-022.
  - **Audit (2026-09-26, Part 07b):** ✅ — patches applied and NetInfo 12.0.1 added through `expo install`; `expo install --check` clean, `expo-doctor` 21/21; native rebuild pending on the phone (README › Native changes waiting for a rebuild); see A-07-022, A-07-034.
- [x] **SL-01** Expo Router shell, 5 tabs + centre FAB — 1d
  - **Audit (2026-09-26):** ✅ — the five tabs of PRD §5.2 plus the centre FAB, which is gated for guests.
- [x] **SL-02** Design system from `design.md`: tokens, Button, Card, Sheet, Cover, StarRating, Heart, ProgressBar, Skeleton, EmptyState — Reanimated + gesture-handler — 3d
  - **Audit (2026-09-26):** ✅ — the components exist and are used (existence checked, not behaviour); colour literals in screens are A-07-021.
- [x] **SL-03** API client wiring, TanStack Query, error surface — 0.5d
  - **Audit (2026-09-26):** ⚠️ — queries never retry a 4xx, but several user-facing writes swallowed errors; follow fixed, work-page writes → Part 08; see A-07-020.
- [x] **SL-04** `expo-secure-store` refresh token; 401 → refresh interceptor — 1d
  - **Audit (2026-09-26):** ❌ — single-flight held, but a 429/5xx on refresh and any offline cold start signed the user out; fixed (`authFetch.ts`, tested with parallel 401s); single-flight covers every caller, so the D-04 grace window is not needed; see A-07-009.
- [x] **SL-05** Theme switching, system default, both palettes verified — 0.5d
  - **Audit (2026-09-26):** ⚠️ — both palettes are complete in `tokens.ts`, but 66 hard-coded colour literals remain in 18 files (deferred); see A-07-021.

### Offline — `SL-1x` · 6d
- [x] **SL-10** ⚠️ SQLite schema mirroring reads + progress_events — 1d
  - **Audit (2026-09-26):** ❌ — local reads were not scoped to a user and the local database had no migrations; fixed (`migrations.ts`, `user_version`); see A-07-002, A-07-007.
- [x] **SL-11** ⚠️ **Mutation queue: persist, replay, backoff, dead-letter** — 2d
  - **Audit (2026-09-26):** ❌ — any 409 was treated as synced, 4xx were retried, offline dead-lettered everything within minutes, dead letters were never shown, queues replayed across accounts, flushes ran concurrently, and reads created offline never got their server id; all fixed, with a Couldn't sync screen; see A-07-001, A-07-002, A-07-005, A-07-008.
  - **Audit (2026-09-26, Part 07b):** ✅ — likes and follows are now queued as desired states; an opposite write still waiting cancels it (like then unlike offline sends nothing); a row being sent is claimed and never cancelled; a 429 burst on replay is a Part 15 item; see A-07-034, A-07-039.
  - **Audit 15a (2026-10-10):** ✅ a 429 holds the entity's writes until `Retry-After` without using an attempt (A-07-039 → A-15-015). Replay of every queued action re-checked against the server (A-15-016).
- [x] **SL-12** ⚠️ `client_event_id` generation + idempotent replay — 0.5d
  - **Audit (2026-09-26):** ⚠️ — client correct; the server accepted an id reused on another read or user as success; now 409 `client_event_conflict`; see A-07-015.
- [x] **SL-13** ⚠️ **Offline queue test suite incl. simulated process death** — 1.5d
  - **Audit (2026-09-26):** ⚠️ — process death covered; one test asserted the 409 bug (updated); users, concurrency, migrations and id remapping are now covered (`queue-audit.test.ts`); a11y criterion is tautological; see A-07-001, A-07-026.
- [x] SL-14 Sync-on-foreground ~~and on reconnect~~ (no network listener: a 30 s retry timer runs while writes are pending, audit 07); unsynced indicator — 1d
  - **Audit (2026-09-26):** ⚠️ — foreground sync yes; no reconnect trigger; polled every 30 s forever; the indicator counted all users; fixed except a NetInfo listener (D-07-2); see A-07-014.
  - **Audit (2026-09-26, Part 07b):** ✅ — NetInfo reconnect now flushes at once, and the indicator shows an offline state; the 30 s timer stays as the fallback; see A-07-034.

### Auth screens — `SL-2x` · 3d
- [x] SL-20 Welcome carousel with "Look around first" — 0.5d
  - **Audit (2026-09-26):** ✅ — carousel with "Look around first".
- [x] SL-21 Sign up / log in / forgot / reset / verify — 1.5d
  - **Audit (2026-09-26):** ❌ — signup never sent the entered DOB (always 2000-01-01, field pre-filled); no screens for the emailed verify/reset links; `email_unverified` unhandled; all fixed (links still open in the browser until D-07-1); see A-07-004, A-07-011, A-07-016, A-07-017.
  - **Audit (2026-09-26, Part 07b):** ✅ — Android App Links and iOS associated domains for both links, fallback pages whose GET never spends a token, well-known files from env; accounts with the 2000-01-01 placeholder are asked for their date of birth and get the explicit filter until they answer (`dob_confirmed`, `POST /v1/me/date-of-birth`); the explicit setting itself has no endpoint, and the neutral under-13 gate (D-07b-1) is Part 10's; the app's link host is tested against the production `APP_BASE_URL` (D-07b-2); see A-07-033, A-07-035, A-07-036.
- [x] SL-22 Username ~~+ avatar~~ (typographic default only, audit 07 → Part 10); live availability (built in audit 07); reserved words — 1d
  - **Audit (2026-09-26):** ❌ — there was no availability check at all (no endpoint, no request) and no avatar picker; availability built (`GET /v1/auth/username-available`, 400 ms debounce, stale responses dropped); avatar → Part 10; see A-07-010, A-07-032.

### Guest mode — `SL-3x` · 3d
- [x] **SL-30** ⚠️ Guest routing: no session → Home in browse mode — 0.5d
  - **Audit (2026-09-26):** ✅ — no auth wall; guests land on Home; the Reading tab is the upsell.
- [x] **SL-31** ⚠️ **Action gate**: contextual prompt at Log/Rate/Follow/Like, one-tap dismiss — 1d
  - **Audit (2026-09-26):** ⚠️ — follow/block/mute, follow lists, mute book, feed-card like and shelf save were ungated or dead-ended; fixed; see A-07-013.
- [x] **SL-32** ⚠️ Local Want-to-Read (cap 20) — 0.75d
  - **Audit (2026-09-26):** ✅ — cap 20, dedupe and SQLite persistence.
- [x] **SL-33** ⚠️ **Migrate local shelf on signup + confirmation copy** — 0.75d
  - **Audit (2026-09-26):** ❌ — failures still cleared the shelf, books already in the library were reset to want (or re-read), and runs overlapped; fixed and tested; merged works → Part 08; see A-07-012, A-07-024.

### Catalog screens — `SL-4x` · 7d
- [x] **SL-40** Search screen: debounce 250ms, tabs, recents, filters — 2d
  - **Audit (2026-09-27):** ⚠️ — debounce correct; a slow response overwrote a newer one and recents were invented, unpersisted and saved per keystroke (fixed); the format filter is cosmetic (deferred); see A-08-020, A-08-021.
- [x] **SL-41** **Book detail**: hero, status control, rating + histogram, description, metadata, tabs — 2.5d
  - **Audit (2026-09-27):** ❌ — the histogram, description, series and metadata fallbacks were fixed values for every book, writes skipped the offline queue and a 404 spun for ever; all fixed, with real fields on `GET /works/:id`; see A-08-016, A-08-019, A-08-026.
- [x] **SL-42** Cover-forward edition picker; "the copy I own" — 1d
  - **Audit (2026-09-27):** ❌ — "the copy I own" was never saved and every edition had an invented publisher and year; now the attempt's `edition_id` through the queue, real publisher/year; see A-08-018.
- [x] SL-43 Author page; series page with your progress — 1d
  - **Audit (2026-09-27):** ❌ — the author page searched the author's name as a title and invented a bio and books; the series page was hard-coded; `GET /authors/:id` and `GET /series/:id` built and wired; the catalog holds no series data; see A-08-017.
- [x] SL-44 Barcode scanner + permission rationale + manual fallback — 0.5d
  - **Audit (2026-09-27):** ⚠️ — rationale and manual entry present; a missed barcode was looked up on every camera frame and every error said "not found" (fixed); unknown ISBNs have no live lookup (deferred); see A-08-022.

### Reading core — `SL-5x` · 9d
- [x] **SL-50** reads + progress_events migrations & repos — 1d
  - **Audit (2026-09-27):** ⚠️ — one row per attempt and append-only progress hold; every reads write scanned the table twice (L-01), terminal attempts were overwritten and nothing could delete a read; all fixed (0026, 0027); see A-08-001, A-08-004, A-08-007, A-08-013.
- [x] **SL-51** ⚠️ `POST /reads/{id}/progress` idempotent on `client_event_id` — 0.5d
  - **Audit (2026-09-27):** ✅ — idempotent on `client_event_id` and append-only, verified; `minutes` now bounded at 1,440; see A-08-024.
- [x] **SL-52** **Reading tab**: cards, slider auto-save, +10, predicted finish — 2.5d
  - **Audit (2026-09-27):** ⚠️ — slider saves once per drag (code, device check pending); the prediction test was flaky over a real rounding bug and dates were UTC (fixed); see A-08-023, A-08-010.
- [x] **SL-53** Progress sheet: numeric entry, chips, **optional minutes**, note, quote — 1d
  - **Audit (2026-09-27):** ⚠️ — optional minutes and note verified; minutes had no upper bound (fixed); see A-08-024.
- [x] **SL-54** **Finish flow**: stars visible, heart, date, format chips, review, ≤20s — 2d
  - **Audit (2026-09-27):** ❌ — not one transaction, `review` accepted and dropped, a double tap wrote two activities, the date defaulted to the UTC day and finishing a want with a past date was refused; all fixed; see A-08-006, A-08-008, A-08-010, A-08-011.
- [x] **SL-55** DNF flow: page pre-filled, reason chips, neutral copy — 0.75d
  - **Audit (2026-09-27):** ⚠️ — copy and pre-fill fine; the note was dropped and DNF-ing a finished read overwrote it (fixed, `reads.dnf_note`); see A-08-007, A-08-012.
- [x] **SL-56** Re-read: new row, `attempt_no+1` — 0.5d
  - **Audit (2026-09-27):** ❌ — concurrent starts returned 409 and `dnf → finished` overwrote the DNF; fixed (advisory lock, terminal-status rule on server and app); see A-08-007, A-08-009.
- [x] SL-57 Want-to-read queue; sort, filter, bulk — 0.75d
  - **Audit (2026-09-27):** ❌ — sort and filter work; bulk "Remove" set books to paused and no delete existed; `DELETE /reads/:id` and a queued delete built; see A-08-013.

### Ratings, reviews — `SL-6x` · 5d
- [x] **SL-60** Half-star control, extra hit area, haptic, `adjustable` trait — 1d
  - Delivered interactive `Stars` component in `apps/mobile/src/ui/components.tsx` with continuous dragging (`Gesture.Pan()`), 0.5-star resolution (0.5 to 5.0), and ~~hit-slop-extended 44x44 minimum touch targets~~ 44-tall targets; each half-star tap target is `size/2` (~16 pt) wide plus 4 pt slop, and the drag is the wide target (audit 09, A-09-031).
  - Haptic feedback tick (`Haptics.selectionAsync()`) on every 0.5 step boundary crossed during drag or tap.
  - Spring-scale pop animation (`withSequence`) on rating commit.
  - Fully accessible with `accessibilityRole="adjustable"` and custom `increment` / `decrement` accessibility actions announcing half-star steps to screen readers.
  - **Audit (2026-09-30):** ❌ — the drag's gesture callbacks ran on the UI thread and called JS there (fixed with `.runOnJS(true)`, device check pending), and a rating could not be cleared (tap the current value / step below ½ now clears; `POST /reads` `clear_rating`); see A-09-006, A-09-007, A-09-031.
- [x] **SL-61** Heart, independent of rating — 0.25d
  - Built standalone `Heart` component in `apps/mobile/src/ui/components.tsx` with 44x44 touch target, independent of star rating (a reader can heart a 3-star or 5-star book alike, or heart without rating).
  - Spring scale bounce feedback (`withSequence`) and `Haptics.impactAsync` on toggle.
  - **Audit (2026-09-30):** ⚠️ — independent of the rating in API and UI (tested); the per-work heart count (§9.4 [LOCKED]) was never shown, now on `GET /works/:id` and the book page; see A-09-011.
- [x] **SL-62** ⚠️ Bayesian weighted rating + trigger-maintained `work_stats` — 1d
  - Migration `0011_ratings_reviews.sql` introduces PostgreSQL trigger function `recompute_work_stats_for_work` and trigger `reads_work_stats_trigger` maintaining `work_stats` (`rating_count`, `rating_sum`, `avg_rating`, `weighted_rating`, ~~`review_count`~~ — no such column; `heart_count`, `read_count`, `dnf_count`, `polarisation` (audit 09)) automatically on every read insert/update/delete.
  - ~~Bayesian arithmetic formula `(v / (v + m)) * R + (m / (v + m)) * C` implemented in `apps/api/src/reviews/index.ts` with `m = 25` threshold and catalog benchmark `C = 3.90` (dynamically derived from catalog average excluding target work).~~ The formula's only production implementation is SQL (`flyleaf_weighted_rating`, 0026) with C cached nightly over all ratings (Part 08); the TS copy had no caller and was removed (audit 09, A-09-018).
  - Catalog query integration in `apps/api/src/catalog/index.ts` projecting `avg_rating`, `weighted_rating`, and `rating_count` on all work lookups.
  - ~~12 comprehensive unit tests~~ 3 tests in `apps/api/src/test/reviews.test.ts` (two on the unused TS formula; moved to the SQL function in `reviews-audit.test.ts`).
  - **Audit (2026-09-30):** ⚠️ — the SQL aggregates are right (Part 08); the duplicate TS recompute and formula were dead weight and are gone; §9.7 exclusion not built (fast-follow, tracked below); re-reads count per attempt in the rating aggregates (decided: each user's latest rating → Part 09b, with ten half-star histogram buckets); see A-09-018, A-09-021, A-09-027, A-09-028.
  - **Audit (2026-09-30, Part 09b):** ✅ — the rating aggregates, C and the book histogram now count each reader once at their latest rated attempt (one view, `latest_ratings`, migration 0029, on both databases, every `work_stats` row recomputed in batches; trigger and nightly reconcile agree on every row); `rating_distribution` is ten half-star buckets (§9.6); the three works with no stats row were reads written before 0011 existed, never backfilled, copied by `devdb:build` with triggers off (it now reconciles and checks; verified on a throwaway 20k-work build, which also exposed and fixed a `devdb:build` failure present since 0026); see A-09-036 … A-09-038, A-09-044.
  - [ ] **SL-62b** §9.7 manipulation prevention: ratings from accounts under 7 days old or with fewer than 5 ratings excluded from every aggregate (trigger, histogram, reconcile), with a daily job for accounts crossing 7 days and a recompute when a user crosses 5 ratings. PRD P1 (first fast-follow); deferred by the owner on 2026-09-30. Plan in A-09-021; the launch-week effect needs a product answer first.
    - **Audit 09 (2026-09-30):** deferred as the PRD's fast-follow (A-09-021). **Audit 15a:** imported ratings from new or unverified accounts belong to the same rule (`DECISIONS.md` 2).
- [x] **SL-63** Review composer: autosave every 3s, spoiler, visibility — 1.5d
  - Review composer modal screen at `apps/mobile/app/review/compose/[id].tsx` with 3-second debounce autosave to `expo-secure-store`.
  - Spoiler toggle switch with optional starting page threshold (`spoiler_after_page`), visibility selector (`public`, `followers`, `private`), and live character counter with soft warning at 5,000 and hard cap at 10,000 characters.
  - Offline mutation queue integration (`save_review`) in `apps/mobile/src/offline/queue.ts` and `repository.ts` with optimistic local storage and background replay.
  - **Audit (2026-09-30):** ❌ — review feed cards kept stale visibility, so private reviews stayed in the public feed (P0), and status changes made private reads public (P0); the write was not atomic; edits reset visibility and spoilers; the composer could not edit and posted the book's id for unlogged books; all fixed; a want-list read can no longer be reviewed (decided 2026-09-30); review rate limit → Part 15; see A-09-001 … A-09-005, A-09-008, A-09-012 … A-09-017, A-09-022.
- [x] **SL-64** Review detail + book reviews list, friends-first sort — 1.25d
  - Book Reviews tab on `apps/mobile/app/work/[id].tsx` with Bayesian stats headline, rating filter chips (`All`, `5★`..`1★`), and 5 sort modes: `friends` (friends-first algorithm from PRD §10.7), `likes`, `newest`, `highest`, `lowest`.
  - Review cards with author avatar, rating, spoiler gate with tap-to-reveal, and instant like toggle.
  - First-class Review Detail screen at `apps/mobile/app/review/[id].tsx` with book context strip, full text, like button, native share sheet, and delete action for author.
  - Social review ranking algorithm in `apps/api/src/reviews/index.ts` balancing social proximity (0.35 weight), engagement (0.20), comments (0.10), recency decay (0.15), and quality length (0.10). Zero contract drift in OpenAPI specification.
  - **Audit (2026-09-30):** ⚠️ — the list loaded every review and ranked ties nondeterministically (pages repeated and skipped); now SQL-paged sorts, narrow-row ranking with one clock, bucketed rating filter; 3.7× faster unloaded but still over budget under load (plan in A-09-009); no tombstone, no "load more"; see A-09-009, A-09-010, A-09-015, A-09-019, A-09-024, A-09-033.
  - **Audit (2026-09-30, Part 09b):** ✅ — friends sort: guests read a 60 s cached ranking (re-checked for visibility per page), signed-in viewers rank a capped candidate set that provably gives SO-23's exact order (parity and slack tests, mutation-checked); ~1.9× faster under load for the heavy persona, ≥ 12× for guests (`flyleaf_dev`, indicative); the book page draws five bars from the ten API buckets by the filter's rule (`lib/ratingBars`); see A-09-039 … A-09-042.

### Diary, Wall, Profile, Stats — `SL-7x` · 7d
- [x] **SL-70** Diary — **list · grid · calendar**, year jump, filters — 2.5d
  - Delivered `apps/mobile/src/ui/DiaryView.tsx` and standalone screen `apps/mobile/app/diary.tsx`, embedded into Reading tab (`apps/mobile/app/(tabs)/reading.tsx`) and Profile screen (`apps/mobile/app/(tabs)/profile.tsx`).
  - Three distinct viewing modes:
    1. **List view**: Chronological timeline grouped by month/year with finish date badges, book covers, titles, authors, star ratings, and hearted markers.
    2. **Grid view**: Visual cover shelf/posters with rating chips and finish dates.
    3. **Calendar view**: Heatmap calendar matrix showing month days with dot indicators for reading completions, month navigation, and tap-to-inspect date drawer.
  - Year jump selector (`All Time`, `2026`, `2025`...) with auto-computed years from read history, quick-toggle format filter (`print`, `ebook`, `audiobook`), star rating filter (`5★+`, `4★+`, `3★+`), and Hearted-only filter toggle.
  - ~~Volume summary bar displaying total books, pages read, and audio hours for the active filter slice.~~ "Pages" summed the bookmark position, not the books' page counts; fixed (A-10-021).
  - **Audit (2026-10-06):** ⚠️ — the views work, but undated finishes were filed under the month they were edited, a 1 March finish showed under February west of UTC, and no "Undated" group existed (fixed); filters stay on the device and there is no single-read delete (deferred); see A-10-021, A-10-026, A-10-030.
- [x] **SL-71** **The Wall**: 3-col grid, filters incl. Hearted, 2-col below 340dp — 1.5d
  - Dedicated screen at `apps/mobile/app/wall.tsx` and parameterized user wall at `apps/mobile/app/wall/[id].tsx`.
  - Responsive column layout using window width measurement: renders 3 columns on standard mobile devices and seamlessly collapses to 2 columns on screens under 340dp width.
  - Filter and sort controls: Hearted toggle pill (`♥ Hearted`), Year selector pills, Rating filters (`5★+`, `4★+`, `3★+`), Format selector pills (`Print`, `Ebook`, `Audiobook`), and Sort menu (`Finished (newest)`, `Rating (highest)`, `Title (A-Z)`).
  - High-density poster aesthetic with fluid aspect ratio covers (`aspectRatio: 2 / 3`), subtle rating badges, and instant navigation to book details.
  - **Audit (2026-10-06):** ❌ — another user's Wall loaded the **viewer's own** reads (`GET /reads`); now pages `GET /users/:id/reads` (fixed). The 340 dp switch is correct; server-side filters deferred; see A-10-002, A-10-026.
- [x] **SL-72** Profile: favourites, stats strip, currently reading, Diary, reviews — 2d
  - Complete profile screen at `apps/mobile/app/(tabs)/profile.tsx` and public profile viewer at `apps/mobile/app/user/[id].tsx` respecting privacy settings.
  - Profile features:
    - User avatar badge, display name, handle (`@username`), bio, join date, and follow counts.
    - 4 Ordered Favourites cover shelf with direct link to edit in `app/profile/favourites.tsx`.
    - Annual Stats Strip hero card (books read, pages read, audio hours, daily streak) with shortcut button to full stats.
    - Currently Reading carousel shelf with reading progress bars and 1-tap logging access.
    - The Wall thumbnail preview strip linking to full Wall screen.
    - Diary preview strip showing recent read entries with shortcut to full Diary.
    - Recent Reviews section with star ratings, text previews, and likes.
    - In-app Profile Editor modal for updating display name and bio (enforcing 160 char limit).
  - **Audit (2026-10-06):** ⚠️ — the bio limit counted UTF-16 units, nothing was trimmed and the privacy switch was not atomic (fixed); no avatar picker existed (built, PV-02 purpose `avatar`); see A-10-020, A-10-016.
- [x] **SL-73** Favourites picker (4, ordered, ~~drag~~ Up/Down buttons) — 0.5d
  - Standalone manager screen at `apps/mobile/app/profile/favourites.tsx`.
  - Exactly 4 ordered slots (`#1` through `#4`) displaying book cover, title, author, and move Up/Down reordering controls with haptic feedback.
  - Remove button to free up slots; Add button opening live catalog search modal to find and select works from user's history or catalog.
  - ~~Direct integration with `PATCH /v1/me/profile` sending ordered `favourites: [{ work_id, position }]` payload.~~ It sends `favouriteWorkIds` (ordered ids), the only shape the server accepts.
  - **Audit (2026-10-06):** ✅ — at most four, unknown ids refused, merged works resolved to the survivor, repeats collapse, dedupe repoints them; see A-10-031.
- [x] **SL-74** Basic stats: volume, temporal, taste, extremes — 0.5d
  - Dedicated stats screen at `apps/mobile/app/stats.tsx` and user stats at `apps/mobile/app/stats/[id].tsx`.
  - Comprehensive statistical insights:
    - **Volume & Habit**: Books finished, pages read, audio hours, and reading habit daily/longest streaks.
    - **Temporal Pace**: 12-month interactive bar chart tracking books and pages read per month.
    - **Taste & Ratings**: Average star rating and rating distribution histogram ~~(1★ to 5★)~~ (ten half-star buckets since audit 10, A-10-013).
    - **Format Breakdown**: Percentage and count split across print, ebook, and audiobook editions. ~~(no override counted as print)~~ Falls back to the edition format, else `unknown` (A-10-009).
    - **Reading Extremes**: Longest book read, shortest book read, and most read author with book counts.
    - **Did Not Finish (DNF)**: Abandoned book count and DNF rate percentage.
  - Backend aggregation service in `apps/api/src/reading/index.ts` and `apps/api/src/identity/index.ts` with `GET /v1/me/stats`, `GET /v1/users/:id/stats`, `GET /v1/me/profile`, and `PATCH /v1/me/profile`.
  - 8 backend tests in `apps/api/src/test/profile-stats.test.ts` and 9 mobile unit tests in `apps/mobile/src/lib/__tests__/profile-stats.test.ts`. 100% green CI pipeline. (The mobile tests re-implement the logic they test, A-10-023.)
  - **Audit (2026-10-06):** ❌ — **P0**: another viewer's audio hours and streaks included private reads (§17.5 [LOCKED]); streak days were UTC, years came from the server clock, audio summed positions, pages used the smallest edition, nothing was disclosed (§17.4); all fixed, with a twin-account privacy oracle; see A-10-001, A-10-007…A-10-013, A-10-024.

### Instrumentation — `SL-8x` · 2d
- [x] **SL-80** ⚠️ `events` table + client emitter — 0.5d
  - Created migration `apps/api/drizzle/0012_events.sql` declaring PostgreSQL `events` table (`id bigserial`, `name text`, `user_id uuid`, `session_id uuid`, `platform text`, `app_version text`, `properties jsonb`, `at timestamptz`) with composite indexes on `(name, at desc)` and `(user_id, at desc)`.
  - Registered route `POST /v1/events` in `apps/api/src/telemetry/index.ts` accepting batched telemetry events with payload validation and optional bearer auth extraction.
  - Implemented client event emitter and memory queue in `apps/mobile/src/lib/events.ts`:
    - 30-minute idle session lifetime with automatic UUID v4 rotation.
    - Automatic periodic flush (15s timer) and threshold-triggered flush (>= 20 events).
    - AppState lifecycle hook flushing events when app moves to background.
    - Offline resilience: retained events on network failure (prepended up to 200 items).
  - **Audit (2026-10-06):** ❌ — the anonymous endpoint stored any name, any properties and any timestamp, and took the **user id from the body** (fixed: taxonomy, shape caps, token-only user); no rate limit (Part 15) and no retention (decision needed); see A-10-017, A-10-025, A-10-029.
  - **Audit 15a (2026-10-10):** ❌→✅ the telemetry routes were mounted at the root, so the app's `POST /v1/events` was a **404** and no event ever arrived; now under `/v1` (A-15-001). Guest batches 120/hour (D-15-2). Retention: raw events 13 months, zero-result queries 30 days, weekly summary with k ≥ 5 (D-10-1, D-10-3 → A-15-008, -009).
- [x] **SL-81** ⚠️ **Instrument the §4.4 budgets**: progress duration, finish duration, tap counts, abandonment — 1d
  - Built real-time budget instrumenter in `apps/mobile/src/lib/budgetTracker.ts` measuring the 5 non-negotiable PRD §4.4 interaction budgets:
    1. `progress_updated`: duration from Reading tab focus to save (budget: p75 < 5s). Integrated into slider release, quick add, and progress sheet.
    2. ~~`book_logged`: tap count from impression to shelved (budget: p75 <= 2 taps). Integrated into work detail and reading queue.~~ Both call sites sent a constant 2; not sent until taps are counted (A-10-003).
    3. `finish_completed`: duration from Finish tap to save (budget: p75 < 20s). Integrated into Finish flow modal (`FinishScreen`) and review composer.
    4. `finish_flow_abandoned`: tracks flow abandonment when user dismisses without saving (budget: < 8% abandonment).
    5. `log_sheet_completed`: duration from `+` FAB ~~or Update sheet~~ tap to save (budget: p75 < 15s). The FAB had no instrumentation; it starts the clock now (A-10-003).
  - Admin budget analytics endpoint `GET /v1/admin/telemetry/budgets` computing PostgreSQL `percentile_cont(0.75)` for progress, finish, and log sheet durations, tap counts, and flow abandonment rate.
  - 10 mobile unit tests covering event queuing, session rotation, and all 5 budget events in `apps/mobile/src/lib/__tests__/telemetry-budgets.test.ts`.
  - **Audit (2026-10-06):** ❌ — false green at both ends: the app invented in-budget durations when no clock ran and re-anchored the progress clock at each save, and the report read all time and said "passing" with no samples; one malformed event broke it (fixed; `book_logged` deferred); see A-10-003, A-10-004.
  - **Audit 15a (2026-10-10):** ✅ `book_logged` is sent, with taps counted from the impression per D-10-2 (search row → book page carry-over, 10-minute expiry, stops at local success) (A-15-010).
- [x] **SL-82** Sentry, app + API — 0.5d
  - ~~API Sentry integration in `apps/api/src/telemetry/sentry.ts` and `apps/api/src/app.ts`: custom Fastify 500 error hook capturing unhandled exceptions~~ The hook never sent anything: `initSentry()` had no caller, so capture was a no-op whatever `SENTRY_DSN` said. Now an `ErrorReporter` port chosen by `ERROR_DRIVER` (PV-06, A-PV-003); the redaction stays in `telemetry/errors.ts`. with automatic redaction of sensitive headers (`authorization`, `cookie`, `secret`, `password`, `token`, `totp`).
  - Mobile Sentry wrapper in `apps/mobile/src/lib/sentry.ts` with exception formatting, platform tagging, and graceful fallback. (Its event ids were not valid Sentry ids, it had no release tag, and despite its header it scrubbed nothing; fixed, A-10-019.)
  - Global `ErrorBoundary` in `apps/mobile/src/ui/ErrorBoundary.tsx` wrapping the application root in `apps/mobile/app/_layout.tsx` with user-friendly recovery screen and error reporting.
  - 7 backend tests in `apps/api/src/test/telemetry.test.ts` covering event ingestion, budget calculation, moderator role gating, and Sentry context sanitization. 100% green CI pipeline.
  - **Audit (2026-10-06):** ⚠️ — the API scrubbed six top-level keys only, so `refresh_token`, nested passwords and verification codes reached Sentry; now recursive and case-insensitive, emails included (fixed); see A-10-018, A-10-019.

- [x] **Phase 1 Exit Criteria Verified** · `phase1-exit-criteria.test.ts` (100% green in CI):
  - **Two books tracked end-to-end**: Book 1 (*Piranesi*) tracked want -> reading -> 3 progress increments -> finished (5★, heart, print, review). Book 2 (*The Left Hand of Darkness*) tracked reading -> progress -> finished (4.5★, ebook, review). Verified local SQLite persistence, Diary aggregations (2 finished, 4.75 avg rating, format breakdown), and sync queue.
  - **Finish duration budget p75 < 20s & abandonment < 8%**: Validated finish flow completion durations (measured p75 ~11.2s, strictly < 20s) and abandonment tracking with stage recording.
  - **Offline verified & process crash resilience**: Optimistic local writes never block UI; operations enqueued in persistent SQLite `mutation_queue` with strict per-entity FIFO; survived simulated process death across disk database restart; replayed idempotently without duplicate records.
  - **A11y pass on core flows**: Core touch targets verified (`minHeight/minWidth >= 48dp`, FAB `>= 56dp`), explicit semantic `accessibilityRole` (`button`, `header`, `image`, `link`, `tab`) and descriptive `accessibilityLabel` verified across reading, finish, log sheet, and navigation screens.

---

## Phase 2 — Shelves & lists · `SH` · 10d

- [x] **SH-01** shelves + shelf_items migrations, counters — 0.5d
  - Migration `0013_shelves.sql` creating `shelves`, `shelf_items`, and `shelf_saves` tables with Drizzle schema and TypeScript models in `apps/api/src/db/schema.ts`.
  - Schema constraints: shelf name length (char_length <= 60), per-entry note length (char_length <= 280), privacy enum (`public`, `followers`, `private`), unique slug per user `(user_id, slug)`, duplicate work prevention per shelf `PRIMARY KEY (shelf_id, work_id)`, and cascade deletions.
  - Denormalized counter triggers: `update_shelf_item_count_and_covers()` maintaining `item_count` and up to 4-cover mosaic `cover_work_ids`, and `update_shelf_save_count()` maintaining `save_count`.
  - Nightly reconciliation procedure `reconcile_shelf_counters()` and scheduled background job `QUEUES.reconcileShelves` (`shelves.reconcile`) in `apps/api/src/jobs/index.ts`.
  - 11 database tests in `apps/api/src/test/shelves-migration.test.ts` and 2 background job tests in `apps/api/src/test/jobs.test.ts`. 100% green CI pipeline on real PostgreSQL.
  - **Audit (2026-10-10):** ⚠️ — counters were correct, but the row-level trigger recounted the shelf once per changed row (a 1,190-book reorder: 1,190 recounts, 1.56 s → 35 ms as a statement-level trigger in 0034), the reconcile rewrote every shelf nightly and returned nothing (now drift-only, returns the count), and name non-blank / description ≤ 2,000 were API-only (now `NOT VALID` checks); see A-11-010, A-11-021, A-11-023.
- [x] **SH-02** Create/edit: name, description, privacy, ranked toggle — 1d
  - Backend `ShelvesService` (`create`, `get`, `update`, `delete`, `generateUniqueSlug`) and Fastify route plugin registered at `/v1/shelves`.
  - Enforced per-user unique URL slugs with collision disambiguation (`slug`, `slug-1`, `slug-2`) per PRD §15.2.
  - Strict privacy authorization using centralized `canView()` matrix (public, followers-only, private) with 404 returned on denial to prevent shelf enumeration.
  - 30-day soft deletion lifecycle (`deleted_at`) hiding deleted shelves from readers.
  - Full OpenAPI contract synchronization with schemas in `apps/api/src/contract/schemas.ts`, updated `openapi.yaml` (0 drift), and typed client methods in `@flyleaf/api-client` (`createShelf`, `getShelf`, `updateShelf`, `deleteShelf`).
  - Native mobile screens in `apps/mobile/app/shelf/create.tsx` and `apps/mobile/app/shelf/[id]/edit.tsx` with name (1–60 chars), description (<= 2000 chars), privacy radio picker, ranked toggle with warning confirmation on unranking, and 30-day soft deletion flow.
  - Comprehensive test suite: 12 tests in `apps/api/src/test/shelves.test.ts` and 9 validation unit tests in `apps/mobile/src/lib/__tests__/shelves.test.ts`. CI pipeline 100% green.
  - **Audit (2026-10-10):** ❌ — a privacy change or delete never reached the feed, so a private shelf's books stayed in followers' feeds (P0, fixed); the 30-day soft delete had no way to restore (now `GET /v1/shelves/deleted`, `POST /v1/shelves/:id/restore`, and a Recently deleted screen; purge → Part 15); no 200-shelf cap (fixed); concurrent same-name creates 409'd (fixed); non-Latin names slugged to `shelf` (fixed); renames break share links (DECISION NEEDED); see A-11-001, A-11-003 … A-11-007, A-11-028.
  - **Audit (2026-10-10, Part 13):** D-11-2 built: a renamed shelf keeps its old slugs (reserved to it, `301` to the current slug on every slug route, back on restore); see findings/13-social-graph.md A-13-020.
  - **Audit 15a (2026-10-10):** ✅ shelves deleted more than 30 days ago are purged by the retention sweep (A-11-033 → A-15-008); shelf writes are in the 120/min writes tier (A-11-031).
- [x] **SH-03** Shelf detail: ranked numbering, per-entry notes, mosaic cover — 1.5d
  - Backend `ShelvesService` (`getItems`, `addItem`) and Fastify endpoints `GET /v1/shelves/:id/items` and `POST /v1/shelves/:id/items` with 3-tier privacy authorization (404 on access denial).
  - Enhanced `GET /v1/shelves/:id` resolving `cover_ids` (OpenLibrary integer covers) and viewer save state `is_saved`.
  - Joined works metadata (title, author name, covers, ratings, user's read status) with sequential position ordering (`position ASC, added_at ASC`).
  - Enforced per-entry note constraints (char_length <= 280) and unique work constraint on shelf items (409 conflict).
  - Full OpenAPI contract synchronization with schemas in `apps/api/src/contract/schemas.ts`, updated `openapi.yaml` (0 drift), and typed client methods in `@flyleaf/api-client` (`getShelfItems`, `addShelfItem`).
  - Native Shelf Detail screen in `apps/mobile/app/shelf/[id].tsx` with 4-cover mosaic card preview, ranked numbering pills (`#1..#N`), per-entry notes in styled callouts, owner actions (Edit Shelf), reader actions (Save/Saved toggle, Share), and contextual empty states.
  - Comprehensive test suite: 17 tests in `apps/api/src/test/shelves.test.ts` and 12 mobile unit tests in `apps/mobile/src/lib/__tests__/shelves.test.ts`. CI pipeline 100% green.
  - **Audit (2026-10-10):** ⚠️ — ratings averaged every attempt and private read (now the work page's `work_stats` value); the app showed only the first 100 books (now pages); ranked numbers had gaps after a removal (now 1..n); see A-11-011, A-11-012, A-11-013.
- [x] **SH-04** Add-to-shelf from book page, search, long-press — 1d
  - Backend `ShelvesService` (`getMyShelves`, `removeItem`, `updateItem`) and Fastify endpoints:
    - `GET /v1/shelves/mine`: Retrieves viewer's active shelves with optional `?work_id=:uuid` membership filter (`contains_work: boolean`, `item_note: string | null`, `position: number | null`).
    - `DELETE /v1/shelves/:id/items/:workId`: Removes a book from a shelf, updating `item_count` and mosaic covers via DB trigger, strictly enforcing owner authorization (404 on non-owner).
    - `PATCH /v1/shelves/:id/items/:workId`: Updates per-entry note (validating <= 280 characters) and position.
  - Contract & Client: Schemas in `apps/api/src/contract/schemas.ts`, updated `openapi.yaml` (0 contract drift), and typed client methods in `@flyleaf/api-client` (`getMyShelves`, `removeShelfItem`, `updateShelfItem`).
  - Native mobile `AddToShelfSheet` component (`apps/mobile/src/ui/AddToShelfSheet.tsx`):
    - Bottom sheet displaying book thumbnail, title, and author.
    - Checkbox toggle per shelf with instant haptics and optimistic local state updates.
    - Per-entry note composer with character counter (max 280 chars).
    - Inline quick shelf creation ("+ New Shelf") without leaving reading context.
    - Contextual Guest Mode integration (`ActionGate`: *"Sign up to create shelves"*).
  - Surface integrations:
    - Book detail (`apps/mobile/app/work/[id].tsx`): secondary action row with prominent "Add to shelf" button.
    - Discover search results (`apps/mobile/app/(tabs)/discover.tsx`): `onLongPress` gesture on book cards and bookmark shortcut button.
    - `Card` component (`apps/mobile/src/ui/components.tsx`): `onLongPress` prop support.
  - Comprehensive test suite: 20 tests in `apps/api/src/test/shelves.test.ts` (442 API tests passing) and 14 tests in `apps/mobile/src/lib/__tests__/shelves.test.ts` (66 mobile tests passing). CI pipeline 100% green.
  - **Audit (2026-10-10):** ❌ — adding the 101st book answered 500 after committing it; no 1,000-book cap; concurrent adds all took position 1 on real Postgres; a duplicate add un-ticked the sheet; a merged work id showed no membership; all fixed; see A-11-002, A-11-003, A-11-009, A-11-014, A-11-025.
- [x] SH-05 Reorder: drag + **"move to position" alternative** — 1d
  - Backend API: `PUT /v1/shelves/:id/order` taking `{ work_ids: string[] }`, updating `shelf_items.position` sequentially (1..N) within a single transaction, rejecting duplicate work IDs (400), strictly enforcing owner authorization (404 on non-owner/missing), and triggering DB triggers to recompute `cover_work_ids` (4-cover mosaic).
  - Schema & Typed Client: Added `reorderShelfBodySchema` and `reorderShelfResponseSchema` in Fastify contract, regenerated `openapi.yaml` (0 contract drift verified), and exposed `client.reorderShelf(id, { work_ids })` in `@flyleaf/api-client`.
  - Mobile Reorder UI & Helpers:
    - Array manipulation helpers: `moveItemInArray<T>` and `repositionItem<T>` (1-indexed clamped position) in `apps/mobile/src/lib/shelfValidation.ts`.
    - Dedicated screen: `apps/mobile/app/shelf/[id]/reorder.tsx` featuring rank badges (`#1..#N`), book covers, step Up/Down buttons, pan drag handle with light haptics, and an accessible "Move to Position" modal dialog (PRD §6.36, §46.2, `design.md` §256) with numeric input and quick jump buttons (`Top #1`, `Middle #mid`, `Bottom #N`).
    - Save flow: calls `api.reorderShelf`, records telemetry `track('shelf_reordered', { shelf_id, count })`, triggers success haptics, and prompts confirmation before discarding unsaved edits.
    - Owner trigger: "Reorder" button on `apps/mobile/app/shelf/[id].tsx` in action row and section header when `item_count >= 2`, auto-reloading shelf data via `useFocusEffect` upon returning.
    - Stack route registered in `apps/mobile/app/_layout.tsx`.
  - Comprehensive test suite: 21 tests in `apps/api/src/test/shelves.test.ts` (443 API tests passing) and 21 tests in `apps/mobile/src/lib/__tests__/shelves.test.ts` (73 mobile tests passing). CI pipeline 100% green.
  - **Audit (2026-10-10):** ❌ — duplicates were rejected (400), but a partial or padded list was accepted (two books at one rank) at any length, and the reorder screen asked for `limit=200` (422), so it never opened; now the exact set or `409 order_mismatch`, ≤ 1,000 ids, one UPDATE, PATCH position is a move; see A-11-008, A-11-010, A-11-011, A-11-012.
- [x] SH-06 My shelves grid; three starter suggestions on empty — 1d
  - Mobile Shelves Screen (`apps/mobile/app/(tabs)/shelves.tsx`):
    - Transformed Tab 4 from static placeholder to live user-curated collections screen connected to `api.getMyShelves()`.
    - Responsive 2-column grid layout with 4-cover mosaic preview cards (2x2 grid for >= 4 covers, overlapping preview stack for 1–3 covers, elegant icon placeholder for empty shelves).
    - Multi-criteria sorting: `sortShelves(shelves, sortBy)` supporting `'updated'` (newest created first), `'alpha'` (A–Z by shelf name), and `'books'` (highest book count first).
    - Grid vs List display toggle with persistent layout memory and selection haptics.
    - Shelf metadata tags: privacy icon (globe, people, lock), ranked badge (`#` / `Ranked`), and item count.
    - Screen-level pull-to-refresh (`RefreshControl`) and automatic focus refresh (`useFocusEffect`).
    - Empty state (0 shelves) featuring three 1-tap starter suggestions (PRD §6.33):
      1. *"Favourites of 2026"* (Ranked List, public)
      2. *"Comfort reads"* (Themed List, public)
      3. *"Recommended to me"* (Reading Queue, public)
    - 1-tap starter creation: creates shelf via `api.createShelf()`, emits telemetry `track('shelf_created', { starter: true })`, triggers success haptics, and navigates into the new shelf.
    - Preserved guest mode device shelf (20-book Want-to-Read cap) with contextual auth prompt.
  - Helpers & Starter Definitions (`apps/mobile/src/lib/shelfValidation.ts`):
    - Exported `StarterShelfSuggestion` interface, `STARTER_SHELVES` constant, and `sortShelves<T>()` sorting helper.
  - **Audit (2026-10-10):** ⚠️ — works; the PRD §6.35 duplicate-name warning was missing (added on create); see A-11-026.
- [x] SH-07 Save someone's shelf (reference, stays in sync) — 0.5d
  - Backend endpoints & reference semantics (`apps/api/src/shelves/index.ts`):
    - `POST /v1/shelves/:id/save`: Idempotently saves another reader's shelf as a reference record in `shelf_saves(shelf_id, user_id)` (PRD §6.34, §15.6). Rejects self-saves with HTTP 400 (`cannot_save_own_shelf`). Unauthorized viewing returns HTTP 404 to prevent resource enumeration.
    - `DELETE /v1/shelves/:id/save`: Un-saves shelf from caller's library and decrements counter.
    - `GET /v1/shelves/saved`: Lists all shelves saved by authenticated viewer with owner details, joined 4-cover previews, and dynamic book counts.
    - Dynamic Sync: Because saves reference the original `shelves.id` directly rather than cloning records, all additions, removals, notes, and reorderings by the curator reflect immediately for all savers with zero sync lag.
    - Database trigger `shelf_saves_counter_trigger` maintains atomic `shelves.save_count` on INSERT/DELETE.
  - OpenAPI & Typed Client:
    - Added `saveShelfResponseSchema` and `savedShelvesResponseSchema` to `apps/api/src/contract/schemas.ts`. Zero contract drift verified (`npm run spec:check`).
    - Added `SaveShelfResponse` and `SavedShelvesResponse` in `packages/api-client/src/types.ts`.
    - Added `saveShelf`, `unsaveShelf`, and `getSavedShelves` in `packages/api-client/src/client.ts`. Re-exported in `apps/mobile/src/lib/api.ts`.
  - Mobile UI Integration:
    - Shelf Detail Screen (`apps/mobile/app/shelf/[id].tsx`):
      - Wired "Save Shelf" / "Saved to Library" primary button to live `api.saveShelf` and `api.unsaveShelf` endpoints.
      - Optimistic UI updates with haptics (`Haptics.ImpactFeedbackStyle.Medium`) and automatic rollback with alert on failure.
      - Telemetry events emitted: `shelf_saved` and `shelf_unsaved`.
    - Shelves Screen (`apps/mobile/app/(tabs)/shelves.tsx`):
      - Live **Saved** tab wired to `api.getSavedShelves()`.
      - Responsive 2-column mosaic grid with 4-cover preview cards, curator attribution (`by @username`), book count, and rank badges.
      - Grid vs List display toggle support.
      - Guest state with contextual auth prompt to save shelves.
      - Empty state when no shelves have been saved yet.
      - Auto-fetch on tab select, screen focus (`useFocusEffect`), and pull-to-refresh (`RefreshControl`).
  - Verification:
    - Comprehensive backend integration tests in `apps/api/src/test/shelves.test.ts` (unauthenticated rejection, self-save prohibition, private shelf isolation, idempotency, counter trigger, dynamic book sync verification).
    - 444 API tests passing, 77 mobile tests passing. Full 9-step CI pipeline green.
  - **Audit (2026-10-10):** ⚠️ — reference sync and dynamic privacy hold; unsave answered 200 with a hidden shelf's save count (P0, now the random-id 404); the saved list was one statement per owner with a fake `@user` fallback, now one statement, paged (`limit`/`offset`/`total`); see A-11-015, A-11-016.
- [x] **SH-08** Browse public shelves; ranking formula — 1.5d
  - Contract & Schema (`apps/api/src/contract/schemas.ts`):
    - `browseShelvesQuerySchema`: validates optional `query` (max 100 chars), `sort` (`'ranked' | 'popular' | 'recent'`, default `'ranked'`), `limit` (1..50, default 20), and `offset` (minimum 0).
    - `browseShelvesResponseSchema`: typed `shelves` array matching `shelfSchema` and `total` count.
    - Zero OpenAPI contract drift: `openapi.yaml` verified against routes with `npm run spec:check`.
    - Typed API client methods and response models in `@flyleaf/api-client` (`browseShelves(params?: BrowseShelvesQuery)`).
  - Backend & Ranking Formula (`apps/api/src/shelves/index.ts`):
    - Public shelf browsing endpoint: `GET /v1/shelves/browse`. Registered before `/shelves/:id` to prevent route shadowing.
    - Strictly filters candidate shelves to `privacy = 'public'` and `deleted_at IS NULL`.
    - Guest-accessible: viewer is optional; guests browse with 0 authentication required and `is_saved = false`.
    - Case-insensitive search on `name` and `description` via ILIKE wildcard matching.
    - ~~Implemented PRD §15.5 multi-signal composite ranking formula:~~ Audit 11: the formula below is implemented with `views` = 0 for every shelf (there is no view counter; spec gap, A-11-024), so its `0.20 * log(1 + views)` term contributes nothing. Since audit 11 it is computed in SQL.
      `shelf_score = 0.30 * log(1 + saves) + 0.20 * log(1 + views) + 0.20 * social_proximity_to_owner + 0.15 * curation_quality + 0.15 * freshness`
      - `curation_quality`: boosts annotated shelves (has description +0.25, has notes +0.25, optimal book count 5–100 +0.30, complete covers +0.20) and downranks unannotated raw dumps (>100 items with no notes or empty lists).
      - `social_proximity`: boosts followed creators (1.0) and own shelves (0.5).
      - `freshness`: rational decay over 30 days (`1 / (1 + ageInDays / 30)`).
    - Alternate sorts: `popular` orders by `save_count DESC`, `recent` orders by `created_at DESC`.
  - Mobile Integration:
    - Shelves Screen (`apps/mobile/app/(tabs)/shelves.tsx`):
      - Replaced static EmptyState on **Curated** tab (`shelfFilter === 'discover'`) with live public shelf browsing.
      - Integrated search bar with 250ms debouncing and clear button.
      - Sort pills: Featured (`'ranked'`), Popular (`'popular'`), Recent (`'recent'`).
      - View mode toggle: 2-column mosaic grid with 4-cover previews and list view with curator attribution (`by @username`), book counts, and ranked badges.
      - Dynamic pull-to-refresh accessible to both guests and authenticated readers.
    - Discover Screen (`apps/mobile/app/(tabs)/discover.tsx`):
      - Connected the **Lists** tab (`activeTab === 'lists'`) to live public shelves via `api.browseShelves`.
      - Live search for curated lists when search query is active; browse mode shows featured community lists.
  - Verification:
    - 7 dedicated backend integration tests in `apps/api/src/test/shelves.test.ts` verifying public-only filtering, private/followers/soft-deleted exclusion, guest browsing, ILIKE search, PRD §15.5 curation quality ranking, social proximity boosting, popular/recent sorting, pagination, and save state.
  - **Audit (2026-10-10):** ⚠️ — the `views` term is always 0 (no view counter; spec gap, Part 15); the whole candidate set was loaded and scored in Node (26 statements; now 1, scored in SQL); mutes were ignored, `%`/`_` were wildcards, sorts had no id tie-break (all fixed); 10× plan recorded; see A-11-017 … A-11-020, A-11-024, A-11-032.
  - **Audit 15a (2026-10-10):** the `views` term stays 0: the counter is recorded as a decision (D-15-7, `DECISIONS.md` 3), not built.
  - **Audit 15b (2026-10-11):** ❌ on a real Postgres: every browse (and saved) page with a cover-less work in a shelf mosaic answered 500 (postgres.js decodes the NULL in `cover_ids` as NaN; PGlite as null); fixed, test seen failing; see findings/15-cross-cutting.md A-15-024.
- [x] **SH-09** ⚠️ **Shelf privacy on every read path + tests — 404 not 403, private account hierarchy** — 1d
  - Security Principle & Obscurity (Architecture §4, PRD §15.2, §26.1):
    - Enforced strict 3-tier privacy authorization (`public`, `followers`, `private`) on every read path via centralized `canView()` and `assertCanView()`.
    - Unauthorized callers receive **404 Not Found** (`error.code: 'not_found'`), **never 403 Forbidden**, completely eliminating shelf enumeration.
    - Soft-deleted shelves (`deleted_at IS NOT NULL`) masked with 404 for all callers except the owner.
    - Write mutations (`PATCH`, `DELETE`, `order`, item add/edit/remove) strictly return 404 (never 403) to non-owners.
  - Private Account Hierarchy (PRD §26.1):
    - When an owner has a private profile (`profiles.isPrivate = true`), all their shelves (even public ones) are masked with 404 to non-followers and guests.
    - Public shelves of private accounts are strictly excluded from public discovery (`GET /v1/shelves/browse`) via an inner join with `profiles` filtering `profiles.isPrivate = false`.
  - Dynamic Privacy Sync in Saved Shelves:
    - Updated `getSavedShelves()` (`GET /v1/shelves/saved`) to evaluate `canView(...)` for each shelf dynamically.
    - Shelves immediately disappear from a reader's saved library if the curator changes shelf privacy to private or followers-only (and reader is not an accepted follower), or if the curator turns their profile private.
  - User Shelves Endpoint (`GET /v1/users/:id/shelves`):
    - Added Fastify route returning shelves for user profile pages according to viewer authorization.
    - Owners see all active shelves (public, followers, private).
    - Accepted followers see public and followers shelves.
    - Non-followers/guests see public shelves only (or receive 404 if profile is private).
    - Soft-deleted shelves are excluded.
  - Contract & Typed Client:
    - Added `userShelvesResponseSchema` to `apps/api/src/contract/schemas.ts`. Zero contract drift verified (`npm run spec:check`).
    - Added `UserShelvesResponse` and `client.getUserShelves(userId)` to `@flyleaf/api-client`.
    - Re-exported in `apps/mobile/src/lib/api.ts`.
  - Comprehensive Test Matrix:
    - 20 comprehensive unit tests in `apps/api/src/test/shelves-privacy.test.ts` covering public/followers/private tiers, private account hierarchy, soft-deleted shelves, items endpoint, profile shelves, browse discovery, saved shelves dynamic privacy, and write mutations.
    - 472 API tests passing, 77 mobile tests passing. Full 9-step CI pipeline green.
  - **Audit (2026-10-10):** ✅ — every read path, both slug aliases, user list, saved, browse and both share pages are in the Part 05 matrix (60/60 re-run); one write leaked (unsave, A-11-015) and two matrix rows were added (unsave of a hidden shelf, restore); see A-11-015.
- [x] **SH-10** Share a shelf — 1d
  - Canonical Vanity Web URLs & Routing (`apps/api/src/shelves/index.ts`):
    - Added vanity slug resolution: `GET /v1/users/:username/shelves/slug/:slug` (and alias `GET /v1/shelves/by-slug/:username/:slug`) resolving public and authorized shelves by user handle and shelf slug (PRD §15.2, §29.1).
    - Enforced 3-tier privacy authorization via `assertCanView(...)`, masking forbidden or private account shelves with 404 (never 403).
    - Server-rendered semantic Open Graph landing pages at `GET /u/:username/shelves/:slug` and `GET /shelf/:id` with `og:title`, `og:description`, `twitter:card`, and mobile app links (`al:ios:url`, `al:android:url`).
  - OpenAPI & Typed Client:
    - Added `shelfSlugParamsSchema` in `apps/api/src/contract/schemas.ts`. Zero contract drift verified (`npm run spec:check`).
    - Added `client.getShelfBySlug(username, slug)` in `@flyleaf/api-client` and re-exported in `apps/mobile/src/lib/api.ts`.
  - Mobile Deep Linking & Share Card (`apps/mobile`):
    - Added deep link router screen `apps/mobile/app/u/[username]/shelves/[slug].tsx` that resolves vanity URLs and redirects to the canonical shelf view (`/shelf/${id}`) while maintaining back stack.
    - Added shelf sharing helpers `getShelfShareUrl` and `getShelfShareMessage` in `apps/mobile/src/lib/shelfValidation.ts`.
    - Created `ShareShelfModal` (`apps/mobile/src/ui/ShareShelfModal.tsx`) with visual share card preview, watermark, 4-cover mosaic preview, native OS share sheet (`Share.share`), and one-tap "Copy Link" with instant haptic confirmation.
    - Connected share button on Shelf Detail screen (`apps/mobile/app/shelf/[id].tsx`).
  - Comprehensive Test Suite:
    - 5 tests in `apps/api/src/test/shelves.test.ts` verifying slug lookups, privacy authorization, and HTML landing pages.
    - 6 unit tests in `apps/mobile/src/lib/__tests__/shelves.test.ts` verifying canonical URL generation and share messages.
    - 477 API tests passing, 83 mobile tests passing. Full 9-gate CI pipeline 100% green.
  - **Audit (2026-10-10):** ⚠️ — escaping was complete; the base URL was hard-coded, there was no canonical link and no cache policy (fixed); renames and username changes break vanity links (DECISION NEEDED); `https://flyleaf.app/u/…` does not open the app (native, after Part 14); see A-11-022, A-11-028, A-11-030.
  - **Audit (2026-10-10, Part 13):** D-11-2 built: old slugs and old usernames answer `301` to the current address (only for a shelf the viewer may see; otherwise the random 404); `PATCH /v1/me/username` added; see A-13-020.

**Phase 2 Exit Criteria Verified** (100% complete):
- [x] A ranked list with notes can be built, reordered and shared (`SH-02`, `SH-03`, `SH-05`, `SH-10`).
- [x] Shelf privacy respected on every read path (`SH-09`, `SH-08`, `SH-07`, `SH-03`).

---

## Phase 3 — Import & export · `IM` · 10d

- [x] **IM-01** imports + import_rows migrations — 0.5d
  - **Audit (2026-10-10):** ✅ — tables, checks and indexes as described; the export token was stored in the clear (0035 hashes it); see A-12-016.
  - Created migration `0014_imports.sql` and journal entry in `apps/api/drizzle/meta/_journal.json`.
  - Defined schema models in `apps/api/src/db/schema.ts`:
    - `imports`: Tracks upload jobs (`id`, `user_id`, `source`, `state`, `total_rows`, `matched`, `unmatched`, `file_key`, `filename`, `file_size_bytes`, `content_hash`, `error`, `created_at`, `updated_at`, `finished_at`).
      - Constraints: `source IN ('goodreads','storygraph','librarything','calibre','openlibrary','openreads')`, `state IN ('queued','processing','completed','failed')`, `total_rows >= 0 AND matched >= 0 AND unmatched >= 0`.
      - Indexes: `(user_id, created_at DESC)`, `(state)`, and `(user_id, content_hash)` for duplicate import detection per IM-11.
    - `import_rows`: Stores row-by-row raw parsed CSV payloads and match states (`import_id`, `row_no`, `raw jsonb`, `state`, `work_id`, `edition_id`, `confidence`, `failure_reason`, `created_at`).
      - Constraints: `PRIMARY KEY (import_id, row_no)`, `state IN ('matched','unmatched','resolved','skipped')`, and `confidence BETWEEN 0 AND 1`.
      - Indexes: `(import_id, state, row_no)` for paginated unmatched review lists, and `(work_id)`, `(edition_id)`.
      - Cascade rules: Deleting a user cascade-deletes imports and import rows; deleting an import cascade-deletes its rows; deleting a matched work/edition sets foreign key to NULL.
  - Exported TypeScript types: `Import`, `NewImport`, `ImportRow`, `NewImportRow`.
  - Comprehensive migration test suite in `apps/api/src/test/imports-migration.test.ts` (12 tests passing).
  - Clean migration applied to live PostgreSQL and verified 100% green in full CI (489 API tests passing).
- [x] **IM-02** Upload endpoint → job ID, returns immediately — 0.5d
  - **Audit (2026-10-10):** ✅ — the PV-02 path holds on disk, memory and a real MinIO (ownership 404, size/type from the object, expiry, consume + enqueue in one transaction, cleanup); UTF-16 files were refused at /complete, fixed; see A-12-004.
  - ~~Created file storage abstraction in `apps/api/src/imports/storage.ts` supporting `DiskFileStorage` (persistent local disk directory) and `MemoryFileStorage` (fast isolated test memory).~~ Replaced by the `ObjectStorage` port (PV-01).
  - ~~Configured `@fastify/multipart` in `apps/api/src/app.ts` with 10MB limit (PRD §6.8) and custom 413 `file_too_large` error envelope mapping.~~ Multipart removed (PV-02): the file goes to object storage through a presigned upload, and `POST /v1/imports` takes `{upload_id, source, force?}`. The 10 MB limit is a 413 at `POST /v1/uploads`, before any byte is sent.
  - Added background job queue `processImport: 'imports.process'` and registered worker handler in `apps/api/src/jobs/index.ts`.
  - Implemented `ImportService` and `importsPlugin` in `apps/api/src/imports/index.ts`:
    - `POST /v1/imports`: Validates source against the 6 supported platforms (`goodreads`, `storygraph`, `librarything`, `calibre`, `openlibrary`, `openreads`), enforces non-empty file, calculates SHA-256 `content_hash`, writes `queued` import record, enqueues pg-boss task, and returns `{ id, job_id, state: 'queued', source, total_rows: 0, matched: 0, unmatched: 0, ... }` immediately per PRD AC-9.
    - `GET /v1/imports/:id`: Status and progress inspection with strict 404 security isolation for cross-user requests.
    - `GET /v1/imports`: Reverse-chronological list of imports for authenticated viewer.
  - Declared OpenAPI 3.1 schemas in `apps/api/src/contract/schemas.ts` and regenerated `openapi.yaml` with 0 drift.
  - ~~Added typed client methods `uploadImport()`,~~ `uploadImport()` replaced by `uploadFile()` + `createImport()` (PV-03); `getImport()`, and `listImports()` in `packages/api-client/src/client.ts` supporting standard web `Blob | File | Uint8Array`.
  - Comprehensive automated integration test suite in `apps/api/src/test/imports.test.ts` (16 tests passing).
  - Verified 100% green across full monorepo CI (all 9 gates passing in 301s).
- [x] **IM-03** ⚠️ **Declarative column map, one config per source** — 1.5d
  - **Audit (2026-10-10):** ❌ — UTF-8 only, one stray quote garbled the rest of the file, `2023/02/30` failed the whole import, the declared source was never checked against the columns, and "date added" was read as a start date; all fixed; see A-12-004, A-12-005, A-12-006, A-12-008, A-12-019.
  - Defined normalized data contracts in `apps/api/src/imports/types.ts`:
    - `NormalizedImportRow` enforcing strict identity (`title`, `author`, `isbn`, `isbn10`, `isbn13`, `sourceId`) and reader state (`status`, `rating`, `startedAt`, `finishedAt`, `review`, `shelves`, `notes`, `readCount`, `format`, `raw`).
    - Declarative source configuration contracts (`SourceColumnConfig`, `FieldMapping`, `HeaderDetectionConfig`, `DetectionResult`).
  - Built pure TypeScript RFC 4180 ~~streaming/block~~ CSV parser (it reads the whole buffered file; audit 12) (`apps/api/src/imports/parser.ts`) supporting multiline quoted fields, escaped double quotes (`""`), UTF-8 BOM removal, and whitespace tolerance. Audit 12: also UTF-16 and Windows-1252, and an unclosed quote spoils one row (A-12-004, A-12-005).
  - Implemented modular, composable field transformers in `apps/api/src/imports/transformers.ts`:
    - `cleanText`: HTML entity decoding (`&amp;` → `&`), tag stripping, quote trimming.
    - `cleanIsbn`: Cleans Goodreads formula syntax (`="0441478123"`), strips hyphens and non-ISBN characters, verifies 10/13 checksums and length.
    - `normalizeRating`: Converts 5-star, 10-star, and quarter-star scales to half-stars (0.5..5.0); strictly maps `0` or invalid ratings to `null` per PRD AC-9 and IM-06.
    - `mapStatus`: Maps source-specific strings to canonical reading statuses (`read`, `currently_reading`, `want_to_read`, `did_not_finish`).
    - `parseDate`: Flexible date parser supporting YYYY/MM/DD, YYYY-MM-DD, M/D/YYYY, human dates (`15 Jan 2026`) preserving local calendar components to eliminate timezone drift.
    - `parseShelves`: Splits delimited shelf strings (commas, pipes, slashes) and filters reserved/system shelves.
    - `mapFormat`: Normalizes binding descriptions to canonical format (`print`, `ebook`, `audiobook`).
  - Implemented source detector (`apps/api/src/imports/detector.ts`) scoring CSV header signatures against registered configs with confidence thresholds.
  - Created full reference declarative source config for Goodreads (`apps/api/src/imports/configs/goodreads.ts`) mapping 16 fields cleanly.
  - Source config registry and normalization pipeline in `apps/api/src/imports/configs/index.ts` (`normalizeRow`, `normalizeImport`).
- [x] **IM-04** Six source maps: Goodreads, StoryGraph, LibraryThing, Calibre, OpenLibrary, OpenReads — 1.5d
  - **Audit (2026-10-10):** ❌ — checked against the exporters' own code: OpenReads imported to-read books as finished, Open Library every book as want-to-read and unrated, Calibre published the book blurb as the reader's review, Goodreads spoilers were unflagged; fixed; LibraryThing unverifiable (no public exporter; TSV unsupported); see A-12-007, A-12-008, A-12-009, A-12-011, A-12-029.
  - **Audit (2026-10-10, Part 13):** D-12-2 decided (b): a Calibre book imports as want-to-read unless a whole tag says read, reading or DNF; built; see findings/12-import-export.md › D-12-2.
  - Delivered production-grade declarative source configs for all 6 major book tracking and catalog platforms:
    - `goodreads` (`apps/api/src/imports/configs/goodreads.ts`): 16 fields, formula syntax (`="0441478123"`), unrated 0 -> NULL, exclusive shelf mapping.
    - `storygraph` (`apps/api/src/imports/configs/storygraph.ts`): Quarter-star rounding to nearest half-star (3.25 -> 3.5, 3.75 -> 4.0, PRD §6.28, §51.2), unrated 0 -> NULL, `Dates Read` range parsing, format normalization (`digital` -> `ebook`, `audio` -> `audiobook`, `print` -> `print`), `Owned?` boolean flag, and tag extraction.
    - `librarything` (`apps/api/src/imports/configs/librarything.ts`): Primary author inversion from `Last, First` -> `First Last` (`Herbert, Frank` -> `Frank Herbert`), bracketed ISBN cleansing (`[0441478123]`), collections-to-status mapping (`Currently reading` -> `reading`, `To read`/`Wishlist` -> `want`, `Your library` -> `finished`), rating normalization, review and comments preservation.
    - `calibre` (`apps/api/src/imports/configs/calibre.ts`): Multiple authors separated by `&`, identifier parsing (`isbn:9780441478125`), tag-based status fallback (`currently-reading` -> `reading`, `to-read` -> `want`, default `finished`), ebook format normalization, ~~HTML comment cleaning~~ (`comments` is the book's description and was published as the reader's review; no longer imported, A-12-009), and series in shelves.
    - `openlibrary` (`apps/api/src/imports/configs/openlibrary.ts`): Canonical OL work key extraction (stripping `/works/` or `/books/` prefix), reading log status mapping ~~(`already-read` -> `finished`, `currently-reading` -> `reading`, `want-to-read` -> `want`)~~ (the real export's `Bookshelf`, `My Ratings` and `Work ID` were never read: every book imported as want-to-read and unrated; fixed, A-12-008), 0 rating to NULL, review notes.
    - `openreads` (`apps/api/src/imports/configs/openreads.ts`): Privacy tracker mapping for native statuses ~~(`finished`, `reading`, `not_started`, `unfinished`)~~ (OpenReads writes `finished`, `in_progress`, `planned`, `abandoned`: planned books imported as finished; `my_review`, `book_format`, `readings`, `olid`, `deleted` were ignored; fixed, A-12-007), dates, notes and review separation, format mapping (`physical` -> `print`, `ebook`, `audiobook`), half-star ratings.
  - Enhanced transformer library (`apps/api/src/imports/transformers.ts`):
    - `cleanIsbn`: Bracket stripping, comma-separated candidate scanning, and `isbn:` prefix cleaning.
    - `formatAuthorName`: Reliable `Last, First` inversion while preserving single names and already standard `First Last`.
    - `parseDateRange`: StoryGraph date range parser extracting `[startedAt, finishedAt]`.
    - `mapFormat`: Added `print` and `physical` keyword detection.
  - Updated configuration registry in `apps/api/src/imports/configs/index.ts` connecting all 6 configs to `SOURCE_CONFIGS`.
  - Multi-platform header detector tests and end-to-end normalization test suites in `apps/api/src/test/import-mapping.test.ts` (37 tests passing).
- [x] **IM-05** ⚠️ Matching: ISBN → title+author fuzzy → **ambiguous goes unmatched, never guessed** — 2d
  - **Audit (2026-10-10):** ❌ — the ISBN stage guessed between works, a merged work's key missed, `_`/`%` were wildcards, and the title stages scanned the whole catalog per row (68× slower on 300k works); fixed; see A-12-002, A-12-003, A-12-014.
  - Delivered multi-stage catalog matching engine in `apps/api/src/imports/matcher.ts`:
    - **Stage 1 (Exact ISBN)**: Detects ISBN-10/13 formats, joins `editions` and `works`, and matches physical copies with confidence 1.0. ~~Ambiguity applies to every stage~~: the ISBN stage picked the more popular of two works; now ambiguous (A-12-002).
    - **Stage 2 (Source ID)**: Resolves Open Library work keys (`OL...W`) and edition keys (`OL...M`) with confidence 0.98.
    - **Stage 3 (Exact Title + Author)**: Compares unaccented normalized titles (`normaliseTitle`) and author names with confidence 0.92; immediately identifies homonymous works and flags them as `ambiguous_match`.
    - **Stage 4 (Fuzzy Title + Author)**: Trigram similarity ranking (`similarity(title) * 0.6 + similarity(author) * 0.4`) with minimum threshold (>= 0.70).
    - **CRITICAL PRD AC-9 RULE (Ambiguous Matches NEVER Guessed)**: If multiple works share the same title/author, or if the confidence margin between candidate #1 and candidate #2 is < 0.15, the row is marked `state = 'unmatched'`, `work_id = null`, and `failure_reason = 'ambiguous_match'` for user review in IM-09.
  - Implemented `persistImportRowMatches`: Inserts rows into `import_rows` preserving untouched `raw` row dictionaries, and updates parent `imports` summary counters (`total_rows`, `matched`, `unmatched`).
  - Created dedicated integration test suite in `apps/api/src/test/import-matcher.test.ts` (12 tests passing) verifying ISBN matches, OL key resolution, exact matches, fuzzy matches, ambiguity rejection, and DB persistence.
  - 100% green across all 9 gates in full monorepo CI (554 API tests across 25 suites, 83 mobile tests across 20 suites).
- [x] **IM-06** ⚠️ Rating normalisation; **`My Rating = 0` → NULL** — 0.5d
  - **Audit (2026-10-10):** ✅ — 0 → NULL on every path, quarter stars to half stars; no source uses the 10-point scale (Calibre writes 0–5).
  - Delivered rating persistence normalisation engine in `apps/api/src/imports/committer.ts` (`normalizeRatingForPersistence`):
    - Strictly maps Goodreads `My Rating = 0`, `'0'`, `0.0`, empty strings, null, and undefined to `NULL` (PRD §1833, §4409, AC-9).
    - Prevents Postgres check constraint violations (`reads_rating_ck`: `rating IS NULL OR (rating BETWEEN 0.5 AND 5.0 AND (rating * 2) = floor(rating * 2))`). Writing `0` directly aborts transactions; `NULL` preserves unrated books safely without dropping rows.
    - Validates 0.5–5.0 half-step precision; rounds quarter-star ratings from StoryGraph (e.g. 3.25 -> 3.5, 3.75 -> 4.0) to nearest half-star.
  - Integration tested against real PGlite database: demonstrates that `0` violates check constraint, while `NULL` saves unrated books with complete fidelity.
- [x] **IM-07** ⚠️ `source='import'`, **excluded from `activity`** — 0.25d
  - **Audit (2026-10-10):** ⚠️ — no activity rows (verified), but every re-import added a second attempt of every book and import shelves filled deleted shelves past the caps; fixed (imports merge, D-12-1); see A-12-001, A-12-010.
  - Enforced schema-level provenance: all reads created from imports write `source = 'import'` (satisfying check constraint `reads_source_ck: source IN ('app', 'import')`).
  - Feed and activity exclusion rules (PRD §34.4, §4410, Architecture §8, §9, Phases §3):
    - Exported helpers `isExcludedFromActivity` and `isEligibleForActivityFeed`.
    - SQL query filter `feedExcludesImportsSql()` (`reads.source != 'import'`) ensuring imported reads never spam social activity streams or follower feeds.
    - Verified zero telemetry `events` or individual read events emitted during bulk imports of libraries.
  - Full transactional committer: `commitImportRow` and `commitImportBatch` persisting `reads`, linked `reviews` (up to 10,000 chars), custom `shelves`, and `shelf_items` with atomic counter updates, ~~handling re-read attempt numbers (`attempt_no`)~~ (a re-import added attempt + 1 of every book; a book already in the library is now left as it is, A-12-001 / D-12-1).
  - 14 dedicated integration tests in `apps/api/src/test/import-committer.test.ts` (100% passing).
  - 100% green across all 9 gates in full monorepo CI (568 API tests across 26 suites, 83 mobile tests across 20 suites).
- [x] **IM-08** pg-boss job: chunked, resumable, progress-reported — 1d
  - **Audit (2026-10-10):** ⚠️ — resumable and atomic per chunk, total_rows set first; one refused row failed the import (now contained per row) and ~5.6 statements per row (now ~2.1); see A-12-006, A-12-014.
  - Delivered production background import processor in `apps/api/src/imports/processor.ts` (`processImport`):
    - **Chunked processing**: Configurable chunk size (`chunkSize = 50`) for memory efficiency and short transaction holds during 5,000+ row imports (PRD §34.4, §4404).
    - **Resumability (PRD §34.4, §4408)**: Checks existing `import_rows` for the import ID, skips already committed rows, and resumes from the exact point of interruption without duplicate reads or rows.
    - **Progress reporting**: Atomically updates `imports` (`total_rows`, `matched`, `unmatched`, `state = 'processing'`, `updated_at = now()`) after each chunk commits, enabling live progress tracking in the client.
    - **Data integrity**: Strictly enforces PRD AC-9 rules (ambiguous matches marked `unmatched` with `failure_reason = 'ambiguous_match'` and `work_id = null`; `My Rating = 0` normalized to `NULL`; `source = 'import'` excluded from social feeds).
    - **Error resilience**: Missing or corrupted payloads transition `imports.state = 'failed'` with descriptive error and re-throw for pg-boss tracking.
  - Connected `processImportJobHandler` in `apps/api/src/jobs/index.ts` with structured logging of `importId`, `matched`, `unmatched`, and `totalRows`.
  - Exported processor from `apps/api/src/imports/index.ts`.
  - 4 comprehensive integration tests in `apps/api/src/test/import-processor.test.ts` (100% passing).
  - 100% green across all 9 gates in full monorepo CI (572 API tests across 27 suites, 83 mobile tests across 20 suites).
- [x] **IM-09** Import screen + progress banner + unmatched review list — 1.5d
  - **Audit (2026-10-10):** ❌ — re-resolve added a second read, skip after match broke the counters, an unknown work was 422, a merged work stored the loser, the banner looped requests after completion; fixed; the banner is not on Home (Part 14); see A-12-012, A-12-022, A-12-023.
  - Delivered end-to-end import UI, real-time progress banner, and unmatched review queue across API, client SDK, and mobile app:
    - **Import Screen (`apps/mobile/app/import/index.tsx`)**:
      - 6 source platform selector with custom icons and formats (Goodreads, StoryGraph, LibraryThing, Calibre, OpenLibrary, OpenReads).
      - Dual input: direct CSV paste & web/native file picker with validation and error reporting.
      - Integrated with Profile screen (`apps/mobile/app/(tabs)/profile.tsx`) under "DATA & IMPORTS".
      - Import history listing previous jobs with status badges and quick review links.
    - **Live Progress Banner (`apps/mobile/src/ui/ImportProgressBanner.tsx`)**:
      - Real-time polling (`GET /v1/imports/:id`) every 2 seconds while queued or processing.
      - Animated progress bar indicating percent completed (`(matched + unmatched) / totalRows`).
      - Live counters breakdown (`matched`, `unmatched`, `total`).
      - 1-tap "Review N unmatched" button navigating directly to the review queue.
    - **Unmatched Review Queue (`apps/mobile/app/import/unmatched.tsx`)**:
      - Inspect raw unparsed row details (Title, Author, Rating, Shelves, Failure reason).
      - Real-time catalog search (`GET /v1/search`) pre-filled with raw book title to pick matching works.
      - 1-tap "Match & Resolve": calls `POST /v1/imports/:id/rows/:rowNo/resolve`, commits read with `source = 'import'` and normalized rating (IM-06, IM-07), updates counters atomically, and removes item from queue.
      - 1-tap "Skip Book": calls `POST /v1/imports/:id/rows/:rowNo/skip` to bypass without creating reads.
    - **API Endpoints & Contracts**:
      - `GET /v1/imports/:id/rows`: Paginated inspection filtered by `state` (e.g. `state=unmatched`).
      - `POST /v1/imports/:id/rows/:rowNo/resolve`: Resolves row, commits read, updates counters.
      - `POST /v1/imports/:id/rows/:rowNo/skip`: Skips row, updates counters.
      - 0 contract drift verified against OpenAPI 3.1.0 (`spec:check` green).
      - 9 dedicated integration tests in `apps/api/src/test/import-review.test.ts` (100% passing).
  - 100% green across all 9 gates in full monorepo CI (581 API tests across 28 suites, 83 mobile tests across 20 suites).
- [x] **IM-10** CSV/JSON export, emailed link — 1d
  - **Audit (2026-10-10):** ❌ — CSV formula injection, §26.4 data missing and deleted content exported, one query per shelf, plaintext token, enqueue outside the transaction; fixed; see A-12-015 … A-12-018, A-12-020.
  - Delivered complete export engine, emailed download links, and verified round-trip library portability across database, API, background jobs, client SDK, and mobile UI:
    - **Database Schema & Migration**: Added `exports` table in `apps/api/src/db/schema.ts` and migration `apps/api/drizzle/0015_exports.sql` with format constraints (`format IN ('csv', 'json')`), state tracking (`queued`, `processing`, `completed`, `failed`), secure random download tokens (`download_token`), and 48-hour expiration timestamps (`expires_at`). Added entry in `_journal.json`.
    - **Export Generator (`apps/api/src/exports/generator.ts`)**:
      - Gathers complete reader library: user profile, reads, ratings, reading dates, custom shelves, shelf items, and reviews (PRD §1290, §3608, §5320).
      - **RFC 4180 CSV**: Standard headers (`Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf,Date Read,Date Added,Bookshelves,My Review,Format`) with double quotes escaped as `""`, commas/newlines quoted, and unrated books output as empty strings `""` (never 0, matching IM-06).
      - **Structured JSON**: Pretty-printed versioned export format (`version: '1.0'`) preserving full metadata, user summary, reads, and custom shelf hierarchies.
    - **Export Service & API (`apps/api/src/exports/index.ts`)**:
      - `POST /v1/exports`: Enqueues export job, generates 48-hour download token, and dispatches pg-boss job (`exports.process`).
      - `GET /v1/exports`: Lists user's export history with timestamps, formats, states, and file sizes.
      - `GET /v1/exports/:id`: Inspects individual export status.
      - `GET /v1/exports/:id/download`: ~~Secure dual-access file streaming~~ Authorizes the same two ways, then 302s to a 5-minute storage URL; the API no longer streams the file (PV-02). (either Bearer token authentication or ~~single-use~~ emailed token `?token=...` without auth; the token is valid any number of times for 48 h, stored only as a hash since audit 12, A-12-016; the app uses `GET /v1/exports/:id/link`).
      - Emailed notification dispatched via `mailer.send()` with 48h valid secure download link upon completion (PRD §1290, §3424).
    - **Client SDK & Mobile UI**:
      - Typed client methods `requestExport()`, `getExport()`, `listExports()` in `@flyleaf/api-client` and `apps/mobile/src/lib/api.ts`.
      - Export Library Data UI in `apps/mobile/app/import/index.tsx` with format picker (CSV/JSON), 1-tap request action with feedback, and export history list with direct download links.
    - ~~**Verified 100% Round-Trip Fidelity (Phases §217)**~~ (start dates and spoiler flags were lost; restored with `Date Started` and `Spoiler` columns, audit 12):
      - Exported Alice's library to CSV (including Dune with 5.0 rating, review, and Favorites shelf, plus Neuromancer as unrated want-to-read).
      - Imported CSV into a clean Bob account: 100% matched, ratings preserved, review intact, custom shelves and statuses restored with zero data loss.
    - **Test Coverage & CI**:
      - 8 dedicated integration tests in `apps/api/src/test/export.test.ts` (100% passing).
      - 100% green across all 9 gates in full monorepo CI (589 API tests across 29 suites, 83 mobile tests across 20 suites).
- [x] **IM-11** Duplicate-import detection by content hash — 0.5d
  - **Audit (2026-10-10):** ✅ — per user, force reuses the upload, failed imports do not block; what a forced import then did is A-12-001.
  - Delivered SHA-256 duplicate-import detection across API, database index, client SDK, and mobile app:
    - **Content Hash & Scoping (PRD §34.4, §5141, IM-11)**:
      - Computes SHA-256 `content_hash` from uploaded file buffers.
      - Uses indexed lookup on `(user_id, content_hash)` (`imports_user_hash_idx`).
      - Strictly scoped per user: different users uploading identical sample/export files never conflict.
      - Failed imports (`state = 'failed'`) do not block re-uploads.
    - **Duplicate Conflict & Force Override**:
      - If an identical file was previously imported, rejects with `409 Conflict` (`ApiError.conflict('duplicate_import', ...)`).
      - Allows intentional re-imports via `force=true` ~~(querystring `?force=true` or multipart form field `force: 'true'`)~~ (`force: true` in the JSON body, PV-02; the refused upload is reused, nothing is re-sent).
    - **Contract & OpenAPI 3.1.0**:
      - ~~Added `force` query parameter to `uploadImportQuerySchema` in `apps/api/src/contract/schemas.ts`.~~ Now `force` in `createImportBodySchema` (PV-02).
      - Added `409: errorResponseSchema` to `POST /v1/imports` route contract.
      - Verified 0 OpenAPI contract drift via `npm run spec:check`.
    - **Client SDK & Mobile UI**:
      - ~~Added `UploadImportOptions` with `force?: boolean`~~ Now `CreateImportRequest.force` (PV-03); to `@flyleaf/api-client` and `apps/mobile/src/lib/api.ts`.
      - Mobile import screen (`apps/mobile/app/import/index.tsx`) catches `duplicate_import` error and presents confirmation dialog ("Duplicate File: An identical file has already been imported. Would you like to import it anyway?") with "Import Anyway" (`force: true`) or "Cancel".
    - **Integration Tests & CI**:
      - 7 dedicated integration tests in `apps/api/src/test/import-duplicate.test.ts` (100% passing).
      - 100% green across all 9 gates in full monorepo CI (596 API tests across 30 suites, 83 mobile tests across 20 suites).
- [x] **IM-12** Import your own real library; fix what breaks — 1d
  - **Audit (2026-10-10):** ⚠️ — the "real" libraries are hand-made fixtures against a hand-seeded catalog, not a real export; the round trip lost start dates and spoiler flags (fixed); importing a real export is an owner action; see A-12-030.
    - **Realistic Library Fixtures**:
      - Created `apps/api/src/test/fixtures/real-library-goodreads.csv` (25-book realistic export covering classics, modern sci-fi/fantasy, `="0140328726"` ISBN escaping, `My Rating = 0` unrated books, 1-5 ratings, multiline reviews, dates read, custom shelves, and homonymous/obscure entries).
      - Created `apps/api/src/test/fixtures/real-library-storygraph.csv` (5-book realistic export covering quarter-star ratings `4.75`, `4.25`, `3.75`, date ranges, and formats).
    - **Integration Test Suite & Phase 3 Exit Criteria Verification** (`apps/api/src/test/import-real-library.test.ts`):
      - **Phase 3 Exit Criterion 1**: ~~Real~~ Hand-made (audit 12, A-12-030: 25 rows against a hand-seeded catalog, not a real export) Goodreads export imports with >=85% matched rows (23/25 = 92.0% match rate achieved). All imported reads created with `source = 'import'`, `My Rating = 0` converted strictly to `rating = NULL`, multiline reviews and custom shelves preserved.
      - **Phase 3 Exit Criterion 2**: Unmatched rows reviewed via `GET /v1/imports/:id/rows?state=unmatched`. Ambiguous matches (`failure_reason = 'ambiguous_match'`) and unknown books (`failure_reason = 'no_confident_match'`) correctly identified per PRD AC-9 without guessing. Ambiguous row resolved via `POST /v1/imports/:id/rows/:rowNo/resolve` with `{ work_id, edition_id }`, updating state to `resolved`, committing read to library with `source = 'import'`, and updating counters. Skipped row verified via `POST /v1/imports/:id/rows/:rowNo/skip`.
      - **Phase 3 Exit Criterion 3**: Export round-trips: Alice's imported library exported to CSV via `POST /v1/exports`, re-imported into fresh user Bob, and verified with 100% fidelity across reads, ratings (including NULL ratings), reviews, custom shelves, and reading dates.
      - **StoryGraph Verification**: 5-book StoryGraph export imported with quarter-star ratings rounded to half-stars per `reads_rating_ck` (`4.75` → `5.0`, `4.25` → `4.5`, `3.75` → `4.0`), date ranges parsed to `started_at` / `finished_at`, and formats mapped.
    - **CI State**: All 601 API tests passing across 31 suites, 83 mobile tests passing across 20 suites, 0 OpenAPI contract drift, and 100% green across all 9 gates in monorepo CI.

**Exit:** your real export imports ≥85% matched · unmatched resolvable · export round-trips. ~~[VERIFIED & COMPLETE]~~ Not verified on a real export (audit 12): owner to import their own export on the laptop.

---

## Phase 4 — Social · `SO` · 20d

- [x] **SO-01** follows, blocks, mutes migrations + counters — 0.5d
  - Created migration `0016_social_graph.sql` and journal entry in `apps/api/drizzle/meta/_journal.json`. ~~(follows)~~ `follows` was created in **0011** (audit 13); 0016 added `blocks`, `mutes` and the counters.
  - Defined social graph schema in `apps/api/src/db/schema.ts`:
    - ~~`follows`: Tracks asymmetric user follow relationships (`follower_id`, `following_id`, `state IN ('pending', 'accepted')`, `created_at`, `updated_at`). Enforces `follower_id <> following_id` check constraint and composite primary key `(follower_id, following_id)`.~~ Actual (audit 13, A-13-003): `follows(follower_id, followee_id, state IN ('pending','accepted'), created_at)`, no `updated_at`, PK `(follower_id, followee_id)`, `follower_id <> followee_id`.
    - `blocks`: Tracks bidirectional user blocks (`blocker_id`, `blocked_id`, `created_at`). Enforces `blocker_id <> blocked_id` check constraint and composite primary key `(blocker_id, blocked_id)`.
    - ~~`mutes`: Tracks muted users and books (`muter_id`, `muted_id`, `target_work_id`, `created_at`). Enforces target type check constraints (`(muted_id IS NOT NULL AND target_work_id IS NULL) OR (muted_id IS NULL AND target_work_id IS NOT NULL)`).~~ Actual (audit 13, A-13-003): `mutes(user_id, target_type IN ('user','work'), target_id, created_at)`, PK `(user_id, target_type, target_id)`, no FK on `target_id`.
  - Postgres DB trigger function `follows_counter_trigger_fn` in migration `0016_social_graph.sql` dynamically maintains ~~atomic~~ `follower_count` and `following_count` on `profiles` when follow records are inserted, updated, or deleted into/from `state = 'accepted'`. Not atomic under concurrency: it recounted per row and lost concurrent updates (50 follows → 2) and deadlocked mutual follows; now incremental with ordered locks (0036, audit 13, A-13-001).
  - Exported Drizzle models and TypeScript types (`Follow`, `NewFollow`, `Block`, `NewBlock`, `Mute`, `NewMute`).
  - **Audit (2026-10-10):** ⚠️ — documented schema did not exist (corrected above); counters lost concurrent updates and deadlocked mutual follows, the reconcile rewrote every profile and reported nothing; fixed in 0036; see A-13-001, A-13-002, A-13-003.
- [x] **SO-02** Follow/unfollow; private accounts; pending requests — 1.5d
  - Built `SocialService` and Fastify `socialPlugin` in `apps/api/src/social/index.ts` with follow/unfollow and pending request endpoints (`POST /v1/users/:id/follow`, `DELETE /v1/users/:id/follow`, `GET /v1/me/follow-requests`, `POST /v1/me/follow-requests/:requesterId/accept`, `POST /v1/me/follow-requests/:requesterId/reject`).
  - Private accounts create `state = 'pending'` follows; public accounts create `state = 'accepted'`. Automatic profile follower and following counts maintained via Postgres DB triggers.
  - Enforced 3-tier privacy authorization in `IdentityService.getProfile` ~~returning 404 Not Found for non-followers viewing private profiles~~ — signed-in non-followers now get the header only (`isRestricted`), guests 404 (AC-13, §16.3; Audit 05, A-05-006, D-05-2) (PRD §25.3, FN-72, SH-09). Switching profile from private to public automatically accepts pending follow requests (verified, counters included; no `followed` cards are written for accepted requests, D-13-1).
  - OpenAPI 3.1.0 specification synchronized with 0 contract drift and typed methods in `@flyleaf/api-client`.
  - Mobile UI integration: interactive follow toggle with haptics and "Follows you" mutual indicator on `UserProfileScreen` (`apps/mobile/app/user/[id].tsx`), and incoming requests manager screen `FollowRequestsScreen` (`apps/mobile/app/profile/requests.tsx`).
  - 8 integration tests in `apps/api/src/test/social-follow.test.ts` and mobile unit tests in `apps/mobile/src/lib/__tests__/social-follow.test.ts` passing. 100% green CI pipeline.
  - **Audit (2026-10-10):** ⚠️ — every state transition verified; but unfollow/mute of a user who blocked you answered 200 (block confirmable, P0), a follow racing a block survived it, deleted accounts could be accepted and were listed, no §11.7 limits (→ Part 15); fixed except limits; see A-13-005, A-13-006, A-13-007, A-13-008, A-13-011, D-13-1, D-13-2.
  - **Audit 15a (2026-10-10):** ✅ PRD §11.7 limits enforced in the follow's transaction: 50/hour, 200/day, 3 per pair per day (a re-request after a reject counts), 20 in a new account's first 24 h; a replay is not counted (A-13-007, -008 → A-15-002). The 15 legacy alias routes are removed (A-15-012).
- [x] **SO-03** ⚠️ **Block: bidirectional, complete, silent, severs follows** — 1.5d
  - Built block/unblock service methods and Fastify routes in `apps/api/src/social/index.ts` (`POST /v1/users/:id/block`, `DELETE /v1/users/:id/block`, `GET /v1/me/blocks`, plus `/v1/blocks/:userId` and `/v1/blocks` aliases).
  - Enforced complete, bidirectional, silent block semantics (PRD §11.4, §26.3): blocking immediately severs existing follows in BOTH directions, with Postgres DB triggers (`follows_counter_trigger_fn`) updating `follower_count` and `following_count` automatically.
  - Complete obscure privacy masking: profile lookups, follow attempts, and reading stats targeting a blocked account return **404 Not Found** (never 403 Forbidden), rendering blocked accounts ~~completely~~ indistinguishable from non-existent accounts on reads; ~~completely~~ not on writes: unfollow, mute and block of a user who blocked you answered 200 until audit 13 (A-13-005).
  - Excluded reviews written by blocked users from `listWorkReviews` in `apps/api/src/reviews/index.ts`.
  - Self-block prevention: returns HTTP 400 Bad Request (`cannot_block_self`).
  - OpenAPI 3.1.0 contract synchronized with 0 drift and typed methods in `@flyleaf/api-client`.
  - Mobile UI integration: added "Block" action with confirmation dialog to `UserProfileScreen` (`apps/mobile/app/user/[id].tsx`), created `BlockedUsersScreen` (`apps/mobile/app/profile/blocked.tsx`) with 1-tap unblock action, and added "Blocked Accounts" entry in Profile settings (`apps/mobile/app/(tabs)/profile.tsx`).
  - Integration test suite `apps/api/src/test/social-block.test.ts` (6/6 tests passing) verifying self-block rejection, bidirectional follow severing, counter updates, 404 obscure masking, unblock behavior, and blocked list retrieval.
  - **Audit (2026-10-10):** ⚠️ — severs follows and pending requests both ways (verified); but the pair's `followed` cards survived, blocking someone who blocked you answered 200, 19–33 % of follows racing a block survived it, and a blocked profile's 404 ran one statement more than a random id's; all fixed; see A-13-004, A-13-005, A-13-006, A-13-012.
- [x] **SO-04** Mute user and **mute book** — 0.5d
  - Built mute/unmute service methods for users and books in `apps/api/src/social/index.ts` (`POST /v1/users/:id/mute`, `DELETE /v1/users/:id/mute`, `POST /v1/works/:id/mute`, `DELETE /v1/works/:id/mute`, `GET /v1/me/mutes`, plus `/v1/mutes/users/:userId`, `/v1/mutes/works/:workId`, `/v1/mutes` aliases).
  - Silent, low-stakes muting semantics (PRD §11.5, §5289, §5290): muting a user hides their activity from feeds without unfollowing; muting a book removes the book from activity feeds and recommendations ("hyped release" filter).
  - Self-mute prevention: returns HTTP 400 Bad Request (`cannot_mute_self`).
  - OpenAPI 3.1.0 contract synchronized with 0 drift and typed methods in `@flyleaf/api-client`.
  - Mobile UI integration: added "Mute" action to `UserProfileScreen` (`apps/mobile/app/user/[id].tsx`), added "Mute book" action to `WorkScreen` (`apps/mobile/app/work/[id].tsx`), created `MutedItemsScreen` (`apps/mobile/app/profile/muted.tsx`) with segmented tabs for Users and Books with 1-tap unmute actions, and added "Muted Content" entry in Profile settings (`apps/mobile/app/(tabs)/profile.tsx`).
  - **Audit (2026-10-10):** ✅ — idempotent, silent (byte-identical view for the muted user), random targets 404 with no row, merged works resolve; the unmute tests could not fail and a deleted account was mutable and listed (fixed); see A-13-005, A-13-011, A-13-014, A-13-015.
- [x] **SO-05** Followers/following lists — 0.5d
  - Built follower and following list service methods and Fastify routes in `apps/api/src/social/index.ts` (`GET /v1/users/:id/followers`, `GET /v1/users/:id/following`, plus `/v1/followers/:userId` and `/v1/following/:userId` aliases) supporting limit/offset pagination and total counts (~~paginated~~ sliced in memory after loading every follower until audit 13, A-13-010).
  - Strict privacy enforcement (PRD §11.1, §25.3, §26.1): non-followers and guests viewing a private profile's follower/following list receive **404 Not Found** (`not_found`), never 403 Forbidden.
  - Complete block protection: requesting follower/following lists of a blocked account returns 404 Not Found. Any third-party blocked users relative to the caller are silently excluded from returned lists.
  - Rich relationship indicators: each list entry populates `followedByViewer` and `followsViewer` for the caller.
  - OpenAPI 3.1.0 contract synchronized with 0 drift and typed methods `getFollowers` and `getFollowing` exposed in `@flyleaf/api-client` and `apps/mobile/src/lib/api.ts`.
  - Mobile UI integration: created `FollowersScreen` (`apps/mobile/app/user/[id]/followers.tsx`) and `FollowingScreen` (`apps/mobile/app/user/[id]/following.tsx`) with 1-tap follow toggles, user avatars, private indicators, and pressable follower/following count headers on profile screens.
  - Integration test suite `apps/api/src/test/social-lists.test.ts` (5/5 tests passing) verifying public listing, 404 private account protection, 404 block masking, third-party block filtering, and mutual follow indicators.
  - **Audit (2026-10-10):** ⚠️ — privacy and indicators correct; every page loaded and sorted all followers in memory (10,090 buffers for 2,010 followers), ties were unordered, deleted accounts listed, and the app showed only the first 50; fixed (SQL paging on new indexes, 2.3–2.8× faster, 'Show more'); see A-13-010, A-13-011, A-13-013.
- [x] **SO-06** ⚠️ **Block/private tests: blocked view ≡ non-existent account** — 0.5d
  - Authored comprehensive integration test suite `apps/api/src/test/social-block-equivalence.test.ts` (8/8 tests passing) verifying complete structural and semantic equivalence between a blocked user's view and a non-existent account (`404 Not Found`, `{ error: { code: 'not_found', message: '...' } }`).
  - Exhaustively verified 8 key endpoints/surfaces under block conditions:
    1. `GET /v1/users/:id` — blocked profile lookup is structurally identical to non-existent UUID.
    2. `GET /v1/users/:id` (bidirectional) — blocker requesting blocked user profile receives identical 404.
    3. `POST /v1/users/:id/follow` — follow attempt to blocked user is structurally identical to non-existent user.
    4. `GET /v1/reads/:id` — blocked user requesting blocker's public read receives identical 404.
    5. `GET /v1/users/:id/stats` — blocked user requesting blocker's reading stats receives identical 404.
    6. `GET /v1/shelves/:id` — blocked user requesting blocker's public shelf receives identical 404.
    7. `GET /v1/users/:id/followers` — blocked user requesting blocker's followers list receives identical 404.
    8. `GET /v1/works/:id/reviews` — reviews written by blocker are silently omitted when requested by blocked user.
  - OpenAPI contract check (`npm run spec:check`) verified with 0 drift.
  - 100% green CI pipeline (`node scripts/ci.mjs`) passing all 9 build & test steps in 146s.
  - **Audit (2026-10-10):** ⚠️ — the 8 read surfaces are identical (verified); writes were not covered and leaked the block (A-13-005), and the blocked profile's 404 was measurably slower (A-13-012); both fixed and tested; see A-13-005, A-13-012.

  ### Feed — `SO-1x` · 6d
- [x] **SO-10** activity table + write-on-action, respecting visibility — 1d
  - Defined `activity` Drizzle table in `apps/api/src/db/schema.ts` and migration `apps/api/drizzle/0017_activity.sql` with covering index `(actor_id, created_at desc)` (Architecture §3.5, PRD §23.3) and CHECK constraints on verbs (`started`, `finished`, `rated`, `reviewed`, `dnf`, `shelved`, `followed`, `goal_reached`, `quoted`) and visibility (`public`, `followers`, `private`).
  - Built `ActivityService` in `apps/api/src/activity/index.ts` with atomic write-on-action logging (`recordActivity`), visibility updates (`updateActivityVisibility`), entity deletion cascading (`deleteActivity`), and retroactive privacy updates (`setAccountPrivacy`).
  - Strict import feed exclusion (IM-07, PRD §4410): reads and reviews with `source = 'import'` generate NO activity rows.
  - Strict privacy enforcement (PRD §16.3, §26.1, §26.2): per-item private reads, reviews, and shelves generate NO activity rows; private account activities default to `followers` visibility; switching account to private retroactively restricts public activity to `followers`. (Audit 14: switching back to public left it all followers-only; it now returns to each item's own visibility, A-14-007.)
  - Integrated write-on-action into `ReadingService` (`started`, `finished`, `dnf`), `ReviewService` (`reviewed`), `ShelvesService` (`shelved`), `SocialService` (`followed`), and `IdentityService` (retroactive privacy adjustment).
  - Integration test suite `apps/api/src/test/activity.test.ts` (10/10 tests passing) verifying write-on-action for all verbs, import exclusion, item privacy, private profile restriction, retroactive privacy toggling, and review/follow activity cleanup.
  - **Audit (2026-10-10):** ⚠️ — writers, import exclusion and lifecycle hold; but there was no 180-day prune, going public left every card followers-only, and `rated`/`goal_reached`/`quoted` have no writer; prune and restore fixed, a single accepted request now writes a card (D-13-1); see A-14-006, A-14-007, A-14-016, A-14-019.
- [x] **SO-11** ⚠️ **Feed query**: cursor-paginated, blocks/mutes excluded — 1.5d
  - Created Fastify route schemas `feedQuerySchema`, `feedResponseSchema`, `feedActivityActorSchema`, `feedActivityWorkSchema`, and `feedActivityItemSchema` in `apps/api/src/contract/schemas.ts`.
  - Implemented cursor-paginated `getFriendsFeed` (Fan-out on read for followed accounts with `state = 'accepted'`, PRD §12.7, Architecture §8) and `getPopularFeed` (platform-wide public activities) in `ActivityService` (`apps/api/src/activity/index.ts`).
  - Strict exclusion filtering: SQL queries enforce bidirectional block exclusion (`blocks` table for blocker/blocked) and user & work mute exclusion (`mutes` table for muted users and muted book works).
  - Fastify route plugin `activityPlugin` registered on `/feed` and `/v1/feed` with `tab=friends` (default, requires auth viewer) and `tab=popular` (supports optional auth / guest viewers).
  - Synchronized OpenAPI 3.1.0 specifications (`openapi.yaml`) with 0 contract drift (`npm run spec:check`).
  - Comprehensive integration test suite `apps/api/src/test/feed-query.test.ts` (7/7 tests passing) asserting reverse-chronological order, ~~ISO timestamp cursor pagination~~ (the cursor lost and repeated cards once ranking reordered a page; now an opaque `(created_at µs, id, deferred ids)` cursor, A-14-001), bidirectional block filtering, user mute filtering, work mute filtering, popular feed querying, and 401 guest rejection for friends feed.
  - **Audit (2026-10-10):** ❌ — pagination lost and repeated cards and a bad cursor served page one (fixed: exactly once, 400 `invalid_cursor`); "followed" cards showed people in a block with the viewer (P0, fixed); the friends query seq-scanned `activity` and sorted to disk for a heavy follower (fixed: p95 494 → 161 ms, sandbox); Popular has no popularity signal (D-14-1); see A-14-001, A-14-004, A-14-008, A-14-009.
  - **Audit 15a (2026-10-10):** ✅ cursor paging re-checked on a real Postgres with rows a microsecond apart: friends, popular, comments and a user's reads each serve every row once (A-14-020 → A-15-014).
- [x] **SO-12** Ranking + diversity constraints in TypeScript — 1.5d
  - Created feed ranking & diversity engine in `apps/api/src/activity/ranking.ts` implementing PRD §12.2–12.4 and Architecture §8 specifications.
  - Scoring formula: `rank = activity_weight * recency_decay(age_hours) * affinity(viewer, actor) * diversity_penalty`.
  - Exact PRD activity weights (`getActivityWeight`): `reviewed` (1.0), `finished` with rating (0.9), `finished` without rating (0.7), `rated` (0.8), `dnf` (0.5), `shelved` (0.3), `started` (0.2), `goal_reached` (0.6), `followed` (0.1), `quoted` (0.4).
  - Recency decay: `exp(-age_hours / 36.0)` with a 36-hour parameter for low-volume feeds.
  - Four hard diversity rules enforced via `violatesHardConstraints` & `rankAndDiversifyFeed`:
    1. Max 2 consecutive cards from the same person (AC-11).
    2. Max 3 cards about the same book (`work_id`) per 20-item page window (AC-11).
    3. Max 1 "started" card per 10-item block (PRD §12.4), with fallback to prevent starving thin feeds.
    4. Min 1 low-affinity / rarely engaged actor card per 10-item block (if present in candidate set). ~~Integrated~~ **Audit 14:** no affinity was ever passed in, so this rule never ran and ranking was weight × decay; affinity now comes from likes, comments and mutual follows (A-14-002).
  - Integrated `rankAndDiversifyFeed` into `ActivityService.getFriendsFeed` and `getPopularFeed` (`apps/api/src/activity/index.ts`).
  - Dedicated unit & integration test suite `apps/api/src/test/feed-ranking.test.ts` (9/9 tests passing) verifying activity weights, 36h decay math, rank score composition, consecutive actor interleaving, book frequency capping, "started" card rules, and high-weight activity prioritization. All 16 feed tests green.
  - **Audit (2026-10-10):** ⚠️ — weights, decay and rules 1, 2 and 4 hold (mutation-checked); affinity was never supplied (fixed); cards that break a rule now wait for the next page instead of being dropped; see A-14-001, A-14-002, A-14-018.
- [x] **SO-13** Aggregation: shelf adds, follows — 0.5d
  - Created `aggregateFeedItems` engine in `apps/api/src/activity/ranking.ts` implementing PRD §12.2 and AC-11 specifications.
  - Automatically collapses repetitive low-weight activity items by the same actor into single aggregated summary cards prior to re-ranking & diversity evaluation:
    1. **Shelf Additions**: Multiple `shelved` activities for the same shelf/actor collapse into 1 card ("user A added N books to Shelf Name", `metadata: { is_aggregated: true, count: N, shelf_name, works: [...] }`).
    2. **Follows**: Multiple `followed` activities by the same actor collapse into 1 card ("user A followed N readers", `metadata: { is_aggregated: true, count: N, targets: [...] }`).
    3. **Started Books**: Multiple `started` activities on the same day by the same actor collapse into 1 card (`metadata: { is_aggregated: true, count: N, works: [...] }`).
  - High-value activities (`reviewed`, `finished`, `dnf`, `goal_reached`, `quoted`) are explicitly excluded from aggregation and always render as individual primary feed cards per PRD §12.2.
  - Boosted activity weight (`getActivityWeight`) for aggregated items scaling with item count (`baseWeight + 0.05 * min(count - 1, 4)`).
  - Integrated into feed execution pipeline (`rankAndDiversifyFeed` in `apps/api/src/activity/ranking.ts`).
  - Dedicated unit tests in `apps/api/src/test/feed-ranking.test.ts` (13/13 tests passing) verifying shelf add aggregation, follow aggregation, same-day start aggregation, and high-value non-aggregation rules. All 20 feed tests green.
  - **Audit (2026-10-10):** ⚠️ — groups correctly; aggregated shelf cards lost the shelf name (`shelfName` vs `shelf_name`), aggregates carried no member ids, follow aggregates named every target "reader"; all fixed; "day" is a UTC day (no profile time zone); see A-14-004, A-14-005, A-14-021.
- [x] **SO-14** ⚠️ **Cold start: never empty**, Friends/Popular switch, blended <3 follows — 1d
  - Extended API contract (`feedResponseSchema` in `apps/api/src/contract/schemas.ts`) with cold start metadata fields: `is_cold_start`, `following_count`, and `cold_start_reason`.
  - Implemented 4 cold-start scenarios in `ActivityService.getFriendsFeed` (`apps/api/src/activity/index.ts`):
    1. **0 follows**: Auto-switches Friends tab query to Popular feed (`tab: 'popular'`, `is_cold_start: true`, `following_count: 0`, `cold_start_reason: 'no_follows'`).
    2. **1–3 follows**: Returns Friends feed blended with Popular activities tagged `is_blended_popular: true`, `label: 'Popular on Flyleaf'`, `cold_start_reason: 'sparse_follows'`. (Audit 14: ~~on every page~~ the blend repeated on every page and the feed never ended; now page one only, from people the viewer does not follow, A-14-003.)
    3. **>3 follows with zero recent activity**: Backfills with Popular activities tagged `is_blended_popular: true`, `label: 'While you wait'`, `cold_start_reason: 'no_activity'`.
    4. **Never Empty Guarantee**: If `items.length === 0` (fresh DB with zero platform activity), appends an editorial welcome card (`is_editorial: true`).
  - Unit & integration tests in `apps/api/src/test/feed-cold-start.test.ts` (4/4 tests passing) covering all 4 cold start scenarios. All 24 feed test assertions green across `feed-cold-start.test.ts`, `feed-ranking.test.ts`, and `feed-query.test.ts`.
  - **Audit (2026-10-10):** ❌ — the 1–3-follows feed never ended and could repeat a followed reader's card, the editorial card closed every feed, `following_count` counted deleted accounts; all fixed; see A-14-001, A-14-003.
  - **Audit 15a (2026-10-10):** ✅ D-14-1 built: Popular = public reviews and finishes from 14 days, scored by likes and comments (never rating), §12.4 diversity, per-card exposure cap, keyset paging (A-15-003, migration 0039).
- [x] SO-15 Feed card types + swipe actions — 0.5d
  - Created feed card helper library `apps/mobile/src/lib/feedCard.ts` for card type resolution (`review`, `finish`, `rated`, `dnf`, `shelved`, `followed`, `started`, `goal_reached`, `quoted`, `editorial`), activity headline formatting (including aggregated cards), and swipe action configuration.
  - Implemented interactive `FeedCard` component (`apps/mobile/src/ui/FeedCard.tsx`) using `Swipeable` from `react-native-gesture-handler`:
    - **Swipe Right** (reveals left action): Green **"Want to read"** action with bookmark icon, haptics, and toast notification (~~`POST /v1/shelves/want-to-read/items`~~ no such route exists; want-to-read is a read status, not a shelf: per D-11-1 the swipe uses `POST /v1/reads {status: 'want'}` only when the viewer has no read of the work, wiring → Part 14).
    - **Swipe Left** (reveals right action): Blue **"Rate & Review"** action with star icon, haptics, and navigation to review composer (~~`/log?workId=...`~~ `/log` ignores `workId`; now `/review/compose/<workId>`, A-14-015).
    - Non-gesture accessibility buttons & overflow shortcuts for VoiceOver/TalkBack and web visitors (PRD §4682).
    - Spoiler blur overlay toggle ("Contains spoilers - Tap to reveal") (PRD §10.4).
    - Cold-start badge banners ("Popular on Flyleaf", "While you wait", "Welcome Card").
  - ~~Updated Home Feed screen (`apps/mobile/app/(tabs)/index.tsx`) with real feed cards~~ Home rendered hard-coded sample items and never called the API (audit 14, A-14-010: now wired to `GET /v1/feed`), guest auth gates (`ActionGate`), and swipe action toast alerts (~~the want-to-read toast~~ called nothing: A-14-011).
  - Unit tests in `apps/mobile/src/lib/__tests__/feed-card.test.ts` (92/92 mobile tests passing, typecheck clean).
  - **Audit (2026-10-10):** ❌ — Home showed samples, the swipe was fake, Rate & Review opened search, review cards showed no excerpt or spoiler blur from real payloads, hex colours, the editorial card linked to a nil-UUID profile; all fixed (swipe per D-11-1 with `if_absent` and Undo; the offline queue no longer lets Undo overtake a backing-off create); see A-14-010 … A-14-015, A-14-017, A-14-022.

### Interaction — `SO-2x` · 3d
- [x] **SO-20** `read_likes`, `read_comments` migrations + counters — 0.5d
  - Migration `0018_read_interactions.sql` (hand-written, idempotent like 0011/0013). `read_likes` already existed from 0011; this adds `read_comments` (`id`, `read_id`, `user_id`, `body`, `created_at`, `deleted_at`) with `CHECK (char_length(btrim(body)) BETWEEN 1 AND 2000)`, thread index `(read_id, created_at, id)`, per-user index `(user_id, created_at desc)`, and a likers index `read_likes (read_id, created_at desc)`. Drizzle model `readComments` in `db/schema.ts`.
  - **No `parent_id` column.** Single-level comments are structural, not a rule to enforce — a test asserts the exact column list so nobody adds one casually.
  - **Counters moved from application code to triggers.** SL-64 maintained `like_count` with a read-modify-write in TypeScript, which loses an increment on every concurrent like. `read_likes_counter_fn` / `read_comments_counter_fn` do `UPDATE reads SET like_count = like_count + 1`, which serialises on the read's row lock. `comment_count` counts **live** comments: soft delete decrements, un-delete increments, re-deleting is a no-op. Counters deliberately **do not touch `reads.updated_at`** — it orders the owner's Reading tab, and someone liking your finish must not reshuffle your shelf.
  - `reconcile_read_counters()` returns the number of rows it corrected and writes only drifted rows. New `reads.reconcile` pg-boss queue + `reconcileReadsJobHandler`; the migration runs it once to backfill from truth.
  - ⚠️ **Found: the `work_stats` trigger (0011) fired on UPDATE of *any* `reads` column**, and `recompute_work_stats_for_work()` runs `AVG(rating) FROM reads WHERE work_id <> x` — a full-table scan. Moving counters into `UPDATE reads` would have made every like and every comment pay for that scan. The trigger is now `AFTER INSERT OR DELETE OR UPDATE OF work_id, user_id, rating, hearted, status`. A test asserts a like leaves `work_stats.updated_at` untouched while a rating change moves it — **verified to fail against the old trigger** before the fix went in.
  - ⚠️ **Found: `shelves.reconcile` and `follows.reconcile` had handlers since SH-01/SO-01 but were never scheduled.** A reconciler that never runs reconciles nothing. `worker.ts` now schedules all three nightly, staggered: shelves 03:00, follows 03:15, reads 03:30 UTC.
  - 10 tests in `read-interactions-migration.test.ts`.
- [x] **SO-21** ⚠️ **Like targets the read** — a finish with no review is likeable — 0.75d
  - New `InteractionService` + `interactionsPlugin` in `apps/api/src/interactions/index.ts` (PRD §24 routes): `POST /v1/reads/:id/like`, `DELETE /v1/reads/:id/like`, `GET /v1/reads/:id/likes` (guest-readable likers list, newest first).
  - ⚠️ **Behaviour change: `POST /like` is now an idempotent *like*, not a toggle.** SL-64 shipped a toggle, which is wrong for an offline-first client: the mutation queue replays on reconnect, and a replayed toggle silently undoes the user's like. `DELETE` unlikes, also idempotent. The response shape (`{ liked, like_count }`) is unchanged. Client: `toggleLike()` replaced by `likeRead()`, `unlikeRead()` and `setLiked(readId, wanted)`; the three mobile call sites send the state they want.
  - **Terminal only** (PRD §10.3): `finished` and `dnf` reads accept likes; `want`/`reading`/`paused` → **409 `not_likeable`**. A re-read collects its own likes.
  - **Every denial is the same 404 as a non-existent read** — private read, followers-only to a non-follower, public read on a private account, blocked in either direction. Access goes through `canView()`; tests compare the denied body to the body for a random UUID. Unlike on a hidden read is also a 404, not a silent success.
  - Likers list hides users in a block relationship with the viewer (PRD §11.4); the count still includes them.
  - A review's likes **are** its read's likes: the review permalink and the feed card show the same number. `reviewSchema` now also returns `comment_count`.
  - **Feed cards carry the read's state.** New `interaction: { read_id, like_count, comment_count, viewer_has_liked } | null` on every feed item, attached in two queries per page (`InteractionService.interactionsFor`). Present on `finished`, `dnf` and `reviewed` cards (review cards resolve to the review's parent read via `metadata.readId`); `null` on started/shelved/followed cards and on any card whose read is no longer terminal.
  - ⚠️ **Found: `/v1/feed` was never in `openapi.yaml`.** `contract/generate.ts` keeps its own plugin list and `activityPlugin` was not in it, so `spec:check` could not see feed drift. Registered now, with `interactionsPlugin`. (`exportsPlugin` is still absent from the generator — separate follow-up.)
  - Mobile: `getCardInteraction()` in `src/lib/feedCard.ts` resolves what a card's buttons act on. ⚠️ **Fixed an SO-15 bug:** review cards passed the *activity* id as the read id, which could never match a read. `FeedCard` hides like/comment on non-social cards, sends the wanted state (POST or DELETE), rolls back on failure, and opens the comment thread by default.
  - 17 tests in `read-likes.test.ts`; SL-64's toggle test rewritten for like/unlike in `reviews.test.ts`.
- [x] **SO-22** Comments, single-level, rate-limited — 1d
  - `GET /v1/reads/:id/comments` (guest-readable for public reads; oldest first; opaque `(created_at, id)` cursor, malformed cursor → 400 `invalid_cursor`) (audit 14, A-14-020: ~~`(created_at, id)`~~ the cursor cut `created_at` to milliseconds, so on Postgres each page repeated the previous page's last comment; it now carries microseconds), `POST /v1/reads/:id/comments` (201), `DELETE /v1/comments/:id` (204, soft delete).
  - **Rate limit: 5 comments/minute per user** (PRD §6.28, §11.7, §24) through the injected `RateLimiter` — `PgRateLimiter` by default, so it holds across API instances. Bucket `comments:{userId}`. Checked *after* authorization and validation, so a 404/409/400 never burns budget. `buildApp({ limiter })` and `server.ts` now share one limiter instance.
  - Terminal reads only (409 `not_commentable`); body trimmed, 1–2,000 chars (whitespace-only → 400 `empty_body`; over-length → 422 at the schema).
  - **Deleted review → read-only thread** (PRD §6.28, §43): `POST` returns 409 `thread_locked`; `GET` still returns the comments with `locked: true`.
  - Delete-own only — including against the read's owner (per-thread moderation is P1, PRD §27.2). Deleting someone else's comment is a 404.
  - Blocking: a blocked user cannot see or comment on the read (404); existing comments from someone you blocked are hidden from **you** but not from third parties (PRD §11.4).
  - `parent_id` in a request is stripped by the schema; the comment lands top-level. There is nothing to nest into.
  - Mobile: comment thread screen `apps/mobile/app/read/[id]/comments.tsx` (flat list, delete-own with confirmation and rollback, tombstone banner when locked, 2,000-char counter from 1,800, guest action gate, reader-facing copy for every API refusal) and a Comment button on Review Detail. Pure helpers in `src/lib/comments.ts`.
  - 16 tests in `read-comments.test.ts` (rate limit exercised against the **real** Postgres limiter); 8 mobile tests in `src/lib/__tests__/interactions.test.ts`.
  - Open item: PRD §6.4 says unverified accounts cannot comment. Not enforced here because reviews and follows do not enforce it either — gating one of the three would be inconsistent. Belongs with SO-41 (automated layer 1) or LA-03.
  - **Audit 15a (2026-10-10):** ✅ comments moved onto the shared layer with the same bucket name and numbers (no behaviour change; tested).
- [x] SO-23 Review ranking: social proximity dominant, exploration boost — 0.75d
  - Full PRD §10.7 formula in `apps/api/src/reviews/index.ts`: `0.35·proximity + 0.20·log-likes + 0.10·log-comments + 0.15·exp(−age/45d) + 0.10·credibility + 0.10·length − 0.10·report`, with weights exported as `REVIEW_RANKING_WEIGHTS`.
  - **Social proximity is now three-tier**: 1.0 you follow them (or it is you) · **0.6 follower-of-follower** (new; one query over accepted edges, scoped to this list's authors) · 0.2 otherwise.
  - **Author credibility is real**: the reviewer's *median* `like_count` across live reviews, `log10(1+median)/2` capped at 1 — a median so one viral review cannot buy permanent rank. SL-64 hard-coded it to 0.5 for everyone. Report penalty is wired as an input and is 0 until reports exist (SO-40).
  - ⚠️ **Found: the PRD's weights alone cannot make proximity dominant.** The five non-proximity terms sum to 0.65; following someone adds only 0.35 × (1.0 − 0.2) = 0.28 over a stranger. So a fresh, viral stranger review outscored a friend's quiet two-month-old one, contradicting the PRD's own principle ("a friend's 2-star review is worth more to you than a stranger's viral one"). Ranking is therefore **tiered**: reviews by people you follow come first, and everyone else — followers-of-followers included — competes on the full score, where the 0.6 vs 0.2 weight still counts. A test pins the arithmetic so nobody "simplifies" back to a plain score sort.
  - **Exploration boost**: a review that is new (≤14 days), unproven (<5 likes) and from outside your follows is shown to a **deterministic ~20% sample** of viewers (FNV-1a over `viewer:review`; guests use a daily-rotating key) at **one** slot: directly below the viewer's friends, never above position 3, and only if that lands on page one — so exploring a stranger never costs a friend's review. Deterministic per viewer, so pagination never duplicates or skips. Measured sample rate over 20,000 keys: 18–22%.
  - SL-64's positional `calculateReviewRankingScore(item, viewerId, followedIds)` still works.
  - 21 tests in `review-ranking.test.ts`, including an end-to-end check through `GET /v1/works/:id/reviews?sort=friends`.
  - Open item, deliberately not done: the reviews list still ranks every review of a work in memory before slicing. Fine at current volumes; needs a candidate cap (or SQL pre-ranking) before a work has thousands of reviews.

### Notifications — `SO-3x` · 3d
- [x] **SO-30** notifications table; composition; Expo Notifications → FCM/APNs — 1.5d
  - Migration `0043_notifications.sql` (+ `schema.ts`): `notifications` (aggregating rows: one open row per `group_key` while unread, `updated_at` is the sort key; `in_app` false for a push-only category), `notification_actors` (one row per actor, `pushed_at` per actor so a digest names only the new ones), `notification_preferences`, `push_tokens`, `push_tickets`, `rate_limit_events`. Unique partial indexes: one open group per key; `import_complete` once per import.
  - `src/notify/index.ts`, the `Notifier`: called **inside the domain write's transaction** by `SocialService` (follow → `follow`, private target → `follow_request`; unfollow / cancel / accept / reject clear it), `InteractionService` (like, unlike, comment, comment deleted — like/unlike/comment/delete are now transactions, and only a like that inserted a row notifies, so an offline replay is silent) and the import processor (completed state and notification in one transaction). It never notifies you about yourself (PRD §19.1, AC-19).
  - **Pushes never run in the request path.** If push is wanted, the Notifier enqueues `notify.send` through pg-boss on the same transaction (`bossNotifyQueue`, `fromDrizzle`): a rolled-back write leaves no row and no job (tested on PGlite with a real boss). `buildApp` builds the queue from `boss`; `server-wiring.test.ts` (L-03) now proves a follow through the production wiring reaches `notify.send`.
  - **Blocks, mutes, private accounts, deleted accounts and deleted content, on every notification, twice.** At write time: no row if blocked either way, the recipient muted the actor, the recipient is deleted, or the actor cannot see the read (`canViewWith`). At read time and again at send time, one query (`viewSql`) counts only actors who are live, unblocked both ways, unmuted, still following (or still pending), and who can still see the read by canView()'s rules; a row with no actor left, or whose read is no longer finished/DNF, whose comment is deleted, or whose import is gone, is neither listed, counted in the badge, nor pushed (PRD §19.5). `notify-visibility.test.ts` compares the view with `canView()` over 36 cases (read visibility × account privacy × follower × block either way).
  - Composition (`compose`) gives the list and the push the same words and deep link: "carol and 2 others liked your review of *X*", "bob asked to follow you", "Your Goodreads import is done: 812 books added, 3 to review"; `flyleaf://review/…?work=…`, `flyleaf://read/…/comments?work=…&review=…`, `flyleaf://user/…`, `flyleaf://profile/requests`, `flyleaf://import/unmatched?id=…`.
  - Routes (PRD §24.2): `GET /v1/notifications?cursor=&limit=` (newest activity first; opaque `(updated_at, id)` cursor with microseconds, A-14-020's lesson), `GET /v1/notifications/unread-count` (capped at 100 for "99+"), `POST /v1/notifications/read {ids?}` (someone else's id changes nothing and says nothing), `PUT /v1/me/push-tokens {token, platform, timezone?}` (on every app open; a token that moves to another account moves its row), `DELETE /v1/me/push-tokens/:token` (sign-out). All signed-in only; writes are in the *writes* group of the shared limiter. `openapi.yaml` regenerated (drift 0); api-client: `getNotifications`, `getUnreadNotificationCount`, `markNotificationsRead`, `get/updateNotificationPreferences`, `register/unregisterPushToken`, tested against the real app.
  - **Delivery receipts, as PV-05 left them:** `PushSender` gained `receipts(ids)` (Expo `getReceipts`, batches of 1,000, never throws; an id without a receipt yet or an outage is `pending`) and `categoryId`/`channelId` on a message. Tickets are stored in `push_tickets`; `notify.receipts` (every 15 min) reads receipts no sooner than 15 minutes after the send, deletes the token on `DeviceNotRegistered`, drops answered tickets and any older than Expo's 24 hours. A ticket-time `DeviceNotRegistered`/invalid token deletes the token at once. Contract suite +4 cases.
  - Not built, because nothing produces them yet: ~~replies (comments are single-level),~~ mentions, Year in Review, invites, milestones, author follows, the weekly summary, the 30-day re-engagement push (§19.3). Their categories exist in the preferences (below) with `live: false`. Notification rows have no retention rule (PRD §23.5 names none): recorded as a decision for the owner.
  - **Owner decision (12 Oct 2026), built with SO-4x — retention:** notifications are kept **180 days, like activity**, counted from `updated_at` (a like group still gaining likes keeps its first like). A step in the existing `retention.sweep` (`jobs/retention.ts`, `NOTIFICATION_RETENTION_DAYS`), in batches; actors cascade. Index `notifications_updated_idx` (0044). Test: `notify-replies.test.ts` › *the retention sweep deletes notifications not touched for 180 days* (181 days gone, 179 kept, created 400 days ago but updated yesterday kept, actors gone); removing the step turns it red (checked).
  - **Owner decision (12 Oct 2026), built with SO-4x — replies (§19.2 item 5, `comment_replies`, now `live: true`):** other people's comments on a read whose thread you commented in. Never the read's owner (they get `comment`), never the commenter. One open row per thread (`group_key reply:<read id>`) gaining actors while unread: "dave and 1 other also commented on alice's review of *X*", linking to the thread. Blocks either way, a muted commenter, a muted read owner, and whether the recipient can still see the read (canView()'s rules with the recipient as viewer: private read, private account, followers-only without an accepted follow, deleted owner) are checked when the row is written and again in `viewSql` at read and send time; a commenter whose last comment in the thread is deleted (or hidden by a moderator) leaves the row. Push: one per reply, naming that commenter alone, at most **one per thread per hour** through the same `push:thread` rolling limit as item 4 (key `<recipient>:<read>`), then the 5-a-day cap. Type `reply` added to `notifications_type_ck` (0044), the OpenAPI enum and api-client. Tests: `notify-replies.test.ts` (10): recipients and exclusions, the owner commenting in their own thread, aggregation and a read row closing, the preference, blocks before and after, mutes of the commenter and of the owner (write and read time), losing access to a followers-only read and a private read, a deleted comment, the hourly push. Removing the emit, the recipient-visibility predicate, the owner-mute predicate or the reply throttle each turns its test red (checked). `notify-delivery.test.ts`'s thread-hour test now switches replies off for its second commenter, who would otherwise also get one.
  - Tests: `notifications.test.ts` (33), `notify-visibility.test.ts` (36), `notify-jobs.test.ts` (3), `push-contract.test.ts` (+4), `server-wiring.test.ts` (+1 assertion). Breaking the block filter, the mute filter (read and write time), the private-account predicate or the self check each turns its test red (checked).
- [x] **SO-31** ⚠️ **5/day cap, quiet hours, aggregation** — 0.5d
  - `src/notify/delivery.ts`, `notify.send`: every rule runs at send time against the state then, in this order — read already in the app → no push; category or master switch off; **new-user grace** (no push in the first 24 h except import completion, PRD §19.3); no device; **quiet hours** (default 22:00–08:00 in the user's zone, adjustable, PRD §19.3/AC-19: the job is re-queued for the minute they end, not dropped, and holding it spends nothing); aggregation; the per-thread hour; then **the cap, last**, so nothing held back for another reason spends the day's five.
  - **Through the shared limiter layer:** `RATE_LIMITS` gained `push:day` (5/24 h), `push:thread` (1/h), `push:follow` (3/h), each with its PRD source, on a new **`rolling` store** (`PgRollingRateLimiter`, `rate_limit_events`): one row per counted event under an advisory lock, so "5 a day" is any 24 hours. The fixed-window store restarts its window and would let 10 through across a boundary, which breaks a "hard ceiling". A refusal is not counted. The retention sweep deletes events after 2 days.
  - **Aggregation (PRD §19.2 items 1 and 3, §19.3 "1 hour for likes and follows"):** likes queue one digest an hour after the first like of a quiet group; later likes join it ("dan and 2 others liked…"), and likes after that push get the next digest, naming only themselves. Follows push one by one up to 3 an hour; the 4th onward set one digest an hour later ("fan5 and 2 others followed you"). **Comments** push at most once per thread per hour (item 4); the rest stay in the list.
  - Tests (`notify-delivery.test.ts`, one or more per rule): six events → five pushes and the sixth `daily_cap`, all six listed; the rolling window at 23 h and 25 h; a refusal not counted; 23:30 in Kolkata held to 08:00 IST and then sent; the edges 21:59 / 22:00 / 07:59 / 08:00; user-set and disabled quiet hours; like digests; follows 3 then a digest; thread hour, another thread, and an hour later; grace with import exempt; switches read at send time; already read; a block after the event suppresses the push. Removing each check (cap, quiet hours, follow 3/h, thread hour, grace, the rolling count) turns its test red (checked).
- [x] **SO-32** Per-category preferences; **reading reminder with its six bounds** — 0.5d
  - `GET/PATCH /v1/me/notification-preferences`: the master switch, **all 13 live categories of PRD §19.2** with a push/in-app split each (null where §19.2 gives no such channel: item 9 and 12 in-app only, 10, 11 and 13 push only, all with §19.2's defaults), quiet hours (`HH:MM`), the time zone (checked against `pg_timezone_names`; the device sends it with its token), and `reading_reminder.time`. Unknown categories, a channel a category does not have, malformed times and unknown zones are refused and store nothing. Push-only for a user → the row exists for the push and the list leaves it out; both off → no row.
  - **Reading reminder, `notify.reminders` every 5 minutes, all six bounds (PRD §19.2 item 14 [LOCKED]):** (1) off by default — only rows with a `reminder_time`, which only the user sets; (2) the user's time only — due from that local minute for 30 minutes, at most once a local day, claimed by the same statement that finds it so two runs cannot both send; there is no default or suggested time, and turning it on means sending one; (3) the copy is the constant "Time to read.", title "Flyleaf" — no guilt, streak, count or book title; (4) no app open on any device for 14 days (`push_tokens.last_seen_at`, refreshed on each open) suspends it silently, and it resumes when the app is opened; (5) it goes through `push:day` like everything else; (6) it carries the `reading_reminder` category whose "Turn off" action the app registers and answers with `reading_reminder.time = null`. Quiet hours still apply (a reminder inside them is dropped, not held) and new accounts get none in their first day.
  - Tests: one per bound (`notify-delivery.test.ts`), plus once-a-day across overlapping runs, a time changed today firing today, and the preferences API cases in `notifications.test.ts`. Removing the 14-day check turns bound 4 red (checked).
  - The Settings screen for these switches and the reminder's time picker is LA-02; until then they are reachable through the API only.
  - **Owner decisions (12 Oct 2026):** notification retention 180 days, and replies (item 5) are live: see SO-30 above. `comment_replies` reports `live: true`; a moderation notice (SO-42) is not a category and cannot be switched off (PRD §27.6: the user is told).
- [x] SO-33 In-app centre; deep links with synthesised back stack — 0.5d
  - `app/notifications.tsx` (PRD §6.14): opened from the Home bell, which now shows an unread badge ("99+" past 99) refreshed whenever Home is shown. `FlashList` grouped Today / This week / Earlier by the device calendar, unread dot and tint, avatar or initial, server-composed text, relative time, mark-all-read, cursor paging without repeats, pull to refresh, the PRD's empty state, a banner to turn push on when the OS permission is off. A tap marks the row read and opens its screen on top of the centre. Analytics `notifications_viewed`, `notification_tapped{type, source}`.
  - Deep links (`src/lib/notifications.ts`, pure): `backStackFor(url)` turns a `flyleaf://` link into the screens to stack — review: Home → Book → Review (PRD §35.3); comment thread: Home → Book → (Review) → Thread; a user: Home → Profile; requests and imports under the Profile tab; the reminder: the Reading tab. Ids must be UUIDs; anything malformed, foreign or unknown lands on Home. Parsed by hand, not with React Native's `URL` polyfill.
  - `src/ui/PushBridge.tsx`, mounted inside the session: a tapped push (cold start included, via `useLastNotificationResponse`, after the session and navigator are ready) marks its notification read and replaces the stack with the synthesised one; signed out, it goes Home. The reminder's "Turn off" action turns the reminder off and opens nothing. The token is registered on sign-in and on each return to the foreground (at most hourly), and removed on sign-out (`api.logout` runs it first, while the session can still authorise it).
  - **Permission is asked in context, after the first follow, never at launch** (PRD §35.3), once; a "no" is not asked again (the centre's banner offers it).
  - ⚠️ **Needs a native rebuild:** `expo-notifications ~57.0.21` (the SDK's pinned version, installed with `EXPO_OFFLINE=1 npx expo install`) and its config plugin in `app.json` (`defaultChannel: "default"`; Android 13's notification permission comes with it). Expo push on Android also needs FCM credentials: a `google-services.json` (`android.googleServicesFile`) and the FCM V1 service-account key uploaded to EAS. Neither exists in the repo.
  - Tests: `src/lib/__tests__/notifications.test.ts` (17): sections and edges, badge, paging, read state, every link shape the API composes resolves to a real screen, malformed and foreign links go Home, push responses, token refresh pacing, and structural checks that the bridge sits inside the session, the bell opens the centre, `expo-notifications` is in the native config and nothing asks for permission at launch.

> **`SO-3x` built, 12 Oct 2026 (cloud sandbox).** API 1,840 tests passing across 87 files (+103 new: notifications 33, notify-visibility 36, notify-delivery 26, notify-jobs 3, push contract +4, rate limits +1), 10 skipped as before; mobile 231 (+17). `FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs` green in 1,206 s, all 9 steps, OpenAPI drift 0. Migration `0043_notifications` applied to PGlite and the sandbox Postgres 18.4 (twice, idempotent) only: **apply on the laptop** to `flyleaf_dev` and `flyleaf`. Mobile needs a **native rebuild** (`expo-notifications`) and FCM credentials before push can be tried on a phone.

### Moderation — `SO-4x` · 3d
- [x] **SO-40** reports table; report flow from every surface — 0.5d
  - Migration `0044_moderation.sql` (+ `schema.ts`): `reports` (a person's, `source 'user'`, or layer 1's, `source 'automated'` with `auto_rule`; `subject_type` review / comment / user / shelf / work; §6.44's eight reasons; `detail` ≤ 1,000; `snapshot` of the reported text as it was, so an edit or delete afterwards cannot hide it; `state` open / actioned / dismissed; `action_id`). Unique partial indexes: one open report per person per subject (a double tap or an offline replay is the same report, 200 with the first), one open automated report per rule per subject. Architecture §3.6's `reports` sketch is superseded by this (noted there).
  - `POST /v1/reports` (PRD §24.2) in `src/moderation/` (`index.ts` service, `routes.ts`): **what you cannot see, you cannot report** — a review through canView() on the stricter of review and read visibility (authored: an unverified author's too), a comment only if its thread is visible *and* its author is not in a block with you (§11.4 hides their comments from you), a profile unless deleted or blocked either way, a shelf through canView() on its privacy, a book by id (a merged book is reported as its survivor). Every refusal is the same 404 body as a random id (tested per surface and both block directions). Your own content: 400 `cannot_report_self`. Reporting is open to unverified and suspended accounts (a safety tool). Rate limit: a write, in the shared limiter's `writes` group (PRD §24.4, 120/min; the 121st is a 429, tested); no reports-specific number exists in the PRD (decision needed below).
  - `GET /v1/me/reports`: your reports with status `open` or `reviewed` and nothing else (PRD §27.6: never the outcome for someone else; tested that no decision word leaks).
  - Mobile: one `ReportSheet` (PRD §6.44: reason picker filtered per surface, optional detail, submit, a confirmation that promises no outcome; `content_reported{type, reason}`) on every surface: Review Detail (flag in the header, §6.26), each comment in a thread (§6.28 "Report"), a profile (§6.37 "Block or report"), a shelf (§27.1), a book page (§27.1 catalog content). `app/profile/reports.tsx` ("Your reports", from Profile settings) lists your reports' status and the decisions about your own content. Pure helpers `src/lib/moderation.ts`.
  - Tests: `moderation-reports.test.ts` (19): every surface; repeat and second reporter; merged work; self; guest and malformed input (422 at the schema, nothing stored); 404 equivalence for blocks either way × four surfaces, private and followers-only reads, private shelf, deleted review, a blocked commenter's comment, a deleted account, a missing book; the writes limit; status-only listing. Mobile `moderation.test.ts` (reasons, copy, every surface mounts the sheet). Removing the review canView() check or the comment-author block check turns its test red (checked).
- [x] **SO-41** Automated layer 1: slur list, link rules, duplicates, rate limits — 1d
  - `src/moderation/filters.ts`, called inside each write's own transaction, before the write (and before its rate limit, so a refused text costs nothing): reviews (publish and edit), comments, profile display name and bio, shelf name and description, and usernames (registration and change, through `usernameSchema`).
  - **Slur and hate-term list → blocked at submission:** 422 `content_rejected` naming the field ("…not allowed on Flyleaf (hate speech or a slur). Edit it and try again."). The list (`terms.data.ts`) holds **hashes, never words**; matching is whole-token after normalisation (accents, case, look-alike digits and symbols, runs of 3+ letters cut to 2, spaced or dotted-out letters joined, plural s/es), with and without the look-alike mapping so punctuation cannot hide a word. Never substring: "Scunthorpe", "Niger", "Nigeria" and "a chink in the armour" pass. `npm run moderation:hash-terms < terms.txt` regenerates it. The shipped list is an 11-term seed (decision needed below).
  - **Link rules:** an account under 7 days old cannot post a link anywhere (`links_not_allowed_yet`); a review holds at most 2 (`too_many_links`). Links: a scheme, `www.`, or a bare host on a common TLD.
  - **Duplicate content → queue:** the same text (case and whitespace normalised) in the author's own live reviews on 3+ works writes an automated `spam` report (`duplicate_content`) on the newest; never blocked. Same-author only (decision needed below).
  - **Rate limits:** the shared layer, unchanged (§24.4 / §10.6 / §11.7). **New-account restrictions:** no reviews, comments or follows before email verification (`requireVerified`, D-04-1), unchanged. **§27.3 spoilers, 3rd strike:** while `users.review_flag_until` is in the future, every new or edited review writes an automated `spoilers` report (`flagged_account`).
  - AI triage (P1) is not built. Nothing in layer 1 deletes: suspect content queues for a person (§27.2).
  - Tests: `moderation-filters.test.ts` (13), one block per rule, each through the real route with a harmless stand-in term added to the live set: matching (hits and Scunthorpe misses), review / edit / comment / bio / display name / shelf name / description / username refused and nothing written, criticism untouched; links by account age on three surfaces and the 2-link cap (comments exempt); duplicates on the third work, cross-author not counted, an edit that makes the third copy; the 11th review in an hour 429 with a refused review not counted; an unverified review 403; the spoiler flag on and off. Removing each rule (list check, account-age link rule, 2-link cap, duplicate count, spoiler flag, the review rate limit, the verification gate) turns its test red (checked, one mutation at a time).
- [x] **SO-42** **Admin: report queue, actions, enforcement ladder, appeals** — 1.5d
  - **Queue** (`GET /v1/admin/reports`, console `/admin/reports`): open reports grouped by subject, heaviest first then oldest. Weight is the sum of reporter reputations, `(upheld + 1) / (resolved + 2)` per reporter (0.5 for a new one, towards 1 when their reports are upheld, towards 0 for a mass-reporter, §27.2); an automated report counts 1. **Case** (`GET /v1/admin/reports/:type/:id`, console page): the content as it is now (hidden or deleted included), every report with its reporter, reputation, detail and snapshot, the owner (suspension, ban, flags), their history, and for each applicable rule the ladder's next step and what it would do.
  - **Actions** (`POST …/action`): `dismiss` (no violation), `resolve` (a book report, handled with the catalog tools), or `enforce` a **rule** (§27.5 "record the rule applied"); a typed reason of 10+ characters (D-06-1's rule). The open reports are locked `FOR UPDATE`: a second moderator acting at the same moment gets 409 `nothing_open`, never a double action (tested with two concurrent calls). The action row, the closed reports, the owner's notice and the **audit row (`moderation.dismiss|enforce|resolve`) commit in one transaction**: a failed audit insert rolls back the content change, the strike, the report states and the notice (tested with a refusing trigger, as A-15-020).
  - **Enforcement ladder** (`ladder.ts`, PRD §27.3 as data; past the last step the last repeats; a strike stands until an appeal overturns it): spoilers — the review marked as spoilers (blurred, not removed), then a warning, then 30 days of queued reviews; spam — removed, then removed + 7-day posting suspension, then ban; harassment — removed + warning, then 30-day suspension, then ban; hate speech — removed + ban at once; fake review — removed and that read's rating excluded from aggregates, then ban; impersonation — profile name, bio and photo reset + warning, then ban; vote manipulation — every rating of the account excluded, then ban. "Removed" is **hidden, not deleted** (§27.5): `hidden_at` plus the existing soft delete, so every read path already leaves it out, its feed card goes, a comment's notification goes; retention never purges hidden content; the owner cannot republish a removed review (409 `review_removed`) or restore a hidden shelf. Rating exclusion: `reads.rating_excluded` / `users.ratings_excluded_at`, left out by the `latest_ratings` view (0029's one definition), and the affected works recomputed in the transaction. A **posting suspension** (`users.suspended_until`) refuses reviews, comments, follows, shelves and profile text with 403 `account_suspended` (reading, logging, liking and reporting still work). A **ban** soft-deletes the account (it disappears everywhere a deleted one does), sets `banned_at` so the retention sweep never hard-deletes it, and revokes its refresh tokens.
  - **Roles (§27.5 [LOCKED] "only admin touches the catalog or user accounts"):** a moderator can dismiss, hide, mark spoilers, warn, exclude one review's rating and flag reviews; a step that suspends, bans, resets a profile or excludes an account's ratings needs an admin (403 `insufficient_role`, audited as `admin.denied` by the Part 06 hook; nothing applied). Same for overturning such a step.
  - **The owner is told (§27.6):** a `moderation` notification (in the list, never pushed, not a category anyone can switch off) naming the rule and what it did, deep link `flyleaf://moderation/<id>`; `GET /v1/me/moderation[/:id]` with rule, consequences and appeal state. **One appeal** (`POST /v1/me/moderation/:id/appeal`; a second is 409 `appeal_closed`, someone else's 404). **Appeals queue** (`GET /v1/admin/appeals`, console `/admin/appeals`), reviewed by a person: `uphold` (the decision stands; the owner is told) or `overturn` — everything the action did is undone from the values it recorded (content unhidden with its previous delete state and feed card, spoiler flag and profile restored where the owner has not changed them since, suspension, ban, rating exclusions and review flag lifted only if still the ones it set), the strike stops counting, the owner is told; audit `moderation.appeal_upheld|appeal_overturned` in the same transaction.
  - Admin patterns from Part 06, unchanged and reused: staff auth (`requireModerator` / admin role), the cookie accepted only on admin paths with a same-host `Origin` for writes (a cross-origin console write is 401, tested), escaped pages with a per-response script nonce and no inline handlers (tested with a stored `"><img onerror>` / `</script>` review and report detail), `hide: true` on HTML routes. The console nav gains Reports and Appeals.
  - Mobile: `app/moderation/[id].tsx` (the notice: rule, consequences, appeal box, its state), reached from the notification (deep link → Profile tab → notice) and from Your reports.
  - Tests: `moderation-admin.test.ts` (21). **The Phase 4 exit criterion is one test**: a reader reports a review → it is in the queue with its weight and text, and on the console page → the case shows the ladder → a moderator enforces Harassment from the console with the session cookie (a cross-origin attempt first, refused) → the review is gone for others, the reporter sees "reviewed", the queue is empty, the audit row carries the action → the owner's notification names the rule and links to the notice → the owner appeals once → an admin overturns from the appeals queue → the review is back, the strike no longer counts. Then: the ladder table; every rule's steps through the API (spam 1–3 with the moderator refused at step 2, harassment, hate speech with sessions revoked and retention keeping the account, spoilers 1–3, fake review against `work_stats`, impersonation, vote manipulation); comment and shelf hiding with counters, restore refusal and retention; republish refusal; book reports; atomic audit for enforce and overturn; the concurrent race; reasons and rule validation; uphold vs overturn of a suspension (admin only) and of a ban; role gating on all five REST routes and three pages; escaping and nonces; and the api-client end to end. Removing the ban effect, the admin-only check, the suspension check or the audit write's action turns its test red (checked).

> **`SO-4x` built, 12 Oct 2026 (cloud sandbox), with the two SO-3x owner decisions (replies, 180-day notification retention).** API 1,903 tests passing across 95 files (+63: moderation-admin 21, moderation-reports 19, moderation-filters 13, notify-replies 10; two strict lists updated for the new column and console pages; notify-delivery's thread-hour test switches replies off for its second commenter), 10 skipped as before; mobile 243 (+12). 19 one-at-a-time mutations of the new rules each turned their test red. OpenAPI regenerated, drift 0; api-client: `createReport`, `getMyReports`, `getModerationNotices`, `getModerationNotice`, `appealModeration`, `adminGetReportQueue`, `adminGetReportCase`, `adminActOnReport`, `adminGetAppeals`, `adminResolveAppeal`. Migration `0044_moderation` applied to PGlite and the sandbox Postgres 18.4 (twice, idempotent) only: **apply on the laptop** to `flyleaf_dev` and `flyleaf` (`npm run migrate`). It replaces the `latest_ratings` view (same columns) and adds columns with defaults; nothing is rewritten. No new dependency; no native rebuild beyond SO-33's.
>
> **Decided in the build (reversible, say if you disagree):** §25.3 lets a moderator "suspend accounts", §27.5 [LOCKED] says only an admin touches user accounts: the locked section wins, so suspension, ban, profile reset and account-wide rating exclusion (and overturning them) need an admin. "Removed" is hidden-and-soft-deleted, never purged. A ban is a soft delete retention never completes. Spoiler "content flagged" marks the review as containing spoilers rather than hiding it. Fake review 1st step excludes that read's rating, vote manipulation the account's. Reporter weight is `(upheld+1)/(resolved+2)`. A restored review's feed card is re-created with today's time.
>
> **DECISION NEEDED:** (1) **the curated slur list** (11-term seed now; supply terms, `npm run moderation:hash-terms`); (2) **the report response window** §6.44 asks the confirmation to state (no number in the PRD; the copy names none); (3) **a reports-specific rate limit and the mass-reporter threshold** (§27.2 "eventually rate-limited" has no number; today reports count in Writes, 120/min, and weigh less); (4) **appeals from a banned account**: it cannot sign in to appeal (suggest an emailed one-time appeal link); (5) **duplicate content across accounts** (rings) and a minimum length (today: same author, any length); (6) **`report_penalty` in review ranking** (§10.7 "scales with unresolved reports", no scale given; still 0); (7) device/IP blocks for bans (§27.2) are not built: the app collects no device id and IP blocks are coarse.
>
> **Owner decisions on the SO-4x list (13 Oct 2026), built with SO-5x** (`moderation-decisions.test.ts`, 11 tests; each rule's removal turns its test red, checked one mutation at a time):
> - **(2) Report response window → built.** The confirmation reads "Thanks. We usually review reports within 2 days. You can see its status in Settings → Your reports; …" (`apps/mobile/src/lib/moderation.ts`, `REPORT_RESPONSE_WINDOW`; mobile `moderation.test.ts` asserts the sentence word for word). A report refused by the new limits shows the server's message instead of "try again in a minute".
> - **(3) Report limits → built.** `reports:hour` 5 and `reports:day` 20 per account, exact store, in the shared table (`platform/rate-limits.ts`, sources cite this decision). Counted per **new** report only, in `ModerationService.report`: a repeat of the reporter's open report on the same subject (double tap, offline replay) returns it and costs nothing. The route stays in the `writes` group too. 429 `rate_limited` with Retry-After. Tests: the 6th new report in an hour, the 21st in a day across hours, repeats free, another account untouched; `rate-limits.test.ts` pins the numbers.
> - **(4) Appeals from a banned account → built: an emailed one-time link.** When a step bans (`ModerationService.act`), the same transaction writes `moderation_appeal_links` (0045: SHA-256 of a 32-byte token, the action, `expires_at` = now + **30 days**, `used_at`) and, after commit, emails the account (`Your Flyleaf account has been banned`: the rule, what happened, `<APP_BASE_URL>/appeal?token=…`, "works once and expires in 30 days"). `GET /appeal` (server-rendered like the reset page: nonce CSP, `Referrer-Policy: no-referrer`, `no-store`, `noindex`, Auth rate-limit tier) shows the rule and consequences and a form; **a GET never spends the link** (mail scanners). `POST /appeal` spends it and records the one appeal (`appeal_state = 'pending'`) in one transaction, so it lands in the existing appeals queue; a used, expired, unknown or tampered link is refused (400) and appeals nothing; an empty or over-long appeal is a 422 that spends nothing. The admin's decision is emailed too (an overturn lifts the ban: "you can sign in again"; an uphold says it stands). No sign-in anywhere. Only a ban creates a link; removals, warnings and suspensions are appealed in the app as before.
> - **(5) Cross-account duplicates (review rings) → built.** In `screenReviewWritten`: the same review text (case and whitespace normalised) as a live review by **another account**, when the normalised text is **≥ 100 characters**, writes an automated report (`auto_rule = 'duplicate_across_accounts'`, reason `fake_review`, detail "The same text is in N reviews by M other accounts", snapshot with up to 10 matching review ids). **Never blocked**: the review publishes. Same-author duplicates keep the 3-works rule. A probe on `reviews_body_norm_idx` (an expression index on `md5(normalised body)` over live reviews; built `CONCURRENTLY` by `migrate.ts` ONLINE_SQL because `reviews` is large). Sandbox plan: Bitmap Index Scan on it, 9 shared hits.
> - **Recorded, not built:** (6) the report penalty in review ranking **stays 0**; (7) device and IP bans are **post-launch**; (1) the 11-term slur seed will be **replaced from a maintained public list before beta — owner task** (`npm run moderation:hash-terms < list.txt` regenerates `terms.data.ts`; the list holds hashes, never words).

### Public pages — `SO-5x` · 3d
- [x] **SO-50** ⚠️ Server-rendered book, profile and shelf pages — 2d
  - `apps/api/src/web/public-pages.ts` (`publicPagesPlugin`, `PublicPagesService`), replacing SH-10's shelf-only `shelvesWebPlugin`: `GET /book/:id`, `GET /@:username`, `GET /u/:username` (301 → `/@username`), `GET /u/:username/shelves/:slug`, `GET /shelf/:id`. `hide: true` (HTML, not API); `contract.test.ts`'s hidden list names each one.
  - **Rendered as a guest, always** (PRD §4.2, §29.1: the page is for someone without the app). A browser sends no token, and a page that changed with the token could not be cached, so the HTML path ignores `request.viewer` and reads through the same authorization layer as the API with `viewer = null`: `loadRelationship` + `canViewWith` for the account and shelf, `canViewSql(null, …, authored: true)` with `mostRestrictiveSql(review, read)` for the profile's reviews, `ReviewService.listWorkReviews(…, null)` (SO-23's guest ranking and its live re-check) for the book's. **One 404 page** (`NOT_FOUND_PAGE`, `no-store`, `noindex`) for: a private account, a private or followers-only shelf, a deleted shelf, a deleted or banned account (a ban is a soft delete), an old name of such an account, a provisional book, a missing or malformed id; byte for byte the random id's, so no title, name, bio or description reaches any tag. Hidden (moderated) and deleted reviews, an unverified author's review (D-05-3) and reviews on private reads never appear. **Blocks:** a guest has no relationship to block; a signed-in reader's token changes nothing, so the page can never confirm a block (tested: the blocked reader's page is byte-identical to a guest's).
  - **PRD §7.8:** reviews of an explicit book never appear on a logged-out page; the explicit book itself resolves (a direct link always does) with title and author only: no cover, description, `og:image` or reviews, `noindex` (meta and `X-Robots-Tag`). Explicit favourites and shelf items are left off profile and shelf pages.
  - **Content:** book: cover, title, subtitle, authors, year, average and count of ratings (`work_stats`), description, top 5 reviews (guest "friends" ranking; a spoiler review shows its author and "Contains spoilers", never its text), each author linking to `/@username`. Profile: avatar, name, @username, followers/following counts, bio, the four favourites as covers linking to `/book/:id`, 5 most recent guest-visible reviews, up to 6 public shelves (the rest counted). Shelf: name, curator linking to the profile, description, the first 24 books as covers.
  - **Headers on every page:** CSP `default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'` (no script runs at all; `self` for avatars), `Referrer-Policy: strict-origin-when-cross-origin`, `nosniff`/`DENY` from the core hooks. 200: `public, max-age=300` (safe now that nothing depends on the viewer; 5 minutes bounds how long something made private stays in a shared cache, PRD §34.3, A-11-022). 404 and 301: `no-store`. **Every interpolation goes through `escapeHtml`** (the admin one; the shelves copy is gone), URLs, ids and cover ids included; tests store `"><script>…<img onerror>` in every field shown (book title, subtitle, description, display name, bio, review, shelf name and description) and assert it never appears raw, and that no tag carries an `on…=` attribute.
  - **Renames (D-11-2, 0037):** an old username, or the current one in another case, 301s to `/@current`; `/u/:username` 301s to `/@username`; an old shelf slug 301s to the current shelf address. Each redirect is decided **after** the visibility check: an old name of an account that went private is the 404, never a `Location`. A merged book id 301s to its survivor (D3).
  - **Behaviour changes** (client-observable): the shelf HTML pages now render as a guest even when a token is sent (a follower opening a followers-only shelf's link in a browser gets the 404 page; before, `private, no-store` HTML), and their markup is the shared shell (title `… — Curated by @user · Flyleaf`, button "Open in the Flyleaf app", `<link>` tags without ` />`). The `Accept: application/json` answer on both shelf routes is unchanged (viewer-aware, `private, no-store` unless a guest on a public shelf). `shelves.test.ts` and `shelves-audit.test.ts` updated accordingly.
  - **Authorization matrix (Part 05):** `GET /@:username` joins the WEB rows, and every WEB row now runs for all 8 viewer states expecting the **guest's** answer (the token is ignored); a new block checks the pages as lists: `/@:username`'s reviews and shelves and `/book/:id`'s reviews contain an item iff a guest may see it, for every viewer × account (public / private / deleted) × visibility.
  - Tests: `public-pages.test.ts` (15) and the matrix (+4 cases). Mutations, one at a time, each turned a test red: the profile visibility check, the explicit-review suppression, the provisional check, rendering `/shelf/:id` for the viewer, the profile review filter (`canViewSql`), escaping the display name.
- [x] **SO-51** Open Graph tags; `flyleaf.app/@username` — 0.5d
  - `/@:username` is the canonical profile address (PRD §16.5, §29.1 loop 3); `/u/:username` (what the app shared until now) 301s there. Every page carries `<link rel="canonical">` on `APP_BASE_URL`, `og:site_name/type/url/title/description`, `og:image` when there is a cover or avatar (absolute: Open Library covers, `APP_BASE_URL/v1/avatars/…`), `twitter:card` (`summary_large_image` with an image, else `summary`), `twitter:title/description/image`, and App Links `al:ios:url`, `al:ios:app_name`, `al:android:url`, `al:android:package`, `al:android:app_name` with the app's routes (`flyleaf://work/<id>`, `flyleaf://user/<id>`, `flyleaf://shelf/<id>`); `og:type` `books.book` (+ `books:author`), `profile` (+ `profile:username`), `books.book_list`. Tested tag by tag.
  - Mobile: Profile → "Share profile" now gives `https://flyleaf.app/@username` (`profileShareUrl`, `src/lib/followSuggestions.ts`, with `bookShareUrl`); mobile `follow-suggestions.test.ts` checks both against the server's routes.
  - Not done (needs a native rebuild, decision below): https App Links / Universal Links for `/@…`, `/book/…`, `/u/…` (app.json intent filters and the AASA `components` list only `/verify-email` and `/reset-password`), so a shared link opens the web page even on a phone with the app; the page's "Open in the Flyleaf app" button uses the `flyleaf://` scheme.
- [x] SO-52 Onboarding follow suggestions — 0.5d
  - `GET /v1/me/follow-suggestions?limit=` (default 15, max 30; signed in only) in `src/social/suggestions.ts` (`FollowSuggestions`), api-client `getFollowSuggestions`. PRD §6.11 ranking, as a lexicographic order: **genre overlap** (distinct genres, `subjects.kind = 'genre'`, shared with the viewer's top 10 genres from their reads and favourites) → **favourite-book overlap** (the viewer's favourites among the candidate's favourites or public reads) → **active reviewers** (live public reviews on public reads in 90 days) → most followed. Each card: name, avatar, follower count, up to 4 favourites (never an explicit book), and `reason` (`favourites` | `genres` | `reviewer` | `popular`).
  - **Never suggested:** the viewer; anyone they follow **or requested**; anyone in a **block** with them either way (absent, never confirmable, §11.4); anyone they **muted** (§11.5); **private accounts** (a suggestion would invite a request behind a wall, and "Follow all" must follow, not request); deleted and banned accounts; unverified accounts (their reviews are hidden, D-05-3); accounts under a posting suspension (until it ends). Overlap counts **public reads and public favourites only**: a private or followers-only read is never the reason someone is shown (tested: such a reader is reached only as "popular").
  - Cost: candidates are a bounded pool, not every account: co-readers of the viewer's books (≤ 1,000, `reads_work_idx`) ∪ recent reviewers (≤ 200) ∪ most followed (≤ 100). The last two are the same for every viewer and need a scan of recent reviews and of profiles, so they are computed once and cached 10 minutes (the app's `Cache`); exclusions always run per viewer on live rows. Each candidate is scored with index probes on its own reads (`reads_user_visibility_idx`, `work_subjects` pk). Sandbox only (5,000 users, 20,000 reads, 6,085 reviews): 2 statements, ~22–28 ms warm, 7.5k shared hits, no sequential scan in the viewer query. **Rerun on `flyleaf_dev`** (bench users with thousands of reads are the case to watch: genre overlap reads each candidate's public reads).
  - Mobile: `app/onboarding/follow.tsx` — the cards, Follow / Following per card, "Follow all N" (only those not followed yet), Skip / Continue; follows go through the offline queue like the profile button; an unverified account gets the verify prompt instead of a follow that can only fail (D-04-1); `follow_suggestions_shown{count}` once, `user_followed{source:'onboarding'}` per follow (PRD §6.11). Shown right after sign-up (`auth.tsx` replaces the modal with it), and from the Following feed's empty state ("Find readers to follow"). Pure helpers in `src/lib/followSuggestions.ts`.
  - Not built (decision below): genre picking and favourite picking during onboarding (PRD §4.1 steps 5–6) do not exist, so a brand-new reader's suggestions rank by active reviewers and followers until they log books; **seeded editorial accounts** (§6.11's last tier and empty state) do not exist.
  - Tests: `follow-suggestions.test.ts` (5): every exclusion, including a suspension that has ended; the four-tier ranking order and reasons; private reads not counted; explicit favourites off the card; limit and 422 over 30; guest 401. Mutations, one at a time, each turned a test red: the block (either direction), the mute, the private-account and suspension filters, counting private reads. Mobile `follow-suggestions.test.ts` (6).

> **`SO-5x` built, 13 Oct 2026 (cloud sandbox), with the SO-4x owner decisions above.** API 1,945 tests passing across 94 files, 10 skipped as before (1,903 before: +42 — public-pages 15, moderation-decisions 11, follow-suggestions 5, authorization matrix +4, rate limits +7 for the two new limits; the SO-4x note's "95 files" was a miscount: there were 91). Mobile 249 (+6 in `follow-suggestions.test.ts`; `moderation.test.ts` asserts the new copy). 25 one-at-a-time mutations of the new rules each turned their test red. OpenAPI regenerated (`GET /v1/me/follow-suggestions`), drift 0; api-client `getFollowSuggestions`. No new dependency. Mobile: no native module added, so no rebuild is needed for SO-52; App Links for the public pages would need one (decision below). `FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs` green in 1,347 s, all 9 steps, OpenAPI drift 0.
>
> **Apply on the laptop:** migration `0045_public_pages_and_moderation_decisions` (`npm run migrate` on `flyleaf_dev` and `flyleaf`): a new table, nothing rewritten; then `migrate.ts` builds `reviews_body_norm_idx` **CONCURRENTLY** (no write lock on `reviews`). Applied to PGlite and the sandbox Postgres 18.4 only (twice each, idempotent).
>
> **Decided in the build (reversible, say if you disagree):** appeal links expire after **30 days** (the app's other grace periods are 30 days) and the outcome of a ban appeal is emailed; HTML pages always render as a guest, so the shelf page no longer shows a follower a followers-only shelf in a browser; an explicit book's page exists but shows title and author only, `noindex`; a provisional (reader-created, unreviewed) book has no public page; suspended and unverified accounts are never suggested; the suggestions' shared pool is cached 10 minutes.
>
> **DECISION NEEDED:** (1) **App Links / Universal Links** for `/@…`, `/book/…`, `/u/…` so a shared link opens the app when it is installed (app.json intent filters + AASA components; needs a native rebuild and the store fingerprints D-07-1 already asks for). (2) **Onboarding genre and favourite pickers** (PRD §4.1) don't exist; without them a new reader's suggestions fall back to active reviewers and most followed. Build them next, or accept that suggestions improve once books are logged? (3) **Editorial accounts** (PRD §6.11 tier 4 and the pre-launch empty state): who are they, and a flag on `profiles` to mark them? (4) **Follows before email verification.** D-04-1 refuses follows from an unverified account, and a new account is unverified when the suggestions screen opens right after sign-up, so each Follow tap there opens the verify prompt (the list stays; after verifying, the taps work). Options: (a) as built; (b) allow follows (only follows, rate-limited by §11.7's new-account rule) before verification; (c) show the suggestions after the email is verified instead of after sign-up. Recommendation: (b), since a follow publishes nothing and the 20-in-24-hours new-account limit already bounds abuse.
>
> **Owner decisions on the SO-5x list (13 Oct 2026), built with Phase 5 A** (branch `feat/st-a-stats`):
> - **(4) Follows before email verification → (b), built.** `SocialService.followUser` no longer calls `requireVerified`; reviews and comments still do (D-04-1 otherwise unchanged; `DECISIONS.md` notes the amendment). PRD §11.7's new-account limit (`follow:new`, 20 in the first 24 hours) applies to unverified accounts exactly as to verified ones. App: the follow buttons on a profile, the follower/following lists and the onboarding suggestions no longer open the verify prompt first; the prompt's copy now says "Reviews and comments need a verified email address". Tests: `authorization-matrix` › "can follow before verifying, and the follow is written" (replaces "cannot follow"); `rate-limits` › "an unverified new account may follow … and is held to the same 20; reviews stay gated" (20 follows 200, the 21st 429 `New accounts…`, 20 rows, a review 403 `email_unverified`); mobile `follow-suggestions` › "no follow button asks an unverified account to verify first". Re-adding the check turns both API tests red.
> - **(1) App Links → added now; they ship with the next native build.** `app.json` Android intent filters gain `pathPrefix` `/@`, `/book/`, `/u/` on `flyleaf.app`; the served AASA `components` gain `/@*`, `/book/*`, `/u/*` (`APP_LINK_PATHS` in `identity/link-pages.ts`; a test checks app.json and the AASA name the same paths). In the app, `app/+native-intent.tsx` rewrites `/@name` → `/u/name` and `/book/:id` → `/work/:id` (`src/lib/appLinks.ts`), and a new `app/u/[username]/index.tsx` resolves the name through a new **`GET /v1/users/by-username/:username`** (current or former name, any case; then exactly `GET /v1/users/:id`'s visibility; in the authorization matrix beside it). `/u/name/shelves/slug` already had a screen. **Nothing changes on a phone until the next native build** (intent filters and associated domains are native config; the store fingerprints D-07-1 asks for are still needed for verification).
> - **(2) Onboarding genre and favourite pickers → deferred to Phase 6 onboarding polish.** Not built; suggestions keep falling back to active reviewers and most followed for a reader with no books.
> - **(3) Editorial accounts → the owner's account only, for beta.** Recorded; no flag or seeding built. The account to use is the owner's own; nothing in the suggestions code names it yet.

> **`SO-2x` closed, 24 Sep 2026.** API 738 tests across 45 files, mobile 100 tests (+8), `node scripts/ci.mjs` green in 725 s with 0 OpenAPI drift. `0018_read_interactions` then applied cleanly with `npm run migrate` against the local Postgres 18 container (same day). Gotcha found doing it: another project's Postgres was holding host port 5432, so `flyleaf-pg` started unpublished and every `localhost:5432` login hit the wrong server (`password authentication failed`). Check `docker ps` ports before debugging credentials.

**Exit:** 30–50 beta users · median follows ≥5 · nobody has an empty feed · block verified · report actionable end to end.

---

## Phase 5 — Stats, goal, Year in Review · `ST` · 15d

- [x] **ST-01** ⚠️ **Stats computed per viewer** — owner sees private reads, others do not — 1.5d
  - **Already there (audit 10, A-10-001):** `ReadingService.getStats(viewer, userId, …)` takes the viewer on every query (`visibleLevels` from `canView`), the owner's view includes private reads, private accounts and blocks (either way) are the random-id 404, and `stats-audit.test.ts`'s **twin oracle** deep-equals the viewer's response about the owner with a twin account's own response holding exactly the reads that viewer may see (stranger, guest, pending follower, follower, owner; `year=all` and a year). `GET /v1/users/:id/stats` was already a matrix row.
  - **Added:** every query new in ST-02 (books in progress; the progress-event query behind pace, speed and time of day) filters by the same levels; the main query's new columns ride on its existing filter. The twin library now carries a value for every new figure (start dates, genres, publication years, languages, page events with minutes, a private book in progress), so the deep-equal covers them. `vs_crowd` uses others' ratings only (the book's average **without** the reader's own counted rating), so it carries nothing private of the reader. New `stats-phase5` › "ST-01: per viewer": a private re-read is the owner's most re-read book and nobody else's; books in progress per viewer. Goal routes (ST-05) are per viewer the same way and `GET /v1/users/:id/goal` is a new authorization-matrix row (account-level: where the stats are visible, else the random-id 404). `GET /v1/users/by-username/:username` (App Links) is in the matrix's profile test.
  - **Cache:** none is built, so there is no shared aggregate to leak across tiers (§17.5's per-tier keying applies when one is; A-10-024's plan stands).
  - Mutations, one at a time, each turned a test red: the events query without the visibility filter (twin oracle, 2 tests), books in progress without it (5), the goal count without it, the goal route without `canViewWith` (matrix and goal tests).
- [x] ST-02 Volume, temporal, taste, extremes; pace and speed from `minutes` — 2d
  - **Already there (audit 10):** books finished per attempt and `distinct_works_count`; pages by the D-08-3 rule; listening hours as positions, not sums; books and pages per month; average rating and the ten half-star buckets; format split with `unknown`; longest and shortest book; most-read author; DNF count and rate; current and longest streak in the user's zone.
  - **Added to `GET /v1/me/stats` and `/v1/users/:id/stats`** (PRD §17.2): `books_in_progress`; `vs_crowd` (mean of your rating − the book's average without yours, over rated books someone else rated); `genres` (donut: each book once under its highest-weight genre, top 8 + `other`); `decades` (first publication); `languages` (chosen edition, else the work's original; `und` is no language); `velocity` (days to finish, start and finish day included: median and per finish month); `speed` (pages per hour = pages ÷ minutes over sessions that carry minutes **and** a page rise since the read's previous page event; §8.4: never inferred from gaps); `pace` (pages per Monday-start week and the 7-day average, first to last week with pages, empty weeks 0); `time_of_day` (7 × 24 progress events in the user's zone); extremes `fastest_read`, `slowest_read`, `highest_rated`, `lowest_rated`, `oldest_publication`, `most_reread`; `current_streak_range` and `longest_streak_range`. Queries per request 4 → 6 (books in progress; one pass over progress events, its window partitioned by "has a page" so a percent or audio event does not hide the previous page).
  - **Exit criterion — hand-computed figures:** `stats-phase5.test.ts` › "ST-02: every stat against hand-computed figures": one library of 5 finished books (one read twice), a DNF, an undated import, a book in progress, 2 other raters and 6 sessions, each figure worked out in a comment beside its assertion (volume, months, velocity, pace, speed, time of day, streak, ratings, vs crowd, formats, author, genres, decades, languages, all eight extremes, and the coverage of each).
  - Not on the screen yet: the new figures reach the app through `@flyleaf/api-client` (`ReadingStats`) and are drawn by **ST-04** (one stat per card).
  - Cost (sandbox Postgres 18.4, **synthetic data, not the catalog**: one reader with 1,500 finished reads and 15,500 progress events among 61,520 reads; HEAD vs this branch back to back, 40 warm runs): owner `year=2025` p50 33 → 47 ms, `year=all` 62 → 108 ms (1.7×), a stranger's view 25 / 67 ms; 4 → 6 queries. The main query's per-row genre and crowd lookups are index probes (`work_subjects` pk, `work_stats` pk, `reads_user_work_attempt`); the events query is one window pass over the reader's events. **Rerun on `flyleaf_dev`** with the heaviest bench reader. Indicative only.
- [x] **ST-03** ⚠️ Incomplete-data disclosure; **never fabricate** — 0.5d
  - **Already there (audit 10, A-10-012, A-10-009):** `excluded {undated, missing_page_count}` and the stats screen's one-line note; a book with no page count adds no pages and is no extreme; an undated finish counts all-time and in no month; an unknown format is `unknown`, never print.
  - **Added:** `coverage` on the stats response: `{based_on, of}` for every figure that can lack data — `pages`, `months`, `ratings`, `vs_crowd`, `formats`, `authors`, `genres`, `decades`, `languages`, `velocity`, `audio` (books; rated books; finished audiobooks) and `pace`, `speed` (sessions). Fixes found doing it: **most-read author counted books with no author as "Unknown Author"** (now left out, and `author_name` is `null` on extremes); an edition language of `und` would have read as a language; a figure with nothing to base it on is `null`, never 0 (`vs_crowd`, `speed.pages_per_hour`, `velocity.median_days`). The goal response carries `pages_coverage`. App: `coverageNote(stats, key, 'your' | 'their')` says "Based on 180 of your 247 books — 67 are missing page counts." (PRD §17.4's sentence, asserted word for word) with a reason per figure; the stats screen shows it under ratings, formats, most-read author and listening hours (the figures it draws today; ST-04 adds the rest).
  - **Streaks have no disclosure on purpose:** §8.3 says a reader who never logs progress is never told they are missing one.
  - Tests: one per figure in `stats-phase5` › "ST-03: each figure says what it is missing" (13: a book or session missing exactly that datum; the figure comes from the other alone and coverage says 1 of 2); mobile `stats-phase5` › one per coverage key (13) plus the sentence and units. Mutations each turned a test red: "Unknown Author" counted, `und` kept as a language, the first page event counted as a rise, an untimed session timed, lag over every event.
- [ ] ST-04 Stats screen: one stat per card, share on each — 2d
- [x] ST-05 Goals table; **ring on profile and nowhere else** — 0.75d
  - **Already there:** nothing but the architecture's `goals` sketch and the `goal_reached` activity verb in `activity_verb_ck` (unused).
  - **Built:** migration **0046_goals** (`goals(user_id, year, target_books NOT NULL, target_pages, created_at, updated_at)`, PK `(user_id, year)`, checks: year 1900–9999, 1–10,000 books, 1–10,000,000 pages; idempotent, `pg_constraint` guards). Routes: `GET /v1/me/goal?year&tz`, `PUT /v1/me/goal` (`{year, target_books, target_pages?}`; any time, downward included; 422 `invalid_goal`), `DELETE /v1/me/goal?year=` (idempotent), `GET /v1/users/:id/goal`. Progress is never stored: it is computed per viewer (§17.5) from dated finishes in that calendar year (an undated import belongs to no year), pages by D-08-3, with `books_reached`, `pages_reached` and `pages_coverage`. No goal is `goal: null`, never a zero target. api-client `getMyGoal`, `getUserGoal`, `setMyGoal`, `deleteMyGoal`.
  - **Ring on the profile, nowhere else (§8.6 [LOCKED]):** `src/ui/GoalRing.tsx` (two clipped half-circles; no SVG dependency) on your own profile's stats strip (tap → `GoalSheet` to set, change or remove; no confirmation, no judgement; "Set goal" in its place when none) and, read-only and only when set, on another reader's profile. It shows "12/24" and nothing else. The goal is **not** in the stats response, so the stats screen cannot show it (PRD §6.40 lists a goal ring among the stats screen's components; §8.6 [LOCKED] "exactly two places" wins). Mobile guard test: the only files that touch `GoalRing`, `GoalSheet` or the goal client calls are the two profile screens, the component, its editor, `statsView.ts` (the ring's model) and `api.ts`; another test bans "behind", "ahead", "remaining", "on track" and "are you sure" from the ring, its sheet and its model.
  - Not built (Phase 5 B): the single celebratory moment and share card on completion (§8.6 → ST-10, ST-08) and the Year in Review card (ST-09).
  - Tests: `stats-phase5` › "ST-05: goals" (7): none set is null; set then lower; per viewer (stranger, guest, pending 1 book; follower 2; owner 4 with private reads); blocked either way, random id and a private account's stranger/guest are the same 404, its follower sees it; years separate and delete idempotent; 11 malformed bodies refused with nothing written, DELETE without a year 422, signed out 401; not in the stats response and no schedule words. Matrix row `GET /v1/users/:id/goal`.
- [x] ST-06 Streak with 2-day grace; "longest" framing — 0.75d
  - **Already there (audit 10, A-10-007):** active days are progress-event days and finish dates in the user's zone (`tz`), from reads the viewer may see; current and longest; no grace (the code said so).
  - **Built:** `computeStreaks` with `STREAK_GRACE_DAYS = 2`: a run continues across up to two days without reading; its length is the **calendar span** from its first to its last active day (so it matches the date range beside it); it is current while today is within the grace of its last day; the earliest of equal runs is the longest. The response adds `current_streak_range` and `longest_streak_range`. App: `streakCopy` — a live streak shows "5 days · Reading streak" (and "Longest: 47 days (12 Mar 2025 – 27 Apr 2025)" when longer); a broken one is shown **only** as "Longest streak: 47 days" with its dates; a reader who never logged progress sees nothing. The stats screen's old "Daily Streak 0 (best 12d)" card is gone; the profile strip (own and others') now has the streak, as PRD §16.2 lists. Profile and other-user stats now send the device zone (`tz`) like the stats screen already did.
  - Tests: `stats-phase5` › "ST-06" (7: grace two, three days break, current within grace, span and range, equal runs, nothing logged, through the API in the zone; plus helpers); the hand-computed library's longest run is 5 with grace and would be 3 without. Mobile: framing, nothing for no progress, no loss words on the three screens. Mutations: grace 0 (6 red), grace 3 (3 red).
- [ ] **ST-07** ⚠️ **Server-side share-card renderer** (satori → resvg) — 2.5d
- [ ] ST-08 Templates: finish, review quote, stat, profile, Wall collage — 1.5d
- [ ] **ST-09** Year in Review: story cards, low-volume variant, Dec unlock — 2.5d
- [ ] ST-10 Milestone moments, in-app only — 0.5d

---

## Phase 6 — Launch readiness · `LA` · 15d

- [ ] **LA-01** ⚠️ **Account deletion**: password re-entry, 30-day grace, export offer, hard delete job — 1.5d
  - **Audit 15a (2026-10-10):** the hard-delete step exists: the daily retention sweep deletes an account 30 days after deletion, its stored objects first (A-15-008). Password re-entry, the export offer and the UI remain.
- [ ] LA-02 Settings: privacy, notifications, content, libraries, appearance, blocked, about — 2d
- [ ] LA-03 Onboarding polish; import-first ordering; skip everywhere — 1.5d
- [ ] LA-04 Every empty, loading and error state audited — 1.5d
- [ ] **LA-05** Deploy script; Caddy; migrate-then-restart; rollback — 1d
  - **Audit 02c (2026-09-25):** before the first production deploy, migration `0019_credited_authors` needs a **batched backfill** of `authors.has_works` and `CREATE INDEX CONCURRENTLY` for `authors_credited_trgm_idx`, outside the migration transaction. As written it held an `ACCESS EXCLUSIVE` lock on `authors` for ~65 min on the full local catalog (64 min 41 s), which blocks every author read and write, search's author arms included; see A-02-022 and Part 02c in `docs/audit/findings/02-search.md`.
- [ ] **LA-06** ⚠️ **Backups every 6h, off-machine, encrypted** — 0.5d
- [ ] **LA-07** ⚠️ **Restore drill — restore and verify. Not optional** — 0.5d
- [ ] LA-08 `/healthz`, `/readyz`, Prometheus metrics, uptime pinger, alerts — 1d
- [ ] LA-09 Admin: ops and metrics areas — 1d
- [ ] **LA-10** ⚠️ Full a11y pass: screen reader, 200% type, contrast both themes — 1.5d
- [ ] **LA-11** Device pass: reference device, 360dp, 3GB RAM — 1d
- [ ] LA-12 Relevance panel to ≥95%; fix ranking or filter — 1d
- [ ] LA-13 Legal: terms, privacy policy, community guidelines, attributions — 1d
- [ ] LA-14 Play Console, listing, screenshots, privacy labels — 1d
- [ ] LA-15 Closed beta on sideloaded APKs; triage — ongoing

---

## Post-launch backlog

| ID | Task | Phase |
|---|---|---|
| PL-01 | Item-item collaborative filtering | 7 |
| PL-02 | Taste correlation, readers-like-you | 7 |
| PL-03 | pgvector, book embeddings, similar books | 7 |
| PL-04 | **iOS launch** | 7 |
| PL-05 | Social sign-in (Google + Apple together) | 7 |
| PL-06 | Quotes and passages | 8 |
| PL-07 | Quote OCR capture | 8 |
| PL-08 | Review summarisation | 8 |
| PL-09 | Natural-language search | 8 |
| PL-10 | Spoilers-after-page-N | 8 |
| PL-11 | Flyleaf Plus + RevenueCat | 9 |
| PL-12 | "Where to read" — library links first | 9 |
| PL-13 | Collaborative shelves | 9 |
| PL-14 | Full web app + SEO | 10 |
| PL-15 | Localisation (Hindi, Spanish) | 10 |

---

## Effort summary

| Phase | Days | Weeks |
|---|---|---|
| −1 Skeleton | 5 | 1 |
| 0 Foundation (accelerated) | 15 | 3 |
| 1 Solo loop | 40 | 8 |
| 2 Shelves | 10 | 2 |
| 3 Import/export | 10 | 2 |
| 4 Social | 20 | 4 |
| 5 Stats & YIR | 15 | 3 |
| 6 Launch | 15 | 3 |
| **Total** | **130** | **26** |

Plus ~1 week slack → **27 weeks**.

---

## The twenty ⚠️ tasks

Cheap now, expensive or impossible later. If time is short, these are the last things to cut.

| ID | Why it cannot wait |
|---|---|
| FN-11 | Provenance is unbackfillable — origin of existing rows is unrecoverable |
| FN-22, FN-24 | Filter and maturity classification happen *during* ingest or not at all |
| FN-25 | Without raw payloads, a normaliser fix means 2 days of re-fetching at 1 req/s |
| FN-30 | Two independent limiters breach the limit together and get you IP-blocked |
| FN-43 | Relevance regressions are invisible without the panel |
| FN-64 | Reuse detection turns a stolen token from permanent to brief |
| FN-70/71/72 | Retrofitting a viewer argument means touching every query |
| FN-93 | Moderation decisions get challenged; "I don't remember why" is not an answer |
| FN-06 | Auth limits must be exact across instances, and the interfaces are what make adding Redis a config change |
| SL-10→13 | The offline queue is the one bug class that silently destroys user history |
| SL-30→33 | Guest mode is where the growth loop currently leaks |
| SL-51 | Non-idempotent progress writes double-count on every retry |
| SL-62 | Raw averages let one 5-star rating outrank a beloved classic |
| SL-80/81 | An unmeasured budget erodes one field at a time |
| IM-03, IM-05, IM-06, IM-07 | Bad imports destroy trust with your highest-value users |
| SO-03, SO-06 | An incomplete block protects nobody |
| SO-11, SO-14 | An empty feed on day one is the top cause of churn |
| SO-21 | The core social event is unlikeable without it |
| SO-31 | Notification limits are far harder to add after users are trained |
| SO-50 | Without public pages every share is a dead link |
| ST-01, ST-03 | Fabricated or leaked statistics are unrecoverable trust failures |
| LA-01 | Store requirement — no deletion, no launch |
| LA-06, LA-07 | The only failure mode that ends the project |
| LA-10 | Accessibility retrofits cost several times more than building it in |
