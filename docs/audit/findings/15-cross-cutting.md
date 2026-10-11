# Audit 15a — Cross-cutting fixes (the cloud half of Part 15)

2026-10-10 · CI: **green in 1,327 s**, all 9 steps (sandbox; details at the end) · Tests: API **1,610 → 1,733** (+94 `rate-limits.test.ts`, +8 `popular-feed.test.ts`, +16 `cross-cutting-audit.test.ts`, +1 each in `dedupe`, `ingest`, `shelves-audit`, +2 `admin-security`, +1 `auth-audit`); mobile **207 → 214** (+6 tap counter in `telemetry-budgets.test.ts`, +1 in `queue.test.ts`). No test was weakened or skipped. Existing assertions that pinned behaviour this part deliberately changed were updated with a comment naming the finding (list under "Behaviour changes" › "Tests changed").

**How this part ran.** The brief is split: **15a** (this file, a cloud sandbox) does every code change, the docs, and the measurements that are meaningful on a small synthetic database. **15b** (the owner's laptop, `docs/audit/15b-laptop.md`) applies the migrations to `flyleaf` and `flyleaf_dev`, runs every deferred bench, and finishes `perf/comparison.md` and `SUMMARY.md`. Overrides for this run:

- **No `flyleaf` / `flyleaf_dev`, no Docker.** A local **PostgreSQL 18.3** (the `embedded-postgres` npm package, as in Parts 12–14) on :5432 with an empty `flyleaf` database; `npm run migrate` applied 0038–0041 to it cleanly. **MinIO** built from source (`go install github.com/minio/minio@RELEASE.2025-04-22T22-12-26Z`) on :9000 for the storage contract tests.
- **New migrations 0038–0041 are applied to PGlite and the sandbox Postgres only.** `flyleaf_dev` is unchanged until 15b (with 0034–0037 from Parts 11–13).
- **Every number below says where it came from.** "Sandbox, synthetic" numbers are only good for ratios and plan shapes. Nothing measured on `flyleaf`/`flyleaf_dev` is claimed here; those rows say **TBD in 15b**.
- Branch `audit/15a-cross-cutting` from `main` (after PR #4), committed, pushed, PR to `main`.

## Owner decision recorded at the start of this part

- **D-14-1 accepted as recommended, narrowed by the owner:** Popular = public **reviews and finishes** from the last **14 days**, scored by **likes and comments (never rating)**, with a **per-card exposure cap**. Built here (A-15-003). Recorded in `findings/14-feed.md` › Decisions.

## Verdict per brief section

| § | Asked | Done | Findings |
|---|---|---|---|
| 1 | one limiter layer for every RL finding; PRD refs next to numbers; global tier; 429 + Retry-After; measure the cost; table tests; `rate_limits` cleanup | ✅ `platform/rate-limits.ts`, one table, two stores chosen by measurement; every RL finding of Parts 01–14 mapped below; `rate_limits` rows now expire and are swept | A-15-002, A-15-015 |
| 2 | `DECISIONS.md` | ✅ written; nothing in it implemented | — |
| 3 | per-job `work_mem` / `statement_timeout`; container memory; no whole-catalog statement; A-03-027 ingest fix | ✅ code; **measurements TBD in 15b** | A-15-004 … A-15-006 |
| 4 | matrix; counters; `has_works` repair; retention; HTML/CSP; offline replay | ✅ | A-15-007 … A-15-009, A-15-014, A-15-016 … A-15-019 |
| 5 | docs reconciliation | ✅ except numbers that need the laptop (**TBD in 15b**) | — |
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

- **Cost (sandbox, synthetic; `perf/15a-rate-limit-overhead-sandbox.md`, 3 runs):** one `PgRateLimiter.hit` ≈ 1.5–1.7 ms p50 against ≈ 1 µs in process. End to end on one cheap route: production config (Global in process) within noise of no limits; Global in Postgres **26–35 % fewer requests/s** and one row update per request. Hence the split above. Laptop rerun: **TBD in 15b**.
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
- **Not measured here:** the OOM scenario on the full catalog. **TBD in 15b** (`15b-laptop.md` › 4).

### A-15-005 · P1 · No batch job builds a whole-catalog set in one statement (A-03-026)
- **Reconciles:** `reconcile_read/follow/shelf_counters(lo, hi)` and `reconcile_work_counters(lo, hi, c)` (0040) take a key range; the jobs walk `walkRanges` (`jobs/ranges.ts`) in ranges of `RECONCILE_BATCH` = 5,000 keys and report ranges and rows corrected. The whole-table functions are kept for tests and manual use.
- **Dedupe:** `detectStage12` runs stage 1 in ISBN ranges (`STAGE1_ISBN_BATCH` = 20,000) and stage 2 in author batches (the backlog's walk, A-03-025); stage 3 runs its peer search in chunks of `STAGE3_PEER_CHUNK` = 500 per author batch. Results are merged and sorted in JS, so the output is the same.
- **Finalise:** `MARK_CREDITED_AUTHORS` (one statement over 15.4M authors) is replaced by the range repair of A-15-007.
- **Tests:** `cross-cutting-audit` › *walkRanges covers every key once…* and *read, follow, shelf and work counters: drift repaired range by range; the whole-table function then finds nothing*; `dedupe.test.ts` › *sliced stages 1–3 find exactly the pairs the whole-catalog statements find* (guard: proves equivalence, passes by design).
- **Measurement on the full catalog:** **TBD in 15b** (dedupe dry run with `/usr/bin/time -v` and `pg_stat_activity` peak, `15b-laptop.md` › 4).

### A-15-006 · P1 · Ingest no longer adds a second credit under a name already on the work (A-03-027)
- **Evidence (Part 03c, `flyleaf`):** 11,112 live works credited to two author records with the same name.
- **Fix:** `catalog/ingest/writer.ts` `SAME_NAME_CREDIT_GUARD`: `MERGE_WORK_AUTHORS` and `RESOLVE_PENDING_WORK_AUTHORS` credit at most one author record per `lower(btrim(name))` per work (the first by key order; an existing credit wins).
- **Test:** `ingest.test.ts` › *A-03-027: a work is not credited twice under one name*. Seen failing on the old SQL: yes (2 credits).
- **Existing data and an author merge:** not changed here. `src/bench/duplicate-credits.ts` (read-only) counts the affected works, the same-name record pairs that share a work (merge candidates) and samples them. **Run in 15b**; whether to merge same-name authors is **D-15-8** in `DECISIONS.md`.

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

All here is **sandbox, synthetic** (empty catalog). Every laptop number is **TBD in 15b** and goes to `perf/comparison.md`.

- Rate-limit overhead: `perf/15a-rate-limit-overhead-sandbox.md` (A-15-002).
- Job settings verified by readback (A-15-004).
- Cursor sweep (A-15-014).
- Popular: the score uses `activity_popular_idx` (partial, 14 days of two verbs); its EXPLAIN on `flyleaf_dev` is in 15b.

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
| Apply 0034–0041 to `flyleaf` and `flyleaf_dev`; every deferred bench; ANALYZE and index checks; A-03-026/027 measurements; §6 verification; `comparison.md`; SUMMARY's perf headline | Needs the laptop's databases | **15b** (`15b-laptop.md`) |
| Recreate the Postgres container with the new memory settings | Restarts the database; after the bench | 15b |
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
- **15b:** TBD. Steps 1 and 13 of `15b-laptop.md` add the laptop's migration times and its CI run.
