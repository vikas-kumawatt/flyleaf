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
- [x] **FN-24** ⚠️ Maturity classification from subjects + imprints. `unclassified` is never treated as a synonym for `general`; children's classification beats a mature keyword — 1d
- [x] **FN-25** ⚠️ Raw payload persistence + hash-skip, so the monthly re-ingest does not rewrite unchanged rows and a classifier fix is a reprocess rather than a 12 GB re-download — 0.5d
- [x] **FN-26** `--finalise` pass: cover backfill, default editions, ANALYZE. `--seed` takes the popularity slice from the **reading-log dump (65 MB)** rather than guessing from edition counts — 0.5d

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
- [x] **FN-40** Search query: **prefix** tsvector (`token:*`) + ILIKE substring + trigram + author, as four INDEPENDENT indexed arms unioned into a small candidate set. Merged and provisional works excluded; LIKE metacharacters escaped; `to_tsquery` input sanitised. `SEARCH_SQL` is exported so the tests run the real query, not a copy — 1d
- [x] **FN-41** Popularity (`--popularity`) + ranking: title prefix 0.30 · exact title 0.20 · author match 0.20 · trigram 0.10 · `ln(1+log_count)` capped, 0.35. **3,203,476 works scored**; most-logged is Atomic Habits at 64,006 — 0.5d

> ### Search on 3.2M works: 40s → 47ms
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

> **Settings that must be set on the DATABASE, not the session.** `pg_trgm.similarity_threshold` via `ALTER DATABASE`, because a plain `SET` lands on one pooled connection out of ten. It reaches NEW connections only, so the API needs a restart — and the test harness sets it explicitly, or tests would quietly run at 0.3 while production runs at 0.45.
- [x] **FN-42** ISBN detection → exact edition path — 0.5d
  - Added `apps/api/src/catalog/isbn.ts`: `cleanIsbn`, `isValidIsbn10` (mod-11), `isValidIsbn13` (mod-10), `isbn10ToIsbn13`, `isbn13ToIsbn10`, and `detectIsbn` with bidirectional 10↔13 checksum cross-conversion.
  - Added exact edition resolver `CatalogService.getEditionByIsbn(viewer, isbn)` and updated `search(q, limit)` to prioritize exact ISBN matches as result #1 (PRD §1013, §14.2).
  - Added `GET /v1/editions/isbn/:isbn` endpoint (guest-readable barcode scan path, PRD §3374) with `editionLookupResponseSchema` and `isbnParamSchema`.
  - Regenerated `openapi.yaml` with 0 drift and added typed `getEditionByIsbn` to `@flyleaf/api-client`.
  - 18 tests in `apps/api/src/test/isbn.test.ts`; 217-query relevance panel holds 99.5% (216/217); full CI suite green (313 tests across 11 test suites).
- [x] **FN-43** ⚠️ **217-query relevance panel**, hard cases included, runs in CI — 1d
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
  - ⚠️ **A merge is seven repoints, and four of them collide.** `reads` has `UNIQUE (user_id, work_id, attempt_no)`, so a user who logged **both** duplicates breaks the naive `UPDATE reads SET work_id = survivor`. Attempts are renumbered to continue after that user's existing ones — which is also the semantically right answer, since they did read it twice. `work_authors`, `work_subjects` and `series_entries` collide on their primary keys (insert-then-delete with `ON CONFLICT DO NOTHING`); `work_stats` is keyed on `work_id` alone and is dropped rather than merged, because summing it would double-count anyone who logged both copies — `stats.workstats` recomputes from the reads that just moved. Merge **chains** are flattened, or resolving an old id takes two hops and the next merge makes it three.
  - ⚠️ **`work_merges` is written by the merge, not by the undo.** PRD §40.3 wants 30-day reversibility; once a merge has renumbered `attempt_no` and forgotten the old values, the undo is not deferred work, it is impossible. The prior attempt numbers go into `moved` jsonb at merge time. A partial unique index on `loser_id WHERE undone_at IS NULL` makes merging the same work twice an error — it would mean it came back from the dead.
  - **Stage 1 is written and inert.** ISBNs live on editions and the catalog has 102 of them, so it finds nothing until the editions pass runs. It is here rather than deferred because the merge machinery is identical and writing it later means re-deriving all of the collision handling above.
  - The normalisation rule exists **twice** — TypeScript for callers, SQL for the 3.2M-row scan — so there is a test asserting the two agree on 15 titles. Two implementations of one rule is how a dedupe pass starts merging the wrong things, and the divergence would surface as books quietly disappearing.
  - Not accent-folded, deliberately: `flyleaf_unaccent` is for search, where a false match costs a slightly wrong result. Here a false match destroys a book, and folding would collide distinct translations.
- [x] **FN-51** Stage 3–4 queue; 30-day undo; admin review UI — 1d
  - Migration `0008_dedupe_queue.sql` introduces `dedupe_queue` table with foreign keys, checks, and unique indexes preventing duplicate reviews.
  - Stage 3 detection (`findStage3Candidates` / `queueStage3Candidates`): Trigram title similarity > 0.85, author similarity > 0.9, first publication year ±2. Never auto-merges; always enqueues for human review (PRD §40.3).
  - Stage 4 reporting (`queueReportedDuplicate`): Accepts user and admin duplicate reports with validation and collision checks.
  - 30-day reversible undo engine (`undoMerge`): Enforces `merged_at >= now() - interval '30 days'` window and restores loser work, reclaims moved reads to exact prior attempt numbers, un-merges authors, subjects, and editions, and marks merge record `undone_at`.
  - Preview & collision forecasting (`previewMerge`): Queries survivor and loser side-by-side to forecast colliding reads (user read both), moved reads, and merged metadata prior to applying changes.
  - Admin dedupe REST endpoints (`/v1/admin/dedupe/queue`, `/v1/admin/dedupe/preview/:survivorId/:loserId`, `/v1/admin/dedupe/queue/:id/resolve`, `/v1/admin/dedupe/report`, `/v1/admin/merges`, `/v1/admin/merges/:id/undo`) and server-rendered HTML review UI (`/admin/merges`) with confidence badges, side-by-side cards, and 1-click undo.
  - Complete OpenAPI spec synchronization (`openapi.yaml`) with 0 contract drift, plus typed `@flyleaf/api-client` methods (`getDedupeQueue`, `previewDedupeMerge`, `resolveDedupeQueueItem`, `reportDuplicate`, `getRecentMerges`, `undoMerge`).
  - 38 unit & route tests in `apps/api/src/test/dedupe.test.ts` passing.
- [x] **FN-52** Register `catalog.dedupe` as the monthly pg-boss job — 0.5d
  - Registered `QUEUES.catalogDedupe = 'catalog.dedupe'` in `apps/api/src/jobs/index.ts`.
  - Added pure `dedupeJobHandler` wrapping `runDedupe(db, opts)` and worker event logging.
  - Scheduled monthly cron (`0 0 1 * *`) in `apps/api/src/worker.ts` with `--dedupe` standalone worker runner.
  - Verified job registration, handler execution, and full lifecycle in `apps/api/src/test/jobs.test.ts`. Complete monorepo CI green.

### Auth — `FN-6x` · 5d
- [x] **FN-60** users, refresh_tokens, profiles migrations — 0.5d
  - Migration `0005_auth.sql` applies cleanly on an empty database and live database. `users` gained `date_of_birth` (13+ age gate), `email_verified_at`, `role`, and `deleted_at`. `username` lives on `profiles`. `sessions` replaced by `refresh_tokens`.
- [x] **FN-61** argon2id (`@node-rs/argon2`); common-password list; 10-char minimum — 0.5d
  - `isCommonPassword` check rejects top dictionary passwords regardless of length. `passwordSchema` enforces 10-character minimum without entropy-reducing composition rules.
- [x] **FN-62** Register, login, DOB age gate — 1d
  - `isAtLeast13` rejects registration for users under 13 years old per PRD §26.6. `IdentityService.register` and `login` return full user + profile context with rate-limited login.
- [x] **FN-63** **JWT 15m (`jose`) + opaque rotating refresh, hashed, `family_id`** — 1d
  - 15-minute HS256 JWT evaluated statelessly by Fastify's `onRequest` hook. 256-bit cryptographically secure opaque refresh tokens stored as SHA-256 hashes with 60-day expiry.
- [x] **FN-64** ⚠️ **Reuse detection: used token → revoke whole family** — 0.5d
  - Presenting an already-consumed refresh token immediately revokes all tokens matching its `family_id` and rejects with 403 `token_reused`. All 35 identity tests pass in 2.8s.
- [x] **FN-65** Email verification + password reset behind a sender interface — 1d
  - Defined swap-ready `EmailSender` interface, `ConsoleEmailSender`, and `MemoryEmailSender` in `platform/mail.ts`.
  - Added `email_verification_tokens` and `password_reset_tokens` tables (SHA-256 hashed, short-lived, single-use) with migration `0007_auth_tokens.sql` applied to live PostgreSQL.
  - Implemented `POST /v1/auth/verify-email` (burns token, marks `users.email_verified_at`), `POST /v1/auth/resend-verification` (authenticated `Bearer`, 1/60s rate limit, no-op when verified), `POST /v1/auth/forgot-password` (unauthenticated, always 200 without email enumeration), and `POST /v1/auth/reset-password` (argon2id update, burns token, **revokes all active refresh token families** for user).
  - Registration automatically dispatches a 24-hour verification token.
  - Updated Fastify route schemas, regenerated `openapi.yaml` with 0 drift, and added typed methods to `@flyleaf/api-client`. 42 tests in `identity.test.ts`, 289 tests passing across full suite in CI.
- [x] **FN-66** Session list + per-device revoke — 0.5d
  - Added `sessionSchema`, `sessionListResponseSchema`, and `revokeSessionResponseSchema` in `apps/api/src/contract/schemas.ts`.
  - Device info captured via `User-Agent` request header on register/login and preserved during refresh token rotation.
  - Implemented `IdentityService.listSessions(userId)` grouping unrevoked, unexpired tokens by `family_id` and device, returning `id`, `device`, `createdAt`, `lastUsedAt`.
  - Implemented `IdentityService.revokeSession(userId, familyId)` revoking the entire token family (returns 404 `not_found` if not owned by caller or already revoked).
  - Implemented `IdentityService.logoutAll(userId)` revoking all active sessions for the user.
  - Added endpoints `GET /v1/auth/sessions`, `DELETE /v1/auth/sessions/:id`, and `POST /v1/auth/logout-all` with Bearer auth.
  - Updated `@flyleaf/api-client` with typed `Session` interfaces and `getSessions()`, `revokeSession()`, `logoutAll()` methods; fixed request helper so empty body DELETE/POST does not attach content-type.
  - 47 unit/HTTP tests in `identity.test.ts` and contract tests in `contract.test.ts`; 295 tests passing across full CI suite with 0 OpenAPI drift.

### Authorization — `FN-7x` · 3d
- [x] **FN-70** ⚠️ Repository layer: **viewer ID a required argument everywhere** — 1d
  - Enforced `viewer: string | null` (or `viewer: string` for authenticated operations) as the required first argument across `ReadingService` (`get`, `list`, `upsert`, `addProgress`), `CatalogService` (`getWork`), and `IdentityService` (`getProfile`). No method reading user-scoped data can be queried without a viewer argument.
  - Added `visibility` column to `reads` table with migration `0006_reads_visibility.sql` (`CHECK IN ('public', 'followers', 'private')`, default `'public'`).
  - Added `GET /v1/reads/:id` and `GET /v1/users/:id/reads` endpoints supporting guest (`req.viewer === null`) and authenticated callers.
- [x] **FN-71** ⚠️ Single `canView()`: public/followers/private/blocked/guest — 0.5d
  - Implemented centralized `canView()` and `assertCanView()` in `src/authorization/index.ts` covering complete bidirectional block invisibility, owner access, private item visibility, private account visibility, followers-only items, and guest access.
- [x] **FN-72** ⚠️ **Cross-user access test suite — 404 not 403, every private type** — 1.5d
  - Implemented comprehensive unit matrix and HTTP injection test suite in `src/test/authorization.test.ts` (43 tests).
  - Asserts that guest callers, non-followers, and blocked callers attempting to view another user's private reads, followers-only reads, private accounts, or add progress to another user's read receive **404 Not Found** with error code `'not_found'` — **never 403 Forbidden**.


### API contract — `FN-8x` · 2d
- [x] **FN-80** Fastify route schemas for the Phase 0–1 surface; `openapi.yaml` generated from them — 1d
  - Defined Fastify route schemas (`schema: { params, querystring, body, response }`) and reusable JSON schemas in `apps/api/src/contract/schemas.ts` for all Phase 0–1 endpoints across `Auth`, `Catalog`, `Reading`, and `System`.
  - Integrated `@fastify/swagger` and `yaml` with OpenAPI 3.1.0 specifications and BearerAuth security scheme.
  - Implemented `npm run spec:generate` and `npm run spec:check` in `src/contract/generate.ts`, generating `openapi.yaml` at repo root with zero schema drift.
- [x] **FN-81** Typed client generated into `packages/api-client`, CI-enforced — 0.5d
  - Created `packages/api-client` containing TypeScript interfaces and typed `FlyleafClient` with full endpoint coverage and standard error parsing (`FlyleafApiError`).
  - Connected `apps/mobile/src/lib/api.ts` to `@flyleaf/api-client`, replacing hand-written endpoint types and contracts with Fastify route schema bindings.
  - Added `api-client · build` and `api · spec check` to `scripts/ci.mjs`, ensuring CI breaks if schemas, `openapi.yaml`, or `@flyleaf/api-client` drift. 282 tests passing across 10 test suites in CI.
- [x] **FN-82** Hook chain incl. the auth hook that never rejects (guests) — 0.5d
  - Centralized Fastify hook chain and app factory in `apps/api/src/app.ts` (`registerCoreHooks` & `buildApp`).
  - **Auth hook that never rejects (PRD §4.2, Architecture §3.3 & §7)**: Statelessly extracts Bearer token, populates `req.viewer` when valid, and falls back to `req.viewer = null` for guests. Never throws 401/500 on expired, forged, malformed, or missing tokens; protected endpoints enforce authentication explicitly via `requireViewer(req)`.
  - **Correlation & defensive headers**: Injected `X-Request-Id` (propagating `req.id`), `X-Content-Type-Options: nosniff`, and `X-Frame-Options: DENY` on every response via `onSend` hook.
  - **Error envelope & not found**: Centralized `setErrorHandler` mapping `ApiError` status/envelope, Fastify schema validation to 422 `invalid_field`, malformed JSON to 400 `invalid_json`, and unhandled errors to 500 `internal`. Uniform 404 handler.
  - Refactored `server.ts` and test harnesses (`identity.test.ts`, `contract.test.ts`, `isbn.test.ts`, `authorization.test.ts`) to use shared core hooks.
  - Dedicated 17-test suite in `apps/api/src/test/hooks.test.ts`; 330 tests passing across 12 test suites in full CI. All tasks in **API contract `FN-8x`** are now complete.

### Admin (early slice) — `FN-9x` · 2d
- [x] **FN-90** Admin auth, separate from app accounts, 2FA — 0.5d
  - Migration `0009_admin_auth.sql` introduces isolated `admin_credentials` table storing RFC 6238 TOTP secrets and SHA-256 backup codes.
  - Zero-dependency RFC 6238 TOTP engine in `apps/api/src/admin/totp.ts` with ±1 step clock drift tolerance, base32 encoding/decoding, and backup code hashing.
  - Role-based token isolation with `aud: 'flyleaf-admin'` and `scope: 'admin'`. Regular app tokens rejected immediately on admin routes (`admin_auth_required`).
  - Role separation: `moderator` (read-only review access to queue & audit trail) vs `admin` (can execute and undo catalog merges).
  - Admin login (`POST /v1/admin/auth/login`) requires valid password AND TOTP (or backup code).
  - Server-rendered admin web console at `/admin/login`, `/admin/merges`, and `/admin/audit-log` with secure session cookies (`flyleaf_admin_session`).
- [x] **FN-91** Merge review UI + undo — 0.75d
  - Delivered with FN-51 & FN-90: Server-rendered dashboard (`/admin/merges`), side-by-side work comparison cards, collision forecasting, and 1-click reversible 30-day undo.
- [x] **FN-92** Maturity override; ingestion status dashboard — 0.75d
  - Catalog works inspection & review API (`GET /v1/admin/catalog/works`, `GET /v1/admin/catalog/works/:id`) with maturity filter (`unclassified`, `general`, `mature`, `explicit`) and text search.
  - Non-negotiable maturity override (`POST /v1/admin/catalog/works/:id/maturity`): Updates `works.maturity`, locks `field_provenance` (`is_locked = true`, `provider = 'user'`) to protect human overrides from dump re-ingests, and logs to `admin_audit_log` with action `catalog.maturity_override` and mandatory human reason.
  - Role gating: `requireModerator` for reading works and status; `requireAdmin` for maturity mutations (moderator receives 403 `insufficient_role`).
  - Ingestion status dashboard (`GET /v1/admin/ingest/status`): Ingest runs history (`ingest_runs`), catalog breakdown (works, editions, authors, covers, raw payloads, maturity distribution), pending authorship queue depth, dedupe queue depth, and `outboundBreaker` state (`closed`, `open`, `half-open`) with rate limiter headroom.
  - Server-rendered HTML console views at `/admin/catalog/maturity` and `/admin/ingest` with shared navigation bar, role badges, and interactive override modal.
  - Zero-drift OpenAPI 3.1.0 specifications and typed client methods in `@flyleaf/api-client` (`adminGetCatalogWorks`, `adminGetCatalogWork`, `adminOverrideMaturity`, `adminGetIngestStatus`).
  - 7 dedicated test cases in `apps/api/src/test/admin-catalog.test.ts`. 100% test pass rate across 14 test suites in CI. Phase 0 Foundation is now complete.
- [x] **FN-93** ⚠️ `admin_audit_log` on every action — 0.25d
  - Migration `0009_admin_auth.sql` introduces `admin_audit_log` with indexes on `(created_at desc)` and `(actor_id, created_at desc)`.
  - Non-negotiable audit logging (`logAdminAction`) automatically records every admin action: logins (`admin.login`), dedupe merges (`catalog.merge`), undos (`catalog.undo`), and dismissals (`catalog.dismiss`).
  - Enriched audit log entries capture actor ID, email, role, target resource/subject, reason, IP address, user agent, and contextual payload diffs.
  - Audit log query API (`GET /v1/admin/audit-log`) with filtering by `action`, `actorId`, and pagination.
  - HTML audit trail viewer at `/admin/audit-log` with formatted JSON payloads and chronological history.
  - 22 dedicated test cases in `apps/api/src/test/admin.test.ts`. 100% test coverage for 2FA, token isolation, role enforcement, and audit recording.

**Exit:** 50 owned books findable · panel ≥90% · cross-user suite green · migrations clean in CI.

---

## Phase 1 — Solo loop · `SL` · 40d

### Client foundation — `SL-0x` · 6d
- [x] **SL-00** ⚠️ Run `npx expo install --check` and `npx expo-doctor` before adding any mobile dependency. Expo Go rejects a project whose native module versions differ from what it ships — pin from `bundledNativeModules.json`, never npm `latest` — 0.25d
- [x] **SL-01** Expo Router shell, 5 tabs + centre FAB — 1d
- [x] **SL-02** Design system from `design.md`: tokens, Button, Card, Sheet, Cover, StarRating, Heart, ProgressBar, Skeleton, EmptyState — Reanimated + gesture-handler — 3d
- [x] **SL-03** API client wiring, TanStack Query, error surface — 0.5d
- [x] **SL-04** `expo-secure-store` refresh token; 401 → refresh interceptor — 1d
- [x] **SL-05** Theme switching, system default, both palettes verified — 0.5d

### Offline — `SL-1x` · 6d
- [x] **SL-10** ⚠️ SQLite schema mirroring reads + progress_events — 1d
- [x] **SL-11** ⚠️ **Mutation queue: persist, replay, backoff, dead-letter** — 2d
- [x] **SL-12** ⚠️ `client_event_id` generation + idempotent replay — 0.5d
- [x] **SL-13** ⚠️ **Offline queue test suite incl. simulated process death** — 1.5d
- [x] SL-14 Sync-on-foreground and on reconnect; unsynced indicator — 1d

### Auth screens — `SL-2x` · 3d
- [x] SL-20 Welcome carousel with "Look around first" — 0.5d
- [x] SL-21 Sign up / log in / forgot / reset / verify — 1.5d
- [x] SL-22 Username + avatar; live availability; reserved words — 1d

### Guest mode — `SL-3x` · 3d
- [x] **SL-30** ⚠️ Guest routing: no session → Home in browse mode — 0.5d
- [x] **SL-31** ⚠️ **Action gate**: contextual prompt at Log/Rate/Follow/Like, one-tap dismiss — 1d
- [x] **SL-32** ⚠️ Local Want-to-Read (cap 20) — 0.75d
- [x] **SL-33** ⚠️ **Migrate local shelf on signup + confirmation copy** — 0.75d

### Catalog screens — `SL-4x` · 7d
- [x] **SL-40** Search screen: debounce 250ms, tabs, recents, filters — 2d
- [x] **SL-41** **Book detail**: hero, status control, rating + histogram, description, metadata, tabs — 2.5d
- [x] **SL-42** Cover-forward edition picker; "the copy I own" — 1d
- [x] SL-43 Author page; series page with your progress — 1d
- [x] SL-44 Barcode scanner + permission rationale + manual fallback — 0.5d

### Reading core — `SL-5x` · 9d
- [x] **SL-50** reads + progress_events migrations & repos — 1d
- [x] **SL-51** ⚠️ `POST /reads/{id}/progress` idempotent on `client_event_id` — 0.5d
- [x] **SL-52** **Reading tab**: cards, slider auto-save, +10, predicted finish — 2.5d
- [x] **SL-53** Progress sheet: numeric entry, chips, **optional minutes**, note, quote — 1d
- [x] **SL-54** **Finish flow**: stars visible, heart, date, format chips, review, ≤20s — 2d
- [x] **SL-55** DNF flow: page pre-filled, reason chips, neutral copy — 0.75d
- [x] **SL-56** Re-read: new row, `attempt_no+1` — 0.5d
- [x] SL-57 Want-to-read queue; sort, filter, bulk — 0.75d

### Ratings, reviews — `SL-6x` · 5d
- [x] **SL-60** Half-star control, extra hit area, haptic, `adjustable` trait — 1d
  - Delivered interactive `Stars` component in `apps/mobile/src/ui/components.tsx` with continuous dragging (`Gesture.Pan()`), 0.5-star resolution (0.5 to 5.0), and hit-slop-extended 44x44 minimum touch targets.
  - Haptic feedback tick (`Haptics.selectionAsync()`) on every 0.5 step boundary crossed during drag or tap.
  - Spring-scale pop animation (`withSequence`) on rating commit.
  - Fully accessible with `accessibilityRole="adjustable"` and custom `increment` / `decrement` accessibility actions announcing half-star steps to screen readers.
- [x] **SL-61** Heart, independent of rating — 0.25d
  - Built standalone `Heart` component in `apps/mobile/src/ui/components.tsx` with 44x44 touch target, independent of star rating (a reader can heart a 3-star or 5-star book alike, or heart without rating).
  - Spring scale bounce feedback (`withSequence`) and `Haptics.impactAsync` on toggle.
- [x] **SL-62** ⚠️ Bayesian weighted rating + trigger-maintained `work_stats` — 1d
  - Migration `0011_ratings_reviews.sql` introduces PostgreSQL trigger function `recompute_work_stats_for_work` and trigger `reads_work_stats_trigger` maintaining `work_stats` (`rating_count`, `rating_sum`, `avg_rating`, `weighted_rating`, `review_count`) automatically on every read insert/update/delete.
  - Bayesian arithmetic formula `(v / (v + m)) * R + (m / (v + m)) * C` implemented in `apps/api/src/reviews/index.ts` with `m = 25` threshold and catalog benchmark `C = 3.90` (dynamically derived from catalog average excluding target work).
  - Catalog query integration in `apps/api/src/catalog/index.ts` projecting `avg_rating`, `weighted_rating`, and `rating_count` on all work lookups.
  - 12 comprehensive unit tests in `apps/api/src/test/reviews.test.ts` verifying Bayesian shrinkage and trigger consistency.
- [x] **SL-63** Review composer: autosave every 3s, spoiler, visibility — 1.5d
  - Review composer modal screen at `apps/mobile/app/review/compose/[id].tsx` with 3-second debounce autosave to `expo-secure-store`.
  - Spoiler toggle switch with optional starting page threshold (`spoiler_after_page`), visibility selector (`public`, `followers`, `private`), and live character counter with soft warning at 5,000 and hard cap at 10,000 characters.
  - Offline mutation queue integration (`save_review`) in `apps/mobile/src/offline/queue.ts` and `repository.ts` with optimistic local storage and background replay.
- [x] **SL-64** Review detail + book reviews list, friends-first sort — 1.25d
  - Book Reviews tab on `apps/mobile/app/work/[id].tsx` with Bayesian stats headline, rating filter chips (`All`, `5★`..`1★`), and 5 sort modes: `friends` (friends-first algorithm from PRD §10.7), `likes`, `newest`, `highest`, `lowest`.
  - Review cards with author avatar, rating, spoiler gate with tap-to-reveal, and instant like toggle.
  - First-class Review Detail screen at `apps/mobile/app/review/[id].tsx` with book context strip, full text, like button, native share sheet, and delete action for author.
  - Social review ranking algorithm in `apps/api/src/reviews/index.ts` balancing social proximity (0.35 weight), engagement (0.20), comments (0.10), recency decay (0.15), and quality length (0.10). Zero contract drift in OpenAPI specification.

### Diary, Wall, Profile, Stats — `SL-7x` · 7d
- [x] **SL-70** Diary — **list · grid · calendar**, year jump, filters — 2.5d
  - Delivered `apps/mobile/src/ui/DiaryView.tsx` and standalone screen `apps/mobile/app/diary.tsx`, embedded into Reading tab (`apps/mobile/app/(tabs)/reading.tsx`) and Profile screen (`apps/mobile/app/(tabs)/profile.tsx`).
  - Three distinct viewing modes:
    1. **List view**: Chronological timeline grouped by month/year with finish date badges, book covers, titles, authors, star ratings, and hearted markers.
    2. **Grid view**: Visual cover shelf/posters with rating chips and finish dates.
    3. **Calendar view**: Heatmap calendar matrix showing month days with dot indicators for reading completions, month navigation, and tap-to-inspect date drawer.
  - Year jump selector (`All Time`, `2026`, `2025`...) with auto-computed years from read history, quick-toggle format filter (`print`, `ebook`, `audiobook`), star rating filter (`5★+`, `4★+`, `3★+`), and Hearted-only filter toggle.
  - Volume summary bar displaying total books, pages read, and audio hours for the active filter slice.
- [x] **SL-71** **The Wall**: 3-col grid, filters incl. Hearted, 2-col below 340dp — 1.5d
  - Dedicated screen at `apps/mobile/app/wall.tsx` and parameterized user wall at `apps/mobile/app/wall/[id].tsx`.
  - Responsive column layout using window width measurement: renders 3 columns on standard mobile devices and seamlessly collapses to 2 columns on screens under 340dp width.
  - Filter and sort controls: Hearted toggle pill (`♥ Hearted`), Year selector pills, Rating filters (`5★+`, `4★+`, `3★+`), Format selector pills (`Print`, `Ebook`, `Audiobook`), and Sort menu (`Finished (newest)`, `Rating (highest)`, `Title (A-Z)`).
  - High-density poster aesthetic with fluid aspect ratio covers (`aspectRatio: 2 / 3`), subtle rating badges, and instant navigation to book details.
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
- [x] **SL-73** Favourites picker (4, ordered, drag) — 0.5d
  - Standalone manager screen at `apps/mobile/app/profile/favourites.tsx`.
  - Exactly 4 ordered slots (`#1` through `#4`) displaying book cover, title, author, and move Up/Down reordering controls with haptic feedback.
  - Remove button to free up slots; Add button opening live catalog search modal to find and select works from user's history or catalog.
  - Direct integration with `PATCH /v1/me/profile` sending ordered `favourites: [{ work_id, position }]` payload.
- [x] **SL-74** Basic stats: volume, temporal, taste, extremes — 0.5d
  - Dedicated stats screen at `apps/mobile/app/stats.tsx` and user stats at `apps/mobile/app/stats/[id].tsx`.
  - Comprehensive statistical insights:
    - **Volume & Habit**: Books finished, pages read, audio hours, and reading habit daily/longest streaks.
    - **Temporal Pace**: 12-month interactive bar chart tracking books and pages read per month.
    - **Taste & Ratings**: Average star rating and rating distribution histogram (1★ to 5★).
    - **Format Breakdown**: Percentage and count split across print, ebook, and audiobook editions.
    - **Reading Extremes**: Longest book read, shortest book read, and most read author with book counts.
    - **Did Not Finish (DNF)**: Abandoned book count and DNF rate percentage.
  - Backend aggregation service in `apps/api/src/reading/index.ts` and `apps/api/src/identity/index.ts` with `GET /v1/me/stats`, `GET /v1/users/:id/stats`, `GET /v1/me/profile`, and `PATCH /v1/me/profile`.
  - 8 backend tests in `apps/api/src/test/profile-stats.test.ts` and 9 mobile unit tests in `apps/mobile/src/lib/__tests__/profile-stats.test.ts`. 100% green CI pipeline.

### Instrumentation — `SL-8x` · 2d
- [x] **SL-80** ⚠️ `events` table + client emitter — 0.5d
  - Created migration `apps/api/drizzle/0012_events.sql` declaring PostgreSQL `events` table (`id bigserial`, `name text`, `user_id uuid`, `session_id uuid`, `platform text`, `app_version text`, `properties jsonb`, `at timestamptz`) with composite indexes on `(name, at desc)` and `(user_id, at desc)`.
  - Registered route `POST /v1/events` in `apps/api/src/telemetry/index.ts` accepting batched telemetry events with payload validation and optional bearer auth extraction.
  - Implemented client event emitter and memory queue in `apps/mobile/src/lib/events.ts`:
    - 30-minute idle session lifetime with automatic UUID v4 rotation.
    - Automatic periodic flush (15s timer) and threshold-triggered flush (>= 20 events).
    - AppState lifecycle hook flushing events when app moves to background.
    - Offline resilience: retained events on network failure (prepended up to 200 items).
- [x] **SL-81** ⚠️ **Instrument the §4.4 budgets**: progress duration, finish duration, tap counts, abandonment — 1d
  - Built real-time budget instrumenter in `apps/mobile/src/lib/budgetTracker.ts` measuring the 5 non-negotiable PRD §4.4 interaction budgets:
    1. `progress_updated`: duration from Reading tab focus to save (budget: p75 < 5s). Integrated into slider release, quick add, and progress sheet.
    2. `book_logged`: tap count from impression to shelved (budget: p75 <= 2 taps). Integrated into work detail and reading queue.
    3. `finish_completed`: duration from Finish tap to save (budget: p75 < 20s). Integrated into Finish flow modal (`FinishScreen`) and review composer.
    4. `finish_flow_abandoned`: tracks flow abandonment when user dismisses without saving (budget: < 8% abandonment).
    5. `log_sheet_completed`: duration from `+` FAB or Update sheet tap to save (budget: p75 < 15s).
  - Admin budget analytics endpoint `GET /v1/admin/telemetry/budgets` computing PostgreSQL `percentile_cont(0.75)` for progress, finish, and log sheet durations, tap counts, and flow abandonment rate.
  - 10 mobile unit tests covering event queuing, session rotation, and all 5 budget events in `apps/mobile/src/lib/__tests__/telemetry-budgets.test.ts`.
- [x] **SL-82** Sentry, app + API — 0.5d
  - API Sentry integration in `apps/api/src/telemetry/sentry.ts` and `apps/api/src/app.ts`: custom Fastify 500 error hook capturing unhandled exceptions with automatic redaction of sensitive headers (`authorization`, `cookie`, `secret`, `password`, `token`, `totp`).
  - Mobile Sentry wrapper in `apps/mobile/src/lib/sentry.ts` with exception formatting, platform tagging, and graceful fallback.
  - Global `ErrorBoundary` in `apps/mobile/src/ui/ErrorBoundary.tsx` wrapping the application root in `apps/mobile/app/_layout.tsx` with user-friendly recovery screen and error reporting.
  - 7 backend tests in `apps/api/src/test/telemetry.test.ts` covering event ingestion, budget calculation, moderator role gating, and Sentry context sanitization. 100% green CI pipeline.

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
- [x] **SH-02** Create/edit: name, description, privacy, ranked toggle — 1d
  - Backend `ShelvesService` (`create`, `get`, `update`, `delete`, `generateUniqueSlug`) and Fastify route plugin registered at `/v1/shelves`.
  - Enforced per-user unique URL slugs with collision disambiguation (`slug`, `slug-1`, `slug-2`) per PRD §15.2.
  - Strict privacy authorization using centralized `canView()` matrix (public, followers-only, private) with 404 returned on denial to prevent shelf enumeration.
  - 30-day soft deletion lifecycle (`deleted_at`) hiding deleted shelves from readers.
  - Full OpenAPI contract synchronization with schemas in `apps/api/src/contract/schemas.ts`, updated `openapi.yaml` (0 drift), and typed client methods in `@flyleaf/api-client` (`createShelf`, `getShelf`, `updateShelf`, `deleteShelf`).
  - Native mobile screens in `apps/mobile/app/shelf/create.tsx` and `apps/mobile/app/shelf/[id]/edit.tsx` with name (1–60 chars), description (<= 2000 chars), privacy radio picker, ranked toggle with warning confirmation on unranking, and 30-day soft deletion flow.
  - Comprehensive test suite: 12 tests in `apps/api/src/test/shelves.test.ts` and 9 validation unit tests in `apps/mobile/src/lib/__tests__/shelves.test.ts`. CI pipeline 100% green.
- [x] **SH-03** Shelf detail: ranked numbering, per-entry notes, mosaic cover — 1.5d
  - Backend `ShelvesService` (`getItems`, `addItem`) and Fastify endpoints `GET /v1/shelves/:id/items` and `POST /v1/shelves/:id/items` with 3-tier privacy authorization (404 on access denial).
  - Enhanced `GET /v1/shelves/:id` resolving `cover_ids` (OpenLibrary integer covers) and viewer save state `is_saved`.
  - Joined works metadata (title, author name, covers, ratings, user's read status) with sequential position ordering (`position ASC, added_at ASC`).
  - Enforced per-entry note constraints (char_length <= 280) and unique work constraint on shelf items (409 conflict).
  - Full OpenAPI contract synchronization with schemas in `apps/api/src/contract/schemas.ts`, updated `openapi.yaml` (0 drift), and typed client methods in `@flyleaf/api-client` (`getShelfItems`, `addShelfItem`).
  - Native Shelf Detail screen in `apps/mobile/app/shelf/[id].tsx` with 4-cover mosaic card preview, ranked numbering pills (`#1..#N`), per-entry notes in styled callouts, owner actions (Edit Shelf), reader actions (Save/Saved toggle, Share), and contextual empty states.
  - Comprehensive test suite: 17 tests in `apps/api/src/test/shelves.test.ts` and 12 mobile unit tests in `apps/mobile/src/lib/__tests__/shelves.test.ts`. CI pipeline 100% green.
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
    - Implemented PRD §15.5 multi-signal composite ranking formula:
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

**Phase 2 Exit Criteria Verified** (100% complete):
- [x] A ranked list with notes can be built, reordered and shared (`SH-02`, `SH-03`, `SH-05`, `SH-10`).
- [x] Shelf privacy respected on every read path (`SH-09`, `SH-08`, `SH-07`, `SH-03`).

---

## Phase 3 — Import & export · `IM` · 10d

- [x] **IM-01** imports + import_rows migrations — 0.5d
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
  - Created file storage abstraction in `apps/api/src/imports/storage.ts` supporting `DiskFileStorage` (persistent local disk directory) and `MemoryFileStorage` (fast isolated test memory).
  - Configured `@fastify/multipart` in `apps/api/src/app.ts` with 10MB limit (PRD §6.8) and custom 413 `file_too_large` error envelope mapping.
  - Added background job queue `processImport: 'imports.process'` and registered worker handler in `apps/api/src/jobs/index.ts`.
  - Implemented `ImportService` and `importsPlugin` in `apps/api/src/imports/index.ts`:
    - `POST /v1/imports`: Validates source against the 6 supported platforms (`goodreads`, `storygraph`, `librarything`, `calibre`, `openlibrary`, `openreads`), enforces non-empty file, calculates SHA-256 `content_hash`, writes `queued` import record, enqueues pg-boss task, and returns `{ id, job_id, state: 'queued', source, total_rows: 0, matched: 0, unmatched: 0, ... }` immediately per PRD AC-9.
    - `GET /v1/imports/:id`: Status and progress inspection with strict 404 security isolation for cross-user requests.
    - `GET /v1/imports`: Reverse-chronological list of imports for authenticated viewer.
  - Declared OpenAPI 3.1 schemas in `apps/api/src/contract/schemas.ts` and regenerated `openapi.yaml` with 0 drift.
  - Added typed client methods `uploadImport()`, `getImport()`, and `listImports()` in `packages/api-client/src/client.ts` supporting standard web `Blob | File | Uint8Array`.
  - Comprehensive automated integration test suite in `apps/api/src/test/imports.test.ts` (16 tests passing).
  - Verified 100% green across full monorepo CI (all 9 gates passing in 301s).
- [x] **IM-03** ⚠️ **Declarative column map, one config per source** — 1.5d
  - Defined normalized data contracts in `apps/api/src/imports/types.ts`:
    - `NormalizedImportRow` enforcing strict identity (`title`, `author`, `isbn`, `isbn10`, `isbn13`, `sourceId`) and reader state (`status`, `rating`, `startedAt`, `finishedAt`, `review`, `shelves`, `notes`, `readCount`, `format`, `raw`).
    - Declarative source configuration contracts (`SourceColumnConfig`, `FieldMapping`, `HeaderDetectionConfig`, `DetectionResult`).
  - Built pure TypeScript RFC 4180 streaming/block CSV parser (`apps/api/src/imports/parser.ts`) supporting multiline quoted fields, escaped double quotes (`""`), UTF-8 BOM removal, and whitespace tolerance.
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
  - Delivered production-grade declarative source configs for all 6 major book tracking and catalog platforms:
    - `goodreads` (`apps/api/src/imports/configs/goodreads.ts`): 16 fields, formula syntax (`="0441478123"`), unrated 0 -> NULL, exclusive shelf mapping.
    - `storygraph` (`apps/api/src/imports/configs/storygraph.ts`): Quarter-star rounding to nearest half-star (3.25 -> 3.5, 3.75 -> 4.0, PRD §6.28, §51.2), unrated 0 -> NULL, `Dates Read` range parsing, format normalization (`digital` -> `ebook`, `audio` -> `audiobook`, `print` -> `print`), `Owned?` boolean flag, and tag extraction.
    - `librarything` (`apps/api/src/imports/configs/librarything.ts`): Primary author inversion from `Last, First` -> `First Last` (`Herbert, Frank` -> `Frank Herbert`), bracketed ISBN cleansing (`[0441478123]`), collections-to-status mapping (`Currently reading` -> `reading`, `To read`/`Wishlist` -> `want`, `Your library` -> `finished`), rating normalization, review and comments preservation.
    - `calibre` (`apps/api/src/imports/configs/calibre.ts`): Multiple authors separated by `&`, identifier parsing (`isbn:9780441478125`), tag-based status fallback (`currently-reading` -> `reading`, `to-read` -> `want`, default `finished`), ebook format normalization, HTML comment cleaning, and series in shelves.
    - `openlibrary` (`apps/api/src/imports/configs/openlibrary.ts`): Canonical OL work key extraction (stripping `/works/` or `/books/` prefix), reading log status mapping (`already-read` -> `finished`, `currently-reading` -> `reading`, `want-to-read` -> `want`), 0 rating to NULL, review notes.
    - `openreads` (`apps/api/src/imports/configs/openreads.ts`): Privacy tracker mapping for native statuses (`finished`, `reading`, `not_started`, `unfinished`), dates, notes and review separation, format mapping (`physical` -> `print`, `ebook`, `audiobook`), half-star ratings.
  - Enhanced transformer library (`apps/api/src/imports/transformers.ts`):
    - `cleanIsbn`: Bracket stripping, comma-separated candidate scanning, and `isbn:` prefix cleaning.
    - `formatAuthorName`: Reliable `Last, First` inversion while preserving single names and already standard `First Last`.
    - `parseDateRange`: StoryGraph date range parser extracting `[startedAt, finishedAt]`.
    - `mapFormat`: Added `print` and `physical` keyword detection.
  - Updated configuration registry in `apps/api/src/imports/configs/index.ts` connecting all 6 configs to `SOURCE_CONFIGS`.
  - Multi-platform header detector tests and end-to-end normalization test suites in `apps/api/src/test/import-mapping.test.ts` (37 tests passing).
- [x] **IM-05** ⚠️ Matching: ISBN → title+author fuzzy → **ambiguous goes unmatched, never guessed** — 2d
  - Delivered multi-stage catalog matching engine in `apps/api/src/imports/matcher.ts`:
    - **Stage 1 (Exact ISBN)**: Detects ISBN-10/13 formats, joins `editions` and `works`, and matches physical copies with confidence 1.0.
    - **Stage 2 (Source ID)**: Resolves Open Library work keys (`OL...W`) and edition keys (`OL...M`) with confidence 0.98.
    - **Stage 3 (Exact Title + Author)**: Compares unaccented normalized titles (`normaliseTitle`) and author names with confidence 0.92; immediately identifies homonymous works and flags them as `ambiguous_match`.
    - **Stage 4 (Fuzzy Title + Author)**: Trigram similarity ranking (`similarity(title) * 0.6 + similarity(author) * 0.4`) with minimum threshold (>= 0.70).
    - **CRITICAL PRD AC-9 RULE (Ambiguous Matches NEVER Guessed)**: If multiple works share the same title/author, or if the confidence margin between candidate #1 and candidate #2 is < 0.15, the row is marked `state = 'unmatched'`, `work_id = null`, and `failure_reason = 'ambiguous_match'` for user review in IM-09.
  - Implemented `persistImportRowMatches`: Inserts rows into `import_rows` preserving untouched `raw` row dictionaries, and updates parent `imports` summary counters (`total_rows`, `matched`, `unmatched`).
  - Created dedicated integration test suite in `apps/api/src/test/import-matcher.test.ts` (12 tests passing) verifying ISBN matches, OL key resolution, exact matches, fuzzy matches, ambiguity rejection, and DB persistence.
  - 100% green across all 9 gates in full monorepo CI (554 API tests across 25 suites, 83 mobile tests across 20 suites).
- [x] **IM-06** ⚠️ Rating normalisation; **`My Rating = 0` → NULL** — 0.5d
  - Delivered rating persistence normalisation engine in `apps/api/src/imports/committer.ts` (`normalizeRatingForPersistence`):
    - Strictly maps Goodreads `My Rating = 0`, `'0'`, `0.0`, empty strings, null, and undefined to `NULL` (PRD §1833, §4409, AC-9).
    - Prevents Postgres check constraint violations (`reads_rating_ck`: `rating IS NULL OR (rating BETWEEN 0.5 AND 5.0 AND (rating * 2) = floor(rating * 2))`). Writing `0` directly aborts transactions; `NULL` preserves unrated books safely without dropping rows.
    - Validates 0.5–5.0 half-step precision; rounds quarter-star ratings from StoryGraph (e.g. 3.25 -> 3.5, 3.75 -> 4.0) to nearest half-star.
  - Integration tested against real PGlite database: demonstrates that `0` violates check constraint, while `NULL` saves unrated books with complete fidelity.
- [x] **IM-07** ⚠️ `source='import'`, **excluded from `activity`** — 0.25d
  - Enforced schema-level provenance: all reads created from imports write `source = 'import'` (satisfying check constraint `reads_source_ck: source IN ('app', 'import')`).
  - Feed and activity exclusion rules (PRD §34.4, §4410, Architecture §8, §9, Phases §3):
    - Exported helpers `isExcludedFromActivity` and `isEligibleForActivityFeed`.
    - SQL query filter `feedExcludesImportsSql()` (`reads.source != 'import'`) ensuring imported reads never spam social activity streams or follower feeds.
    - Verified zero telemetry `events` or individual read events emitted during bulk imports of libraries.
  - Full transactional committer: `commitImportRow` and `commitImportBatch` persisting `reads`, linked `reviews` (up to 10,000 chars), custom `shelves`, and `shelf_items` with atomic counter updates, handling re-read attempt numbers (`attempt_no`).
  - 14 dedicated integration tests in `apps/api/src/test/import-committer.test.ts` (100% passing).
  - 100% green across all 9 gates in full monorepo CI (568 API tests across 26 suites, 83 mobile tests across 20 suites).
- [x] **IM-08** pg-boss job: chunked, resumable, progress-reported — 1d
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
      - `GET /v1/exports/:id/download`: Secure dual-access file streaming (either Bearer token authentication or single-use emailed token `?token=...` without auth).
      - Emailed notification dispatched via `mailer.send()` with 48h valid secure download link upon completion (PRD §1290, §3424).
    - **Client SDK & Mobile UI**:
      - Typed client methods `requestExport()`, `getExport()`, `listExports()` in `@flyleaf/api-client` and `apps/mobile/src/lib/api.ts`.
      - Export Library Data UI in `apps/mobile/app/import/index.tsx` with format picker (CSV/JSON), 1-tap request action with feedback, and export history list with direct download links.
    - **Verified 100% Round-Trip Fidelity (Phases §217)**:
      - Exported Alice's library to CSV (including Dune with 5.0 rating, review, and Favorites shelf, plus Neuromancer as unrated want-to-read).
      - Imported CSV into a clean Bob account: 100% matched, ratings preserved, review intact, custom shelves and statuses restored with zero data loss.
    - **Test Coverage & CI**:
      - 8 dedicated integration tests in `apps/api/src/test/export.test.ts` (100% passing).
      - 100% green across all 9 gates in full monorepo CI (589 API tests across 29 suites, 83 mobile tests across 20 suites).
- [x] **IM-11** Duplicate-import detection by content hash — 0.5d
  - Delivered SHA-256 duplicate-import detection across API, database index, client SDK, and mobile app:
    - **Content Hash & Scoping (PRD §34.4, §5141, IM-11)**:
      - Computes SHA-256 `content_hash` from uploaded file buffers.
      - Uses indexed lookup on `(user_id, content_hash)` (`imports_user_hash_idx`).
      - Strictly scoped per user: different users uploading identical sample/export files never conflict.
      - Failed imports (`state = 'failed'`) do not block re-uploads.
    - **Duplicate Conflict & Force Override**:
      - If an identical file was previously imported, rejects with `409 Conflict` (`ApiError.conflict('duplicate_import', ...)`).
      - Allows intentional re-imports via `force=true` (querystring `?force=true` or multipart form field `force: 'true'`).
    - **Contract & OpenAPI 3.1.0**:
      - Added `force` query parameter to `uploadImportQuerySchema` in `apps/api/src/contract/schemas.ts`.
      - Added `409: errorResponseSchema` to `POST /v1/imports` route contract.
      - Verified 0 OpenAPI contract drift via `npm run spec:check`.
    - **Client SDK & Mobile UI**:
      - Added `UploadImportOptions` with `force?: boolean` to `@flyleaf/api-client` and `apps/mobile/src/lib/api.ts`.
      - Mobile import screen (`apps/mobile/app/import/index.tsx`) catches `duplicate_import` error and presents confirmation dialog ("Duplicate File: An identical file has already been imported. Would you like to import it anyway?") with "Import Anyway" (`force: true`) or "Cancel".
    - **Integration Tests & CI**:
      - 7 dedicated integration tests in `apps/api/src/test/import-duplicate.test.ts` (100% passing).
      - 100% green across all 9 gates in full monorepo CI (596 API tests across 30 suites, 83 mobile tests across 20 suites).
- [x] **IM-12** Import your own real library; fix what breaks — 1d
    - **Realistic Library Fixtures**:
      - Created `apps/api/src/test/fixtures/real-library-goodreads.csv` (25-book realistic export covering classics, modern sci-fi/fantasy, `="0140328726"` ISBN escaping, `My Rating = 0` unrated books, 1-5 ratings, multiline reviews, dates read, custom shelves, and homonymous/obscure entries).
      - Created `apps/api/src/test/fixtures/real-library-storygraph.csv` (5-book realistic export covering quarter-star ratings `4.75`, `4.25`, `3.75`, date ranges, and formats).
    - **Integration Test Suite & Phase 3 Exit Criteria Verification** (`apps/api/src/test/import-real-library.test.ts`):
      - **Phase 3 Exit Criterion 1**: Real Goodreads export imports with >=85% matched rows (23/25 = 92.0% match rate achieved). All imported reads created with `source = 'import'`, `My Rating = 0` converted strictly to `rating = NULL`, multiline reviews and custom shelves preserved.
      - **Phase 3 Exit Criterion 2**: Unmatched rows reviewed via `GET /v1/imports/:id/rows?state=unmatched`. Ambiguous matches (`failure_reason = 'ambiguous_match'`) and unknown books (`failure_reason = 'no_confident_match'`) correctly identified per PRD AC-9 without guessing. Ambiguous row resolved via `POST /v1/imports/:id/rows/:rowNo/resolve` with `{ work_id, edition_id }`, updating state to `resolved`, committing read to library with `source = 'import'`, and updating counters. Skipped row verified via `POST /v1/imports/:id/rows/:rowNo/skip`.
      - **Phase 3 Exit Criterion 3**: Export round-trips: Alice's imported library exported to CSV via `POST /v1/exports`, re-imported into fresh user Bob, and verified with 100% fidelity across reads, ratings (including NULL ratings), reviews, custom shelves, and reading dates.
      - **StoryGraph Verification**: 5-book StoryGraph export imported with quarter-star ratings rounded to half-stars per `reads_rating_ck` (`4.75` → `5.0`, `4.25` → `4.5`, `3.75` → `4.0`), date ranges parsed to `started_at` / `finished_at`, and formats mapped.
    - **CI State**: All 601 API tests passing across 31 suites, 83 mobile tests passing across 20 suites, 0 OpenAPI contract drift, and 100% green across all 9 gates in monorepo CI.

**Exit:** your real export imports ≥85% matched · unmatched resolvable · export round-trips. [VERIFIED & COMPLETE]

---

## Phase 4 — Social · `SO` · 20d

- [x] **SO-01** follows, blocks, mutes migrations + counters — 0.5d
  - Created migration `0016_social_graph.sql` and journal entry in `apps/api/drizzle/meta/_journal.json`.
  - Defined social graph schema in `apps/api/src/db/schema.ts`:
    - `follows`: Tracks asymmetric user follow relationships (`follower_id`, `following_id`, `state IN ('pending', 'accepted')`, `created_at`, `updated_at`). Enforces `follower_id <> following_id` check constraint and composite primary key `(follower_id, following_id)`.
    - `blocks`: Tracks bidirectional user blocks (`blocker_id`, `blocked_id`, `created_at`). Enforces `blocker_id <> blocked_id` check constraint and composite primary key `(blocker_id, blocked_id)`.
    - `mutes`: Tracks muted users and books (`muter_id`, `muted_id`, `target_work_id`, `created_at`). Enforces target type check constraints (`(muted_id IS NOT NULL AND target_work_id IS NULL) OR (muted_id IS NULL AND target_work_id IS NOT NULL)`).
  - Postgres DB trigger function `follows_counter_trigger_fn` in migration `0016_social_graph.sql` dynamically maintains atomic `follower_count` and `following_count` on `profiles` when follow records are inserted, updated, or deleted into/from `state = 'accepted'`.
  - Exported Drizzle models and TypeScript types (`Follow`, `NewFollow`, `Block`, `NewBlock`, `Mute`, `NewMute`).
- [x] **SO-02** Follow/unfollow; private accounts; pending requests — 1.5d
  - Built `SocialService` and Fastify `socialPlugin` in `apps/api/src/social/index.ts` with follow/unfollow and pending request endpoints (`POST /v1/users/:id/follow`, `DELETE /v1/users/:id/follow`, `GET /v1/me/follow-requests`, `POST /v1/me/follow-requests/:requesterId/accept`, `POST /v1/me/follow-requests/:requesterId/reject`).
  - Private accounts create `state = 'pending'` follows; public accounts create `state = 'accepted'`. Automatic profile follower and following counts maintained via Postgres DB triggers.
  - Enforced 3-tier privacy authorization in `IdentityService.getProfile` returning 404 Not Found for non-followers viewing private profiles (PRD §25.3, FN-72, SH-09). Switching profile from private to public automatically accepts pending follow requests.
  - OpenAPI 3.1.0 specification synchronized with 0 contract drift and typed methods in `@flyleaf/api-client`.
  - Mobile UI integration: interactive follow toggle with haptics and "Follows you" mutual indicator on `UserProfileScreen` (`apps/mobile/app/user/[id].tsx`), and incoming requests manager screen `FollowRequestsScreen` (`apps/mobile/app/profile/requests.tsx`).
  - 8 integration tests in `apps/api/src/test/social-follow.test.ts` and mobile unit tests in `apps/mobile/src/lib/__tests__/social-follow.test.ts` passing. 100% green CI pipeline.
- [x] **SO-03** ⚠️ **Block: bidirectional, complete, silent, severs follows** — 1.5d
  - Built block/unblock service methods and Fastify routes in `apps/api/src/social/index.ts` (`POST /v1/users/:id/block`, `DELETE /v1/users/:id/block`, `GET /v1/me/blocks`, plus `/v1/blocks/:userId` and `/v1/blocks` aliases).
  - Enforced complete, bidirectional, silent block semantics (PRD §11.4, §26.3): blocking immediately severs existing follows in BOTH directions, with Postgres DB triggers (`follows_counter_trigger_fn`) updating `follower_count` and `following_count` automatically.
  - Complete obscure privacy masking: profile lookups, follow attempts, and reading stats targeting a blocked account return **404 Not Found** (never 403 Forbidden), rendering blocked accounts completely indistinguishable from non-existent accounts.
  - Excluded reviews written by blocked users from `listWorkReviews` in `apps/api/src/reviews/index.ts`.
  - Self-block prevention: returns HTTP 400 Bad Request (`cannot_block_self`).
  - OpenAPI 3.1.0 contract synchronized with 0 drift and typed methods in `@flyleaf/api-client`.
  - Mobile UI integration: added "Block" action with confirmation dialog to `UserProfileScreen` (`apps/mobile/app/user/[id].tsx`), created `BlockedUsersScreen` (`apps/mobile/app/profile/blocked.tsx`) with 1-tap unblock action, and added "Blocked Accounts" entry in Profile settings (`apps/mobile/app/(tabs)/profile.tsx`).
  - Integration test suite `apps/api/src/test/social-block.test.ts` (6/6 tests passing) verifying self-block rejection, bidirectional follow severing, counter updates, 404 obscure masking, unblock behavior, and blocked list retrieval.
- [x] **SO-04** Mute user and **mute book** — 0.5d
  - Built mute/unmute service methods for users and books in `apps/api/src/social/index.ts` (`POST /v1/users/:id/mute`, `DELETE /v1/users/:id/mute`, `POST /v1/works/:id/mute`, `DELETE /v1/works/:id/mute`, `GET /v1/me/mutes`, plus `/v1/mutes/users/:userId`, `/v1/mutes/works/:workId`, `/v1/mutes` aliases).
  - Silent, low-stakes muting semantics (PRD §11.5, §5289, §5290): muting a user hides their activity from feeds without unfollowing; muting a book removes the book from activity feeds and recommendations ("hyped release" filter).
  - Self-mute prevention: returns HTTP 400 Bad Request (`cannot_mute_self`).
  - OpenAPI 3.1.0 contract synchronized with 0 drift and typed methods in `@flyleaf/api-client`.
  - Mobile UI integration: added "Mute" action to `UserProfileScreen` (`apps/mobile/app/user/[id].tsx`), added "Mute book" action to `WorkScreen` (`apps/mobile/app/work/[id].tsx`), created `MutedItemsScreen` (`apps/mobile/app/profile/muted.tsx`) with segmented tabs for Users and Books with 1-tap unmute actions, and added "Muted Content" entry in Profile settings (`apps/mobile/app/(tabs)/profile.tsx`).
- [x] **SO-05** Followers/following lists — 0.5d
  - Built follower and following list service methods and Fastify routes in `apps/api/src/social/index.ts` (`GET /v1/users/:id/followers`, `GET /v1/users/:id/following`, plus `/v1/followers/:userId` and `/v1/following/:userId` aliases) supporting limit/offset pagination and total counts.
  - Strict privacy enforcement (PRD §11.1, §25.3, §26.1): non-followers and guests viewing a private profile's follower/following list receive **404 Not Found** (`not_found`), never 403 Forbidden.
  - Complete block protection: requesting follower/following lists of a blocked account returns 404 Not Found. Any third-party blocked users relative to the caller are silently excluded from returned lists.
  - Rich relationship indicators: each list entry populates `followedByViewer` and `followsViewer` for the caller.
  - OpenAPI 3.1.0 contract synchronized with 0 drift and typed methods `getFollowers` and `getFollowing` exposed in `@flyleaf/api-client` and `apps/mobile/src/lib/api.ts`.
  - Mobile UI integration: created `FollowersScreen` (`apps/mobile/app/user/[id]/followers.tsx`) and `FollowingScreen` (`apps/mobile/app/user/[id]/following.tsx`) with 1-tap follow toggles, user avatars, private indicators, and pressable follower/following count headers on profile screens.
  - Integration test suite `apps/api/src/test/social-lists.test.ts` (5/5 tests passing) verifying public listing, 404 private account protection, 404 block masking, third-party block filtering, and mutual follow indicators.
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

  ### Feed — `SO-1x` · 6d
- [x] **SO-10** activity table + write-on-action, respecting visibility — 1d
  - Defined `activity` Drizzle table in `apps/api/src/db/schema.ts` and migration `apps/api/drizzle/0017_activity.sql` with covering index `(actor_id, created_at desc)` (Architecture §3.5, PRD §23.3) and CHECK constraints on verbs (`started`, `finished`, `rated`, `reviewed`, `dnf`, `shelved`, `followed`, `goal_reached`, `quoted`) and visibility (`public`, `followers`, `private`).
  - Built `ActivityService` in `apps/api/src/activity/index.ts` with atomic write-on-action logging (`recordActivity`), visibility updates (`updateActivityVisibility`), entity deletion cascading (`deleteActivity`), and retroactive privacy updates (`setAccountPrivacy`).
  - Strict import feed exclusion (IM-07, PRD §4410): reads and reviews with `source = 'import'` generate NO activity rows.
  - Strict privacy enforcement (PRD §16.3, §26.1, §26.2): per-item private reads, reviews, and shelves generate NO activity rows; private account activities default to `followers` visibility; switching account to private retroactively restricts public activity to `followers`.
  - Integrated write-on-action into `ReadingService` (`started`, `finished`, `dnf`), `ReviewService` (`reviewed`), `ShelvesService` (`shelved`), `SocialService` (`followed`), and `IdentityService` (retroactive privacy adjustment).
  - Integration test suite `apps/api/src/test/activity.test.ts` (10/10 tests passing) verifying write-on-action for all verbs, import exclusion, item privacy, private profile restriction, retroactive privacy toggling, and review/follow activity cleanup.
- [ ] **SO-11** ⚠️ **Feed query**: cursor-paginated, blocks/mutes excluded — 1.5d
- [ ] **SO-12** Ranking + diversity constraints in TypeScript — 1.5d
- [ ] **SO-13** Aggregation: shelf adds, follows — 0.5d
- [ ] **SO-14** ⚠️ **Cold start: never empty**, Friends/Popular switch, blended <3 follows — 1d
- [ ] SO-15 Feed card types + swipe actions — 0.5d

### Interaction — `SO-2x` · 3d
- [ ] **SO-20** `read_likes`, `read_comments` migrations + counters — 0.5d
- [ ] **SO-21** ⚠️ **Like targets the read** — a finish with no review is likeable — 0.75d
- [ ] **SO-22** Comments, single-level, rate-limited — 1d
- [ ] SO-23 Review ranking: social proximity dominant, exploration boost — 0.75d

### Notifications — `SO-3x` · 3d
- [ ] **SO-30** notifications table; composition; Expo Notifications → FCM/APNs — 1.5d
- [ ] **SO-31** ⚠️ **5/day cap, quiet hours, aggregation** — 0.5d
- [ ] **SO-32** Per-category preferences; **reading reminder with its six bounds** — 0.5d
- [ ] SO-33 In-app centre; deep links with synthesised back stack — 0.5d

### Moderation — `SO-4x` · 3d
- [ ] **SO-40** reports table; report flow from every surface — 0.5d
- [ ] **SO-41** Automated layer 1: slur list, link rules, duplicates, rate limits — 1d
- [ ] **SO-42** **Admin: report queue, actions, enforcement ladder, appeals** — 1.5d

### Public pages — `SO-5x` · 3d
- [ ] **SO-50** ⚠️ Server-rendered book, profile and shelf pages — 2d
- [ ] **SO-51** Open Graph tags; `flyleaf.app/@username` — 0.5d
- [ ] SO-52 Onboarding follow suggestions — 0.5d

**Exit:** 30–50 beta users · median follows ≥5 · nobody has an empty feed · block verified · report actionable end to end.

---

## Phase 5 — Stats, goal, Year in Review · `ST` · 15d

- [ ] **ST-01** ⚠️ **Stats computed per viewer** — owner sees private reads, others do not — 1.5d
- [ ] ST-02 Volume, temporal, taste, extremes; pace and speed from `minutes` — 2d
- [ ] **ST-03** ⚠️ Incomplete-data disclosure; **never fabricate** — 0.5d
- [ ] ST-04 Stats screen: one stat per card, share on each — 2d
- [ ] ST-05 Goals table; **ring on profile and nowhere else** — 0.75d
- [ ] ST-06 Streak with 2-day grace; "longest" framing — 0.75d
- [ ] **ST-07** ⚠️ **Server-side share-card renderer** (satori → resvg) — 2.5d
- [ ] ST-08 Templates: finish, review quote, stat, profile, Wall collage — 1.5d
- [ ] **ST-09** Year in Review: story cards, low-volume variant, Dec unlock — 2.5d
- [ ] ST-10 Milestone moments, in-app only — 0.5d

---

## Phase 6 — Launch readiness · `LA` · 15d

- [ ] **LA-01** ⚠️ **Account deletion**: password re-entry, 30-day grace, export offer, hard delete job — 1.5d
- [ ] LA-02 Settings: privacy, notifications, content, libraries, appearance, blocked, about — 2d
- [ ] LA-03 Onboarding polish; import-first ordering; skip everywhere — 1.5d
- [ ] LA-04 Every empty, loading and error state audited — 1.5d
- [ ] **LA-05** Deploy script; Caddy; migrate-then-restart; rollback — 1d
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
