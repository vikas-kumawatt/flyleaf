# Audit Part 15 — Cross-cutting fixes and wrap-up

**Read `docs/audit/00-method.md` first. Then read every `docs/audit/findings/*.md`.** This part runs last. It does the fixes that were deliberately deferred so they could be done once, coherently, and it closes the audit.

## 1. Rate limiting, done once

Collect every finding tagged `RL`. Build one limiter layer:

- One way to declare a limit per route: route `config` plus a hook, or a small helper like `enforce(req, 'comments', key)`. Buckets come from a single table in code that mirrors **PRD §24.4**, plus §11.7 (follows, cycles, new accounts) and §10.6 (reviews 10/hour, 30/day). Keep **PRD section references next to each number**.
- It uses the injected `RateLimiter` interface (`PgRateLimiter` today; Redis later is "one implementation plus a config line"). Comments (SO-22) already follow this pattern. Migrate them onto the shared layer without changing behaviour.
- Keys: per account for signed-in users; per IP for anonymous. That depends on Part 04's proxy-trust decision, so read it.
- **Global** limits (1,000/hour authenticated, 200/hour anonymous) as well as per-group ones.
- 429 responses carry a stable error code and `Retry-After`.
- **Cost**: `PgRateLimiter` does one `INSERT … ON CONFLICT` per check. With a global limit on every request, that's an extra write per request. Measure the overhead with the bench, and if it's significant, propose the cheapest correct design: e.g. in-process token buckets for the global limit (acceptable while there's one instance, as architecture §4.1 argues) and Postgres for the exact low-volume ones (auth, comments, imports). Get it right rather than uniform.
- Table-driven tests: each bucket allows exactly N, then refuses with 429, and the window resets.
- Also: `rate_limits` rows accumulate forever? Add cleanup.

## 2. Decisions

List every `DECISION NEEDED` from all findings files in `docs/audit/DECISIONS.md`: the question, options, recommendation, and which part raised it. **Don't implement any of them.** I'll answer them separately. (Expected ones include the unverified-email gating from Part 04, and possibly the feed pagination strategy, shelf view counting, and §9.7 thresholds, depending on what the earlier parts decided.)

## 3. Performance, end to end

- Re-run the full bench with the same data set and label it `after`. Produce `docs/audit/perf/comparison.md`: every scenario's baseline vs after (p50/p95/p99, queries per request), with the budget and pass/fail.
- Anything still over budget: its own entry with the `EXPLAIN` evidence and a concrete plan.
- Check the planner once more on the real DB: `ANALYZE`, then look for unused indexes (`pg_stat_user_indexes.idx_scan = 0` among those added during the audit) and missing ones (`pg_stat_user_tables.seq_scan` on big tables).
- **Batch jobs must not be able to take the server down (A-03-026, from Part 03c).** A dedupe query was OOM-killed by the kernel; Postgres then dropped every connection and ran crash recovery (an outage in production). Give every batch/maintenance job (dedupe monthly + backlog, the nightly reconciles, ingest and `--popularity`) its own `work_mem` and `statement_timeout`; size Postgres memory to a container limit (there is none today); and check that no job builds a whole-catalog intermediate set in one statement (the monthly `runDedupe` still does, via `detectStage12`; the reconciles aggregate all of `reads`). The backlog's author walk (A-03-025) is the pattern.
- **Duplicate author credits (A-03-027, from Part 03c).** 11,112 live works are credited to two author records with the same name (e.g. *Hell Has No Limits*: José Donoso as OL4279328A and OL3074073A). Ingest should not add a second credit whose name is already on the work (or should merge the authors first); measure an author-dedupe pass for same-name records with overlapping works.

## 4. Consistency sweep

These are the sibling-feature inconsistencies that each part saw only half of:
- Every user-owned resource answers the same 8-viewer matrix the same way (re-run Part 05's matrix; it should now include every resource added by later parts).
- Every counter has a trigger **and** a scheduled reconcile job with a drift-repair test: reads, follows, shelves, `work_stats`, `works.log_count`.
- **`authors.has_works`** (migration 0019/0020, from Part 02b/02c): the ingest bypasses its trigger with `flyleaf.bulk_load` and relies on `--finalise` (`MARK_CREDITED_AUTHORS`) to set it. An ingest that crashes before `--finalise` leaves new authors invisible to author search. Add a nightly repair job (the same set-based statement, plus clearing authors whose works were all merged away) with a drift-repair test.
- Every soft-delete has a defined hard-delete or retention path (shelves, reviews, comments, imports' uploaded files, exports, events, rate_limits, the activity prune).
- Every server-rendered HTML surface escapes output and sends a CSP.
- Every mutation reachable offline is replay-safe (Part 07's table, updated).

## 5. Docs reconciliation

- `docs/tasks.md`: every task FN-40…SO-15 has an audit line, and every false claim is struck through and corrected. Check none were missed.
- `README.md`: refresh "Where it is", "Verification status" (test counts, suites, migrations, jobs, the perf numbers from `comparison.md`) and the endpoints table. Remove claims the audit disproved.
- `docs/architecture.md`: update anything the audit changed (rate limiting, the feed pagination design, jobs, retention).
- `docs/surprises.md`: add the audit's lessons in its existing style: the few patterns behind most findings (e.g. "features added after a subsystem was written were never wired into it"), not a list of bugs.
- `docs/phases.md`: note the audit under the relevant phases.

## 6. Final verification

- `npm run migrate` against the real DB applies every audit migration cleanly. Then `node scripts/ci.mjs`, all green, with the real-Postgres step **not** skipped.
- `npm run bench:seed -- --clean` removes all bench data, and the dev DB's non-bench row counts equal the Part 01 baseline.

## 7. Output

`docs/audit/SUMMARY.md` (one page):
- totals by severity and by part, how many were fixed and how many deferred
- the top 10 findings by impact
- the perf before/after headline
- decisions waiting on me
- what I should check by hand on the device (merge the per-part checklists)
- the recommended order for anything still open

Your final chat message is that summary, shortened.

## Handed over from Part 10 (see `findings/10-profile-stats-telemetry.md`)

- **Event retention, D-10-1 corrected (PRD §23.5 wins), A-10-025:** a daily prune deletes `events` older than **13 months**, and `search_zero_results` older than a **flat 30 days**, independent of the weekly summary (the summary only reads inside that window). State the 13 months in the privacy policy.
- **Zero-result weekly summary, D-10-3:** `(week, query or null, searches, distinct_searchers)`; the query text only when **≥ 5 distinct searchers** that week, otherwise counts only. Searchers are counted with `hmac(week_salt, account id or guest session id)` stored on each zero-result event; the salt lives in its own table, rotates weekly and is **deleted in the same transaction that writes the week's summary**. Nothing user-identifying is stored. Open implementation choice: `/v1/search` receives no guest session id today (the app sends `session_id` only on `POST /events`), so either the app sends it on search or this part decides a fallback.
- **`book_logged` tap counter, D-10-2 refined, A-10-003:** the clock starts at the first render of a screen offering the shelve action for a work (a search row or the book page); it carries from a search row to the book page it opens for the **same work** (that tap counts); it ends on navigation elsewhere or after **10 minutes**; it stops at **local success**, not server acknowledgement. `book_logged` is not sent at all until this exists.
- **Rate limits (RL), A-10-029:** `POST /v1/events` (anonymous), `GET /v1/search` (a zero-result search now writes an event), `PUT /v1/me/content-settings`, `PATCH /v1/me/profile`, `PUT/DELETE /v1/me/avatar`, `GET /v1/avatars/…` (anonymous), `GET /v1/users/:id/stats`, `GET /v1/users/:id/reads`.
- **Avatar objects, A-10-016:** a replaced avatar's object is deleted best effort; a failed delete and a deleted account's avatar belong to the retention sweep (with A-PV-008).

## Handed over from Part 12 (see `findings/12-import-export.md`)

- **Rate limits (RL), A-12-021:** `POST /v1/imports` 3/day and `POST /v1/exports` 2/day per account (PRD §24.4); `POST /v1/uploads` with the import limit (A-PV-007). An import retried by `upload_id` replay (200, same import) must not count twice.
- **Retention:** deleted accounts' `uploads/<user>/` and `exports/<user>/` objects (A-PV-008, unchanged); `import_rows.raw` holds the whole file row by row after the file itself is deleted at 30 days (D-PV-3), so decide how long rows of a finished import stay (proposal: with the import, until the account is deleted; the review queue needs them).
- **Perf comparison (laptop):** `npx tsx src/bench/import-cost.ts --rows 5000 --export` against `flyleaf` (matching at full catalog scale) and `flyleaf_dev`; apply migration 0035 to `flyleaf_dev` with the other audit migrations.
- **§9.7 manipulation (with SL-62b):** an import can bulk-add ratings from a new or unverified account; their reviews are hidden until verification (D-05-3), their ratings are not. Decide with the §9.7 fast-follow.
