# Decisions waiting on the owner

Collected in Part 15a (2026-10-10) from every `DECISION NEEDED` in `docs/audit/findings/*.md`. **None of these is implemented** beyond what the "now" column says. Each names the part that raised it. Decisions that the owner has already answered are listed at the end only for traceability.

## Open

### 1. Drop `authors_search_trgm_idx`? (A-02-027, Part 02b decision 3)
- **Question:** the 938 MB trigram index on `authors.search_text` appears unused. Part 02b made dropping it conditional on dedupe and the import matcher not using it.
- **Precondition now met:** Part 03b showed dedupe stage 3 does not use it (it uses `authors_name_trgm_idx`, which **must stay**). Part 12 showed the import matcher uses neither.
- **Options:**
  - (a) drop it with `DROP INDEX CONCURRENTLY` in a new migration;
  - (b) keep it.
- ~~**Recommendation:** (a), after 15b confirms `idx_scan = 0` on `flyleaf` after the full bench (`15b-laptop.md` › 3). Saves 938 MB and write cost on author ingest.~~
- **15b (2026-10-11): the precondition fails.** The index's expression, `flyleaf_author_names(name, alternate_names)`, is used by **search's ranking author term** (`catalog/index.ts`, the `EXISTS … ILIKE ANY ($7)` in the ORDER BY). That subquery has no `has_works` filter, so the partial `authors_credited_trgm_idx` cannot serve it.
  - On `flyleaf_dev` the planner runs it as a hashed subplan through `authors_search_trgm_idx`: **15,207 scans** this session (`perf/15b/index-check-dev.txt`; plans in `perf/15b/explain-author-search-dev.txt`).
  - On `flyleaf` (959 MB index) the same term ran **per row through primary keys** for `ishiguro`, `ishigoro` and `king`, and did not touch the index (`perf/15b/explain-author-search-full.txt`). "Used by search" is proven only on `flyleaf_dev`.
  - The condition "idx_scan = 0 on `flyleaf` after the full bench" cannot be met as written: the query references the index's expression, the planner chooses it on the smaller database, and 15b runs no search workload on `flyleaf`.
- **Recommendation (15b): (b) keep it.** Revisit after A-02d-002 (author names on `works`), which changes this term; or measure a search sweep on `flyleaf` and read `idx_scan` if the 959 MB matters sooner.
- **Now:** unchanged (kept).

### 2. Ratings from new or unverified accounts, including imports (§9.7, A-09-021; Part 12 hand-over)
- **Question:** an import can bulk-add ratings from a new or unverified account. Their reviews stay hidden until verification (D-05-3). Their **ratings** count in the work's average and histogram at once.
- **Options:**
  - (a) decide together with the PRD's §9.7 fast-follow (SL-62b: a `rating_eligible` predicate in the trigger aggregate, the histogram and the reconcile);
  - (b) now: exclude ratings of unverified accounts from aggregates;
  - (c) now: import ratings count only after the email is verified.
- **Recommendation:** (a). The planned predicate covers all three cases in one place. (b) or (c) alone would be half of it, built twice.
- **Now:** unchanged.

### 3. Shelf view counter (A-11-024, Part 11; recorded here as D-15-7)
- **Question:** the browse ranking's `0.20·log(1+views)` term is always 0. There is no view counter.
- **Options:**
  - (a) keep the spec gap: views = 0, the other weights unchanged;
  - (b) build it:
    - one row per (shelf, viewer or guest session, day) in a small table;
    - written on shelf detail and share-page views, under the Global rate tier;
    - rolled up nightly into `shelves.view_count`;
    - rows deleted after the rollup.
    - About a day.
  - (c) drop `views` from §15.5 and renormalise.
- **Recommendation:** (a) until browse has real traffic to rank; then (b). It is a write on a hot read path, and with today's volume the term would be noise.
- **Now:** (a), decided as reversible in 15a.

### 4. Same-name author records (A-03-027, Part 03c; recorded here as D-15-8)
- **Question:** Part 03c found 11,112 live works on `flyleaf` credited to two author records with the same name. Since 15a, ingest adds no new ones (A-15-006). What to do with the existing ones?
- **Options:**
  - (a) leave them;
  - (b) drop only the duplicate **credit**, keeping both author records (one statement per batch, reversible from a saved list);
  - (c) merge the same-name author records that share a work: aliases kept, works re-pointed, batched, reversible like work merges.
- **Recommendation:** decide after 15b's `npx tsx src/bench/duplicate-credits.ts` count and sample (`15b-laptop.md` › 4). If the sample shows the same person, then (b) now and (c) as an admin-reviewed batch. If not, then (b) only.
- **15b (2026-10-11): the count was not measured.** It failed on a parallel hash (`/dev/shm` 64 MB, A-15-028), then was killed by the memory guard on the 8 GB laptop (`perf/15b/duplicate-credits-full.md`). Still waiting on a run on a machine with ≥ 16 GB.
- **Now:** ingest fixed; existing data unchanged.

### 5. Dedupe groups of more than two (Part 03c, D5 follow-up; in `PENDING.md`)
- **Question:** 170,221 pairs are held because their (author, title) group has more than two works. Some are true duplicates (e.g. *Pandemonium* ×4).
- **Options:**
  - (a) keep holding them;
  - (b) sample about 25 groups and write a rule only if it holds on the sample.
- **Recommendation:** (b), post-audit, as `PENDING.md` says.
- **Now:** held.

### 6. Build A-15-027 and A-15-029 now? (Part 15b)
- **Question:** 15b found two plan problems on write and batch paths. Each fix is a small migration, to be applied to both databases.
  - **A-15-027:** the nightly `has_works` repair hash-scans all of `work_authors` and `works` for every 20,000-author range.
  - **A-15-029:** `activity` has no `(object_type, object_id)` index, so every review save seq-scans `activity` inside the read's lock.
- **Options:**
  - (a) one migration `0042` with both: the repair's set arm driven from `work_authors_author_idx`, and `activity_object_idx`. Verified by EXPLAIN on `flyleaf` and a before/after `review:post` on `flyleaf_dev`. About half a day with the laptop runs.
  - (b) A-15-029 now, A-15-027 with the ≥ 16 GB run of `authors.repair`.
  - (c) both post-audit.
- **Recommendation:** (a). Both are P1, both are small, and the repair cannot be measured until it is ranged in practice.
- **Now:** recorded, not built.

### 7. `shm_size` for the Postgres container (A-15-028, Part 15b)
- **Question:** Docker's default 64 MB `/dev/shm` makes a parallel hash join fail (SQLSTATE 53100). The server's `max_parallel_workers_per_gather` is 2, so this applies to API queries too.
- **Options:**
  - (a) `shm_size: 512m` on the postgres service, plus a container recreate. The memory counts within the 3 GiB limit.
  - (b) `max_parallel_workers_per_gather = 0` for the API.
  - (c) both.
- **Recommendation:** (a), at the next planned recreate.
- **Now:** unchanged.

## Taken in Part 15a (reversible): please confirm or change

| Id | Decision | Why | To reverse |
|---|---|---|---|
| D-15-1 | Per-request limits in process; exact ones in Postgres. Per-request means Global, Search, Writes, Progress, Events and username check. Exact means auth, comments, follows, reviews, imports, exports, uploads and username change. | Measured: Global in Postgres cost 26–35 % of throughput (sandbox). Per-instance counts are acceptable while there is one instance. | Change a row's `store` in `RATE_LIMITS`. Redis when a second instance exists. |
| D-15-1a | Test apps enforce only the four pre-existing limits. | Otherwise 1,600 existing tests would trip the Global tier. Production enforces all of them. | `enabled: 'all'` in a test. |
| D-15-1b | Admin 2FA and admin logout are limited per IP. | Admin requests carry no app viewer. | Key by admin id. |
| D-15-2 | Uploads: 10 intents a day per account. Guest telemetry: 120 batches an hour (per account and per IP). | The PRD has no row for either. Both are well above normal use. | The numbers in `RATE_LIMITS`. |
| D-15-3 | Popular exposure cap: 1,000 servings per card. | Keeps one viral card from staying on top for its whole 14 days. At today's volume it never triggers. | `POPULAR_EXPOSURE_CAP`. |
| D-15-4 | A guest's zero-result searcher id is the app's telemetry session id, sent as `x-flyleaf-session` on search, else the IP. | D-10-3 needed one. The app already has the session id. | `searcherOf` in `catalog/index.ts`. |
| D-15-5 | Committed `import_rows.raw` is trimmed to title/author/ISBN once the import is 30 days old. Rows still to review keep everything. | Part 12: the raw file rows outlived the file (D-PV-3). The review queue needs only unmatched rows. | The trim step in `retentionSweep`. |
| D-15-6 | Deleted comments are purged 30 days after deletion, like reviews and shelves. | No rule existed. | The step in `retentionSweep`. |
| D-15-7 | Shelf view counter not built. | Open question 3 above. | — |

## Owner actions that are not code

- **Privacy policy:** state that raw events are kept for **13 months** and zero-result search terms for **30 days** (D-10-1).

## Answered earlier (for traceability)

All earlier `DECISION NEEDED` items were answered in their parts:

- Part 02: A-02-012, A-02-013, A-02-014, A-02-001, and 02b decisions 1, 2 and 4 (decision 3 is open question 1 above).
- Part 03: D1–D7 (D5's follow-up is open question 5 above).
- Part 04: D-04-1 and D-04-2.
- Part 05: D-05-1, D-05-2 and D-05-3.
- Parts 06, 07 and PV: all decisions.
- Part 08: D-08-1 to D-08-5.
- Part 09: all decisions.
- Part 10: D-10-1 to D-10-3 (built in 15a).
- Part 11: D-11-1 and D-11-2.
- Part 12: D-12-1 and D-12-2.
- Part 13: D-13-1 to D-13-3.
- Part 14: D-14-1 (decided 2026-10-10, built in 15a).
