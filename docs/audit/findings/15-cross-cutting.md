# Audit 15a — Cross-cutting fixes (the cloud half of Part 15)

2026-10-10 · CI: **green in 1,327 s**, all 9 steps (sandbox; details at the end) · Tests: API **1,610 → 1,733** (+94 `rate-limits.test.ts`, +8 `popular-feed.test.ts`, +16 `cross-cutting-audit.test.ts`, +1 each in `dedupe`, `ingest`, `shelves-audit`, +2 `admin-security`, +1 `auth-audit`); mobile **207 → 214** (+6 tap counter in `telemetry-budgets.test.ts`, +1 in `queue.test.ts`). No test was weakened or skipped. Existing assertions that pinned behaviour this part deliberately changed were updated with a comment naming the finding (list under "Behaviour changes" › "Tests changed").

**How this part ran.** The brief is split: **15a** (this file, a cloud sandbox) does every code change, the docs, and the measurements that are meaningful on a small synthetic database. **15b** (the owner's laptop, `docs/audit/15b-laptop.md`) applies the migrations to `flyleaf` and `flyleaf_dev`, runs every deferred bench, and finishes `perf/comparison.md` and `SUMMARY.md`. Overrides for this run:

- **No `flyleaf` / `flyleaf_dev`, no Docker.** A local **PostgreSQL 18.3** (the `embedded-postgres` npm package, as in Parts 12–14) on :5432 with an empty `flyleaf` database; `npm run migrate` applied 0038–0041 to it cleanly. **MinIO** built from source (`go install github.com/minio/minio@RELEASE.2025-04-22T22-12-26Z`) on :9000 for the storage contract tests.
- **New migrations 0038–0041 are applied to PGlite and the sandbox Postgres only.** `flyleaf_dev` is unchanged until 15b (with 0034–0037 from Parts 11–13).
- **Every number below says where it came from.** "Sandbox, synthetic" numbers are only good for ratios and plan shapes. Nothing measured on `flyleaf`/`flyleaf_dev` was claimed by 15a; those rows now carry the 15b laptop result (2026-10-11), each naming its database.
- Branch `audit/15a-cross-cutting` from `main` (after PR #4), committed, pushed, PR to `main`.

## Owner decision recorded at the start of this part

- **D-14-1 accepted as recommended, narrowed by the owner:** Popular = public **reviews and finishes** from the last **14 days**, scored by **likes and comments (never rating)**, with a **per-card exposure cap**. Built here (A-15-003). Recorded in `findings/14-feed.md` › Decisions.

## Verdict per brief section

| § | Asked | Done | Findings |
|---|---|---|---|
| 1 | one limiter layer for every RL finding; PRD refs next to numbers; global tier; 429 + Retry-After; measure the cost; table tests; `rate_limits` cleanup | ✅ `platform/rate-limits.ts`, one table, two stores chosen by measurement; every RL finding of Parts 01–14 mapped below; `rate_limits` rows now expire and are swept | A-15-002, A-15-015 |
| 2 | `DECISIONS.md` | ✅ written; nothing in it implemented | — |
| 3 | per-job `work_mem` / `statement_timeout`; container memory; no whole-catalog statement; A-03-027 ingest fix | ✅ code; 15b: limits verified by readback, reconciles measured on `flyleaf`; `authors.repair`, the dedupe dry runs and the A-03-027 count **not measured** (laptop memory; ≥ 16 GB machine), and the repair's plan is A-15-027 | A-15-004 … A-15-006, A-15-027, A-15-028 |
| 4 | matrix; counters; `has_works` repair; retention; HTML/CSP; offline replay | ✅ | A-15-007 … A-15-009, A-15-014, A-15-016 … A-15-019 |
| 5 | docs reconciliation | ✅; laptop numbers filled in 15b, or marked "not measured" with the reason | — |
| 6 | final verification on the real DBs | **15b** (`15b-laptop.md` › 6) | — |
| Handed over (10) | event retention, zero-result summary, tap counter, avatar retention | ✅ | A-15-008, A-15-009, A-15-010 |
| Handed over (12) | import/export/upload limits; retention of deleted accounts' objects and of `import_rows` | ✅ | A-15-002, A-15-008 |
| Handed over (14) | D-14-1; cursor sweep on a real server; prepared statements | ✅ D-14-1; ✅ sweep; prepared statements deferred (below) | A-15-003, A-15-014 |
| Carried | flaky A-04-006; 15 alias routes; A-11-029; shelf view counter | ✅; ✅; ✅; decision recorded (D-15-7) | A-15-011 … A-15-013 |

## Findings

### A-15-001 · P1 · Telemetry was never reachable where the app sends it
- **Evidence:** `telemetryRoutes` was registered at the root with paths `/events` and `/admin/telemetry/budgets`, so the real app served `POST /events` and `GET /admin/telemetry/budgets`. The app's client posts to `${base}/v1/events` (base ends in `/v1`), so **every telemetry batch from the phone was a 404**, and the admin budgets endpoint documented as `/v1/admin/telemetry/budgets` did not exist. Part 10's tests built their own app with the route at the root, so they could not see it.
- **Fix:** `app.ts` registers `telemetryRoutes` with `{ prefix: '/v1' }`.
- **Test:** `cross-cutting-audit` › *POST /v1/events and GET /v1/admin/telemetry/budgets exist on the real app; the old root paths do not*. Seen failing before the fix: yes (404 for `/v1/events`). `admin-security.test.ts`'s budgets row now uses the `/v1` path (commented).

### A-15-002 · RL · One rate-limit layer (closes every RL finding)
- **Design:** `platform/rate-limits.ts`. `RATE_LIMITS` is one table, each row with its PRD section (`source`), number, window, store and 429 message. Routes get groups in `config.limits`: explicitly (`ROUTE_LIMIT_GROUPS` in `app.ts`) or, for any `POST/PUT/PATCH/DELETE` not listed, `writes`, so a route added later is covered without an entry. A `preValidation` hook checks the Global tier and the route's groups (keyed `account:<id>` when signed in, `ip:<req.ip>` otherwise; `req.ip` follows Part 04's `trustProxy` decision). Rules that need what only a service knows call `limits.enforce(name, key, tx?)` inside the service (follows, reviews, imports, exports, uploads, username, comments, admin login).
- **Two stores, chosen by measurement (below):** `exact` = the injected `RateLimiter` (`PgRateLimiter`), for low-volume limits whose bypass would be a security weakening; `fast` = `MemoryRateLimiter` (in-process fixed windows, swept), for checks on nearly every request (Global, Search, Writes, Progress, Events, username check). Redis later is one implementation of the same interface plus a config line (architecture §4.1).
- **429:** `{ error: { code: 'rate_limited', message } }`, `Retry-After` (seconds) and `X-RateLimit-Limit/Remaining/Reset`. The admin form login renders its HTML page with status 429 and `Retry-After`.
- **Cleanup:** migration **0038** adds `rate_limits.expires_at` (+ index); every hit writes it; the retention sweep deletes ended buckets (A-04-022).
- **Bench runs:** `BENCH_RATE_LIMITS=legacy` keeps only the four pre-existing limits in `server.ts`, so 15b's "after" bench compares like with like (the baseline had no limits; the bench's 10 connections would meet the Global tier in seconds). It is refused at start when `NODE_ENV=production` (tested: *BENCH_RATE_LIMITS=legacy keeps a bench like the baseline, and is refused in production*).
- **Behaviour in tests:** a test app gets only the four limits that existed before this part (login, resend, forgot, comments), unless it passes `rateLimits`; production (`server-wiring.ts`) builds `new RateLimits({ exact: limiter, enabled: 'all' })`. This keeps 1,600 existing tests from tripping a Global tier they never meant to test, and is itself tested (*a test app gets only the limits that existed before Part 15; production gets all*).
- **Coverage, finding by finding:**

| Finding | Limit now | Where |
|---|---|---|
| L-07, A-04-017 login per IP | auth 30/min per IP, 20/min anonymous IP; login 10/min per email (kept) | hook + `IdentityService` |
| A-04-018 register | auth tier | hook |
| A-04-019 refresh, verify-email, reset, logout | auth tier | hook |
| A-04-020 forgot per email only | forgot 5/15 min per email (kept) + auth tier per IP | both |
| A-04-021 no unlock time / headers | `Retry-After`, `X-RateLimit-*` on every 429 | `sendError` |
| A-04-022 `rate_limits` grows forever | `expires_at` + daily sweep | 0038, retention |
| A-05-RL1, A-13-007 follows §11.7 | 50/h, 200/day, 3 per pair per day, 20 in a new account's first 24 h; only a follow that creates a row counts (a replay does not) | `SocialService`, in the follow's transaction |
| A-13-008 re-request after reject | counts in the pair limit (3/day) | same |
| A-05-RL2, A-08-029, A-09-022, A-11-031, A-06-RL3, A-07-038 writes | writes 120/min per account | hook (default for unsafe methods) |
| A-09-022 reviews §10.6 | 10/hour, 30/day for a new or revived review; edits are writes | `ReviewService`, in the publish transaction |
| A-05-RL3 progress | 300/min | hook |
| A-05-RL4, A-12-021 import 3/day, export 2/day | exact; an import replayed by `upload_id` returns the same import and is not counted | services |
| A-PV-007 uploads | 10 intents/day (D-15-2) | `UploadService` |
| A-05-RL5, A-02-016 search | 60/min per account, 20/min per IP | hook |
| A-05-RL6 Global | 1,000/h per account, 200/h per IP (`/healthz`, `/readyz` exempt) | hook |
| A-05-RL7, A-09-042, A-10-029 profile, stats, reads, avatars, book page | Global tier | hook |
| A-07-030 username check | 20/min per IP | hook |
| A-07-037 emailed-link pages | auth tier | hook |
| A-13-021 username changes | 1 per 30 days (the first claim and taking back your own old name are free) | `IdentityService`, transaction |
| A-06-RL1 admin login | 10/min per email + auth tier per IP, JSON and form | `adminAuthRoutes` |
| A-06-RL2 admin 2FA verify | auth-account tier (keyed by IP: admin requests carry no app viewer) | hook |
| A-10-029 `POST /v1/events` (guest) | 120/hour (D-15-2) | hook |
| A-03-009 dedupe report | writes 120/min | hook |
| SO-22 comments | unchanged (5/min, same bucket name) | `enforceWith` |

- **Cost (sandbox, synthetic; `perf/15a-rate-limit-overhead-sandbox.md`, 3 runs):** one `PgRateLimiter.hit` ≈ 1.5–1.7 ms p50 against ≈ 1 µs in process. End to end on one cheap route: production config (Global in process) within noise of no limits; Global in Postgres **26–35 % fewer requests/s** and one row update per request. Hence the split above. **Laptop rerun (15b, `flyleaf_dev`, 3 runs, `perf/15b/rate-limit-overhead.txt`) confirms the reading:** Global in process within noise of no limits (+7–8 % req/s in all three runs: order and warm-up, not a gain); Global in Postgres **22–25 % fewer requests/s** than no limits (a quarter here against a third in the sandbox); one `PgRateLimiter.hit` 5.1 ms p50 (sandbox 1.5–1.7 ms). D-15-1 stands.
- **Tests:** `rate-limits.test.ts` (94): the table mirrors PRD §24.4/§11.7/§10.6 exactly; each in-process limit allows exactly N, refuses N+1 with `Retry-After` and resets; each exact limit the same on Postgres; every state-changing route is in a group; 16 HTTP cases (search per IP and per account, Global across routes, auth per IP, writes vs progress, follows ×3, reviews, imports with replay, exports, uploads, username, events, admin login JSON and form, comments unchanged). Seen failing before the fix: the file cannot load on `main` (no `rate-limits.ts`), and every HTTP case asserts a 429 that `main` never sends (4 limiter call sites).

### A-15-003 · P1 · D-14-1 built: Popular is popular
- **Rule:** public `reviewed` and `finished` cards from the last 14 days; score = `weight × decay(age, 72 h half-life) × (1 + ln(1 + likes + 2 × comments))` from the read's counters; **never rating**; the §12.4 diversity penalty per actor and per work; blocks and mutes for a signed-in viewer. A card leaves Popular after it has been served `POPULAR_EXPOSURE_CAP` = 1,000 times (D-15-3), counted in **0039** `popular_exposures` (served pages and the sparse-friends blend both count).
- **Paging:** keyset on `(score, created_at, id)`, scored "as of" the instant in the cursor (`n`), so a card that gains likes mid-walk is neither repeated nor skipped; `v` versions the formula. A popular cursor without its score, or a friends cursor on the popular tab, is 400 `invalid_cursor`. Partial index `activity_popular_idx` (0039).
- **Tests:** `popular-feed.test.ts` (8). Seen failing on Part 14's Popular: 6 of 8 (the two that passed are the block/mute and cursor-shape guards). `feed-audit.test.ts`'s popular walk now expects only reviews and finishes (commented).

### A-15-004 · P1 · Every batch process has its own memory and time budget (A-03-026)
- **Fix:** `JOB_DB_SETTINGS` in `platform/index.ts`, sent in the connection startup packet (`makeDb(url, { settings })`), so they hold for every statement on that pool and cannot leak to API connections: **worker** (reconciles, retention, summaries) `work_mem` 32 MB, `statement_timeout` 10 min; **dedupe** 64 MB, 30 min, `max_parallel_workers_per_gather` 1; **ingest** 64 MB, 1 h; the API keeps the server default (4 MB, none). `ingest.ts` no longer sets `work_mem = 256MB` for the session. `devdb.ts` uses the ingest profile. The worker opens a separate one-connection dedupe pool.
- **Container memory:** `docker-compose.yml` sets `mem_limit: 3g`, `shared_buffers` 512 MB, `work_mem` 4 MB, `hash_mem_multiplier` 2, `maintenance_work_mem` 256 MB, `max_connections` 50, `effective_cache_size` 2 GB, with the arithmetic in a comment (worst case ≈ API pool × 4 MB × 2 + jobs' budgets + shared buffers < 3 GB). **Applying it recreates the Postgres container: 15b, after the bench.**
- **Verified (sandbox):** `npx tsx src/bench/job-settings-check.ts` read back `SHOW work_mem / statement_timeout` through each pool: worker 32MB / 10min, dedupe 64MB / 30min, ingest 64MB / 1h, API 4MB / 0.
- **Test:** `cross-cutting-audit` › *every batch process connects with its own work_mem and statement_timeout*. Seen failing before the fix: yes (no `JOB_DB_SETTINGS`).
- **15b (laptop):** the container was recreated with the limit (step 12, moved before step 8 by the owner): `HostConfig.Memory` 3221225472, `shared_buffers` 512MB, `work_mem` 4MB, `hash_mem_multiplier` 2, `maintenance_work_mem` 256MB, `effective_cache_size` 2GB (`max_connections` 50, then 100 per A-15-026); both databases at 42 migrations after each recreate; no crash recovery in its log. `job-settings-check.ts` on `flyleaf`, before and after: worker 32MB / 10min, dedupe 64MB / 30min, ingest 64MB / 1h, API 4MB / 0 (before step 12 that API row is the stock default, A-15-031). **The unlimited "before" is Part 03c's OOM crash**: not repeated on this 8 GB machine (owner, 2026-10-11). The monthly dedupe dry run under the limit is **not measured here** (owner: run on a machine with ≥ 16 GB before the backlog merge).

### A-15-005 · P1 · No batch job builds a whole-catalog set in one statement (A-03-026)
- **Reconciles:** `reconcile_read/follow/shelf_counters(lo, hi)` and `reconcile_work_counters(lo, hi, c)` (0040) take a key range; the jobs walk `walkRanges` (`jobs/ranges.ts`) in ranges of `RECONCILE_BATCH` = 5,000 keys and report ranges and rows corrected. The whole-table functions are kept for tests and manual use.
- **Dedupe:** `detectStage12` runs stage 1 in ISBN ranges (`STAGE1_ISBN_BATCH` = 20,000) and stage 2 in author batches (the backlog's walk, A-03-025); stage 3 runs its peer search in chunks of `STAGE3_PEER_CHUNK` = 500 per author batch. Results are merged and sorted in JS, so the output is the same.
- **Finalise:** `MARK_CREDITED_AUTHORS` (one statement over 15.4M authors) is replaced by the range repair of A-15-007.
- **Tests:** `cross-cutting-audit` › *walkRanges covers every key once…* and *read, follow, shelf and work counters: drift repaired range by range; the whole-table function then finds nothing*; `dedupe.test.ts` › *sliced stages 1–3 find exactly the pairs the whole-catalog statements find* (guard: proves equivalence, passes by design).
- **Measurement on the full catalog (15b, `flyleaf`, under the 3 GiB limit, `perf/15b/jobs-full.txt`):** `reconcile.reads` 13 ranges, 0 corrected, 1.4 s; `reconcile.follows` 1 range, 0, 0.3 s; `reconcile.shelves` 1 range, 0, 0.9 s; `reconcile.works` 13 ranges, 0 work_stats / 0 reader_count, 7.6 s; no statement timeout. Postgres container 559–580 MiB in the 5 s samples across all four (`perf/15b/pg-mem.txt`). `authors.repair`: **not measured here: killed by the memory guard at 133 MB**, and its set arm is not ranged in practice (A-15-027). Monthly dedupe dry run and the backlog dry run: **not measured here** (≥ 16 GB machine, before the backlog merge).

### A-15-006 · P1 · Ingest no longer adds a second credit under a name already on the work (A-03-027)
- **Evidence (Part 03c, `flyleaf`):** 11,112 live works credited to two author records with the same name.
- **Fix:** `catalog/ingest/writer.ts` `SAME_NAME_CREDIT_GUARD`: `MERGE_WORK_AUTHORS` and `RESOLVE_PENDING_WORK_AUTHORS` credit at most one author record per `lower(btrim(name))` per work (the first by key order; an existing credit wins).
- **Test:** `ingest.test.ts` › *A-03-027: a work is not credited twice under one name*. Seen failing on the old SQL: yes (2 credits).
- **Existing data and an author merge:** not changed here. `src/bench/duplicate-credits.ts` (read-only) counts the affected works, the same-name record pairs that share a work (merge candidates) and samples them. **15b (`flyleaf`): not measured.** The first attempt failed in Postgres on a parallel hash join (`/dev/shm` 64 MB, A-15-028); the second, with parallelism off for its session, was killed by the memory guard at 175 MB after ~50 s, and its read-only statement was cancelled (`perf/15b/duplicate-credits-full.md`). Part 03c's 11,112 works / 12,524 pairs stand until it runs on a ≥ 16 GB machine; **D-15-8** in `DECISIONS.md` waits on that count.

### A-15-007 · P1 · `authors.has_works` has a nightly repair
- **Fix:** `repair_author_has_works(lo, hi)` (0040) sets the flag for credited authors and clears it for authors whose works were all merged away (`FOR UPDATE SKIP LOCKED`, so it never waits on an ingest); returns `{set, cleared}`. Job `authors.repair`, `'5 4 * * *'`, walks authors in ranges of 20,000. `--finalise` calls the same function.
- **Test:** `cross-cutting-audit` › *flags an author an ingest left unflagged, clears one whose works were all merged away, and reports both*. Seen failing before the fix: yes (no function).

### A-15-008 · P1 · Every soft delete and every log has an end
- **Fix:** `jobs/retention.ts` `retentionSweep`, job `retention.sweep` daily at `'20 4 * * *'`, in batches, each step reporting its count:

| Data | Rule | Source |
|---|---|---|
| `rate_limits` | bucket ended | A-04-022 |
| `events` | older than 13 months | D-10-1 (PRD §23.5) |
| `search_zero_results` events | older than a flat 30 days | D-10-1 |
| shelves, reviews, comments | 30 days after soft delete | SH-02 A-11-033; PRD §6.35; D-15-6 for comments |
| accounts | 30 days after deletion: stored objects (`avatars/`, `uploads/<user>/`, `exports/<user>/`) first, then the row (cascades) | A-PV-008, A-10-016 |
| orphan user mutes | target account gone | — |
| `import_rows.raw` | for committed rows of an import older than 30 days, trimmed to title/author/ISBN; rows still to review keep everything | D-15-5 (Part 12 hand-over) |
| avatar uploads | an avatar object no profile points to, a day after its upload | A-10-016 |

  Exports and the import files themselves already had their own cleanup (`cleanupStorage`, Part 12); the 180-day activity prune is Part 14's. Migration **0041** adds the indexes the sweep needs (`events_at_idx`, `reviews_deleted_idx`, `read_comments_deleted_idx`, `shelves_purge_idx`).
- **Tests:** six in `cross-cutting-audit` › *§4: retention…*, one per row group above, each asserting both what goes and what stays. Seen failing before the fix: yes (no sweep).

### A-15-009 · P2 · D-10-3: the zero-result weekly summary, and a guest's searcher id (D-15-4)
- **Fix:** a zero-result search stores `properties.searcher = hmac(week_salt, who)` where `who` is `account:<id>`, else `session:<x-flyleaf-session header>`, else `ip:<req.ip>` (**D-15-4**: the app now sends its telemetry session id on search; the IP fallback covers other clients). The salt is in `search_week_salts` (0041), one per ISO week. Job `search.zero.summary`, Mondays `'30 4 * * 1'`, writes `search_zero_summaries (week, query, searches, distinct_searchers)` for last week, with the query text only when **≥ 5 distinct searchers**, else one row with `query = NULL` and the counts, and **deletes that week's salt in the same transaction**.
- **Tests:** `cross-cutting-audit` › *a zero-result search stores a weekly searcher key, never the account, session or IP* and *keeps a query's text only past 5 distinct searchers…*. Seen failing before the fix: yes. `search-suggestion.test.ts`'s "never linked to the viewer" test now also checks the `searcher` key's shape and that it does not contain the account id (commented).

### A-15-010 · P2 · D-10-2: `book_logged` counts taps
- **Fix (mobile):** `budgetTracker` keeps one impression per work: started by a search row's render (`searchRowsShown`, Discover and the log sheet) or the book page (`bookPageShown`); a row tap (`searchRowOpened`) counts and carries it to that work's page; it ends when the screen loses focus (`searchLeft`, `bookPageLeft`) or after 10 minutes; the status button counts a tap and **local success** (after the offline repository write, or the guest shelf add) sends `book_logged {tap_count, source: search | work_detail, target_status}` once. Nothing is sent without a live impression.
- **Tests:** `telemetry-budgets.test.ts` › *book_logged counts taps from the impression* (6: carried row tap = 2 taps; direct = 1; no carry across works; 10-minute expiry; navigation ends it; no impression, no event). Seen failing before the fix: yes (methods absent).
- **Counted taps** are the ones on the shelve path (the row that opens the book, the status button); a tap elsewhere on the book page that does not navigate is not counted. Recorded under Behaviour changes.

### A-15-011 · P3 · The flaky login timing test (A-04-006)
- **Evidence:** the test compared wall-clock times of unknown-email and wrong-password logins; on a loaded runner one sample could swing past the threshold.
- **Fix (test only; no product change):** `identity` exposes a `passwordWork` counter; the test now asserts **exactly one** password verification on each path (the property that matters: an unknown email does the same work), and compares the **medians of 7 alternating samples** with the same 0.5 threshold.
- **Mutation check:** with the dummy verify removed from the unknown-email path, the test fails on the count (0 ≠ 1).

### A-15-012 · P3 · The 15 legacy social alias routes are gone
- `/v1/follows/*`, `/v1/blocks*`, `/v1/mutes*`, `/v1/followers/:userId`, `/v1/following/:userId` (kept by Part 13 for one release) are removed; nothing in the app or the client calls them. They now answer the generic 404 body. `social-graph-audit.test.ts`'s alias block now asserts all 15 are 404 and the canonical routes still work (commented); `authorization-matrix.test.ts` drops the alias case (commented). Spec regenerated (drift 0).

### A-15-013 · P3 · Shelf owners carry `avatarUrl` (A-11-029)
- Every shelf owner object (detail, by-slug, cards in mine/saved/browse) has `avatarUrl` beside `avatarKey`, like every other person object. Schema and client type updated.
- **Test:** `shelves-audit` › *every shelf response gives owner.avatarUrl…*. Seen failing before the fix: yes (`expected undefined`).

### A-15-014 · Cursor sweep on a real Postgres (A-14-020): no defect left
- **Run (sandbox Postgres, synthetic rows sharing one millisecond, microseconds apart):** `npx tsx src/bench/cursor-sweep.ts`

| Endpoint | Rows | Served | Repeated | Missing | Result |
|---|---|---|---|---|---|
| `GET /v1/reads/:id/comments` (limit 2) | 9 | 9 | 0 | 0 | OK |
| `GET /v1/users/:id/reads` (limit 2) | 9 | 9 | 0 | 0 | OK |
| `GET /v1/feed?tab=friends` (limit 4) | 24 | 24 | 0 | 0 | OK |
| `GET /v1/feed?tab=popular`, guest (limit 3) | 24 | 24 | 0 | 0 | OK |

- **The sweep detects the bug class:** with the comment cursor truncated back to milliseconds (Part 14's bug), the comment walk failed ("never ended"). Other cursor endpoints use ids or offsets (shelves, admin lists) and have no timestamp to truncate.

### A-15-015 · P2 · A 429 no longer dead-letters queued writes (A-07-039)
- **Fix (mobile):** the queue classifies 429 as `throttled`: the entity's writes halt until `Retry-After` (default 60 s, at most a day), and **no attempt is used**. The client parses `Retry-After` into `FlyleafApiError.retryAfterSeconds`.
- **Test:** `queue.test.ts` test 2d. Seen failing before the fix: yes (the row used an attempt and backed off as an error).

### A-15-016 · Guard · Offline replay safety (Part 07's table, re-run)
- **Test:** `cross-cutting-audit` › *each queued action sent twice leaves one state and one activity row…*: `upsert_read`, `add_progress`, `finish_read`, `save_review`, `dnf_read`, `set_like`, `set_follow`, `delete_read` sent twice each. One read per work, one progress event, one live review, one like, one follow, one activity row per state change (so A-07-023's duplicate activity on replay no longer happens), and the replayed delete answers 404, which the queue treats as done. Passed first time (a guard).
- **Part 07's table, updated:** `upsert_read` ✅ (one row and one activity per state); `finish_read` ✅; `dnf_read` ✅ (`abandoned_at` is kept on a replay, `COALESCE`); `delete_read` (added in Part 08) ✅ 404 = done; and every action: a 429 is now `throttled`, never a dead letter (A-15-015).

### A-15-017 · Guard · Every server-rendered HTML page escapes and sends a CSP
- **Test:** `cross-cutting-audit` › *admin login, both shelf share pages and both emailed-link pages*: with a `<script>` payload in the shelf's name and description and in the emailed links' token, no page echoes it, none has an inline handler, and each sends a CSP with `default-src 'none'` and no `'unsafe-inline'` script source. A guard: no page needed a fix (Parts 05, 06, 07 and 11 fixed them one by one).

### A-15-018 · Guard · The 8-viewer matrix covers the resources added after Part 05
- `authorization-matrix.test.ts` re-run: it already includes reviews, comments, likes, shelves (items, saves, restore, share pages), stats, follower lists, imports, exports and the feed (added by Parts 08–14). Added: `DELETE /v1/reads/:id` to the writes row (Part 08's route). All 8 viewers answer the same way across sibling resources.

### A-15-019 · Guard · Every counter has a trigger, a reconcile and a drift-repair test

| Counter | Trigger | Reconcile (job, now ranged) | Drift-repair test |
|---|---|---|---|
| read likes / comments counts | `read_likes_counter_trigger`, `read_comments_counter_trigger` (0018) | `reconcile_read_counters` (`reconcile.reads`) | `cross-cutting-audit` › *read, follow, shelf and work counters…* |
| follower / following counts | `follows_counter_trigger` (0036) | `reconcile_follow_counters` (`reconcile.follows`) | same |
| shelf item / save counts | `shelf_items_counters_*` (0034), `shelf_saves_counter_trigger` | `reconcile_shelf_counters` (`reconcile.shelves`) | same |
| `work_stats` | `reads_work_stats_trigger` (0018) | `reconcile_work_counters` (`reconcile.works`) | same |
| `works.log_count` (reader count) | `reads_stats_*_trigger` (0026) | `reconcile_work_counters` | same |
| `authors.has_works` | `work_authors_has_works_trigger` (0019) | `repair_author_has_works` (`authors.repair`) | A-15-007 |

### A-15-020 · P2 · Merge, dismiss and undo now commit with their audit row (A-06-026, carried from Part 06)
- **Evidence:** `resolveQueueItem` and `undoMerge` ran their own transactions and the route wrote the audit row afterwards, so a failed audit insert left an unaudited merge and answered 500 for an action that happened.
- **Fix:** both routes run the service call and `logAdminAction` in one transaction (the service's own transaction becomes a savepoint, so its row locks are unchanged).
- **Test:** `admin-security` › *merge, dismiss and undo commit only with their audit row* (a test-only trigger refuses one audit action): dismissal stays `pending`, merge leaves `merged_into_id` null, undo leaves `undone_at` null. Seen failing before the fix: yes (`expected 'dismissed' to be 'pending'`; the merge committed).

### A-15-021 · P3 · Every finished ingest pass analyzes what it loaded (carried from Part 06)
- **Evidence:** only `--finalise` ran `ANALYZE`, on four tables; `flyleaf`'s `works.reltuples` said 3.65M against 3.20M exact, and the admin ingest dashboard reads those estimates (A-06-013).
- **Fix:** `TABLES_LOADED` (writer.ts) names each pass's tables, `raw_payloads` included; a pass that ends `done` runs `ANALYZE` on them; `--finalise` also analyzes `pending_work_authors` and `raw_payloads`.
- **Test:** `cross-cutting-audit` › *a finished ingest pass ANALYZEs every table the writer loads* (every `INSERT INTO` target in the writer is in the list, and the pass calls it). Seen failing before the fix: yes (no `TABLES_LOADED`).

### A-15-022 · P3 · Dependencies: the unused `@fastify/rate-limit` removed; the production tree has no advisory (carried from Part 06)
- `@fastify/rate-limit` was a dependency nothing imported (architecture §4.1 had planned it for the general limits; the shared layer replaces it). Removing it also removed `ip-address`'s two moderate advisories.
- `npm audit fix` (no `--force`, lockfile only): `fast-uri` 3.1.7 → 3.1.8 and 4.1.4 → 4.2.2 inside fastify's, ajv's and @fastify/swagger's ranges. `npm audit --omit=dev` now finds **0**; 7 moderate remain, all devDependencies (drizzle-kit's esbuild loader ×4, autocannon's uuid ×3). `ci.mjs`'s comment said 4; it now gives the recount. The full suite ran on the new lockfile (CI result below).

### A-15-023 · P2 · Forgot-password no longer waits for the mail (A-04-024, carried from Part 04)
- **Evidence:** `forgotPassword` sends mail only when the account exists, and awaited the send. With a console mailer that was invisible, but PV-04 added SMTP: with `EMAIL_DRIVER=smtp` the response time could say whether an email is registered, which the endpoint promises not to reveal (PRD §6.5; Part 04 kept login and forgot non-revealing).
- **Fix:** the send is not awaited; a failure goes to `IdentityService.onMailError`, which production wires to the error reporter. Part 04's plan was a pg-boss job; that would store the raw reset token in `pgboss.job`, where the token table deliberately keeps only a hash, so the send stays in process.
- **Test:** `auth-audit` › *forgot-password does not wait for the mail…*: a mailer that never finishes does not hold the call; a failing one is reported and the call still answers ok. Seen failing with the send awaited again (mutation): yes (`expected 'waited for the mailer' to be 'returned'`).

## Findings added in 15b (laptop, 2026-10-11)

### A-15-024 · P1 · Shelf browse and saved answered 500 for any page with a cover-less work in a mosaic
- **Evidence (`flyleaf_dev`, step 4's first run):** `shelves:browse` 500 × 1,315 and `shelves:saved` 500 × 1,819; the log said `The value of '#/properties/shelves/items/properties/cover_ids/items' does not match schema definition`. postgres.js 3.4.9's array parser has no case for an unquoted `NULL` and hands the text `NULL` to the int4 parser (`+x`), so `ARRAY(SELECT cw.ol_cover_id …)` decodes `{8315603,NULL,4202989}` as `[8315603, NaN, 4202989]`; `cardFromRow` mapped only `=== null`, and `NaN` failed the `integer` schema. PGlite returns `null`, which is why every test (several put cover-less works on shelves) passed. Reproduced over HTTP: every guest `GET /v1/shelves/browse` page was 500.
- **Fix:** `coverIdsFromRow()` (`shelves/index.ts`) maps anything that is not a number to `null`.
- **Test:** `shelves-audit` › *decodes what each driver returns for a NULL cover id as null* (postgres.js `NaN`, PGlite `null`, the text form). Seen failing before the fix: yes, on the extracted old logic (`expected [ 8315603, NaN, 4202989 ] to deeply equal [ 8315603, null, 4202989 ]`), not only on the missing function. After the fix: step 4 re-run, every shelf scenario 2xx.
- **Same class elsewhere (owner's check):** the only other array the API decodes from a query is the admin catalog's `pg_stats` read (`most_common_vals`/`most_common_freqs`, never NULL elements). The `array_agg`s in gap-fill and the ingest writer are consumed inside SQL. The six stored array columns are `text[]`/`uuid[]`: a NULL element there would decode as the **string** `"NULL"`, not `NaN`. Counted on both databases (`array_position(col, NULL) IS NOT NULL`): **0 rows** in `works.alternate_titles`, `authors.alternate_names`, `profiles.favourite_work_ids`, `admin_credentials.backup_codes`/`pending_backup_codes`, `shelves.cover_work_ids`. Residual risk: that is today's data; no constraint stops a writer adding one.

### A-15-025 · P2 · `review:post` and `rate:post` time out under 10 concurrent writes to one read (owner: post-audit)
- **Evidence (`flyleaf_dev`):** 4 and 3 timeouts (10 s) in step 4's run, in its re-run, and in a run with memory freed (medians halved: p50 91 vs 186 ms and 39 vs 94 ms), so memory pressure slowed them but did not cause them. `perf/15b/post-rerun-locks.txt`: 8–9 of 10 backends in `Lock:transactionid` / `Lock:tuple`, the oldest statement's age climbing 1 → 10 s. `perf/15b/post-blocking-pids.txt` (`pg_blocking_pids()` every 0.5 s, after step 12): the **root holder changes every sample** and holds for 0.05–0.3 s (once 1.0, once 1.6 s) while running the transactions' ordinary statements; up to 9 waiters queue on one `reads` row and the unluckiest waits 9.5–9.7 s.
- **Not pool starvation:** every statement inside both transactions uses the transaction (`#lockOwnRead`, `#insertAttempt`, `#afterWrite`, `syncReviewActivity`, `ActivityService.recordActivity`/`updateActivityVisibility` via `dbOrTx`, `requireVerified(tx)`, `limits.enforce(…, tx)`); `this.db` is used only after commit (`getReview`, `#get`). The API pool is 10 (`makeDb` default), equal to the bench's connections, but no holder needs a second connection.
- **Cause:** hot-row serialisation. All 10 bench connections write the **same** read (the hot review) and the tuple-lock queue does not serve waiters evenly. A-15-029 lengthens each holder (a seq scan of `activity` inside the locked transaction).
- **Plan:** spread `review:post`/`rate:post` over one read per connection in `run.ts`; re-measure after A-15-029. A real user does not send 10 concurrent writes to one read, so the production impact is small.

### A-15-026 · P2 · `max_connections` 50 left 8 connections beyond the pools
- **Evidence:** after the first recreate (`max_connections` 50), `social-graph --race` met 10 × `FATAL: sorry, too many clients already` (09:06 UTC), although it still reported 0 errors. The pools: API 10 (`makeDb`) + its pg-boss producer 10 (pg's default; `makeBoss` sets none) + worker 4 + worker dedupe 1 + worker pg-boss 10 + CLIs (dedupe, ingest, migrate, admin) 1 each = **39**, plus 3 reserved for superusers: 42 of 50 before any test, bench, psql session or a second API instance.
- **Fix:** `docker-compose.yml` `max_connections=100`, with the sum in its comment (an idle backend costs a few MB; `work_mem` is per sort or hash, so the memory budget is unchanged). Applied by the second recreate (before CI). `--race` re-run at 100: 0 errors, 0 deadlocks, 0 drift, 0 follows left between blocked users, and **0** connection refusals (`perf/15b/social-graph.txt`).

### A-15-027 · P1 · The "ranged" `has_works` repair reads all of `work_authors` and `works` for every range (DECISION NEEDED)
- **Evidence (`flyleaf`):** `authors.repair` was killed by the session's memory guard ~14 s in (available memory 1,208 → 133 MB in 9 s; the Postgres container grew 574 MiB → 1.23 GiB). EXPLAIN of the function's two predicates for the first real range (`work_mem` 32 MB, the worker's): the **set arm** (`NOT a.has_works AND EXISTS (work_authors ⋈ works …)`) is a **Parallel Hash Semi Join over a Parallel Seq Scan of all of `work_authors` (3.79M) and of `works` (3.2M)**; the planner estimates 40–77k authors per range (20,000 by construction) and prefers hashing to 40k index probes. ~770 ranges re-read the two biggest tables hundreds of times, which is the whole-catalog work A-15-005 set out to remove. The **clear arm** is fine (index nested-loop anti-join). Step 9's one `work_authors` and second `works` seq scan on `flyleaf` are this first range.
- **Client memory (owner's question):** not sampled per process (only system-wide available memory and the Postgres container), so the drop cannot be split between the node process and the VM's file cache. By the code, the client holds nothing per range: `walkRanges` finds each boundary in SQL (`ORDER BY id OFFSET 20000 LIMIT 1`, one row) and the handler receives one `{set, cleared}` row. No client-memory finding is recorded.
- **15c: fixed** (owner: DECISIONS 6 (a); `0042`). Not the plan below as written: a join of the range's credits to the range's authors planned badly in the sandbox. See › 15c.
- **Plan (≈ 1 h + the laptop run):** a new migration redefining `repair_author_has_works`: drive the set arm from `work_authors_author_idx` over the same author range (`… WHERE a.id IN (SELECT wa.author_id FROM work_authors wa JOIN works w … WHERE wa.author_id >= lo AND wa.author_id < hi …)`), so each range reads only its own credits; verify by EXPLAIN on `flyleaf` (PGlite cannot judge a plan); then run `authors.repair` on a ≥ 16 GB machine. Not built in 15b: it needs a migration on both databases and its proof is a full-catalog planner check.

### A-15-028 · P2 · The Postgres container's `/dev/shm` is Docker's default 64 MB: parallel hash joins fail
- **Evidence (`flyleaf`, step 10):** the duplicate-credit count failed in Postgres with `could not resize shared memory segment "/PostgreSQL.…" to 16777216 bytes: No space left on device` (SQLSTATE 53100). `docker inspect`: `ShmSize=67108864`; `dynamic_shared_memory_type = posix`; `max_parallel_workers_per_gather = 2` at the server, so API queries can plan the same parallel hashes.
- **15c: fixed** (owner: DECISIONS 7 (a)): `shm_size: 512m` in `docker-compose.yml`; the recreate is `15c-laptop.md` › 3. See › 15c.
- **Plan:** `shm_size: 512m` on the postgres service (it counts against the 3 GiB limit, which still holds) and a recreate. Not applied in 15b: the owner allowed one recreate before CI, used for A-15-026.

### A-15-029 · P1 · `activity` has no index on `(object_type, object_id)`: every review save seq-scans the activity table inside the read's lock
- **Evidence (`flyleaf_dev`, step 9):** `activity` 982 seq scans, **139M rows read** this session. `EXPLAIN UPDATE activity … WHERE object_type = 'review' AND object_id = $1` (and the `DELETE`) = Seq Scan on `activity` (142k rows here); its indexes are `pkey`, `actor`, `popular`, `visibility`, `work`. `syncReviewActivity` runs that UPDATE on every review save and on every read write that touches a reviewed read; `updateActivityVisibility('read', id)` filters the same way. Cost grows with the activity table (180-day retention), and it runs inside the transaction holding the `reads` row lock (A-15-025).
- **15c: fixed** (owner: DECISIONS 6 (a); `0042`), built `CONCURRENTLY` by `migrate.ts`, not plain as planned below. See › 15c.
- **Plan (≈ 30 min + measurement):** a new migration `CREATE INDEX IF NOT EXISTS activity_object_idx ON activity (object_type, object_id)` (plain, not CONCURRENTLY: the migrator runs in a transaction; 142k rows on `flyleaf_dev`), schema.ts updated, before/after `review:post` on `flyleaf_dev`. **DECISION NEEDED** together with A-15-027 (both are migrations on both databases).

### A-15-030 · P3 · The import matcher scores a subtitle variant like the exact title (fails safe)
- **Evidence (`flyleaf`, `perf/15b/import-match-explain-full.md`):** *Dune / Frank Herbert* → `ambiguous_match` with *Dune*, *DUNE* and *DUNE : the Graphic Novel, Book 2* all at 0.92 (the `%>` whole-word arm). *Emma*, *The Remains of the Day* and *Piranesi* are ambiguous between same-titled duplicate works (the unmerged dedupe backlog). Ambiguous rows go to review, never to a guess (Part 12), so nothing is wrong; the backlog merge removes most of it. Owner: post-audit, with the backlog merge.

### A-15-031 · P3 · `15b-laptop.md` errors found while running it
- `social-graph.ts` runs `--clean` **before** `--seed` whatever the order of the flags, so step 5's one-line command left 7,012 `sgbench_*` users and ~100k follows; removed with a separate `--clean` (users back to 3,002).
- Step 9's third query filters `n_live_tup > 100000`, but step 2's `pg_stat_reset()` zeroes `n_live_tup`, so it returns nothing; run with `pg_class.reltuples` instead.
- Windows: no `/usr/bin/time` and no host `psql` (used `docker exec flyleaf-pg psql`, timings from PowerShell `Measure-Command`).
- Step 6: before step 12 the API row reads 4 MB / 0 because that is Postgres's stock default, so it cannot show the old container from the new.
- After a Docker Desktop restart, `docker compose up -d postgres` would have **recreated** the container with step 12's limit early (the compose hash differed); `docker start flyleaf-pg` restarts it unchanged.

## 15c (cloud sandbox, 2026-10-11): DECISIONS 6 and 7 built

**Owner decisions** (recorded as taken in `DECISIONS.md`):
- **Q6 (a):** one migration `0042`, hand-written and idempotent:
  - `activity_object_idx` on `activity (object_type, object_id)`, built `CONCURRENTLY`;
  - the `has_works` repair's set arm driven from `work_authors_author_idx`, so each 20,000-author range reads only its own rows.
- **Q7 (a):** `shm_size: 512m` on the postgres service.

**How it ran.**
- A cloud sandbox: 4 vCPU, 15 GB. PostgreSQL 18.3 (the `embedded-postgres` binaries) on :5432, with `shared_buffers` 512 MB, `work_mem` 4 MB and `max_connections` 100, as in the compose file.
- **All numbers below are "sandbox, synthetic":** good for plan shapes, buffer counts and same-machine ratios only.
- The database started empty, `npm run migrate` brought it to 42, and then it was seeded with:
  - **A synthetic catalog in flyleaf's proportions:**
    - 15.4M authors, 1.57M of them flagged `has_works`;
    - 1.5M works, 75k of them merged;
    - 1.8M credits (`work_authors`), loaded with the has_works trigger bypassed as the ingest does;
    - then 1,000 credited authors unflagged and 1,000 uncredited ones flagged.
    The first load had 4M authors. At that size the old repair's bad plan did not appear, so the table was grown to 15.4M (below).
  - **Part 01's bench set,** `npm run bench:seed` (142,152 activity rows, as on `flyleaf_dev`).
  - **1,000,000 synthetic activity rows** owned by bench users (`perf/15c/seed-activity.sql`): **1,142,152 in all**.
- No `flyleaf` or `flyleaf_dev` here. The real-database half is `15c-laptop.md`.

### A-15-027 · the `has_works` repair, set arm (fixed in `0042`)
- **Why the plan could go wrong.** Postgres does not interpolate a uuid inside a histogram bucket, so it estimates a 20,000-author range as about half a bucket or as almost nothing:
  - on the 15.4M-author sandbox, **77,016** for the first range and **1** for the ranges at offsets 100,000 and 7,700,000;
  - 15b saw 40–77k on `flyleaf`.
  At the overestimate, 0040's set arm hashes everything. **First range: Hash Right Semi Join over Seq Scans of all of `work_authors` (1.8M rows) and `works` (1.5M, 1.42M kept); 71.5k buffers + 10k temp; 3,632 ms** (`perf/15c/explain-repair-sandbox.txt`). That is the plan 15b saw on `flyleaf`. With 4M authors the same range was estimated at 20,018 and stayed a nested loop, which is why the catalog was grown.
- **Two rewrites were tried and dropped** before the one built (`perf/15c/explain-rejected-join-sandbox.txt`):
  - joining the range's credits to `works`: at the 77k estimate it hashed a **Seq Scan of all of `works`** (596 ms at 4M authors);
  - joining the range's credits to the range's authors, with `works` as a per-credit subquery: at a **1-row estimate** it rescanned the whole range's credits for every author. One range ran for minutes in the job and timed out at 60 s in isolation.
  So the "driven from `work_authors_author_idx`" decision is built **without a join** the planner could reorder:
  ```sql
  UPDATE authors a SET has_works = true
  WHERE a.id = ANY (ARRAY(
      SELECT wa.author_id FROM work_authors wa
      WHERE wa.author_id >= lo AND (hi IS NULL OR wa.author_id < hi)
        AND (SELECT w.merged_into_id IS NULL FROM works w WHERE w.id = wa.work_id)))
    AND NOT a.has_works;
  ```
  The plan is always:
  1. an InitPlan that reads `work_authors_author_idx` on the range and probes `works_pkey` once per credit;
  2. then `authors_pkey` with `id = ANY (…)`.
  A range reads its own credits, their works and their authors, and nothing else.
- **One range, before → after** (warm, back to back, rolled back; `explain-repair-sandbox.txt`):

  | Range (estimate) | Set arm before | Set arm after |
  |---|---|---|
  | first (77,016) | Hash Right Semi Join, seq scans; 71.5k buf + 10k temp; **3,632 ms** | InitPlan + `= ANY`; 14.0k buf; **89 ms** |
  | offset 100,000 (1) | nested loop per author; 74.8k buf; 108 ms | 13.6k buf; 67 ms |
  | offset 7,700,000 (1) | nested loop per author; 74.7k buf; 82 ms | 13.7k buf; 89 ms |

- **Whole sweep** (`npx tsx src/bench/run-job.ts authors.repair`, the worker's settings; the same 2,000-row drift before each; `perf/15c/repair-sweep-sandbox.txt`):
  - before: **540.9 s**, 770 ranges, set 900 / cleared 900;
  - after: **181.3 s**, 770 ranges, set 900 / cleared 900;
  - identical results, **3.0× faster**.
  For the "before" run, 0040's function was re-created in the sandbox database only.
- **Plan cache:** PL/pgSQL may switch a statement to a generic plan after five calls, and a generic plan cannot fold `hi IS NULL`. The sixth call of each arm, PREPAREd the same way, was still a custom plan with both bounds: **generic_plans 0 / custom_plans 6** for 0040's set arm and 0042's two arms (`plancache-sandbox.txt`). So `plan_cache_mode` was not set. (A first draft set it on a guess, and it was taken out.)
- **Tests** (`audit-15c.test.ts`):
  - *sets and clears inside [lo, hi) only, for every kind of credit, and a second night finds nothing:*
    - 28 authors across three ranges (missed, co-author, merged-only, mixed, uncredited, already right);
    - 24 more calls than PL/pgSQL's five custom plans;
    - drift after the cache is warm.
    No behaviour changes, so it **passes on main**, as it should. Mutations seen failing: the credit range removed (`{set: 8}` for `{set: 4}`), and the merged-work check removed (`{set: 6, cleared: 4}`).
  - *the set arm has one plan shape…* and *the set arm's plan: an InitPlan over work_authors_author_idx…*: **seen failing on main: yes** (`JOIN works`/`EXISTS` in the source; `Nested Loop` in the plan).
  - PGlite's plan is only a regression guard. The planner proof is the sandbox files above.
- **Still to do:** the laptop EXPLAIN on `flyleaf` (`15c-laptop.md` › 2), then `authors.repair` on a ≥ 16 GB machine.

### A-15-032 · P2 · The repair's clear arm read the whole partial GIN index `authors_credited_trgm_idx` per range (fixed in `0042`)
- **Evidence (sandbox, first range, estimate 77,016):**
  - the clear arm's `x.has_works` is the predicate of the partial index `authors_credited_trgm_idx … WHERE has_works`;
  - the planner ANDed the range with a **full scan of that GIN index**: 1.57M entries, ~9.4k buffers read, 893 ms of the arm's **920 ms**;
  - at the ranges estimated at 1 row it did not.
- **Fix:** `x.has_works IS TRUE`, the same rows because the column is `NOT NULL`. It does not prove the partial index's predicate, so the arm stays on `authors_pkey`: **57 ms**, 35.6k buffers, all hits, at the first range. Unchanged at the other two (54 vs 60 ms, 55 vs 50 ms).
- **Beyond the owner's wording** ("the set arm"). It is the same function and migration, and a one-token change, so it was made here and flagged in `DECISIONS.md` › 6.
- **Residual risk (not fixed):** the clear arm is still a correlated anti-join. A large enough overestimate could in principle hash it as well. It was a nested-loop anti-join at every range measured here and on `flyleaf` in 15b.
- **Test:** *A-15-032: the clear arm filters `has_works IS TRUE`…*. **Seen failing on main: yes.**

### A-15-029 · `activity_object_idx` (fixed in `0042`)
- **Built `CONCURRENTLY`** after the journal by `migrate.ts` (ONLINE_SQL, with `dropIfInvalid` first, as for 0026's indexes). The migrator runs the journal in one transaction, where `CREATE INDEX CONCURRENTLY` is refused, and the plain form blocks activity writes for the whole build. `0042`'s header says so, and `schema.ts` declares the index.
- **Applied to the sandbox database:** 42 → 43 in 3.5 s (1.14M rows; index 43 MB, valid). A second run was 1.3 s and a no-op. A fresh database: 43 twice, index valid.
- **The review-save statements, before → after** (`perf/15c/explain-activity-{before,after}-sandbox.txt`; the bench's hot review; rolled back):

  | Statement | Before | After |
  |---|---|---|
  | `syncReviewActivity` UPDATE (every review save) | Seq Scan, 1,142,152 rows removed, 20.3k buffers, 213 ms | Index Scan `activity_object_idx`, 17 buffers, 0.45 ms |
  | `syncReviewActivity` DELETE | Seq Scan, 20.3k buffers, 192 ms | Index Scan, 6 buffers, 0.45 ms |
  | `updateActivityVisibility('read', …)` | Seq Scan, 20.3k buffers, 147 ms | Index Scan, 3 buffers, 0.03 ms |

  The "after" UPDATE matched 1 row where the "before" matched 0. The before runs of `review:post` had created the hot review's activity row in between, so the table grew by 1 row.
- **Concurrent `review:post` on one hot row:**
  - the setup: `npm run bench -- --only '^review:post$'`, 10 connections for 10 s; `BENCH_RATE_LIMITS=legacy`; the API at 0042's code before and after, so only the index changed;
  - three runs each: `perf/15c/review-post-{before,after}-sandbox-{1,2,3}.md`.

  | | Run 1 | Run 2 | Run 3 |
  |---|---|---|---|
  | Before: timeouts (10 s) | **4** | **4** | **3** |
  | Before: p50 / p95 / p99 ms | 648 / 10,000 / 10,000 | 550 / 10,000 / 10,000 | 511 / 7,186 / 10,000 |
  | Before: requests, rps | 61, 5.7 | 71, 6.1 | 65, 6.2 |
  | After: timeouts | **0** | **0** | **0** |
  | After: p50 / p95 / p99 ms | 53 / 676 / 1,341 | 52 / 667 / 1,242 | 48 / 603 / 1,626 |
  | After: requests, rps | 704, 70.3 | 723, 72.2 | 762, 76.1 |

  Sequential (unloaded) p50: 227 / 158 / 184 ms before, 28 / 26 / 27 ms after. 10 statements per request in both; the first request of the first before-run took 12, most likely because it created the hot review's activity row (it had none before).
- **The hot-row serialisation (A-15-025) remains.** p95 is still over 300 ms (sandbox, indicative) because 10 connections queue on one `reads` row. The index only shortens each holder.
- **Not measured on `flyleaf_dev`:** the owner's laptop session for 15c runs no benches. The laptop checks the plan (`15c-laptop.md` › 2).
- **Tests:** *activity_object_idx exists on (object_type, object_id) and is valid* and *… plan as index scans* (20,000 rows in PGlite). **Seen failing on main: yes** (`expected [] to have a length of 1`; `[ 'ModifyTable', 'Seq Scan' ]`).

### A-15-028 · `shm_size: 512m` (fixed in `docker-compose.yml`)
- The postgres service gets `shm_size: 512m`, with the SQLSTATE 53100 reason in the comment. `/dev/shm` is a tmpfs, so its pages count against `mem_limit: 3g` only while used.
- **Not exercised in the sandbox:** no Docker there. The recreate and its checks are `15c-laptop.md` › 3.
- **Test:** *docker-compose gives the postgres service shm_size 512m, inside its 3g limit*. **Seen failing on main: yes.**

### 15c behaviour changes
- **None a client can observe.** `0042` changes a nightly job's plans (same results) and adds an index.
- **Deployment:**
  - the Postgres container's `/dev/shm` is 512 MB (A-15-028);
  - `npm run migrate` builds one more index `CONCURRENTLY` on every run, a no-op once it exists.

### 15c tests
- API +7, all in `src/test/audit-15c.test.ts`. 6 of the 7 fail on main.
- The 7th checks a repair that keeps the same behaviour; it passes on main, and two mutations of it fail.
- No test was changed, skipped or weakened.

### 15c CI
`node scripts/ci.mjs` in the sandbox (Postgres 18.3 on 5432 at 43; no MinIO): **green in 1,201 s, exit 0, all 9 steps**:
- api-client build; api typecheck; spec check ("openapi.yaml is up to date", drift 0);
- api tests: **83 files, 1,731 passed, 10 skipped of 1,741**. The 10 are `storage-contract`'s S3 block, which needs MinIO, as on Actions;
- api build; api audit (7 moderate, dev-only, as before);
- mobile typecheck; mobile tests **214 passed**;
- migrations on a real Postgres: `migrations applied`.

GitHub Actions on the PR: see the PR.

### 15c laptop (to fill in from `15c-laptop.md`)
- 0042 on `flyleaf_dev`: _time_; on `flyleaf`: _time_; `activity_object_idx` valid on both: _ _.
- `flyleaf` EXPLAIN, repair first range, after arms: _ _ (`perf/15c/laptop-explain-repair-full.txt`).
- `flyleaf` EXPLAIN, activity statements (activity rows: _ _): _ _ (`perf/15c/laptop-explain-activity-full.txt`).
- Recreate: ShmSize _ _, `/dev/shm` _ _, `max_connections` _ _, `shared_buffers` _ _.
- Migrations: `flyleaf_dev` _ _ / `flyleaf` _ _ (expect 43 / 43).

## Carried to "Part 15" by earlier parts, beyond the brief

Each earlier part's Deferred table names Part 15 for some items the brief does not list. Their status:

| Item | From | Status |
|---|---|---|
| Atomic audit for merge/dismiss/undo (A-06-026) | 06 | ✅ A-15-020 |
| ANALYZE after every ingest pass | 06 | ✅ A-15-021 |
| `npm audit` count in `ci.mjs` | 06 | ✅ A-15-022 |
| Log the shelf reconcile's count | 11 | ✅ every reconcile job now returns `corrected` and `ranges` (A-15-005) |
| Deleted account's 15-minute access token (A-05 answers) | 05 | ✅ already refused: the auth lookup requires `deleted_at IS NULL`; the hard delete is A-15-008 |
| Mobile Sentry scrubbing (A-07-025) | 07 | ✅ already done in Part 10 (`sentryScrub.ts`) |
| Counters vs deleted accounts; orphan mutes (A-13-015, -016) | 13 | ⚠️ orphan mutes ✅ (sweep); counts include a deleted account's follows for up to 30 days, until its hard delete cascades: with LA-01 (account deletion UI) |
| Search residual trigram cost, plan flip on ANALYZE, 2-character title walk, search cursor (A-02-016, A-08-025, 02b) | 02, 08 | Post-audit with the approved author-arm plan (A-02d-002, `PENDING.md`); needs the full catalog (15b numbers first) |
| Admin catalog search seq scans, LIKE escaping (A-06-025) | 06 | Post-audit (≈ half a day; admin-only path) |
| TRUNCATE guard via a non-owner API role (A-06-017) | 06 | With LA-05 (deploy): a role change, not code |
| Provenance locks in `MERGE_EDITIONS`/`MERGE_AUTHORS` (A-06-027) | 06 | With §6.46 corrections (nothing locks those fields yet) |
| `openapi-typescript` for `types.ts` (A-05-021) | 05 | Post-audit (the client's types are hand-written; drift is caught by the contract test for routes, not for types) |
| pg-boss teardown noise in `jobs.test.ts` | 06, 08 | Not fixed: noise after passing tests; no false result |
| Forgot-password timing with a real mailer (A-04-024) | 04 | ✅ A-15-023 (registration's send-after-commit 500 on a mail failure stays open: post-audit) |
| Colour literals design pass (A-07-021) | 07 | Post-audit (UI, needs the device) |
| Tautological Phase 1 tests (A-07-026) | 07 | Post-audit: needs a React Native test renderer; the tests stay (never delete a test) |
| "Email already registered" next step (A-07-031); reviews "load more" (A-09-033); optimistic social state after a refusal (A-07-040) | 07, 09 | Post-audit UI sweep, checked on the device |
| Legacy token key (A-07-029) | 07 | After no install predates the split |
| Prepared statements (Part 14) | 14 | Post-audit (above) |
| Browse at 10× (A-11-032) | 11 | Post-audit, plan in Part 11 |

## Performance

15a's numbers are **sandbox, synthetic** (empty catalog). The laptop numbers are 15b's (2026-10-11); latencies are **indicative only (8 GB dev machine)**, judged by plans and ratios first (`00-method.md`). Outputs in `perf/15b/`.

- Rate-limit overhead: `perf/15a-rate-limit-overhead-sandbox.md` (A-15-002), with the laptop section.
- Job settings verified by readback, before and after step 12 (A-15-004).
- Cursor sweep: sandbox (A-15-014) and **`flyleaf_dev`: all four rows OK** (`cursor-sweep-dev.txt`).
- Popular: `feed-explain-popular.md` (`flyleaf_dev`): 1 statement, 0.3 ms, but **1 item**, because every bench activity row is dated 27 May – 24 Sep except one review of 30 Sep: the 14-day window holds one card. Bench data, not a bug; `feed:popular:guest`'s latency measures a one-card Popular.

### 15b: how it ran
- **Memory.** 7.3 GB machine; Docker's VM 3.8 GB. Every heavy step ran under a guard that killed it below 300 MB available, after a check (drop the VM page cache below 1.1 GB, start only over ~800 MB; "cold cache" below means the drop ran). Claude Code itself stopped background jobs for low memory three times: the step-4 re-run's server and runner (after the runner had written its report), the session's memory sampler, and the CI run (below). The Claude desktop app, MongoDB, MinIO (until CI) and two vendor utilities were stopped; Docker Desktop was restarted with `wsl --shutdown` before step 5 (**step 5 onwards started on a cold cache**; the benches warm up first), and `flyleaf-pg` was brought back with `docker start` so step 12 still happened in its place.
- **Order changed by the owner:** step 12 (the memory limit) before step 8, and step 8 under the limit only; `social-graph` and the `flyleaf_dev` import ran after step 12 (`shared_buffers` 512 MB instead of 128 MB). Cold-cache starts: `social-graph` (first run), `import-cost` on `flyleaf_dev`, `reconcile.follows`, the over-budget search EXPLAINs.
- **Migrations (step 1):** `flyleaf_dev` 34 → 42 in 11.6 s, `flyleaf` 34 → 42 in 12.7 s (wall time including npm/tsx start). ANALYZE + stats reset: 10.7 s and 59.1 s.
- **Not measured on this laptop** (owner: on a machine with ≥ 16 GB, before the backlog merge): `import-cost` on `flyleaf` (guard at 261 MB; its throwaway user removed afterwards); `authors.repair` (guard at 133 MB; A-15-027); the monthly dedupe and backlog dry runs (not started); A-03-027's duplicate-credit count (A-15-028, then the guard at 175 MB).

### 15b: results
| What | Database | Result | File |
|---|---|---|---|
| After bench | `flyleaf_dev` | 24 pass, 11 over budget (indicative), 1 not measured | `perf/comparison.md` |
| Feed EXPLAIN, heavy p1 / p2 | `flyleaf_dev` | 6 statements / 144 ms; 5 / 95 ms. Statement 4 (101 ms) fans out over 1,158 follows (9,195 candidate rows, top-N to 76) | `feed-explain-heavy*.md` |
| Feed EXPLAIN, typical p1 / p2 | `flyleaf_dev` | 4 / 55 ms; 5 / 124 ms | `feed-explain-typical*.md` |
| Part 14's question: §12.7 trigger (feed p95 > 200 ms)? | `flyleaf_dev` | **Hit for `heavy`** (p95 518 ms under load; indicative); typical 122–144 ms | `comparison.md` |
| Followers, Part 01 celebrity page 1 | `flyleaf_dev` | 34 / 42 / 50 ms, 3 statements (runner) | `15-after.md` |
| Followers, `social-graph`'s 2,000-follower celebrity, offsets 0 / 1,000 / 1,900 | `flyleaf_dev` | p95 19.8 / 15.5 / 17.3 ms, 3 statements each: flat with depth | `social-graph.txt` |
| 404 timing, blocked vs random | `flyleaf_dev` | Δp50 0.36 / 0.38 ms, bodies identical | `social-graph.txt` |
| Follow races (at `max_connections` 100) | `flyleaf_dev` | 0 errors, 0 deadlocks, 0 drift, 0 follows between blocked users | `social-graph.txt` |
| Import 5,000 rows + export | `flyleaf_dev` | 242 s, **2.06 statements/row**; export 4,068 reads in 968 ms, 7 statements, +14.7 MB heap | `import-5000-dev.txt` |
| Part 12's question: exact-title matching index-bound for one-word titles? | `flyleaf` | **Yes**: every statement index-bound (ISBN 0.4 ms; title stages on `works_title_trgm_idx`), cost grows with the word's frequency: *It* 36,089 trigram candidates, 1.17 s; *Dune* 5,858, 184 ms; *Emma* 1,936, 73 ms; *Piranesi* 70 ms | `import-match-explain-full.md` |
| Rate-limit overhead | `flyleaf_dev` | A-15-002 (laptop paragraph) | `rate-limit-overhead.txt` |
| Index checks | both | below | `index-check-*.txt` |

### 15b: index and planner checks (step 9; counters since step 2's reset, kept across both recreates)
- **Audit-added indexes at 0 scans** that only nightly jobs use (`rate_limits_expires_idx`, `events_at_idx`, `*_deleted_idx`, `shelves_purge_idx`, `uploads_cleanup_idx`): expected. Others at 0 on `flyleaf_dev`, each with no bench scenario that would use it: `shelves_name/description_trgm_idx` (browse runs without `query`), `admin_audit_log_created_idx`, `dedupe_queue_impact_idx`, `dedupe_runs_finished_idx`, `search_zero_summaries_week_query_uq`, `uploads_key_uq`/`uploads_user_idx`, `series_entries_work_idx`. On `flyleaf` nearly everything is 0 because no API workload ran there.
- **DECISIONS q1:** `authors_search_trgm_idx` **15,207 scans on `flyleaf_dev`**, 0 on `flyleaf`; `authors_name_trgm_idx` 0 on both (dedupe stage 3 did not run). See DECISIONS.md › 1.
- **Big tables by sequential reads.** `flyleaf`: `authors` 1 (15.4M), `works` 2 (6.4M), `work_authors` 1 (3.79M): one `authors` and one `works` scan are 15b's own NULL-element count (A-15-024); the other `works` and the `work_authors` scan are `authors.repair`'s first range (A-15-027). `flyleaf_dev`: `work_authors` 1,639 scans / 228M rows: the search author term and `by_author` (`explain-search-over-budget-dev.txt`, A-02d-002's planned fix); `activity` 982 / 139M: **A-15-029**; `follows` 9 / 1.9M and `authors`/`works` 1–3 each: the `social-graph` seed, clean and reconcile.

## Tools added for 15b (dev-only, under `src/bench/`)

| Script | What it does | Writes |
|---|---|---|
| `compare.ts` | `perf/comparison.md` from two bench reports, budgets and pass/fail per scenario | nothing (stdout) |
| `feed-explain.ts` | EXPLAIN (ANALYZE, BUFFERS) of every read statement one feed request sends, per persona/tab/page | nothing beyond the request itself |
| `run-job.ts` | one reconcile or the `has_works` repair, once, under the worker's settings, with its result and time | repairs counters/flags only |
| `nonbench-counts.ts` | counts and md5 of every user-owned table's non-bench rows (§6 clean check) | nothing |
| `duplicate-credits.ts` | A-03-027 counts and sample | nothing (READ ONLY transaction) |
| `job-settings-check.ts` | each process's `work_mem` / `statement_timeout`, read back | nothing |
| `cursor-sweep.ts` | A-14-020 on a real server | its own rows, removed |
| `rate-limit-overhead.ts` | the limiter's cost per request, three configurations | its own buckets, removed |

## Behaviour changes (client-observable)

1. **429 `rate_limited`** on every route group above, with `Retry-After` and `X-RateLimit-*`, in production. Test apps see only the four pre-existing limits.
2. **Popular** serves only public reviews and finishes from 14 days, ranked by likes and comments; a card leaves after 1,000 servings; its cursor carries `n`/`v` and an old-format popular cursor is 400 `invalid_cursor`.
3. **`POST /v1/events`** and **`GET /v1/admin/telemetry/budgets`** now exist (they were 404); `/events` and `/admin/telemetry/budgets` at the root are 404.
4. **The 15 alias routes** are 404.
5. **Shelf owner** objects gain `avatarUrl`.
6. **Search** reads an optional `x-flyleaf-session` header; zero-result events carry `properties.searcher`.
7. **Retention:** soft-deleted shelves, reviews and comments, and deleted accounts, are hard-deleted 30 days after deletion; events after 13 months; zero-result queries after 30 days; committed import rows are trimmed to title/author/ISBN after 30 days.
8. **Ingest** no longer adds a second same-name author credit to a work.
9. **Mobile:** a 429 holds a queued write until `Retry-After` without using an attempt; `book_logged` is sent (it never was).
10. **Username change:** one new name per 30 days (429).
11. **Server start:** `BENCH_RATE_LIMITS` must be unset, `all` or `legacy`; `legacy` is refused with `NODE_ENV=production`.
12. **Admin:** a merge, dismissal or undo whose audit row cannot be written is now rolled back (500, nothing changed) instead of applied unaudited.
13. **Forgot-password** answers without waiting for the mail; a send failure is reported to the error reporter instead of failing the request.
14. **Ingest:** each finished pass runs `ANALYZE` on the tables it loaded (seconds on the full catalog; printed).
15. **15b, A-15-024:** `GET /v1/shelves/browse`, `/v1/shelves/saved` (and every shelf card) answer 200 with `null` in `cover_ids` for a cover-less work, where a real Postgres made them 500.
16. **15b, A-15-026 (deployment):** the Postgres container allows 100 connections (was 50 in 15a's compose; 100 is also Postgres's default).

### Tests changed (assertions that pinned behaviour this part changed; each commented in the file)
- `admin-security.test.ts`: budgets row uses `/v1/admin/telemetry/budgets` (A-15-001).
- `feed-audit.test.ts`: the popular walk expects reviews and finishes only (D-14-1).
- `social-graph-audit.test.ts`: the alias block asserts 404 instead of equivalence (A-15-012).
- `authorization-matrix.test.ts`: the `/v1/follows` alias case removed (A-15-012).
- `auth-audit.test.ts`: A-04-006 rewritten as above (stronger: it now also counts verifications).
- `search-suggestion.test.ts`: zero-result rows also carry `searcher` (D-10-3).

## Decisions taken here (reversible; listed in `DECISIONS.md` for confirmation)

- **D-15-1** per-request limits in process, exact ones in Postgres (measured).
- **D-15-2** uploads 10 intents/day and guest telemetry 120 batches/hour per IP (the PRD has no row for either).
- **D-15-3** Popular exposure cap 1,000 servings.
- **D-15-4** a guest's searcher id: the app's session id in `x-flyleaf-session`, else the IP.
- **D-15-5** committed `import_rows.raw` trimmed to title/author/ISBN after 30 days (the review queue keeps full rows).
- **D-15-6** deleted comments purged 30 days after deletion, like reviews.
- **D-15-7** shelf view counter (A-11-024): still a spec gap; the design is written down, not built.

## Deferred (with reason and owner)

| Item | Why | Owner |
|---|---|---|
| ~~Apply 0034–0041 to `flyleaf` and `flyleaf_dev`; every deferred bench; ANALYZE and index checks; A-03-026/027 measurements; §6 verification; `comparison.md`; SUMMARY's perf headline~~ | Done in 15b, except the rows below | 15b |
| ~~Recreate the Postgres container with the new memory settings~~ | Done in 15b (step 12, before step 8) | 15b |
| `authors.repair`, monthly dedupe dry run, backlog dry run, A-03-027 count, `import-cost` on `flyleaf` | Not measured: the 8 GB laptop runs out of memory (guard kills at 133–261 MB) | A machine with ≥ 16 GB, before the backlog merge |
| ~~A-15-027 ranged repair; A-15-029 `activity_object_idx`~~ | Built in 15c (`0042`); applying it is `15c-laptop.md` | Owner (laptop) |
| ~~A-15-028 `shm_size`~~ | Built in 15c; the recreate is `15c-laptop.md` › 3 | Owner (laptop) |
| A-15-025 hot-row bench scenario | Bench design. After A-15-029 (sandbox): 0 timeouts, p95 still 603–676 ms on one row | Post-audit |
| Prepared statements (planning ~5–8 ms per feed statement) | A platform-wide driver change (postgres.js `prepare: true` with pgbouncer caveats); measure on the laptop first | Post-audit |
| Shelf view counter (A-11-024) | D-15-7 | Owner |
| Same-name author merge (A-03-027 existing data) | D-15-8, after the 15b count | Owner |
| Redis for the in-process limits | Only when a second API instance exists (architecture §4.1) | When it happens |
| Privacy policy: state the 13-month event retention | Policy text, not code | Owner |

## CI result

`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs` in the sandbox, with Postgres 18.3 on 5432 and MinIO on 9000.

- **Run 1** (commit `fd72b9f`, before the last code changes): green in 1,368 s, exit 0, all 9 steps. API tests: **1,728 passed / 82 files**. Mobile: **214 passed**. Spec drift 0. Migrations applied on the real Postgres. MinIO came up during the run.
- **Run 2, final** (commit `2e9913c`; the later commits are docs only): **green in 1,327 s, exit 0**, all 9 steps:
  - api-client build;
  - api typecheck;
  - spec check ("openapi.yaml is up to date", drift 0);
  - api tests: **1,733 passed / 82 files, 0 skipped** (MinIO up, so the S3 contract block ran);
  - api build;
  - api audit (`--audit-level=high`; 7 moderate, all dev-only);
  - mobile typecheck;
  - mobile tests: **214 passed**;
  - migrations on a real Postgres ("migrations applied", **not skipped**).
- The A-04-006 timing test did not flake in either run.
- **15b (laptop):** migrations `flyleaf_dev` 11.6 s, `flyleaf` 12.7 s (both 34 → 42). CI (`node scripts/ci.mjs`, MinIO up, `DATABASE_URL` unset, after the second recreate): **run 1 with `FLYLEAF_TEST_WORKERS=1`, 15:22, was stopped by Claude Code for low memory ~10 minutes into the api tests** (available memory 1,571 → 591 MB in 12 s); steps 1–3 had passed (api-client build; api typecheck; spec check "openapi.yaml is up to date", drift 0). Its orphaned `ci.mjs`/vitest processes were stopped. **Split (owner option b):** the laptop ran the two parts only it can run, and GitHub Actions runs the full 9 steps on the PR. **Laptop subset (16:45, `perf/15b/ci.txt`):** "api · migrations on a real Postgres" against `flyleaf`: **`migrations applied`** (not skipped); the api test files touching 15b's code change (`shelves`, `shelves-audit`, `shelves-privacy`, `shelves-migration`, one worker): **4 files, 103 passed**, 37 s. **GitHub Actions (PR #6, run 38135155705, commit `1069bd5`): green in 765 s, all 9 steps**: api-client build; api typecheck; spec check (drift 0); api tests **82 files, 1,724 passed, 10 skipped of 1,734** (the 10 are `storage-contract`'s S3 block: Actions has no MinIO); api build; api audit; mobile typecheck; mobile tests **214 passed**; migrations on a real Postgres `migrations applied`. **The 10 Actions skips ran on the laptop** with MinIO up: `storage-contract.test.ts` 41 passed, 0 skipped. So every one of the 1,734 api tests passed in one of the two runs (1,733 in 15a + the A-15-024 test).

**15b §6 clean (step 14, `flyleaf_dev`):** `npm run bench:seed -- --clean` removed 3,000 bench users in 145 s (12,573 touched works' stats dropped and reconciled, 55 rate-limit buckets, no survivors); `nonbench-counts.ts` after = before in **every table, counts and md5 identical** (`perf/15b/nonbench-before.txt` vs `nonbench-after.txt`; the before file was written by PowerShell with a BOM and CRLF, normalised for the diff). Not re-seeded (owner). `social-graph`'s and the import bench's own rows had been removed earlier (A-15-031, and the leftover import user on `flyleaf`).
