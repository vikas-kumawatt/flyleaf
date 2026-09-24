# Audit Part 01 — Baseline, benchmark harness, route inventory

**Read `docs/audit/00-method.md` first.** This part fixes nothing in product code. It builds the instruments every later part uses. Don't skip it or cut it short: an audit without a measured baseline can't show that anything improved.

## 1. Baseline

1. Confirm the database: `docker ps` shows `flyleaf-pg` on `0.0.0.0:5432`. Run `npm run migrate` in `apps/api` and expect `migrations applied`.
2. Run `node scripts/ci.mjs` from the repo root. Record in `docs/audit/findings/01-baseline.md`: API and mobile test counts, duration, and any failures (expected: 738 API, 100 mobile, all green).
3. Record catalog volumes from the real database: row counts for `works`, `editions`, `authors`, `reads`, `activity`, `reviews`, `shelves`. Use `pg_class.reltuples` for the big tables rather than `COUNT(*)`.

## 2. Benchmark data: `apps/api/src/bench/seed.ts`

Write a seed script (`npm run bench:seed`, `npm run bench:seed -- --clean`) that adds a realistic **social** data set on top of the real catalog. Requirements:

- **Removable.** Every user it creates has a username starting `bench_` and an email at `@bench.flyleaf.invalid`. `--clean` deletes exactly those users; all their data must go by cascade, so check that it does. It must never touch other data.
- **Idempotent.** Running it twice doesn't duplicate anything.
- **Realistic shape, not uniform:**
  - ~3,000 users; ~10% private accounts.
  - Power-law follow graph: median ~40 follows, a few users following 1,000+, a few "celebrities" with 2,000+ followers; ~5% pending follows to private accounts.
  - ~150 blocks and ~300 mutes (user and work).
  - ~60,000 reads over the top ~20,000 works by `log_count`, heavily skewed to popular titles, across every status. Include re-reads (`attempt_no` 2+), ~5% private and ~10% followers-only visibility, and ~15% `source = 'import'`.
  - Progress events for reading/finished reads (~200,000 rows).
  - ~12,000 reviews, including one work with **5,000+ reviews** (the hot-work case), and spoiler/visibility variety.
  - ~40,000 likes and ~8,000 comments on terminal reads.
  - ~4,000 shelves (some with 500+ items, some private, some soft-deleted) and ~1,500 saves.
  - Activity rows consistent with the above, spanning ~120 days. Write them the way the services write them (reuse `ActivityService.recordActivity` or match its row shape exactly), so feed queries see production-shaped data.
- **Fast.** Use batched multi-row inserts or `COPY`, not one request per row. Target under ~5 minutes.
- Afterwards, run `reconcile_read_counters()`, the shelf and follow reconcile functions, and `ANALYZE`.
- **Tokens.** Write `apps/api/src/bench/tokens.json` (gitignored, so add it to `.gitignore`) with signed access tokens for a named set of personas:
  - `heavy` (follows 1,000+)
  - `typical` (follows ~40)
  - `new` (follows 0)
  - `private_owner`
  - `blocked_pair_a` / `blocked_pair_b`
  - `celebrity` (2,000+ followers)
  - `reviewer_of_hot_work`

  Also write the ids of the hot work, a big shelf and a private shelf.

## 3. Bench runner: `apps/api/src/bench/run.ts`

`npm run bench -- [--only <pattern>] [--label <name>]` does the following:

- Starts nothing itself. It expects the API running locally (`npm run dev` or `npm run start` in `apps/api`).
- Runs **autocannon** (add it as a pinned devDependency) for ~10 s at 10 connections per scenario.
- Writes p50/p95/p99, request rate and non-2xx counts to `docs/audit/perf/<label>.md` and `docs/audit/perf/<label>.json`.

Scenarios, one per hot endpoint, using the personas:

- search: a mix of 1–2 character prefixes, common words, author names, a non-Latin query (`村上`), typos and an ISBN
- `GET /v1/works/:id` (guest and signed in)
- `GET /v1/works/:hot/reviews?sort=friends` as `heavy` and as a guest
- `GET /v1/reviews/:id`
- `GET /v1/reads?status=reading` and `GET /v1/users/:id/reads`
- `POST /v1/reads/:id/progress` (fresh `client_event_id` per request)
- `GET /v1/me/stats` and `GET /v1/users/:id/stats`
- `GET /v1/feed?tab=friends` as `heavy`, `typical` and `new`, plus page 2 via the cursor
- `GET /v1/feed?tab=popular` as a guest
- `GET /v1/users/:celebrity/followers`
- `GET /v1/shelves/browse`, `GET /v1/shelves/:big/items`, `GET /v1/shelves/saved`
- `GET /v1/reads/:id/comments`
- `GET /v1/imports` / `GET /v1/exports`
- `POST /v1/auth/login`, measured separately with low concurrency, since argon2 dominates by design

Add a **query counter**: when `BENCH_COUNT_QUERIES=1`, log the number of SQL statements per request (postgres.js has a `debug` hook) and include the per-scenario median in the report. Keep this dev-only: when the variable is unset, zero cost and no behaviour change.

Run it once and save the result as `docs/audit/perf/baseline.md`. That file is the "before" for every later part.

## 4. Route inventory: `docs/audit/route-inventory.md`

Generate it from the running app rather than by hand: `app.printRoutes()` or `app.addHook('onRoute')` in a small script. For **every** route record:

- method, path, owning plugin/file
- auth mode: guest OK / signed in / admin / moderator
- whether it has request and response schemas
- whether it appears in `openapi.yaml`
- whether `@flyleaf/api-client` has a method for it
- which test files exercise it (grep the tests for the path)
- the PRD §24.4 rate-limit group it belongs to, and whether any limit is enforced today

Flag duplicates and aliases. Two known ones: the feed plugin is registered both at `/feed` and `/v1/feed`, and social has alias routes such as `/v1/blocks/:userId`. Flag routes missing from the spec, and routes with no test at all.

## 5. Deliverables

- `docs/audit/findings/01-baseline.md`: counts, volumes, the CI result, and a short list of anything alarming you noticed in passing (as numbered leads, without fixing them)
- `apps/api/src/bench/{seed.ts,run.ts}`, npm scripts, and `.gitignore` entries
- `docs/audit/perf/baseline.{md,json}`
- `docs/audit/route-inventory.md`

Finish with CI green and the seed script's `--clean` verified to remove everything it added. Re-seed afterwards, because later parts need the data.
