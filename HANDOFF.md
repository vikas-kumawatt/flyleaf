# Handoff: Flyleaf audit, 10 Oct 2026

Written for continuing from Claude Code in the cloud (phone). **Not committed on purpose:** delete it, or commit it if you decide to keep it.

## Where things stand

- **Branch `main`, clean working tree, in sync with `origin/main`.** Last commit: `6c4c6d9 Part 10 wip + Fastify 5.12.5 bump`. Despite the "wip" in its name, **Part 10 is complete**; see below.
- The implementation audit (FN-40 … SO-15) is done through **Part 10**, plus the extra parts PV-0x, 02d, 03c, 07b and 09b. **Parts 11–15 remain.**
- Commit history, one commit per part: `git log --oneline` from `1e1bf50` (audit harness) to `6c4c6d9`.

## Part 10: profile, stats, telemetry (done)

- **Findings:** `docs/audit/findings/10-profile-stats-telemetry.md`
- **CI:** green in 785 s, all 9 steps, on Fastify 5.12.5. API **1,466/1,466** (74 files), mobile **177/177**.
- **Migrations 0030–0033** are applied to both local databases (`flyleaf_dev` and `flyleaf`).
- **Fixed:**
  - P0: other users' stats included their private reads.
  - Another user's Wall showed the viewer's own books.
  - The §4.4 budget numbers were green by construction.
  - `POST /v1/events` took the user id from the request body.
  - Unscrubbed tokens reached Sentry.
  - Stats used UTC time zones, the server's year, the wrong format split, audio positions instead of time, and the smallest edition's page count.
  - Two high-severity advisories (Fastify pinned at 5.12.5, a lockfile update for source-map-js).
- **Built from hand-offs:**
  - "Did you mean …?" suggestions (`tolkein` → J.R.R. Tolkien) and the zero-result log.
  - The adults-only "Show explicit titles" setting.
  - The neutral under-13 age gate.
  - The avatar picker (PV-0x upload path).
  - Page count = default edition, else the median of edition page counts.
  - Ten-bucket year histogram.
  - Pagination for `/users/:id/reads`.
- **Waiting on the phone:**
  - A native rebuild for `expo-image-picker` and `expo-image-manipulator`, **batched until after Part 14** (listed in README's pending native changes).
  - The phone checklist at the end of the findings file.

## The three Part 10 decisions (recorded in the findings; implementation → Part 15)

1. **D-10-1, event retention (corrected; PRD §23.5 wins):**
   - Raw `events` are kept 13 months.
   - `search_zero_results` rows are deleted after a **flat 30 days**, independent of any summary.
   - The weekly summary reads only rows inside that window.
2. **D-10-3, zero-result summary:**
   - A query's text is kept in the weekly summary only if **≥ 5 distinct searchers** searched it that week; otherwise the summary keeps counts only.
   - Searchers are counted with a **per-week salted hash** of the account id or guest session id.
   - The salt rotates weekly and is **deleted as soon as that week's summary is written**. Nothing user-identifying is kept.
3. **D-10-2, shelve-a-book tap-budget impression:**
   - The clock starts at the first render of a screen offering the shelve action for that work (a search row or the book page).
   - It **carries over** from a search row to the book page it opens for the same work, so that tap counts.
   - It ends on navigation elsewhere or after **10 minutes**.
   - It stops at **local (optimistic) success**, not the server's acknowledgement.
   - `book_logged` stays unsent until this counter exists (Part 15 telemetry).

## What's next

1. **Part 11: shelves and lists** (`docs/audit/11-shelves.md`). Hand-offs addressed to it in earlier findings:
   - L-18: `GET /v1/shelves/browse` p95 600 ms with 26 statements, and it loads all public shelves before paginating.
   - `GET /v1/shelves/:id/items` for a 1,192-item shelf: p95 419 ms.
   - L-10: `GET /v1/shelves/saved` is an N+1 on owner profiles (55–56 statements). See `findings/01-baseline.md`, `findings/05-…`.
   - Lead 2 in the prompt: decide how want-to-read relates to shelves. It's a **read status** (PRD §8.2), and since Part 08 `DELETE /v1/reads/:id` exists. Part 14 needs this decision to wire the feed's "Want to read" swipe.
2. **Part 12: import/export.** It must audit the **presigned upload path** (PV-0x), not multipart. It also carries D-05-3: reviews and ratings by unverified authors are visible only to the author and stay out of aggregates.
3. **Part 13: social graph.**
4. **Part 14: feed.** It also takes:
   - feed review cards showing no text (metadata name mismatch, from Part 09);
   - the fake want-to-read swipe;
   - duplicate cards on replay (Part 07);
   - the server-side Wall/Diary filters and Diary screens (Part 10).
5. **Part 15: cross-cutting and wrap-up, always last.** It has accumulated:
   - rate limits (every `RL` finding);
   - the retention sweep (events per D-10-1/3, rate_limits, uploads, deleted accounts' files);
   - A-03-026: per-job `work_mem`/`statement_timeout`, a container memory limit, and no whole-catalog statements;
   - A-03-027: same-name duplicate OL authors;
   - ANALYZE after ingest;
   - the audit row inside merge/undo;
   - the `jobs.test.ts` teardown noise;
   - the perf before/after comparison;
   - `DECISIONS.md` and `SUMMARY.md`.
6. **Post-audit, before launch** (`docs/audit/PENDING.md`):
   - copy author names onto `works` (A-02d-002, with LA-05);
   - merge the 94,086-pair dedupe backlog in batches;
   - sample the D5 "groups of more than two".
   - Note: PENDING.md's "Next" row still says "Parts 10 … 15". Read it as **11 … 15**.

**Per-part routine used so far:**
- Run each part in a **fresh session**: `Read docs/audit/00-method.md and docs/audit/NN-*.md in full …`, plus a line telling it to grep `docs/audit/findings/` for items handed to that part.
- Review its findings, then run CI.
- Commit with a message file (`git commit -F <file>`) and push.
- Decisions the session can't make go into its findings file as `DECISION NEEDED`.

## Where the plans live

| File | What it holds |
|---|---|
| `docs/audit/README.md` | Part list, run order, ordering rules |
| `docs/audit/00-method.md` | Shared rules for every part: severity, output format, hardware caveat, the two databases |
| `docs/audit/NN-*.md` | One prompt per part (`11-shelves.md` … `15-cross-cutting-and-wrap-up.md` still to run). Some end with "Decided in" / "Handed over" sections |
| `docs/audit/findings/*.md` | One findings file per finished part. Hand-offs are tagged with the receiving part |
| `docs/audit/PENDING.md` | Work outside the numbered parts (post-audit items) |
| `docs/audit/perf/` | Benchmark baselines (Part 01) and per-part before/after notes |
| `docs/tasks.md` | Every task, with an audit line per task. SL-62b is the §9.7 fast-follow |
| `docs/PRD.md`, `docs/architecture.md`, `docs/phases.md`, `docs/surprises.md` | Spec (several sections amended during the audit), architecture, progress, lessons |
| `README.md` | Setup, `devdb:build`, native rebuild steps and pending native changes, backlog procedure, provider swapping |

## How CI runs

- **One script, `node scripts/ci.mjs`,** is used both locally and on GitHub. It has 9 steps:
  1. api-client · build
  2. api · typecheck
  3. api · spec check (OpenAPI drift must be 0)
  4. api · tests (vitest)
  5. api · build
  6. api · audit (`npm audit --audit-level=high`)
  7. mobile · typecheck
  8. mobile · offline tests
  9. api · migrations on a real Postgres
- **Flags:**
  - `--strict` fails step 9 if no database is reachable. Without it, step 9 is skipped.
  - `FLYLEAF_TEST_WORKERS=N` caps vitest workers. It was needed on the 8 GB laptop; likely unnecessary in the cloud.
- **GitHub Actions** (`.github/workflows/ci.yml`) runs `node scripts/ci.mjs --strict` on every push to `main` and on PRs. It uses Node 22, a `postgres:18-alpine` service, and `npm ci` in `apps/api` and `apps/mobile` (two lockfiles, no root workspace). **From the phone, this is the easiest full CI run:** push a branch or PR, then read the run with `gh api repos/vikas-kumawatt/flyleaf/actions/runs`.
- **Running it in a cloud session:**
  - `npm ci` in `apps/api` and `apps/mobile` first.
  - Steps 1–8 need no services.
  - Step 9 needs Postgres 18 at `DATABASE_URL`. Without one, run without `--strict` and rely on GitHub Actions for that step.
  - Postgres 18 matters: `unaccent` and `pg_c_utf8` behaviour depend on it.

## Env vars and services the tests need

- **API tests (vitest):** no external services. Each test uses in-process **PGlite**.
- **Mobile tests:** plain Node (`tsx --test`), no services.
- **`DATABASE_URL`:** used only by step 9, `npm run migrate`, the benches and the dev server. The default is `postgres://flyleaf:flyleaf@localhost:5432/flyleaf`. On the laptop it was a user-level env var pointing at **`flyleaf_dev`**.
- **MinIO** (optional, `localhost:9000`, from `docker-compose.yml`): only the S3 contract block in `storage-contract.test.ts` uses it, and it **skips with a message** when MinIO isn't reachable. The mocked-S3 block always runs.
- **`FLYLEAF_TEST_WORKERS`:** optional, see above.
- **Not needed for tests:** the production variables in `.env.example`:
  - `JWT_SECRET`, `TRUST_PROXY`, `APP_BASE_URL`;
  - `ANDROID_*` / `IOS_*`;
  - `STORAGE_DRIVER` / `S3_*`, `EMAIL_DRIVER` / `SMTP_URL` / `EMAIL_FROM`, `PUSH_DRIVER` / `EXPO_ACCESS_TOKEN`;
  - `ERROR_DRIVER` / `SENTRY_*`.

  Production refuses to start with dev adapters or a missing secret; development defaults to disk, console, memory and noop.
- **`DEDUPE_AUTO_MERGE`:** must stay unset. Only the exact string `true` lets the monthly dedupe job merge.

## What only the laptop can do

The cloud session doesn't have these, so plan around them:

- **The two local databases** (in Docker container `flyleaf-pg`, Postgres 18):
  - `flyleaf` is the full catalog: about 30 GB, 3.2M works.
  - `flyleaf_dev` is a 951 MB slice with the bench data. Part 15's perf comparison must use **this same dataset**, so don't rebuild it before then.

  Any part that measures performance, runs `bench:*`, applies migrations to both databases, or touches the full catalog (dedupe, search latency) needs the laptop. In the cloud, write the code and the PGlite tests, and leave measurements and migration application as explicit TODOs for a laptop session.
- **The Android dev-client rebuild and phone checklists.** These are batched after Part 14. Pending native changes are listed in README.
- **The laptop has 8 GB RAM.** Long or heavy runs there go in a separate terminal, not inside Claude Code: tests in the foreground, a few files at a time, `--maxWorkers=1`. One whole-catalog query has already OOM-killed Postgres once (A-03-026).
