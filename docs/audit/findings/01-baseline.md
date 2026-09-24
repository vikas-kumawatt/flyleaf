# Audit 01 — Baseline, benchmark harness, route inventory (no tasks)

2026-09-24 · CI **green** before (425 s) and after (908 s) · tests **738 API + 100 mobile → 740 API + 100 mobile**

This part changes no product behaviour. It builds the instruments later parts use and records what it noticed on the way, as leads. Nothing below was fixed here.

## 1. Baseline

### CI (before any change)

| Step | Result |
|---|---|
| api-client build, api typecheck, spec check | ✓ |
| api tests | ✓ **738 passed** (45 files), vitest 391 s |
| api build, api audit (`--audit-level=high`) | ✓ (4 moderate: esbuild via drizzle-kit, pre-existing) |
| mobile typecheck | ✓ |
| mobile offline tests | ✓ **100 passed** (11 files; `npm test` lists every `*.test.ts` under `apps/mobile/src`, checked) |
| migrations on the real Postgres | ✓ (`npm run migrate` → `migrations applied`) |
| **Total** | **green in 425 s** |

CI after this part's changes: see *CI after* at the end of this file.

### Catalog volumes (real dev database, `flyleaf-pg`, Postgres 18.6)

| Table | Rows | Size | Source |
|---|---|---|---|
| works | 3,650,397 | 2,581 MB | `pg_class.reltuples` |
| editions | 6,498,040 | 2,379 MB | `pg_class.reltuples` |
| authors | 15,385,548 | 5,382 MB | `pg_class.reltuples` |
| work_authors | 3,791,117 | 641 MB | `pg_class.reltuples` |
| reads | 4 | | `count(*)` before seeding |
| activity | 0 | | `count(*)` before seeding |
| reviews | 0 | | `count(*)` before seeding |
| shelves | 1 | | `count(*)` before seeding |
| users | 2 | | `count(*)` before seeding |

Database 30 GB. **Environment:** `shared_buffers = 128MB` (default), `work_mem = 4MB`, and the Docker/WSL2 VM has **3.5 GB RAM** in total. The catalog's hot indexes do not fit in memory, so anything that touches `works`/`authors` broadly is disk-bound here (the seed's first run read 26.9 GB from disk). Every latency below was measured in this environment; see lead L-13.

## 2. Benchmark data: `apps/api/src/bench/seed.ts`

`npm run bench:seed` / `npm run bench:seed -- --clean` (add `--with-triggers` for the slow trigger-maintained path).

What it creates, as seeded (identical counts on both runs; the PRNG is seeded):

| | Brief | Seeded |
|---|---|---|
| users (`bench_u00001…`, `@bench.flyleaf.invalid`) | ~3,000, ~10% private | 3,000, 300 private (10.0%) |
| follows | median ~40, some 1,000+, celebrities 2,000+, ~5% pending | 186,014; median following **38**; **5** users follow 1,000+; **2** users have 2,000+ followers (celebrity: 2,577); 9,259 pending (5.0%) |
| blocks / mutes | ~150 / ~300 | 150 / 300 (195 user, 105 work) |
| reads | ~60k over top 20k works, skewed, re-reads, 5% private, 10% followers, 15% import | 62,365 over 12,573 distinct works; 5,156 re-reads (max attempt 3); 84.7 / 10.2 / 5.1 % public/followers/private; 15.1% import; status finished 60 / want 20 / reading 9 / dnf 8.5 / paused 3 % |
| progress events | ~200k | 220,584 |
| reviews | ~12k, one work with 5,000+ | 12,000; hot work (*Atomic Habits*, top by `log_count`) has **5,303** |
| likes / comments | ~40k / ~8k | 40,000 / 8,000 (one read with a 459-comment thread) |
| shelves | ~4,000, some 500+, private, soft-deleted | 4,005: 10 with 500–1,192 items, 439 private, 162 soft-deleted; 79,251 items; 1,500 saves |
| activity | consistent, ~120 days, service row shape | 142,152 over exactly the last 120 days (followed 57.6k, shelved 51.8k, started 16.4k, finished 11.2k, reviewed 3.4k, dnf 1.7k) |

**Personas** (in `tokens.json`, gitignored): heavy `bench_u00006` (follows 1,158), typical `bench_u00182` (follows 40), new `bench_u00011` (0/0), private_owner `bench_u00012`, blocked pair `bench_u00013` → `bench_u00014`, celebrity `bench_u00001` (2,577 followers), reviewer_of_hot_work `bench_u00015`. Also hot work, hot review, big shelf (1,192 items), private shelf, the comment-thread read, and a `reading` read for the progress scenario. All accounts have the password in `tokens.json`, so login works.

Design decisions (all visible in the code header):

- **Row shape = the services' shape.** Activity metadata, verbs, `object_type`/`object_id` and visibility are copied from `ReadingService.setStatus/finish/dnf`, `ReviewService`, `ShelfService.addItem` and `SocialService.followUser`: private items and imported reads write no activity; a private account's activity is `followers`; `shelved` uses the shelf id as `object_id` (as the service does).
- **`works.log_count` is not touched,** although `setStatus` increments it on a new attempt. Nothing ever decrements it, so a seed that bumped it could not be cleaned, and search ranking on the real catalog would drift permanently (L-08).
- **One transaction = idempotent.** A second run sees the bench users and exits without writing (verified).
- **Bulk mode (default).** Inserting with triggers on took **1,076 s**, 227.9 s of it for follows and 629.6 s for reads (L-01, L-02). By default the inserts run under `SET LOCAL session_replication_role = replica` (superuser only, this transaction only). That skips triggers *and FK checks*, so before commit the script checks all 25 single-column foreign keys on the seeded tables with anti-joins and derives every counter with the product's own functions: `reconcile_follow_counters`, `reconcile_shelf_counters`, `reconcile_read_counters`, and `recompute_work_stats_for_work` per touched work. Bulk run: **417 s**. 108 s of that is reading the top 20k works cold, and 189 s is `recompute_work_stats_for_work` (12,573 calls, ~15 ms each, the same cost as L-01). The brief's ~5 min target is missed for those two reasons, neither of which the seed can remove without re-implementing product logic.
- **`--clean`** deletes users matching **both** `bench_%` and `@bench.flyleaf.invalid`. It refuses to run if any user matches only one. Everything else goes by `ON DELETE CASCADE`. It then removes the derived `work_stats` rows it created (only for works bench reads touched, and only if no read remains and every counter is 0) and the bench's rate-limit buckets. Finally it checks 23 user-referencing columns for survivors and rolls back if any remain.

**Clean verified.** Fingerprints (counts + md5 over rows) of all non-bench data in users, profiles, reads, reviews, shelves, shelf_items, follows, activity, progress_events, mutes, blocks, likes, comments, saves, refresh tokens, rate limits, and `id‖log_count` of the top 20k works were **identical** before seeding-then-cleaning and after. The only difference was `work_stats` total rows 12,573 → 0, which is the pre-seed state. Clean took **476 s**, 470 s of it the cascade (L-01, L-02 again). The database was then re-seeded (bulk mode) and is seeded now.

## 3. Bench runner: `apps/api/src/bench/run.ts`

`npm run bench -- [--only <regex>] [--label <name>] [--duration <s>] [--connections <n>]`, API started separately. For query counts: `BENCH_COUNT_QUERIES=1`.

- 33 scenarios covering every endpoint in the brief (search split by kind: prefix, common, author, CJK, typo, ISBN).
- Two passes per scenario. The **sequential** pass (≤15 requests one at a time) gives status codes, unloaded p50 and query counts. The **load** pass is autocannon at 10 connections × 10 s; login uses 2 connections × 40 requests, one per bench account, because login is limited to 10/min per email.
- **Honest percentiles.** autocannon emits nothing for a timed-out request, so percentiles over responses alone describe only the fast survivors. The first baseline attempt reported search p50 = 18 ms this way; it was discarded. Timeouts now enter the distribution at the 10 s timeout value. Scenarios that completed fewer than 3 requests per connection are flagged *saturated*.
- **Drain.** The server keeps executing requests that autocannon abandoned, and that backlog was charged to the next scenario (a feed scenario measured 3 req/s behind a search backlog). After every scenario the runner waits for 2 s of consecutive "no active statement" in `pg_stat_activity` and reports the wait.
- **Gap-fill guard.** A search with fewer than 5 local results and 3+ characters calls openlibrary.org live and writes to the catalog (FN-32). Every 3+ character query is first run read-only through `CatalogService` **without** gap-fill; any that would miss is dropped and listed in the report. The load pass therefore never calls Open Library and never writes to the catalog.
- Tokens are re-minted from the persona ids before each scenario (access tokens live 15 minutes).

**Query counter** (`src/bench/query-counter.ts`). postgres.js's `debug` hook plus an `AsyncLocalStorage` scope entered in the first `onRequest` hook. It returns an `x-bench-query-count` header and logs `queries` at info. It is wired by one env-gated line each in `platform/index.ts` (`makeDb`) and `app.ts` (`buildApp`). With the variable unset, no `debug` option and no hooks are installed (test: `bench-query-counter.test.ts`).

- **Validated against Postgres itself.** With `log_statement = 'all'` (enabled temporarily, then reset and confirmed `none`), the header matched the server's statement log exactly on 9/9 requests (feed 3/3, work reviews 5/5, saved shelves 56/56, three rounds each).
- **Limitation:** statements queued behind a busy pool are attributed to whichever request dispatches them, so counts come only from the sequential pass.

## 4. Route inventory: `docs/audit/route-inventory.md`

Generated by `npm run bench:routes`. It captures every route the real `buildApp()` registers, via an `onRoute` hook attached through Fastify's `fastify.initialization` diagnostics channel, so `app.ts` is untouched. Each route is probed as guest and as a signed-in user on a fresh PGlite database. **125 routes** (excluding HEAD twins):

- **7 missing from `openapi.yaml`**: all four `/v1/exports*` routes, `GET /shelf/:id`, `GET /u/:username/shelves/:slug`, `OPTIONS *`. The generator's plugin list omits `exportsPlugin` and `shelvesWebPlugin` (L-04).
- **30 alias routes (15 pairs)** in social, sharing the same handler function: `/v1/blocks*` ≡ `/v1/users/:id/block`, `/v1/follows*` ≡ `/v1/users/:id/follow`, `/v1/mutes/*` ≡ `/v1/users|works/:id/mute`, `/v1/followers|following/:userId`, `/v1/follows/requests*` ≡ `/v1/me/follow-requests*`. **None of the alias variants has a test.**
- **Mounted twice under both prefixes:** the activity plugin (`/feed` and `/v1/feed`), plus `/admin/audit-log` + `/v1/admin/audit-log` and `/admin/merges` + `/v1/admin/merges`. Each pair collapses to one spec path.
- **29 routes no test file mentions**, including `GET /v1/search`, `GET /v1/works/:id`, `GET /v1/me`, `POST /v1/auth/refresh`, `POST /v1/auth/logout` and `POST /events`. Search and works are tested only at the service level (L-06).
- **11 routes with no response schema** (web admin pages, `/healthz`, `/readyz`, shelf web pages).
- **17 `/v1` routes without an api-client method.** They are all the aliases above, plus `GET /v1/exports/:id/download` and `GET /v1/shelves/by-slug/:username/:slug`.
- **Rate limits: 4 enforced call sites in all of `src/`.** Login is 10/min per email and has **no per-IP limit**. Resend-verification is 1/min, forgot-password 5/15 min, comments 5/min. Every other §24.4 group is unenforced (`RL`, Part 15).

## Findings

None. Part 01 audits no task. Everything noticed is a lead below, for the owning part to confirm and classify.

## Performance

Baseline: **`docs/audit/perf/baseline.md`** (and `.json`). This is the "before" for every later part.

Measured 2026-09-24 against `node dist/server.js` (built from this tree, `BENCH_COUNT_QUERIES=1`, `LOG_LEVEL=warn`) on the seeded dev database. Load pass: 10 connections × 10 s, with timeouts counted at 10 s. Budgets: p95 < 300 ms overall, feed p95 < 200 ms, search p95 < 300 ms. "Saturated" means fewer than 3 requests per connection completed in the window, so the unloaded p50 is the better number.

| Endpoint / scenario | p50 / p95 / p99 ms (load) | Unloaded p50 ms | Queries/req | vs budget | Owner |
|---|---|---|---|---|---|
| search: 1–2 char prefix | 6,400 / ≥10,000 / ≥10,000, saturated | 5,832 | 1 | ✗ | Part 02 |
| search: common words (`the`, `love`, …) | every request timed out | 19,328 | 1 | ✗ | Part 02 |
| search: author names | 416 / 785 / 836 | 456 | 1 | ✗ | Part 02 |
| search: CJK (`村上`, `村上春樹`) | 3,219 / ≥10,000, saturated | ≥30,000 (timeout) | — | ✗ | Part 02 |
| search: typos | 1,301 / ≥10,000, saturated | 7,185 | 1 | ✗ | Part 02 |
| search: ISBN (supplement run) | 172 / 1,325 / 1,667 | 101 | 2 | ✗ | Part 02 |
| `GET /v1/works/:id` guest / signed in | 1.2 / 2.1 / 4.1 · 9.7 / 16 / 99 | 0.9 · 5.4 | 0 · 2 | ✓ (60 s in-process cache) | Part 08 |
| `GET /v1/works/:hot/reviews?sort=friends` as heavy | 7,455 / ≥10,000, saturated | 460 | 5 | ✗ | Part 09 |
| same, as guest | 742 / 2,163 / 2,467 | 429 | 2 | ✗ | Part 09 |
| `GET /v1/reviews/:id` | 14 / 131 / 198 | 7.3 | 2 | ✓ | Part 09 |
| `GET /v1/reads?status=reading` · `GET /v1/users/:id/reads` | 11 / 13 / 15 · 24 / 29 / 34 | 6 · 13 | 2 · 4 | ✓ | Part 08 |
| `POST /v1/reads/:id/progress` | 19 / 27 / 38 | 14 | 4 | ✓ | Part 08 |
| `GET /v1/me/stats` · `GET /v1/users/:id/stats` | 20 / 23 / 26 · 26 / 31 / 35 | 10 · 11 | 4 · 6 | ✓ | Part 10 |
| `GET /v1/feed?tab=friends` heavy · page 2 | 182 / **283** / 899 · 168 / **229** / 276 | 92 · 56 | 3 · 3 | ✗ feed p95 | Part 14 |
| same, typical · page 2 | 72 / 96 / 118 · 77 / 116 / 135 | 33 · 33 | 3 · 3 | ✓ | Part 14 |
| same, new (0 follows, cold start) · page 2 | 77 / 87 / 93 · 35 / 41 / 46 | 44 · 16 | 3 · 3 | ✓ | Part 14 |
| `GET /v1/feed?tab=popular` guest | 35 / 40 / 48 | 17 | 2 | ✓ | Part 14 |
| `GET /v1/users/:celebrity/followers` | 99 / 115 / 125 | 21 | 6 | ✓ | Part 13 |
| `GET /v1/shelves/browse` | 503 / 600 / 822 | 228 | **26** | ✗ | Part 11 |
| `GET /v1/shelves/:big/items` (1,192 items) | 395 / 419 / 459 | 299 | 6 | ✗ | Part 11 |
| `GET /v1/shelves/saved` (60 saved) | 206 / 231 / 243 | 78 | **56** | ✓ p95, N+1 (L-10) | Part 11 |
| `GET /v1/reads/:id/comments` (459-comment thread) | 23 / 27 / 30 | 9.2 | 5 | ✓ | Part 13/14 |
| `GET /v1/imports` · `GET /v1/exports` | 6.5 / 8.1 / 9.2 · 6.4 / 7.9 / 9.1 | 3.8 · 3.2 | 1 · 1 | ✓ | Part 12 |
| `POST /v1/auth/login` (2 conn, 40 req) | 30 / 34 / 36 | 23 | 3 | ✓ | Part 04 |

No non-2xx responses in any scenario (the sequential passes' statuses are all 200 apart from search timeouts).

How to re-run for an "after": seed present, then `cd apps/api && npm run build && BENCH_COUNT_QUERIES=1 LOG_LEVEL=warn node dist/server.js`, and in another shell `npm run bench -- --label <part>-after [--only <regex>]`. Compare against this table only on the same machine, and read the environment caveat (L-13) first.

## Leads (noticed in passing, not fixed)

Numbered for reference from later parts. "Evidence" is what was actually observed; the suggested severity is a guess for the owning part to confirm.

**L-01 · perf, likely P1 · Part 08/09.** `reads_work_stats_trigger` runs `recompute_work_stats_for_work()` **per row** on INSERT, DELETE and UPDATE of status/rating/hearted/work_id/user_id. That function does two full scans of `reads`: the per-work aggregate, because no index serves `reads.work_id` for all statuses (`reads_work_finished_idx` is partial on `finished`; the unique index leads with `user_id`), and `AVG(rating) FROM reads WHERE work_id <> x` for the global mean. Measured: 62,365 reads inserted in **629.6 s**, ~10 ms per row at ~31k rows. 12,573 direct calls took 189 s, ~15 ms each at 62k rows. The cost is linear in total `reads`, so every read write in production (log, finish, rate, heart, delete) pays it. Deleting 3,000 users with their reads took most of 470 s. `EXPLAIN (ANALYZE, BUFFERS)` at 62k reads confirms both statements are `Seq Scan on reads`: the per-work aggregate for the hot work removes 56,970 rows by filter, and the global mean removes 38,903. One call for the hot work takes 49 ms.

**L-02 · perf, P2 · Part 13.** `follows_counter_trigger` re-counts both profiles' followers and following with `count(*)` on every follow insert or delete: 186,014 follows took **227.9 s** (1.2 ms/row), with a celebrity's profile row rewritten once per follower. `reconcile_follow_counters()` derives the same numbers set-based in seconds.

**L-03 · correctness, likely P1 · Part 12.** `server.ts` calls `buildApp` without `boss`, `storage` or `mailer`. `ImportService.create` and `ExportService.create` enqueue only `if (this.boss)`, so **imports and exports created through the real API are never enqueued**. `POST /v1/exports` returns 201 in the probe. The comment "the record remains queued and will be picked up by reconciler/retry" (`imports/index.ts:216`) describes a reconciler that does not exist; `worker.ts` schedules only dedupe and the three counter reconcilers.

**L-04 · contract, P2 · Part 05.** `src/contract/generate.ts` does not register `exportsPlugin` or `shelvesWebPlugin`, so 6 routes are missing from `openapi.yaml` and `spec:check` cannot see drift in them (the third time this plugin list has drifted).

**L-05 · consistency, P2 · Part 13/14/05.** 15 social alias pairs, and the feed plugin registered at `/feed` and `/v1/feed` (`app.ts`). None of the aliases has a test, and the spec cannot describe both members of a `/x` + `/v1/x` pair.

**L-06 · tests, P2 · Part 02.** No test sends an HTTP request to `GET /v1/search` or `GET /v1/works/:id`. Route schema, serialisation, and the gap-fill wiring in `server.ts` are untested end to end.

**L-07 · RL · Part 15.** Login has a per-email limit only (§24.4: 10/min per account **and** 30/min per IP, 20/min anonymous per IP). `POST /events` and `POST /v1/admin/dedupe/report` are guest-callable and unlimited (the latter lets anonymous callers write to the admin review queue; Part 03/06 should confirm it is intended).

**L-08 · data integrity, P2 · Part 08.** `ReadingService.setStatus` increments `works.log_count` for every new attempt (`reading/index.ts:179`), but nothing decrements it on read delete, account delete or cascade. The schema comment ("Trigger + nightly reconciliation", `schema.ts:74`) describes neither; no trigger or reconciler for `log_count` exists. Search ranking uses it.

**L-09 · perf/consistency, P2 · Part 08/10.** `GET /v1/users/:id/reads` is **unpaginated**; it returns every read, and a bench user has up to 600. It returns `200 []` for a random, private or blocked user id, while `GET /v1/users/:id` returns 404.

**L-10 · perf, P2 · Part 11.** `GET /v1/shelves/saved` runs **56 SQL statements** for a user with 60 saved shelves: `getSavedShelves` awaits `getOwnerProfile()` sequentially per distinct owner (`shelves/index.ts:896-910`). A broad `catch` then substitutes a fake owner `username: 'user'` on any error, and the list is unpaginated.

**L-11 · consistency, P3 · Part 13.** Follow-request `reject` for a nonexistent requester returns 200; `accept` returns 404 (probe).

**L-12 · data, P3 · Part 09.** `work_stats` had 0 rows while 4 reads existed: the 0011 trigger has no backfill, so reads written before it have no stats.

**L-13 · environment · Part 02/15.** Search is far outside budget **in this environment**. Unloaded single requests: `ha` 4–34 s, `th` 13–59 s, `the` 17–67 s, `war` > 90 s, `村上` > 90 s; `tolkien` 0.4–5.7 s, `murakami` 0.3–2.1 s, `harry pottr` 0.4–2.4 s. That is against a documented 47–85 ms warm. Repeat runs of `the`/`th` do not improve, so this is not only a cold cache; it is also a 3.5 GB VM holding a 30 GB database with 128 MB `shared_buffers`. Part 02 must separate plan problems (EXPLAIN) from memory before judging search, and ideally re-measure with a warmed cache or more memory for the container. Treat the search numbers in `baseline.md` as this machine's floor, not the product's.

**L-14 · feed, P2 · Part 14.** `setStatus` emits a `started` activity for `want` as well as `reading` (`reading/index.ts:204`), so adding to want-to-read appears as "started" in the feed.

**L-15 · tooling, P3.** autocannon 8.0.0 (new devDependency) brings a moderate `uuid <11.1.1` advisory via `hyperid`. Dev only; the CI gate (`high`) is unaffected. The api moderate count went 4 → 7.

**L-16 · perf, likely P1 · Part 09.** `GET /v1/works/:hot/reviews?sort=friends` (5,303 reviews) is saturated under load for `heavy` (1,158 follows): p50 7.5 s, 3 of 10 connections timed out, 460 ms unloaded. As guest it is p50 742 / p95 2,163 ms. The load p95 for both is far outside the 300 ms budget. The part README already expects an in-memory review list; this is the measured cost of it on the brief's hot-work case.

**L-17 · perf, P1 (budget) · Part 14.** Friends feed for `heavy` has p95 **283 ms** (p99 899), and page 2 has p95 229 ms, against the feed budget of p95 < 200 ms. Only 3 statements per request, so the cost is inside the queries or in-process ranking. Needs EXPLAIN.

**L-18 · perf, P1 (budget) · Part 11.** `GET /v1/shelves/browse` p50 503 / p95 600 ms with **26 statements per request**, and `GET /v1/shelves/:id/items` for the 1,192-item shelf p50 395 / p95 419 ms. Both are over budget. Check whether items are paginated.

## Behaviour changes

None when `BENCH_COUNT_QUERIES` is unset, which is every environment except a bench run. With it set, responses carry `x-bench-query-count` and an info log line per request.

## Files

- New: `apps/api/src/bench/{seed.ts, run.ts, routes.ts, query-counter.ts, autocannon.d.ts}`, `apps/api/src/test/bench-query-counter.test.ts`, `docs/audit/route-inventory.md`, `docs/audit/perf/baseline.{md,json}`, this file.
- Changed: `apps/api/src/platform/index.ts` (+3, env-gated `debug`), `apps/api/src/app.ts` (+5, env-gated hooks), `apps/api/package.json` (scripts `bench`, `bench:seed`, `bench:routes`; devDependency `autocannon` **8.0.0**, pinned, because the brief requires a load generator and none exists in the repo), `package-lock.json`, `.gitignore` (+`apps/api/src/bench/tokens.json`).
- Not mine: `.gitignore` also gained `docs/audit` during this session, so these audit files are currently ignored by git.

## Decisions needed

None blocking. One to note: the seed's bulk mode trades trigger-maintained counters for the product's reconcile functions. If you'd rather the seed always exercise the triggers, run it with `--with-triggers` (~18 min).

## Deferred

All leads above, to the parts named. Rate limits (L-07) to Part 15, as the method requires.

## CI after

`node scripts/ci.mjs` after all changes: **green in 908 s**, all 9 steps. api tests **740 passed** (46 files; +2 in `bench-query-counter.test.ts`), mobile **100 passed**, audit gate passes (7 moderate, 0 high), spec check passes (no route changes), migrations applied on the real server.

The slower run is uniform across the whole suite: vitest took 766 s against 391 s, and module import alone took 92 s against 39 s. The only new test file holds two in-memory tests. I did not establish why the machine was slower (the WSL VM had just finished the bench and CI), so treat that as an unmeasured environment effect, not a regression.

`bench-query-counter.test.ts` was checked against three deliberate mutants of `query-counter.ts`, and each one failed it: no scope → no header; one shared counter reset per request → cross-request leakage (`['1','11','23',…]` against `['1','4','8',…]`); always enabled → the gating assertion fails. A fourth mutant, `enterWith` in place of `run`, passed, as it should: it is also a correct per-request scope in a synchronous callback hook.



## Routing changes after Part 01 (24 Sep)
- **L-03: fixed out of band** before Part 02 (production wiring in `src/server-wiring.ts`, test `server-wiring.test.ts`, verified end to end with API + worker). Part 12 verifies.
- **L-01: moved from Part 09 to Part 08**, which measures reading writes and so fixes it first.
- **L-14: routed to Part 14**, together with the want-to-read swipe.
- Perf baselines: `perf/baseline.md` (full DB) and **`perf/baseline-dev.md` (`flyleaf_dev`, with query counts)**. Later parts compare against `baseline-dev` unless they're working on the full catalog.
