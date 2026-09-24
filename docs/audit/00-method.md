# Flyleaf implementation audit — shared method

**Read this file in full before starting any part.** Every part file (`01-…` to `15-…`) assumes it.

## Why this audit exists

Tasks **FN-40 through SO-15** in `docs/tasks.md` are marked `[x]`, and their bullets describe what was built. Most of that work was written by another model and **its claims are unverified**. While building SO-2x we found, among other things:

- a trigger that did a full-table scan on every `reads` update,
- reconciliation jobs that existed but were never scheduled,
- an OpenAPI generator that silently omitted whole plugins,
- a feed card that sent an *activity* id where a *read* id belonged,
- a home screen that still renders sample data while its task says "real feed cards".

Assume every task has problems like these until you have checked it. **A green test suite proves nothing on its own.** Several existing tests would still pass if the feature they cover were deleted.

## Your role

You are a senior engineer auditing and repairing someone else's work. For each task in your part, find out:

1. Does it do what the spec says, on every path?
2. Does it handle the edge cases the spec lists, plus the ones any careful engineer would expect?
3. Would its tests actually fail if the behaviour broke?
4. Is it fast enough, measured rather than assumed, at realistic data volumes?

Then fix what is wrong and record everything.

## Sources of truth, in priority order

1. `docs/PRD.md`. Sections marked **[LOCKED]** are decisions and not up for reinterpretation. Relevant sections for every part: §4.2 guest mode, §24.4 rate limits, §25–26 auth, privacy and safety, §33 NFRs, §34 edge cases, §42 threat model, §43 performance targets, §49 acceptance criteria (AC-n).
2. `docs/architecture.md`.
3. `docs/design.md` (mobile UI).
4. `docs/tasks.md`. This is a list of **claims to verify**, not a source of truth. Where the code disagrees with tasks.md, the code is the fact and tasks.md must be corrected.

If the spec is ambiguous or two sections conflict, **do not decide silently**. Record a `DECISION NEEDED` entry with the options and your recommendation, choose the safest reversible behaviour (or leave the code as is), and keep going.

## The loop, for every task in your part

1. **Claim.** Read the task's bullets in `docs/tasks.md` and every PRD/architecture section they cite. Search the PRD for the feature's keywords; the edge cases in §34 and the ACs in §49 are often far from the feature's own section.
2. **Trace.** Read the code end to end: route → schema → service → SQL → migration/trigger → API client → mobile call site. Note every place the claim and the code diverge.
3. **Judge the tests.** For each existing test ask: *if I deleted the key line of the implementation, would this fail?* Where you're unsure, actually break the code and run the test, then restore it. Tautological or weak tests are findings.
4. **Probe.** Write new tests for the edge cases the spec requires and the ones you'd expect (see "Always check" below). Put them in the relevant `apps/api/src/test/*.test.ts` or `apps/mobile/src/**/__tests__/`.
5. **Measure.** For anything on a request path, check query count per request, `EXPLAIN (ANALYZE, BUFFERS)` against the real local database, and latency under load (see "Performance method").
6. **Classify.** Record each problem as a finding (format below).
7. **Fix.** Fix every P0 and P1, and every P2 that takes under ~30 minutes. Each fix gets a test that **you have seen fail before the fix and pass after**. State in the finding that you saw it fail.
8. **Record.** Update the part's findings file and add an audit note to `docs/tasks.md` (format below).

## Always check (every task that touches these)

**Privacy and authorization**
- Another user's resource you may not see → **404 `not_found`, never 403**, and the body must be identical to the body for a random UUID. Check writes (PATCH/DELETE) as well as reads.
- All eight viewer states: guest, stranger, pending follower, accepted follower, blocked-by, blocker, owner, private-account owner. Cross them with item visibility (public / followers / private).
- Blocks are bidirectional and complete (PRD §11.4). Mutes hide the target but never reveal the mute.
- `viewer` is a required argument on every user-scoped service method (FN-70). One `canView()` (FN-71); flag any hand-rolled visibility check that disagrees with it.

**Input**
- Empty, whitespace-only, too long, unicode/emoji/RTL, SQL/LIKE metacharacters (`% _ \ '`), HTML/script in anything later rendered as HTML, UUIDs that are malformed / valid-but-missing / someone else's, numbers at 0, negative, fractional, huge, and dates in the future, invalid, or across timezones and leap days.

**Concurrency and idempotency**
- Double submit, offline replay of the same request, two requests racing (unique-violation → 500 is a bug), retry after partial failure.
- Multi-statement writes must be atomic (transaction) when a partial write would corrupt state.

**Lifecycle**
- Deleted/soft-deleted users, reads, reviews and shelves; merged works (dedupe repoints only the tables that existed when it was written); account switched to private; unblock.

**Rate limits and abuse**
- Check against the PRD §24.4 table, §11.7 and §10.6. **Do not implement rate limits piecemeal.** Record each missing limit as a finding tagged `RL`; Part 15 builds one coherent limiter layer. (Comments already use the injected `RateLimiter`; follow that pattern.)

**Errors**
- Unhandled DB errors must not become 500s where a 4xx is correct (unique violations, FK violations, check violations).
- No stack traces, SQL or internal ids leak in error bodies.

## Performance method

Budgets (PRD §43 and §44 targets, architecture §8/§12):
- API overall: p50 < 100 ms, p95 < 300 ms, p99 < 800 ms.
- Feed query: p95 < 200 ms. Search: p95 < 300 ms (was 47–85 ms warm on the full catalog; don't regress it).

How to measure:
- Use the **local Postgres with the real 3.2M-work catalog** (`flyleaf-pg` on port 5432). Part 01 creates a benchmark data set (`bench_*` users, follows, reads, reviews, activity, shelves) and a bench runner. Use them. **Never truncate, reset or re-ingest the dev database.** Bench data must be removable with the seed script's `--clean`.
- `EXPLAIN (ANALYZE, BUFFERS)` every query on a hot path, with realistic parameters (a bench user with many follows, a popular work with many reviews). Look for seq scans on large tables, correlated subqueries per row, `Rows Removed by Filter` in the thousands, sorts spilling to disk, and a missing or unused index.
- Count queries per request: look for N+1 loops, sequential `await`s that could run in parallel, and per-row authorization checks.
- Look for in-memory sort/filter/paginate of an unbounded result, `OFFSET` pagination on large tables, `COUNT(*)` on big tables per request, and `SELECT *` pulling large columns.
- Measure latency with the Part 01 bench runner (autocannon against a locally running API). Record before/after numbers in the findings file. A performance fix with no measured "before" is not a fix.
- PGlite tests validate correctness, **not** planner behaviour. Planner claims need the real database.

### Hardware caveat: this is an 8 GB machine

The dev machine has **8 GB of RAM in total**. Docker/WSL gets about 4 GB, Postgres a few hundred MB of shared buffers, and the database is about 30 GB. The hot indexes for 3.2M works **cannot** stay in memory, so absolute latencies here are several times worse than on a production server, and noisy (Part 01 measured search at 2–90 s). Therefore:

- **Judge performance by hardware-independent evidence first:**
  1. `EXPLAIN (ANALYZE, BUFFERS)`: rows scanned vs returned, index vs sequential scan, shared hit + read blocks
  2. queries per request (`BENCH_COUNT_QUERIES=1`)
  3. how cost grows: with the result size (good) or with total table size (bad)
  4. before/after **ratios** on this same machine, run back to back after a warm-up
- A performance finding needs one of: a seq scan or large `Rows Removed by Filter` on a big table, an N+1 or per-row query pattern, unbounded in-memory work, or a same-machine before/after ratio ≥ 2×. "p95 was 900 ms" alone is **not** evidence here.
- PRD latency budgets (p95 < 300 ms, feed < 200 ms) are reported as **indicative only (8 GB dev machine)**, never as pass/fail. Record the block counts alongside them, so the numbers can be re-judged on production-like hardware later.
- Before timing: stop unrelated containers, warm up (run each scenario once, untimed), and never time while CI or the seed is running.

## Severity

| Level | Meaning |
|---|---|
| **P0** | Security hole, privacy leak (anything visible that should 404), data loss or corruption, auth bypass |
| **P1** | Violates a spec requirement (especially **[LOCKED]**), feature broken or missing while marked done, wrong results, over a latency budget |
| **P2** | Missing edge case, weak or tautological test, performance risk at 10× volume, inconsistency with a sibling feature |
| **P3** | Docs wrong, naming, dead code, cleanup |

## Rules

- **Never weaken, skip or delete a test to make it pass.** The one exception is the documented `1984` alternate-title gap test in the search suite, which must be removed deliberately when that gap closes.
- **Never edit a migration that has been applied.** Add new ones: hand-written, idempotent (`IF NOT EXISTS`, `DO $$ … $$` guards), in the style of `0018_read_interactions.sql`, registered in `apps/api/drizzle/meta/_journal.json`, with the Drizzle schema in `src/db/schema.ts` updated to match. Check the journal for the next number; parts run in order and each one may add migrations.
- Hand-written migrations must also pass the real server: run `npm run migrate` in `apps/api` before finishing the part.
- After any route or schema change: `npm run spec:generate` in `apps/api`, update `packages/api-client` (types and methods), and rebuild the client with `npx tsc` in `packages/api-client`. Keep the mobile typecheck green. **OpenAPI drift must stay 0.**
- If `src/contract/generate.ts` is missing a plugin, add it. It keeps its own plugin list, which has already drifted twice.
- New dependencies need a one-line justification and a pinned version. For mobile, follow SL-00 (`npx expo install --check`, and use the version from `bundledNativeModules.json`, never npm `latest`).
- **No drive-by refactors.** Change what the audit requires and nothing else. List every **behaviour change** (anything a client could observe) explicitly in the findings file.
- Keep fixes proportional. If a fix grows past roughly half a day, or needs a product decision, stop: record it as a finding with a proposed plan and move on.
- Don't commit. I review and commit between parts.

## Environment (this machine)

- Windows. The project is at `D:\Bookmarked\flyleaf`. `make` is **not installed**; use the underlying commands (see the Makefile).
- CI in one command, from the repo root: `node scripts/ci.mjs`. It takes about 13 minutes. During work, run targeted tests: `npx vitest run src/test/<file>.test.ts` in `apps/api`, and `npm test` / `npm run typecheck` in `apps/mobile`.
- Database: `docker ps` must show `flyleaf-pg` with `0.0.0.0:5432->5432`. Another project's Postgres (`neolytix-assessment-postgres-1`) has taken 5432 before. If you see `password authentication failed for user "flyleaf"`, check ports before credentials.
- `DATABASE_URL` defaults to `postgres://flyleaf:flyleaf@localhost:5432/flyleaf`.
- **Two databases.** `flyleaf` is the full 3.2M-work catalog (~30 GB). `flyleaf_dev` is a popularity slice built by `npm run devdb:build` (see README §2c-bis) that fits in RAM and contains all user and bench data. Use **`flyleaf_dev` for benchmarks, query counts and day-to-day work**: set `DATABASE_URL=postgres://flyleaf:flyleaf@localhost:5432/flyleaf_dev` for the API and the bench runner. Use the full **`flyleaf`** only where behaviour at full catalog scale is the question: search plans and relevance (Part 02) and dedupe scans (Part 03). Say which database every perf number came from.
- The API tests run on PGlite (Postgres compiled to WASM), one fresh database per test. Registering users through `IdentityService.register` costs about 3 s each (argon2). For speed, use the direct-insert fixtures in `src/test/interaction-fixtures.ts`.

## Output

### 1. Findings file: `docs/audit/findings/NN-<area>.md`

```markdown
# Audit NN — <area> (<task range>)

Date · CI result · tests before → after

## Verdict per task
| Task | Claimed | Verified | Findings |
|---|---|---|---|
| FN-40 | … | ✅ correct / ⚠️ partial / ❌ broken / 🚫 missing | A-NN-001, A-NN-004 |

## Findings
### A-NN-001 · P0 · <title>
- **Where:** `apps/api/src/…:123`
- **Evidence:** exact repro (request + response, or SQL + plan)
- **Spec:** PRD §… / AC-…
- **Fix:** what changed (or `DEFERRED → Part 15` / `DECISION NEEDED`)
- **Test:** file + test name; "seen failing before the fix: yes"

## Performance
| Endpoint / query | Before p50/p95/p99 | After | Plan notes |

## Behaviour changes
## Decisions needed
## Deferred (with reason and owner part)
```

### 2. `docs/tasks.md`

Under each audited task, add one line: `- **Audit (<date>):** ✅/⚠️/❌ — <one-sentence verdict>; see A-NN-xxx.` Where a bullet claims something false, strike it through with `~~…~~` and add the correction right after. **Do not delete history.** Counts and totals in `README.md` are refreshed once, in Part 15.

### 3. Your final chat message for the part

Findings by severity, what you fixed, what you deferred, decisions needed from me, the test count before and after, and the CI result. Keep it short: the details live in the findings file.
