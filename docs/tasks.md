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
- [ ] **SK-09** Have one other person complete the path unaided — 0.25d

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
- [ ] **FN-42** ISBN detection → exact edition path — 0.5d
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
- [ ] FN-50 Stage 1–2 auto-merge (ISBN13; normalised title + shared author) — 1d
- [ ] FN-51 Stage 3–4 queue; `merged_into_id` repointing; 30-day undo — 1d

### Auth — `FN-6x` · 5d
- [ ] **FN-60** users, refresh_tokens, profiles migrations — 0.5d
- [ ] **FN-61** argon2id (`@node-rs/argon2`); common-password list; 10-char minimum — 0.5d
- [ ] **FN-62** Register, login, DOB age gate — 1d
- [ ] **FN-63** **JWT 15m (`jose`) + opaque rotating refresh, hashed, `family_id`** — 1d
- [ ] **FN-64** ⚠️ **Reuse detection: used token → revoke whole family** — 0.5d
- [ ] **FN-65** Email verification + password reset behind a sender interface — 1d
- [ ] FN-66 Session list + per-device revoke — 0.5d

### Authorization — `FN-7x` · 3d
- [ ] **FN-70** ⚠️ Repository layer: **viewer ID a required argument everywhere** — 1d
- [ ] **FN-71** ⚠️ Single `canView()`: public/followers/private/blocked/guest — 0.5d
- [ ] **FN-72** ⚠️ **Cross-user access test suite — 404 not 403, every private type** — 1.5d

### API contract — `FN-8x` · 2d
- [ ] **FN-80** Fastify route schemas for the Phase 0–1 surface; `openapi.yaml` generated from them — 1d
- [ ] **FN-81** Typed client generated into `packages/api-client`, CI-enforced — 0.5d
- [ ] FN-82 Hook chain incl. the auth hook that never rejects (guests) — 0.5d

### Admin (early slice) — `FN-9x` · 2d
- [ ] FN-90 Admin auth, separate from app accounts, 2FA — 0.5d
- [ ] FN-91 Merge review UI + undo — 0.75d
- [ ] FN-92 Maturity override; ingestion status dashboard — 0.75d
- [ ] FN-93 ⚠️ `admin_audit_log` on every action — 0.25d

**Exit:** 50 owned books findable · panel ≥90% · cross-user suite green · migrations clean in CI.

---

## Phase 1 — Solo loop · `SL` · 40d

### Client foundation — `SL-0x` · 6d
- [ ] **SL-00** ⚠️ Run `npx expo install --check` and `npx expo-doctor` before adding any mobile dependency. Expo Go rejects a project whose native module versions differ from what it ships — pin from `bundledNativeModules.json`, never npm `latest` — 0.25d
- [ ] **SL-01** Expo Router shell, 5 tabs + centre FAB — 1d
- [ ] **SL-02** Design system from `design.md`: tokens, Button, Card, Sheet, Cover, StarRating, Heart, ProgressBar, Skeleton, EmptyState — Reanimated + gesture-handler — 3d
- [ ] **SL-03** API client wiring, TanStack Query, error surface — 0.5d
- [ ] **SL-04** `expo-secure-store` refresh token; 401 → refresh interceptor — 1d
- [ ] SL-05 Theme switching, system default, both palettes verified — 0.5d

### Offline — `SL-1x` · 6d
- [ ] **SL-10** ⚠️ SQLite schema mirroring reads + progress_events — 1d
- [ ] **SL-11** ⚠️ **Mutation queue: persist, replay, backoff, dead-letter** — 2d
- [ ] **SL-12** ⚠️ `client_event_id` generation + idempotent replay — 0.5d
- [ ] **SL-13** ⚠️ **Offline queue test suite incl. simulated process death** — 1.5d
- [ ] SL-14 Sync-on-foreground and on reconnect; unsynced indicator — 1d

### Auth screens — `SL-2x` · 3d
- [ ] SL-20 Welcome carousel with "Look around first" — 0.5d
- [ ] SL-21 Sign up / log in / forgot / reset / verify — 1.5d
- [ ] SL-22 Username + avatar; live availability; reserved words — 1d

### Guest mode — `SL-3x` · 3d
- [ ] **SL-30** ⚠️ Guest routing: no session → Home in browse mode — 0.5d
- [ ] **SL-31** ⚠️ **Action gate**: contextual prompt at Log/Rate/Follow/Like, one-tap dismiss — 1d
- [ ] **SL-32** ⚠️ Local Want-to-Read (cap 20) — 0.75d
- [ ] **SL-33** ⚠️ **Migrate local shelf on signup + confirmation copy** — 0.75d

### Catalog screens — `SL-4x` · 7d
- [ ] **SL-40** Search screen: debounce 250ms, tabs, recents, filters — 2d
- [ ] **SL-41** **Book detail**: hero, status control, rating + histogram, description, metadata, tabs — 2.5d
- [ ] **SL-42** Cover-forward edition picker; "the copy I own" — 1d
- [ ] SL-43 Author page; series page with your progress — 1d
- [ ] SL-44 Barcode scanner + permission rationale + manual fallback — 0.5d

### Reading core — `SL-5x` · 9d
- [ ] **SL-50** reads + progress_events migrations & repos — 1d
- [ ] **SL-51** ⚠️ `POST /reads/{id}/progress` idempotent on `client_event_id` — 0.5d
- [ ] **SL-52** **Reading tab**: cards, slider auto-save, +10, predicted finish — 2.5d
- [ ] **SL-53** Progress sheet: numeric entry, chips, **optional minutes**, note, quote — 1d
- [ ] **SL-54** **Finish flow**: stars visible, heart, date, format chips, review, ≤20s — 2d
- [ ] **SL-55** DNF flow: page pre-filled, reason chips, neutral copy — 0.75d
- [ ] **SL-56** Re-read: new row, `attempt_no+1` — 0.5d
- [ ] SL-57 Want-to-read queue; sort, filter, bulk — 0.75d

### Ratings, reviews — `SL-6x` · 5d
- [ ] **SL-60** Half-star control, extra hit area, haptic, `adjustable` trait — 1d
- [ ] **SL-61** Heart, independent of rating — 0.25d
- [ ] **SL-62** ⚠️ Bayesian weighted rating + trigger-maintained `work_stats` — 1d
- [ ] **SL-63** Review composer: autosave every 3s, spoiler, visibility — 1.5d
- [ ] SL-64 Review detail + book reviews list, friends-first sort — 1.25d

### Diary, Wall, Profile, Stats — `SL-7x` · 7d
- [ ] **SL-70** Diary — **list · grid · calendar**, year jump, filters — 2.5d
- [ ] **SL-71** **The Wall**: 3-col grid, filters incl. Hearted, 2-col below 340dp — 1.5d
- [ ] **SL-72** Profile: favourites, stats strip, currently reading, Diary, reviews — 2d
- [ ] SL-73 Favourites picker (4, ordered, drag) — 0.5d
- [ ] SL-74 Basic stats: volume, temporal, taste, extremes — 0.5d

### Instrumentation — `SL-8x` · 2d
- [ ] **SL-80** ⚠️ `events` table + client emitter — 0.5d
- [ ] **SL-81** ⚠️ **Instrument the §4.4 budgets**: progress duration, finish duration, tap counts, abandonment — 1d
- [ ] SL-82 Sentry, app + API — 0.5d

**Exit:** two books tracked end to end on your own phone · finish p75 <20s · offline verified · a11y pass on the core flows.

---

## Phase 2 — Shelves & lists · `SH` · 10d

- [ ] SH-01 shelves + shelf_items migrations, counters — 0.5d
- [ ] SH-02 Create/edit: name, description, privacy, ranked toggle — 1d
- [ ] SH-03 Shelf detail: ranked numbering, per-entry notes, mosaic cover — 1.5d
- [ ] SH-04 Add-to-shelf from book page, search, long-press — 1d
- [ ] SH-05 Reorder: drag + **"move to position" alternative** — 1d
- [ ] SH-06 My shelves grid; three starter suggestions on empty — 1d
- [ ] SH-07 Save someone's shelf (reference, stays in sync) — 0.5d
- [ ] SH-08 Browse public shelves; ranking formula — 1.5d
- [ ] SH-09 Shelf privacy on every read path + tests — 1d
- [ ] SH-10 Share a shelf — 1d

---

## Phase 3 — Import & export · `IM` · 10d

- [ ] **IM-01** imports + import_rows migrations — 0.5d
- [ ] **IM-02** Upload endpoint → job ID, returns immediately — 0.5d
- [ ] **IM-03** ⚠️ **Declarative column map, one config per source** — 1.5d
- [ ] **IM-04** Six source maps: Goodreads, StoryGraph, LibraryThing, Calibre, OpenLibrary, OpenReads — 1.5d
- [ ] **IM-05** ⚠️ Matching: ISBN → title+author fuzzy → **ambiguous goes unmatched, never guessed** — 2d
- [ ] **IM-06** ⚠️ Rating normalisation; **`My Rating = 0` → NULL** — 0.5d
- [ ] **IM-07** ⚠️ `source='import'`, **excluded from `activity`** — 0.25d
- [ ] **IM-08** pg-boss job: chunked, resumable, progress-reported — 1d
- [ ] **IM-09** Import screen + progress banner + unmatched review list — 1.5d
- [ ] **IM-10** CSV/JSON export, emailed link — 1d
- [ ] IM-11 Duplicate-import detection by content hash — 0.5d
- [ ] **IM-12** Import your own real library; fix what breaks — 1d

**Exit:** your real export imports ≥85% matched · unmatched resolvable · export round-trips.

---

## Phase 4 — Social · `SO` · 20d

### Graph — `SO-0x` · 5d
- [ ] **SO-01** follows, blocks, mutes migrations + counters — 0.5d
- [ ] **SO-02** Follow/unfollow; private accounts; pending requests — 1.5d
- [ ] **SO-03** ⚠️ **Block: bidirectional, complete, silent, severs follows** — 1.5d
- [ ] **SO-04** Mute user and **mute book** — 0.5d
- [ ] **SO-05** Followers/following lists — 0.5d
- [ ] **SO-06** ⚠️ Block/private tests: blocked view ≡ non-existent account — 0.5d

### Feed — `SO-1x` · 6d
- [ ] **SO-10** activity table + write-on-action, respecting visibility — 1d
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
