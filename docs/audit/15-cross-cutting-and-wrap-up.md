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

## 4. Consistency sweep

These are the sibling-feature inconsistencies that each part saw only half of:
- Every user-owned resource answers the same 8-viewer matrix the same way (re-run Part 05's matrix; it should now include every resource added by later parts).
- Every counter has a trigger **and** a scheduled reconcile job with a drift-repair test: reads, follows, shelves, `work_stats`, `works.log_count`.
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
