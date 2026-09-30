# Audit Part 09b — Reviews follow-up: latest rating per user, ten-bucket histogram, friends-sort cost, missing stats rows

**Read `docs/audit/00-method.md`, `docs/audit/09-ratings-and-reviews.md` and `docs/audit/findings/09-reviews.md` first.** Run this after Part 09 and before Part 10. Day-to-day work and benchmarks on **`flyleaf_dev`**. Apply any new migration to **both** `flyleaf_dev` and `flyleaf` (set `DATABASE_URL` explicitly for `flyleaf`). Backfills on large tables run in batches; indexes on large tables are built concurrently; guard hand-run queries on `flyleaf` with `statement_timeout` and a modest `work_mem`.

These are the owner's answers (2026-09-30) to Part 09's decisions. They are decided; implement them, don't re-open them.

## 1. Re-reads: count each user's latest rating only (A-09-027)

Today `rating_count`, `rating_sum`, `avg_rating`, `weighted_rating`, `polarisation` and the histogram count every **attempt**, so a reader who rated three re-reads counts three times. `heart_count`, `read_count` and `dnf_count` already count distinct users.

- **Rule:** per (user, work), the rating on the user's **most recent attempt that has a rating** (highest `attempt_no` with `rating IS NOT NULL`). If the owner's intent turns out to be "the latest attempt, rated or not" (so clearing the newest rating removes the user from the average), that is a DECISION NEEDED: record it, keep the rule above, and move on.
- **Everywhere it is computed:**
  - `recompute_work_stats_for_work()` (0026);
  - `reconcile_work_counters()`;
  - `refresh_catalog_rating_mean()` (C must use the same population);
  - the histogram in `CatalogService.getWork`;
  - the list's rating-bucket filter only if its meaning changes (it filters reviews, which are per attempt, so probably not: say which you chose).
- **Migration:** a new hand-written, idempotent migration (`CREATE OR REPLACE FUNCTION`), registered in the journal. Recompute every `work_stats` row by running `reconcile_work_counters()` once per database. Check its cost on `flyleaf` first with `EXPLAIN`: it is one aggregate over `reads`, so run it with `statement_timeout`, and batch it by work-id range if the plan says so. `reads_work_idx (work_id, user_id)` exists; check whether `DISTINCT ON (user_id) … ORDER BY attempt_no DESC` uses it.
- **Tests (each seen failing first):**
  - a re-reader who rated 5 then 3 counts once, as 3;
  - clearing the newest rating falls back to the earlier rated attempt;
  - two users count twice;
  - the nightly reconcile agrees with the trigger (stored row = fresh aggregate, as `reviews-audit.test.ts` › "leaves work_stats exact with the trigger alone" does);
  - C uses the same population.

## 2. The histogram: ten half-star buckets from the API (A-09-029)

PRD §9.6: "a histogram of the ten half-star buckets". `rating_distribution` returns five (`CEIL(rating)`).

- **API:** return ten buckets, `0.5 … 5.0`, from the same per-user population as §1. Replace the field's shape; don't add a second field. The product is pre-launch, and a shim is not wanted: update the contract, `packages/api-client`, and the app in the same change. `spec:generate`, rebuild the client, drift 0.
- **App:** may group the ten into five bars for display. If it does, group by the rule the reviews filter uses (A-09-015: 3.5 and 4.0 are "4★"), so tapping a bar's rating chip lists exactly the reviews that bar counts. Put the grouping in a tested `src/lib` function.
- **Tests:** ten keys, zero-filled; half ratings land in their own bucket; the app grouping matches the filter's bucket rule.

## 3. Friends-sort cost: guest cache and a capped, exact candidate set (A-09-009)

Before numbers are Part 09's after numbers (`docs/audit/perf/09-after.md`, `flyleaf_dev`): friends heavy **792 / 1,033 / 1,177 ms** (load p50/p95/p99), unloaded 203 ms; guest **567 / 693 / 755**, unloaded 141 ms. Every request still ranks all visible reviews of the work.

- **Guests:** the ranking is the same for every guest within a day (the exploration key is daily). Cache the ranked **id list** per work (and rating filter) for 60 s, like `GET /works/:id`, through the injected cache (`MemoryCache` / the platform cache interface), not a module-level map. Hydrate the page per request. A guest cache must never serve a signed-in viewer.
- **Signed-in viewers:** cap the candidates in SQL without changing SO-23's order:
  - every review by accounts the viewer follows (the friend tier);
  - plus the top N non-friend reviews by a SQL **lower-bound** score (every term except credibility and second-degree proximity);
  - plus the exploration pool (≤ 14 days, < 5 likes, non-friend), which the deterministic pick needs in full.
  - Rank exactly in JS. If the page's last exact score is below the Nth lower bound + 0.24 (the most credibility, 0.10, and second-degree proximity, 0.35 × 0.4, can add), double N and repeat.
  - Start N at `max(200, 2 × (offset + limit))`.
- **Tests:** a parity test that the capped ranking equals the uncapped `rankReviews` for the first pages, on a fixture large enough to force at least one extension (credibility and second-degree authors outside the first N). Mutation-check the extension condition. Keep "sort=… pages through every review exactly once".
- **Measure** back to back with 09-after on `flyleaf_dev`, with query counts and `EXPLAIN (ANALYZE, BUFFERS)` of the new queries. Target: p95 < 300 ms (indicative on this machine; judge by ratios and plans).

## 4. Why three `flyleaf_dev` works had reads but no `work_stats` row (A-09-035)

Part 09 found 3 of 12,576 works on `flyleaf_dev` with reads dated 3 Sep and no stats row. It repaired them by running `reconcile_work_counters()` once. Find out why:

- Read `npm run devdb:build` (README §2c-bis and its script). Does it copy `reads` with triggers disabled (`session_replication_role = replica`, `ALTER TABLE … DISABLE TRIGGER`, `COPY` into a table created before the triggers) or before 0011/0026 existed, and does it skip the `work_stats` reconcile afterwards?
  - **If so**, that is the fix: devdb:build runs `reconcile_work_counters()` (and `refresh_catalog_rating_mean()`) as its last step, with a test or a check that "works with reads but no stats row" is 0 after a build.
  - **Otherwise** it is a trigger bug: reproduce it (which write left no row?), write the failing test, fix the trigger, and check `flyleaf` for the same gap (count only, guarded).
- Report which it was, with the evidence.

## Then

Update `findings/09-reviews.md` with a **Part 09b** section (findings, before/after numbers, behaviour changes), the SL-62 and SL-64 audit lines in `docs/tasks.md`, and remove the 09b row from `docs/audit/PENDING.md`. Run tests in the foreground, a few files at a time, at `--maxWorkers=1`; don't run the full suite or `scripts/ci.mjs` (the owner runs CI). Record any missing rate limit as an `RL` finding for Part 15.
