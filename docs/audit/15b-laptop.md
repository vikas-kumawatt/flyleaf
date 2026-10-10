# Audit 15b — the laptop session

The second half of Part 15. **15a** (`findings/15-cross-cutting.md`) did all the code and docs in a cloud sandbox with an empty database. **15b** runs what needs the real databases. Do the steps in order: each one assumes the previous ones are done, and the order is what keeps the comparison fair.

**What 15b changes:**
- `flyleaf_dev` and `flyleaf` get the migrations;
- the Postgres container is recreated with its new memory limit (step 12);
- the bench data is removed and optionally re-seeded (step 14).

Nothing else writes outside a bench's own throwaway rows.

**Conventions.** Commands are bash, run in `apps/api` (WSL or Git Bash). In PowerShell, write `$env:NAME='value'; npx …` instead of `NAME=value npx …`. Put the two URLs in variables once:

```bash
cd apps/api
DEV=postgres://flyleaf:flyleaf@localhost:5432/flyleaf_dev
FULL=postgres://flyleaf:flyleaf@localhost:5432/flyleaf
mkdir -p ../../docs/audit/perf/15b
```

Save every output under `docs/audit/perf/15b/`. Every number written into a doc says which database it came from.

---

## 0. Preflight (5 min)

1. Merge the 15a PR. Then:
   ```bash
   git checkout main && git pull
   git checkout -b audit/15b-laptop
   ```
2. Run `npm ci` in `apps/api` and in `apps/mobile`. Build the client:
   ```bash
   npx tsc -p ../../packages/api-client/tsconfig.json
   ```
3. Check Docker: `docker ps` should show `flyleaf-pg` on 5432. Start MinIO with `docker compose up -d minio`.
4. Record where each database starts:
   ```bash
   for U in $DEV $FULL; do psql "$U" -Atc "select current_database(), count(*) from drizzle.__drizzle_migrations"; done
   ```
   The repo has 42 migrations (`0000`–`0041`). `flyleaf_dev` is probably at 34 (through `0033`, Part 10's, the last part run on the laptop). `flyleaf` is somewhere from 34 to 38, depending on whether you applied 0034–0037 after Parts 11–13. Write both numbers down.
5. Optional, recommended: take a dump of `flyleaf_dev` first, `pg_dump -Fc "$DEV" -f ~/flyleaf_dev-pre15b.dump`. Every migration below is additive. This dump is only for peace of mind.

## 1. Migrations (≈ 5–15 min)

Apply 0034–0041 to both databases. They are hand-written and idempotent. None of them rewrites a large table: 0041's indexes are on `events`, `reviews`, `read_comments` and `shelves`, and 0039's is a partial index on `activity`.

```bash
time DATABASE_URL=$DEV  npm run migrate   # expect: migrations applied
time DATABASE_URL=$FULL npm run migrate   # expect: migrations applied
for U in $DEV $FULL; do psql "$U" -Atc "select count(*) from drizzle.__drizzle_migrations"; done   # 42 and 42
```

Write both times into `findings/15-cross-cutting.md` › CI result › 15b.

## 2. ANALYZE and reset the statistics (≈ 5–20 min)

```bash
psql "$DEV"  -c "ANALYZE" -c "SELECT pg_stat_reset()"
psql "$FULL" -c "ANALYZE" -c "SELECT pg_stat_reset()"
```

`pg_stat_reset()` clears only the usage counters (no data), so step 9's `idx_scan` and `seq_scan` counts reflect this session's bench.

## 3. Snapshot of the non-bench rows (1 min)

```bash
DATABASE_URL=$DEV npx tsx src/bench/nonbench-counts.ts > ../../docs/audit/perf/15b/nonbench-before.txt
```

This is the "before" for §6's clean check (step 14). It is taken after the migrations so that 0036's counter reconcile cannot show as a difference.

## 4. The full "after" bench on `flyleaf_dev` (≈ 15 min)

This is the comparison with `perf/baseline-dev.md` (Part 01, same database, same seed, same runner). The limits added in 15a are switched off with `BENCH_RATE_LIMITS=legacy`, because the baseline had none and the bench's 10 connections would meet the Global tier in seconds. Their cost is measured separately in step 7.

Shell 1:
```bash
npm run build
DATABASE_URL=$DEV BENCH_COUNT_QUERIES=1 BENCH_RATE_LIMITS=legacy LOG_LEVEL=warn node dist/server.js
```

Shell 2:
```bash
npm run bench -- --label 15-after
```

The run writes `docs/audit/perf/15-after.md` and `.json`. It covers every deferred latency:
- Part 11's shelves (`shelves:browse`, `shelves:big:items`, `shelves:saved`);
- Part 13's celebrity followers (`followers:celebrity`);
- Part 14's feed (`feed:*`);
- search, reading, reviews, stats, comments, imports/exports and login.

If a scenario shows non-2xx, stop and look before going on. A 429 means `BENCH_RATE_LIMITS` was not set.

Stop the server (Ctrl-C) when it is done.

## 5. Per-part benches deferred by Parts 11–14 (≈ 20–40 min)

| From | Command | Database | Save as |
|---|---|---|---|
| Part 13 | `DATABASE_URL=$DEV BENCH_COUNT_QUERIES=1 npx tsx src/bench/social-graph.ts --seed --lists --timing --race --clean` | `flyleaf_dev` | `15b/social-graph.txt` |
| Part 14 | `DATABASE_URL=$DEV npx tsx src/bench/feed-explain.ts --persona heavy --tab friends` | `flyleaf_dev` | `15b/feed-explain-heavy.md` |
| Part 14 | the same with `--page 2` | `flyleaf_dev` | `15b/feed-explain-heavy-p2.md` |
| Part 14 / D-14-1 | `DATABASE_URL=$DEV npx tsx src/bench/feed-explain.ts --persona guest --tab popular` | `flyleaf_dev` | `15b/feed-explain-popular.md` |
| Part 12 | `DATABASE_URL=$FULL npx tsx src/bench/import-cost.ts --rows 5000` | `flyleaf` (matching at full-catalog scale) | `15b/import-5000-full.txt` |
| Part 12 | `DATABASE_URL=$FULL npx tsx src/bench/import-cost.ts --rows 10000 --export` | `flyleaf` | `15b/import-export-10000-full.txt` |
| Part 12 | `DATABASE_URL=$DEV npx tsx src/bench/import-cost.ts --rows 5000 --export` | `flyleaf_dev` | `15b/import-5000-dev.txt` |

- Each command cleans up its own rows: `--clean`, a deleted throwaway user, or EXPLAIN only.
- **Deep follower pages:** Part 13 asked for the Part 01 celebrity's followers at offset 1,900. The runner's `followers:celebrity` scenario (step 4) times page 1 only. `social-graph.ts --lists` times offsets 0, 1,000 and 1,900 on its own 2,000-follower celebrity, on the same database. Record both, and say which is which.
- Part 14's question: is the §12.7 trigger (feed p95 > 200 ms) hit? Read it from `15-after.md`'s `feed:*` rows.
- Part 12's question: with the full catalog, does the exact-title stage stay index-bound for one-word titles ("Dune")? Read it from the import's statements per row and time.

## 6. 15a's own benches (≈ 5 min)

```bash
DATABASE_URL=$DEV  npx tsx src/bench/cursor-sweep.ts            > ../../docs/audit/perf/15b/cursor-sweep-dev.txt
DATABASE_URL=$FULL npx tsx src/bench/job-settings-check.ts      > ../../docs/audit/perf/15b/job-settings-full.txt
```

- **Cursor sweep:** all four rows should say OK.
- **Job settings:** expect worker 32MB/10min, dedupe 64MB/30min, ingest 64MB/1h, and API 4MB/0. The API row reads 4MB only after step 12. Before that it shows the server default from the current compose file. Note which one you saw.

## 7. Rate-limit overhead on the laptop (≈ 3 min)

```bash
for i in 1 2 3; do DATABASE_URL=$DEV npx tsx src/bench/rate-limit-overhead.ts --duration 10; done > ../../docs/audit/perf/15b/rate-limit-overhead.txt
```

Add the three runs to `perf/15a-rate-limit-overhead-sandbox.md` under a new heading, "Laptop, `flyleaf_dev`". The 15a reading to confirm or correct: Global in process is within noise of no limits, and Global in Postgres costs about a third of throughput. If the laptop disagrees, say so in `findings/15-cross-cutting.md` A-15-002 and in D-15-1.

## 8. A-03-026: batch jobs under their budgets, on the full catalog (≈ 30–90 min)

Before step 12 (the container still has no memory limit), run each job once and watch memory. In a second shell:

```bash
while true; do docker stats flyleaf-pg --no-stream --format '{{.MemUsage}}' | tee -a ../../docs/audit/perf/15b/pg-mem.txt; sleep 5; done
```

Then, in order, saving each output:

```bash
for J in reconcile.reads reconcile.follows reconcile.shelves reconcile.works authors.repair; do
  DATABASE_URL=$FULL npx tsx src/bench/run-job.ts $J
done 2>&1 | tee ../../docs/audit/perf/15b/jobs-full.txt
/usr/bin/time -v env DATABASE_URL=$FULL npm run dedupe -- --dry-run 2>&1 | tee ../../docs/audit/perf/15b/dedupe-dry-run-full.txt
/usr/bin/time -v env DATABASE_URL=$FULL npm run dedupe -- --backlog --dry-run --limit 5000 2>&1 | tee ../../docs/audit/perf/15b/dedupe-backlog-dry-run-full.txt
```

**What to record (findings 15, A-15-004 and A-15-005):**
- per job: time, ranges and rows corrected;
- the peak of `pg-mem.txt` during each job;
- whether any statement hit its `statement_timeout`. The error says `canceling statement due to statement timeout`.
- The dry runs merge nothing (`--dry-run`).

Part 03c's monthly pass was OOM-killed. The sliced stages must now finish. If one hits its timeout, that is a finding: write it down with the range it was on. Do not raise the timeout.

## 9. Index and planner checks (10 min)

Run on both databases after steps 4–8:

```sql
-- Audit-added indexes never used during this session's bench and jobs.
SELECT relname, indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid)) AS size
FROM pg_stat_user_indexes
WHERE indexrelname IN (
  'authors_credited_trgm_idx','dedupe_queue_impact_idx','dedupe_runs_finished_idx','admin_audit_log_created_idx',
  'uploads_key_uq','uploads_user_idx','uploads_cleanup_idx','series_entries_work_idx','search_suggestions_term_trgm_idx',
  'reads_work_idx','shelves_name_trgm_idx','shelves_description_trgm_idx','shelf_items_noted_idx','shelves_deleted_idx',
  'follows_followee_list_idx','follows_follower_list_idx','users_deleted_idx','shelf_slugs_shelf_idx','username_claims_user_idx',
  'rate_limits_expires_idx','activity_popular_idx','events_at_idx','reviews_deleted_idx','read_comments_deleted_idx',
  'shelves_purge_idx','search_zero_summaries_week_query_uq')
ORDER BY idx_scan, pg_relation_size(indexrelid) DESC;

-- DECISIONS.md question 1: is authors_search_trgm_idx still unused?
SELECT indexrelname, idx_scan, pg_size_pretty(pg_relation_size(indexrelid))
FROM pg_stat_user_indexes WHERE indexrelname IN ('authors_search_trgm_idx','authors_name_trgm_idx');

-- Big tables read by sequential scan during the session.
SELECT relname, seq_scan, seq_tup_read, idx_scan, n_live_tup
FROM pg_stat_user_tables WHERE n_live_tup > 100000 ORDER BY seq_tup_read DESC LIMIT 15;
```

**What to expect:**
- Indexes used only by nightly jobs show `idx_scan = 0` after a bench unless step 8 ran them: `rate_limits_expires_idx`, `events_at_idx`, `*_deleted_idx`, `shelves_purge_idx` and `uploads_cleanup_idx`. Those are fine.
- Any other zero is worth one line in findings 15. Note whether the bench has a scenario that should have used it.
- A big table with a large `seq_tup_read` that is not explained by step 8's jobs needs its own entry with EXPLAIN.
- Save all three outputs as `15b/index-check-dev.txt` and `15b/index-check-full.txt`.

## 10. A-03-027: duplicate author credits (≈ 5–20 min, read-only)

```bash
DATABASE_URL=$FULL npx tsx src/bench/duplicate-credits.ts --sample 25 > ../../docs/audit/perf/15b/duplicate-credits-full.md
```

**Fill in findings 15, A-15-006:**
- the count of affected works (Part 03c: 11,112 works and 12,524 pairs);
- the merge-candidate pairs;
- your reading of the 25-row sample: is each pair the same person?

This answers the measurement the brief asks for. **DECISIONS.md question 4** (D-15-8) is then yours to decide.

## 11. Search and the rest of `comparison.md` (5 min)

```bash
npx tsx src/bench/compare.ts baseline-dev 15-after > ../../docs/audit/perf/comparison.md
```

For every ❌ row, add an entry under "Still over budget":
- the EXPLAIN (ANALYZE, BUFFERS), using `src/bench/explain-search.ts` for `search:*` and `src/bench/feed-explain.ts` for `feed:*`;
- the cause;
- a concrete plan.

Part 02d's author-arm plan (in `PENDING.md`) is the known one for `search:common` and `search:cjk`.

## 12. Recreate the Postgres container with its memory limit (5 min, after every bench above)

The 15a compose file sets:
- `mem_limit: 3g`;
- `shared_buffers=512MB`, `work_mem=4MB`, `hash_mem_multiplier=2`;
- `maintenance_work_mem=256MB`, `max_connections=50`, `effective_cache_size=2GB`.

The volume keeps the data.

Check the Docker VM first: `docker info --format '{{.MemTotal}}'`. Part 02d measured a 3.8 GB VM. The limit has to leave room for MinIO and the VM itself (about 0.5 GB). If the VM is smaller than 3.5 GB, lower `mem_limit` and `shared_buffers` in proportion, and write down what you chose.

```bash
cd ../.. && docker compose up -d postgres && cd apps/api
docker inspect flyleaf-pg --format '{{.HostConfig.Memory}}'          # 3221225472
psql "$DEV" -Atc "SHOW shared_buffers; SHOW work_mem; SHOW max_connections; SHOW hash_mem_multiplier"
DATABASE_URL=$FULL npx tsx src/bench/job-settings-check.ts >> ../../docs/audit/perf/15b/job-settings-full.txt   # API row now 4MB / 0
```

Then repeat the monthly dedupe dry run from step 8 **under the limit**. This is A-03-026's proof:

```bash
/usr/bin/time -v env DATABASE_URL=$FULL npm run dedupe -- --dry-run 2>&1 | tee ../../docs/audit/perf/15b/dedupe-dry-run-full-limited.txt
docker logs flyleaf-pg --since 2h 2>&1 | grep -iE "terminated by signal|out of memory|crash|recovery" || echo "no OOM, no crash recovery"
```

**Not OK:** an OOM kill or crash recovery here. If you see one, write it down with the statement it was running, and the 15a design needs another look before the dedupe backlog runs.

**Also check:** an ingest with `--popularity` or `--finalise` still runs under the new limits (ingest profile, 64 MB per sort or hash). If you have an ingest due, run it now and record its peak. Otherwise note it as unverified.

## 13. §6 final verification: CI on the real database (≈ 20–25 min)

MinIO must be up so the storage contract block runs, not skips. `DATABASE_URL` is unset, so the real-Postgres step uses `flyleaf`.

```bash
cd ../.. && FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs 2>&1 | tee docs/audit/perf/15b/ci.txt; cd apps/api
```

**Required:**
- all 9 steps green;
- "api · migrations on a real Postgres" says `migrations applied`, **not skipped**;
- api tests with 0 skipped.

Record the time and the test counts in findings 15 › CI result › 15b.

## 14. §6 final verification: the clean (≈ 10 min, last, because it removes the bench data)

```bash
DATABASE_URL=$DEV npm run bench:seed -- --clean
DATABASE_URL=$DEV npx tsx src/bench/nonbench-counts.ts > ../../docs/audit/perf/15b/nonbench-after.txt
diff ../../docs/audit/perf/15b/nonbench-before.txt ../../docs/audit/perf/15b/nonbench-after.txt && echo "non-bench rows identical"
```

**Required:** identical counts in every table.
- An md5 difference with equal counts means a non-bench row changed. Look at which table it is in. A real user's follower count changes when bench users who followed them are removed, so `profiles` may legitimately differ. Explain any difference in findings 15.
- Part 01 recorded only that its fingerprints matched, not the numbers, so this compares the state before and after this session's clean.
- Re-seed afterwards if you want the bench data back: `DATABASE_URL=$DEV npm run bench:seed` (bulk mode).

## 15. Fill in the TBDs and finish the summary (≈ 30 min)

```bash
cd ../.. && grep -rn "TBD in 15b\|TBD (15b)\|CI_API_AFTER\|CI_RESULT" README.md docs | grep -v "15b-laptop.md"
```

Replace every hit with the measured number, or with "not measured: <reason>". The files:
- `docs/audit/SUMMARY.md`: the perf headline, at most three lines. Use `comparison.md`'s pass/over/TBD line, the two or three biggest changes, and the step 12 dedupe result.
- `README.md`: Verification status (the perf numbers and test counts from step 13).
- `docs/audit/findings/15-cross-cutting.md`:
  - the steps 1, 6, 7, 8, 9, 10 and 12 results;
  - a "CI result › 15b" paragraph;
  - mark A-15-004 and A-15-005 measured.
- `docs/audit/perf/15a-rate-limit-overhead-sandbox.md`: the laptop section from step 7.
- `docs/audit/PENDING.md`: delete the Part 15 row. Add anything step 8, 9, 11 or 12 turned up.

## 16. Commit and PR

```bash
git add -A docs && git commit -m "audit(15b): migrations on both databases, after bench, comparison, final verification"
git push -u origin audit/15b-laptop
```

Open a PR to `main`. The audit is closed when it merges with CI green.
