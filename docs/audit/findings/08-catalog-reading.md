# Audit 08 — Catalog screens and the reading core (SL-40 … SL-44, SL-50 … SL-57)

2026-09-26/27 · CI: owner's run (`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`, 1,097 s) **failed at api · tests: 1 failed | 1,324 passed | 3 skipped, 2 files failed** (both caused by this part, fixed below); after the fix the two files pass at one worker (36/36) and every step CI did not reach was run here as `ci.mjs` defines it: **api · build ✓, api · audit ✓ (exit 0; 7 moderate, none high), mobile · typecheck ✓, mobile · offline tests ✓ 147/147, api · migrations ✓ (flyleaf_dev and flyleaf)**. The rest of the API suite was not re-run (it passed in the owner's run) · tests **API 1,249 → 1,329** (owner's run 1,328 incl. 3 skipped by the failed `beforeAll`, + 1 new FK-mapping test), **mobile 130 → 147**. No test was weakened, skipped or deleted; four inherited assertions changed with the spec (Behaviour changes).

**Databases.** Every perf number says which database it came from. Migrations 0026 and 0027 are applied to **flyleaf_dev and flyleaf** (flyleaf explicitly, `DATABASE_URL=…/flyleaf`).

**What was run here** (one worker, a few files at a time): API `tsc --noEmit`; the API files `reading`, `reading-lifecycle`, `work-counters`, `catalog-pages`, `dedupe`, `search`, `search-route`, `isbn`, `relevance`, `reviews`, `review-ranking`, `import-committer`, `import-matcher`, `import-real-library`, `import-review`, `shelves`, `shelves-privacy`, `social-mute`, `identity`, `admin-catalog`, `admin-security`, `dob-confirmation`, `schema`, `jobs`, `read-interactions-migration`, `activity`, `feed-query`, `export`, `contract`, `authorization-matrix`, `server-wiring`, `profile-stats`, `catalog-source-contract`, `phase1-exit-criteria` (all green); `spec:generate` (drift 0 by `contract.test.ts`); api-client build; mobile `tsc --noEmit`; mobile `queue`, `queue-audit`, `reading-audit`, `phase1-exit-criteria`, `social-queue`, `readingRules`, `readingVelocity`, `searchState` (all green). **Not run:** the full API suite, the rest of the mobile suite, `scripts/ci.mjs`.

**Screens were checked by reading the code.** The mobile suite has no React Native renderer; the logic behind every screen change is in a tested module (`readingRules`, `searchState`, `repository`, `queue`), and the rest is on the device checklist at the end.

## CI failures in the owner's run, and their fix

- **`dob-confirmation.test.ts` (whole file, `beforeAll`):** it asserted that `0025_dob_confirmation` is the **last** migration and applied `files.at(-1)` as 0025. 0026 and 0027 now follow it. Fixed: 0025 is found by tag, the migrations before it run, the users are seeded, then 0025. Correction to my earlier report: my batch with this file showed "3 skipped", which were these tests skipped by the failing hook; I missed it.
- **`hooks-hardening.test.ts` › "POST /v1/reads with a work that does not exist → 422 invalid_reference":** Part 08 answers an unknown work with 404 (A-08-014, resolved before the insert). This was the **only** test of the foreign-key → 422 mapping, so the mapping is now pinned by a new case whose reference still reaches the database (a random `edition_id` → 422 `invalid_reference`, no internals), and the old case asserts the new contract (404 `not_found`, no internals). I had not run this file before handing over.
- **Noise, not a failure:** `pg-boss error … _PostgresSendReadyForQueryIfNecessary` for every queue (follows, reads, works, imports, exports, storage) during teardown; it names the new `works.reconcile` queue alongside the existing ones, so it is the existing worker-teardown pattern, not something 0026 introduced. Not investigated further (Part 15, jobs).

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| SL-40 | Search: 250 ms debounce, tabs, recents, filters | ⚠️ debounce correct; a slow response overwrote a newer one; recents were four invented queries, never persisted, and every keystroke was saved; the format filter is cosmetic | A-08-020, A-08-021 |
| SL-41 | Book detail: hero, status, rating + histogram, description, metadata, tabs | ❌ the histogram, description, series and four metadata fallbacks were fixed values shown for every book; writes skipped the offline queue and swallowed errors; a 404 spun for ever | A-08-016, A-08-019, A-08-026 |
| SL-42 | Edition picker; "the copy I own" | ❌ nothing was saved; every edition had an invented publisher and year; a work with no editions showed three invented ones | A-08-018 |
| SL-43 | Author page; series page with your progress | ❌ the author page searched the author's name as a title and invented a bio and books; the series page was hard-coded; neither endpoint existed | A-08-017 |
| SL-44 | Scanner, permission rationale, manual fallback | ⚠️ rationale and manual entry present; a missed code was looked up again on every camera frame; every error said "not found"; unknown ISBNs have no live lookup | A-08-022 |
| SL-50 | reads + progress_events migrations & repos | ⚠️ one row per attempt and append-only progress hold; every reads write scanned the table twice (L-01); terminal attempts were overwritten; no delete | A-08-001, A-08-004, A-08-007, A-08-013 |
| SL-51 | Progress idempotent on client_event_id | ✅ idempotent (Part 07 tests); append-only verified (no UPDATE/DELETE outside cascades); `minutes` had no bound | A-08-024 |
| SL-52 | Reading tab: slider auto-save, +10, predicted finish | ⚠️ slider saves once per drag (code); flaky prediction test and a real rounding bug; UTC "today" | A-08-023, A-08-010 |
| SL-53 | Progress sheet: optional minutes, note | ⚠️ note ≤ 280 enforced; minutes unbounded | A-08-024 |
| SL-54 | Finish flow in one call | ❌ not one transaction; `review` accepted and dropped; a double tap wrote two activities; a finish date defaulted to the UTC day; finishing a want with a past date was refused | A-08-006, A-08-008, A-08-010, A-08-011 |
| SL-55 | DNF: page pre-filled, reasons, neutral copy | ⚠️ copy and pre-fill fine; `note` accepted and dropped; DNF-ing a finished read overwrote the finish | A-08-007, A-08-012 |
| SL-56 | Re-read: new row, attempt_no + 1 | ❌ concurrent starts returned 409; `dnf → finished` overwrote the DNF instead of a new row | A-08-007, A-08-009 |
| SL-57 | Want-to-read queue: sort, filter, bulk | ❌ sort and filter work; bulk "Remove" set the books to *paused*; no delete endpoint existed | A-08-013 |

## Findings

### A-08-001 · P1 · FIXED · L-01: every reads write scanned the whole table twice
- **Where:** `recompute_work_stats_for_work()` (0011), per-row `reads_work_stats_trigger` (0018).
- **Evidence (flyleaf_dev, 62,369 reads, before):** both statements `Seq Scan on reads`, 1,313 buffers each: the per-work aggregate for the hot work removed 56,970 rows by filter; the catalog mean `AVG(rating) … WHERE work_id <> x` removed 38,903. A 3-read work also scanned all 62,369 rows. One call: 64 ms (hot work) / 22 ms (small). All 12,576 works: **245 s (19.5 ms each)**.
- **Fix (migration 0026 + `migrate.ts` ONLINE_SQL):**
  - The catalog mean C is **cached** in the one-row `catalog_rating_stats`, refreshed by the migration and by the nightly `works.reconcile` job (`worker.ts`, 03:40). **Drift tolerance: C is at most one day old.** C no longer excludes the work being scored; with m = 25 that moves a weighted rating by at most (m / N) × 4.5 (0.002 at N = 27k ratings), below the column's 0.01 resolution. Nightly, every `work_stats.weighted_rating` is re-derived with the fresh C (before, a work's weighted rating kept whatever C it last saw).
  - The per-work aggregate uses the new `reads_work_idx (work_id, user_id)` (A-08-004).
  - **Statement-level triggers** with transition tables (insert, delete, update): one recompute per affected work per statement, not per row. Transition tables cannot take an `UPDATE OF` column list, so the update trigger compares old and new `(work_id, user_id, status, rating, hearted)` and a like/comment counter update recomputes nothing (tested).
  - The trigger **locks the affected works rows (id order, `FOR NO KEY UPDATE`) before reading `reads`**, so concurrent writers on one work serialise and see each other's committed rows (READ COMMITTED takes a new snapshot per statement). Before, two concurrent writes could each compute stats missing the other's.
  - One formula for the weighted rating (`flyleaf_weighted_rating`) used by the trigger path and the reconcile. The TypeScript duplicate `ReviewService.recomputeWorkStats` (on the review write path, with its own full-table scan and its own C) now calls the SQL function; whether it is needed at all stays Part 09's.
- **Equivalence (flyleaf_dev, all 12,576 works, old function vs new, both in rolled-back transactions):** `rating_sum`, `rating_count`, `avg_rating`, `heart_count`, `read_count`, `dnf_count`, `polarisation` identical on every row except the hot work, whose only difference is the one rating my `rate:post` bench wrote between the two snapshots (3,697 → 3,698 ratings, verified). `weighted_rating`: 6 of 7,907 rated works differ by exactly 0.01 (rounding boundary), none by more. Within the stated tolerance.
- **After:** the hot work's aggregate is a `Bitmap Index Scan on reads_work_idx`, 575 buffers (was 2 × 1,313); a 3-read work, 6 buffers (was 1,313). One call 9.4 ms / 0.8 ms (was 64 / 22). All 12,576 works: **2.5 s (was 245 s, 97×)**. Cost now grows with the work's reads, not with the table.
- **Tests:** `work-counters.test.ts` › "scores with the cached catalog mean, not a live scan…", "falls back to C = 3.9…", "a like or comment counter update does not recompute the work", "one statement touching many reads…", "refreshes the catalog mean and repairs drifted counters, then finds nothing", "is scheduled nightly by the worker". Seen failing before: the cached-mean test cannot fail on HEAD's schema (no cache table); on HEAD's rule it computes C from the live mean (5.0), not 3.0 — by construction. The equivalence run above is the evidence for the rewrite.

### A-08-002 · P1 · FIXED · A-02-013 (decided): what `works.log_count` counts
- **Evidence (HEAD, probed on PGlite):** a re-read by one user left `log_count = 2`; deleting every read left it at `2`; an imported read left it at `0`. Nothing decremented, merges added totals, and no reconcile existed.
- **Fix (0026):**
  - `ol_log_count`: Open Library's baseline, set only by the ingest `--popularity` pass (`ingest.ts` now writes it). It is the old `log_count` **renamed**. The rename is metadata-only; a copy would have rewritten a table with two GIN indexes (measured on flyleaf: ~1 ms a row, a third of updates non-HOT, ≈55 min and ≈1.6 GB of bloat for 3.2M rows).
  - `reader_count`: **distinct users with any read of the work** (any status, imports included, a re-read counts once, private reads count as a number). Kept by the reads triggers (A-08-001), so inserts, deletes, account deletions, work moves and merges all re-derive it; repaired nightly by `works.reconcile`.
  - `log_count`: a **VIRTUAL generated column** `ol_log_count + reader_count` (Postgres 18; PGlite is 18.3 too). No storage, no rewrite. **Ranking combination: one Flyleaf reader weighs the same as one Open Library shelving.** Search SQL and the relevance corpus keep reading `log_count`; `works_log_count_idx` is now an expression index on `(ol_log_count + reader_count)`, built `CONCURRENTLY`, and the planner matches `ORDER BY log_count` to it (EXPLAIN: `Index Scan Backward using works_log_count_idx` for `th`, three arms). `log_count + 0` still defeats it where Part 02 wanted that.
  - **Backfill of the baseline:** today's value minus what Flyleaf added. Only four in-app increments ever happened (the bench seed never incremented), all on three Flyleaf-created works with no `ol_work_key`, so their baseline is 0 by construction; set to 0 on both databases (3 rows each). `reader_count` backfilled in batches of 2,000 works by `backfillReaderCounts` in `migrate.ts` (12,576 works on each database).
  - Merge: the survivor gains the loser's **baseline**; readers are re-derived (a reader of both copies counts once). Undo takes the baseline back (`moved.ol_log_count_added`).
- **Relevance panel (FN-43), before → after:** PGlite corpus **216/217 → 216/217** (floor 0.98, position rules unchanged). Real catalogs, same panel via the new `src/bench/relevance-panel.ts`: **flyleaf_dev 209/217 → 209/217**, **flyleaf 198/217 → 198/217**, identical miss lists. The real-catalog rates were already below 0.98 before this part (author-surname queries against a far larger catalog than the corpus); that is a Part 02 matter, not a regression.
- **Tests:** `work-counters.test.ts` › "is the OL baseline plus the readers", "a re-read does not count the reader again", "an imported read counts", "deleting one of two attempts keeps the reader; deleting the last uncounts them", "account deletion uncounts the reader and their rating", "moving a read to another work moves the reader"; `dedupe.test.ts` › "the survivor gains the loser's OL baseline and counts each reader once", "undo gives back the baseline and the readers". Seen failing before: **yes** for the re-read, delete and import rules (HEAD probe above: 2, 2, 0).

### A-08-003 · P2 · FIXED · A-03-016: a merge scanned `reads` twice per moved read
- **Evidence (flyleaf_dev, `src/bench/merge-cost.ts`, merge + undo of a 466-read work, rolled back):** before **merge 20.4–23.0 s, undo 20.6–22.1 s** (two warm runs).
- **Fix:** A-08-001 (statement triggers: one recompute per work per statement, via the index). The explicit recomputes in `undoMerge` stay: they restore the loser's `work_stats` row when no reads moved.
- **After:** merge **0.58 s**, undo **1.27 s** (warm; the first run was 9.6 s cold). The hot work (5,399 reads): merge 1.27 s, undo 1.74 s.

### A-08-004 · P2 · FIXED · `reads.work_id` had no general index (Part 03b)
- **Evidence:** no index led with `work_id` (`reads_user_work_attempt` leads with `user_id`; `reads_work_finished_idx` is partial). A work's reads (3 rows): `Seq Scan`, 62,366 rows removed, 1,313 buffers.
- **Fix:** `reads_work_idx (work_id, user_id)` created **CONCURRENTLY** by the new `ONLINE_SQL` step in `migrate.ts`. It runs after the journal on every `npm run migrate`, drops an index an interrupted build left INVALID, and is replayed by the PGlite harness. `user_id` second makes the distinct-reader count index-only. This is the mechanism LA-05 needs for 0019 as well.
- **After:** `Bitmap Index Scan on reads_work_idx`, 6 buffers. Full catalog migrate (flyleaf, both indexes concurrently): **44 s**. Part 03c can now run.

### A-08-005 · P1 · FIXED · D3: a merged work id did not work (A-03-008, A-07 lead)
- **Evidence (HEAD probe):** `GET /works/:merged` → **404**; `POST /reads` with a merged id **landed on the tombstone**. Shelf adds, mutes and favourites checked only that the row exists (a tombstone does); favourites did not even check that.
- **Fix:** `catalog/resolve.ts` `resolveWorkId(db, id, { lock })` (one hop at rest, up to four under a concurrent merge). Reads resolve by lookup; **writes resolve inside their transaction under `FOR KEY SHARE`**, which conflicts with the merge's `FOR UPDATE`, so a write racing a merge commits first (and is moved) or waits and follows the tombstone. Applied to: `GET /works/:id` (200 with the survivor's body and `merged_into`), `GET /works/:id/reviews`, `POST /reads`, shelf add (in a transaction now), shelf item update/remove, shelf reorder (one query for the list), mute/unmute (both routes), favourites (resolved, de-duplicated keeping the first slot, unknown ids 422 `unknown_work`). Progress, finish and DNF take a read id, which the merge already moved. The app navigates by the returned id and the work page writes with `work.id`.
- **Undo:** `loser_modified` stays as the safety net; with writes resolved it no longer fires in practice (tested).
- **Tests:** `reading-lifecycle.test.ts` › "a merged id is logged onto the survivor (D3): an offline replay survives a merge", "GET /works/:merged answers 200 with the survivor and merged_into", "a shelf add lands on the survivor", "a mute lands on the survivor, and unmuting the old id removes it", "favourites store the survivor, once; an id that names no work is refused", "a merged id lists the survivor reviews", "progress on a read the merge moved keeps working, on the survivor", "undo still refuses only if something landed on the loser (safety net)". Seen failing before: **yes** for GET and `POST /reads` (probe); the others by code reading at HEAD.

### A-08-006 · P0 · FIXED · Making a read private after the fact left its activity visible
- **Evidence (code, HEAD):** `ReadingService.finish` and `dnf` updated `visibility` but never touched the read's existing activity. A read logged public (`started` activity) and then finished with `visibility: private` kept its public `started` row in followers' feeds. Only `upsert` called `updateActivityVisibility`, and only for `private`.
- **Fix:** every write path (`upsert`, `finish`, `dnf`) carries a visibility change to the read's existing activity: private deletes it, otherwise it is set to what `recordActivity` would store (a **private account's activity stays followers-only**, PRD §26.2; `updateActivityVisibility` alone would have set `public`).
- **Tests:** `reading-lifecycle.test.ts` › "making a finished read private removes its activity", "a private account making a read public keeps its activity followers-only". Seen failing before: first test by code reading (finish never touched activity at HEAD); the second guards the new path.

### A-08-007 · P1 · FIXED · Terminal attempts were overwritten (PRD §8.1, §8.2 [LOCKED], §6.18, §34.2)
- **Evidence (HEAD probe):** `want`… `dnf → finished` via `POST /reads` left **one row, `finished`** (the DNF was lost); `finished → dnf` left one row `dnf` (the finish was lost); `/reads/:id/finish` on a DNF read overwrote it.
- **Fix:** one rule, `startsNewAttempt(current, next)`: a terminal attempt (finished, dnf) moved to a **different** status is a new attempt; the same status edits it; non-terminal statuses move freely. Exported and used by `upsert`; `finish` on a DNF and `dnf` on a finished read create new attempts. The mobile app applies the **same rule** offline (`src/lib/readingRules.ts`, used by `saveReadStatus`), so the attempt shown is the one the sync writes to.
- **Tests:** the **status-transition matrix**, `reading-lifecycle.test.ts` › "status transitions … every cell" (30 cells: none/want/reading/paused/finished/dnf × 5), "the rule itself", "finishing a DNF records a new finished attempt; the DNF stays", "stopping a finished read records a new DNF attempt"; mobile `reading-audit.test.ts` › "finishing a DNF book offline adds an attempt…", "stopping a finished book offline…"; `readingRules.test.ts`. Seen failing before: **yes** (probe; the mobile tests fail against HEAD's `repository.ts`).

### A-08-008 · P1 · FIXED · Activity written for non-events (PRD §34.2)
- **Evidence (HEAD probe):** a rating changed later wrote a second `finished` activity ("Rating changed later: no activity row"); adding a book to want-to-read wrote **`started`**; a double-tapped finish wrote two `finished` rows.
- **Fix:** activity only when the status changes, inside the write's transaction. `want` writes none (§8.2 wants "low, aggregated", which needs a verb and feed rendering: → Part 14). `paused` stays silent.
- **Tests:** "a rating changed later writes no activity", "want writes no started activity; reading does", "a double-tapped or replayed finish writes one activity and one row". Seen failing before: **yes** (probe).

### A-08-009 · P1 · FIXED · SL-56: concurrent starts of a finished book returned 409
- **Evidence (real Postgres, throwaway databases, `src/bench/attempt-race.ts`, 8 concurrent "start again"):** HEAD **1 of 8 and 4 of 8 failed with 23505** (mapped to 409 "That already exists.") on two runs. PGlite serialises transactions and cannot show this.
- **Fix:** `pg_advisory_xact_lock` on (user, work) before the next attempt is decided, in every path that can create one.
- **After:** 8/8 succeed, exactly one new attempt, both runs. The two throwaway databases were created and dropped by the script run.

### A-08-010 · P1 · FIXED · Dates (PRD §8.5)
- **Evidence:** the mobile finish screen and the offline repository defaulted dates with `toISOString().slice(0, 10)`, the **UTC** date: on this machine (Asia/Calcutta) 00:30 on 27 Sep is recorded as **2026-09-26**. Finishing a `want` with a past date set `started_at = today` and was **refused** (422). A finish before the start, `2026-02-30`, or a malformed date came back as the database's generic 422 ("A value is out of range" / "A date is out of range") with no field. Future dates were accepted.
- **Fix:** app: `localDate()` for the finish screen, finish/DNF/start defaults and progress `started_at`. Server: dates validated as real `YYYY-MM-DD` and not after **UTC today + 1 day** (someone's local today); `finished_at < started_at` is 422 `invalid_date` on `finished_at` on every path (a CHECK violation is mapped too); a finish with no start starts on the finish date. The server still defaults to its own `CURRENT_DATE` when the client sends nothing (it knows no time zone); the app now always sends one for finishes.
- **Tests:** `reading-lifecycle.test.ts` › "dates (PRD §8.5)" (4 tests); `readingRules.test.ts` › localDate. Seen failing before: **yes** for "finishing a want with a past date" (probe: 422); the others changed from a generic to a specific 422.

### A-08-011 · P2 · FIXED · `review` sent with a finish was accepted and dropped (A-07-006)
- **Evidence (probe):** `POST /reads/:id/finish {review: "Loved it."}` → 200, 0 reviews stored.
- **Fix:** refused: any non-null `review` is 422, documented in the contract and the client type (`review?: null`). The app never sends it (Part 07 queues `save_review` separately, through the verified-email gate); the stale `review` field was removed from `api.finishRead`.
- **Test:** "refuses a review sent with the finish instead of dropping it". Seen failing before: **yes**.

### A-08-012 · P2 · FIXED · The DNF note (PRD §6.18) was accepted and dropped
- **Fix:** migration **0027** adds `reads.dnf_note` (nullable, ≤ 280, `NOT VALID` check, no rewrite); stored by `/dnf`, returned on every read. Export (Part 12) should include it.
- **Test:** "stores the DNF note (§6.18) instead of dropping it".

### A-08-013 · P1 · FIXED · No way to delete a read; "Remove" in the want queue paused books (SL-57, §34.2)
- **Evidence:** no `DELETE /reads/:id` existed. `reading.tsx` › "Remove books" called `saveReadStatus(work, 'paused')`: the books moved to the paused section.
- **Fix:** `DELETE /v1/reads/:id` (owner only; someone else's, a deleted or a random id → the same 404) deletes, in one transaction, the read's activity and its review's activity, then the read (progress, review, likes and comments cascade); the triggers update `work_stats` and `reader_count`. App: `deleteRead` (local delete + queued `delete_read`; a 404 on replay is success; queue order means a read created offline is created, remapped, then deleted; a refresh before the delete syncs does not resurrect it). Bulk remove uses it. It is one queued request per book (offline-first; a bulk endpoint is not needed at this size).
- **Tests:** `reading-lifecycle.test.ts` › "deleting a read" (2); `reading-audit.test.ts` › "removing a want-to-read book deletes it, after the create it depends on", "a delete the server has already applied (404) is not a sync issue", "a refresh before the delete syncs does not bring the book back".
- **Not built:** the §34.2 confirmation that names what will be lost (review, progress history) for a *finished* read: there is no single-read delete in the UI yet (only the want-queue bulk remove, which already confirms). → device checklist / Part 10 diary.

### A-08-014 · P2 · FIXED · Logging an unknown work was a 422 `invalid_reference`
- Now 404 `not_found` (method: a valid-but-missing UUID is a 404). Test: "an id that names no work is a 404".

### A-08-015 · P2 · FIXED · The reads list scanned a popular work's editions per row
- **Evidence (flyleaf_dev, the 628-read bench user, warm):** cover and page-count subqueries per row sorted all of a popular work's editions: **2.3 s cold / 513 ms warm, 133k buffers**.
- **Fix:** cover = the chosen edition's, else `works.ol_cover_id` (denormalised for this; present for 99% of reads), else the old subquery (lazy `COALESCE`); page count = the chosen edition's (96% of reads name one), else the old fallback **unchanged**.
- **After:** **84 ms warm, 14.5k buffers** (6× / 9×). Test: "the list shows the chosen edition's cover and page count, else the work's cover".
- **DECISION NEEDED (D-08-3):** the fallback page count for a read with no edition is the **smallest** page count among all editions (an abridged 20-page edition wins). Recommendation: the most common page count, or the default edition's. Unchanged here.

### A-08-016 · P1 · FIXED · SL-41: the book page showed invented content
- **Evidence (`app/work/[id].tsx`, HEAD):** a hard-coded histogram (912/341/114/42/14) on every book; the Piranesi blurb as every book's description; "Earthsea Cycle · Book 1" linking to `/series/earthsea` on every book; fallbacks "Paperback", "245 pages", "2020", ISBN "9780571353408", "4 editions"; History tab "Attempt #1" always; a failed load (a 404 included) showed "Loading book…" for ever.
- **Fix:** `GET /works/:id` now returns `description`, `authors [{id, name}]`, `series`, `rating_distribution` (half a star counts in the bucket above, matching the stats screen) and `maturity`/`content_warning`, cached with the rest of the base. The screen shows only real values and hides what is missing; loading, not-found and error states (`useRemote`, `RemoteStatus`).
- **Cost (flyleaf_dev, hot work, cold):** the histogram reads 5,399 ratings through `reads_work_idx`, 595 buffers; cached 60 s with the base.
- **Tests:** `catalog-pages.test.ts` › "description, credited authors with ids, series and a real rating histogram", "a book with none of that says so…". **Request count on open (§43.1):** one request for the page (plus reviews when the Reviews tab shows, as before); the server side is 4 queries on a cache miss, 0 for a guest on a hit and 2 signed in.

### A-08-017 · P1 · FIXED · SL-43: author and series pages were invented
- **Evidence:** `api.author(name)` called **search with the author's name** (finds titles containing it, misses works under alias names), then invented a bio ("an acclaimed author whose books explore memory…"), a works count of 6 and two Piranesi/Jonathan Strange books. `api.series` returned The Locked Tomb / Earthsea for any id. Both screens also showed a hard-coded series card. No endpoint existed.
- **Fix:** `GET /v1/authors/:id` (works through `work_authors`, most logged first, 50 a page with `limit`/`offset`, merged/provisional excluded, explicit per the search rule (§7.8: discovery surface), viewer status and finished count) and `GET /v1/series/:id` (reading order, viewer status, `read_books`). Screens rewired with real states; "Up next" is the first unfinished entry (was always `entries[1]`); author links use ids (Discover resolves the id from the work on tap: search rows carry the name only).
- **Perf (flyleaf_dev, a 789-work author):** the first version let the planner walk the popularity index over 165k works probing `work_authors`: **2.3 s, 543k buffers**. With `ORDER BY log_count + 0` (as in SEARCH_SQL's typo arms) the author's works come from `work_authors_author_idx` and are sorted: **14.7 ms warm** (446 ms cold).
- **Tests:** `catalog-pages.test.ts` (5 tests). The routes did not exist before.
- **Data gap:** the catalog has **0 series** on both databases; nothing ingests Open Library series. Series links appear only when data exists. → FN (ingest) owner.

### A-08-018 · P1 · FIXED · SL-42: "the copy I own" was never saved
- **Evidence:** "Confirm" showed a tick and went back; nothing was written. Every edition was given an invented publisher (Bloomsbury / Faber / Tor) and year; a work with no editions showed three invented editions.
- **Fix:** the choice becomes the current attempt's `edition_id` through the offline queue (same status → edits the attempt; no read yet → want-to-read with that copy, **assumption, D-08-4**); guests are prompted to sign up. Editions carry real `publisher`/`publish_year` from `GET /works/:id`.
- **Test:** none (screen); the persistence path is `saveReadStatus`, covered by `reading-audit.test.ts`.

### A-08-019 · P2 · FIXED · Work-page writes skipped the queue, errors were swallowed, and changing status cleared the heart (A-07-019/020/024)
- **Fix:** status, rating and progress go through `OfflineRepository` with an optimistic update and a visible "Not saved" on failure. `saveReadStatus` no longer defaults `hearted` to false (the reading tab passed `false`, and `COALESCE(false, hearted)` un-hearted a paused book when it was started again).
- **Test:** `reading-audit.test.ts` › "changing status keeps the heart, locally and in what is sent". Seen failing before: **yes** (against HEAD's repository).
- **Not fixed:** the mute button always starts as "not muted" (no mute state on the work) → Part 13.

### A-08-020 · P2 · FIXED · SL-40: search race and recents (A-02-017)
- **Fix:** `latestOnly()` guard: only the latest request may set results (the effect used to cancel the timer, not the request). Recents: no invented seed list, persisted on the device (`recentsStore.ts`), recorded on submit or when a result is opened, not on every keystroke; unique ignoring case, capped at 10. Every viewer status now shows on a result (AC-7 "my status if any"; only finished/reading did).
- **Tests:** `searchState.test.ts` (4) › "a slow answer for an earlier query does not replace the later one", recents rules.

### A-08-021 · P2 · DEFERRED → Part 02/10 · SL-40 format filter is cosmetic
- Search results carry no `editions`, so `filteredResults` keeps every result for every format. Needs a format facet in SEARCH_SQL or the filter removed; not changed here (search SQL is Part 02's tuned query).

### A-08-022 · P2 · FIXED (partly) · SL-44 scanner
- **Fixed:** a missed code stayed in view and was **looked up on every camera frame** (`setScanned(false)` re-armed the camera): now ignored for 3 s. Every error said "No edition found": now 404 → not found, 422 → not an ISBN, anything else → connection. "Continue" on the explicit interstitial records the acknowledgement, so the book page does not ask again (one-time per work, §7.8).
- **Deferred:** an unknown ISBN has no live lookup / provisional record (§34.1 "ISBN mismatch") → gap-fill owner (FN-32 / Part 02). A permanently denied camera permission offers manual entry but no Settings link → device checklist.

### A-08-023 · P2 · FIXED · Flaky `readingVelocity.test.ts`, and the bug under it (A-02-021)
- **Evidence:** the events test built two timestamps from two `Date.now()` calls; 2 days + a few ms → `ceil(2.000001) = 3`. The same happens for real users. The page-case assertion had been loosened to `in (4|5) days`.
- **Fix:** `predictFinishDate(input, now)` takes the clock; the page path rounds before `ceil` like the percent path. Tests pin a fixed clock; the page case is strict again (`in 4 days`); new tests for a span a few ms over whole days and for dating a long prediction from the given clock.
- **Test:** seen failing before: **yes** (3 of 7 against HEAD).

### A-08-024 · P2 · FIXED · `minutes` on a progress event had no upper bound
- Now ≤ 1,440 (one day), in zod and the contract. Test: "minutes are optional and at most one day".

### A-08-025 · P2 · DEFERRED → Part 15 (search) · Search plan flips with ANALYZE sampling
- **Evidence (flyleaf):** three consecutive `ANALYZE works` gave the `title ILIKE '%pir%'` arm row estimates of **317, 32,233 and 96,718** (true 23,152); above a few thousand the planner walks the popularity index with a filter. `pir` measured 11.0 s → 16.5 s across this part's ANALYZE. Not caused by 0026 (the old btree allowed the same walk). Options: `log_count + 0` in `title_like` (loses the fast walk for common short queries), or a higher statistics target on `works.title`. Re-judge on production hardware.

### A-08-026 · P2 · FIXED · `maturity` on direct links and a one-time interstitial (rest of A-02-019)
- `GET /works/:id` returns `maturity` and `content_warning` (the scan's rule; the viewer's opt-in is only queried for explicit works). The book page shows the interstitial once per work (remembered on the device); a scan's acknowledgement counts.

### A-08-027 · P3 · DEFERRED → Part 10 · L-09: `GET /users/:id/reads` is unpaginated
- Returns every read (628 for one bench user). It answers `200 []` for a random, private or blocked user alike (no leak between those), while `GET /users/:id` is 404. Part 10 owns profiles and the diary.

### A-08-028 · P3 · Recorded
- History tab shows only the latest attempt (now labelled so): a per-work attempts list is not served. `+10` at the page count writes a no-change event where §34.2 wants "Did you finish?". The slider saves once per drag (pan `onEnd` / tap) by code reading; it has never been tested on a device before 26 Sep. `want` activity "low, aggregated" (§8.2) → Part 14. `log_count` is labelled "readers" on the author page but includes OL shelvings.

### A-08-029 · RL · DEFERRED → Part 15 · No rate limits on the reading and catalog routes
- PRD §24.4: none of `POST /reads`, `POST /reads/:id/{progress,finish,dnf}`, `DELETE /reads/:id`, `GET /works/:id`, `GET /authors/:id`, `GET /series/:id` has a limit. The new author and series reads are guest-readable and cost an index lookup and a sort per request.

## Performance

All on **flyleaf_dev** unless marked. Latencies are **indicative only (8 GB dev machine)**; the block counts and ratios are the evidence.

| Endpoint / query | Before | After | Plan notes |
|---|---|---|---|
| `recompute_work_stats_for_work` hot work (5,399 reads) | 64 ms, 2 × Seq Scan (2,626 buf) | 9.4 ms, 575 buf | `Bitmap Index Scan on reads_work_idx` |
| same, 3-read work | 22 ms, 1,313 buf | 0.8 ms, 6 buf | cost follows the work, not the table |
| all 12,576 works | 245 s | 2.5 s | 97× |
| `rate:post` (finish with a changing rating on the hot work, 10 connections) | p50 241 / p95 763 / p99 988 ms, 30 rps | p50 34 / p95 91 / p99 129 ms, 238 rps | q = 6 both; see caveat |
| `progress:post` | p50 51 / p95 74 / p99 101 | p50 21 / p95 27 / p99 33 | trigger not on this path; q 5 → 5 |
| merge + undo, 466 reads | 20.4 s + 20.6 s | 0.58 s + 1.27 s | statement triggers |
| reads list, 628-read user | 513 ms warm, 133k buf | 84 ms warm, 14.5k buf | edition scans skipped |
| `GET /authors/:id`, 789 works | (new) 2.3 s, 543k buf | 14.7 ms warm | `log_count + 0` |
| full-catalog migrate 0026 + ONLINE_SQL (**flyleaf**) | — | 44 s | two concurrent index builds |
| search `th` (**flyleaf**) | 2.0 s | 0.76 s | expression index matched in 3 arms |
| search `pir` (**flyleaf**) | 11.0 s | 16.5 s | A-08-025 (ANALYZE sampling), not 0026 |

**Caveat on the API bench (`docs/audit/perf/08-before.md`, `08-after-l01.md`):** the control scenarios that never touch the trigger (`reads:mine:reading`, `work:signed-in`) were also ~2× faster in the after run, so part of every gain there is run-to-run environment; `rate:post` improved 7× against ~2× for the controls. The hardware-independent evidence is the buffer counts above. The bench's `heavy` persona has 7 reads and none `reading`, so `reads:mine:reading` measured an empty list; the reads-list row above uses the heaviest bench user directly.

## Behaviour changes

- `works.log_count` = OL baseline + distinct Flyleaf readers (was baseline + one per new attempt from the app). On the two local databases 12,576 works gained their bench readers. `works.ol_log_count` and `works.reader_count` are new.
- A terminal attempt moved to a different status is a new attempt (`dnf → finished`, `finished → dnf`, `finished|dnf → paused`), on the server and offline. `/finish` on a DNF read or on a finished read with a different date creates a new attempt; `/dnf` on a finished read creates one.
- No activity for rating/heart/date edits, repeated finishes or `want`.
- Visibility changes propagate to existing activity from every path.
- `POST /reads` for a work that does not exist: 404 (was 422 `invalid_reference`). Dates: 422 `invalid_date` / `invalid_field` naming the field; dates after UTC tomorrow refused.
- `POST /reads/:id/finish` refuses a non-null `review` (422). `minutes` > 1,440 refused.
- New: `DELETE /v1/reads/:id`, `GET /v1/authors/:id`, `GET /v1/series/:id`; `reads.dnf_note`; on `GET /works/:id`: `merged_into`, `maturity`, `content_warning`, `description`, `authors`, `series`, `rating_distribution`, editions' `publisher`/`publish_year`.
- Every id that names a merged work acts on the survivor (reads and writes); favourites refuse unknown ids.
- The weighted rating's C is cached (≤ 1 day old) and no longer excludes the work itself.
- Mobile: local dates; want-queue "Remove" deletes; status changes keep the heart; recents start empty and persist; the book, author, series and edition screens show only real data.
- **Inherited assertions changed with the spec:** `hooks-hardening.test.ts` unknown work 422 `invalid_reference` → 404 `not_found` (the FK mapping is still pinned, via `edition_id`); `dob-confirmation.test.ts` finds 0025 by name instead of assuming it is the last migration; `dedupe.test.ts` "the survivor gains the loser's log count" (107 → baseline 107 + 2 readers, now asserted separately); `readingVelocity.test.ts` page case `in (4|5) days` → `in 4 days` (strengthened); `relevance.test.ts` / other fixtures write `ol_log_count` (a virtual column cannot be inserted).

## Decisions (answered by the owner, 2026-09-27)

- **D-08-1 · `/finish` on an already finished read: accepted as implemented.** Same or no `finished_at` → an edit; a different date → a re-read (new attempt).
- **D-08-2 · `finished → dnf` / `→ paused`: accepted as implemented** (a new attempt; nothing is lost).
- **D-08-3 · Fallback page count: change it, in Part 10.** The default edition's page count, else the median of the editions' page counts ignoring values under 20, in one function for progress, stats and Year in Review. Recorded in `docs/audit/10-profile-stats-telemetry.md` ("Decided in Part 08: D-08-3"). Unchanged here.
- **D-08-4 · "The copy I own" for a book not in the library adds it to Want to read: accepted, with a toast.** Done: the edition picker says "Added <title> to Want to read" and stays 1.8 s before going back (it did not say anything before).
- **D-08-5 · One Flyleaf reader = one OL shelving in ranking: accepted.**

## Deferred (with reason and owner part)

| Item | Owner | Reason |
|---|---|---|
| A-08-021 format filter cosmetic | Part 02 / 10 | needs a facet in search SQL |
| A-08-022 unknown ISBN live lookup; Settings link | gap-fill owner / device checklist | provider work |
| A-08-025 search plan flip on ANALYZE | Part 15 | search tuning |
| A-08-027 L-09 unpaginated `/users/:id/reads` | Part 10 | profile/diary |
| A-08-029 RL on reading and catalog routes | Part 15 | one limiter layer |
| `want` activity, aggregated | Part 14 | new verb + feed |
| Mute state on the book page | Part 13 | no mute state served |
| Series ingest (0 series in the catalog) | ingest (FN) | data |
| Per-work attempt history; §34.2 delete confirmation for a finished read | Part 10 | diary screen |
| Export includes `dnf_note` | Part 12 | export format |
| LA-05: use `ONLINE_SQL` for 0019's index | LA-05 | deploy |
| D-08-3 fallback page count (default edition, else median ≥ 20) | Part 10 | decided; recorded in the Part 10 prompt |
| Home feed swipe "Saved to Want to Read" shows a toast and writes nothing (`app/(tabs)/index.tsx` `handleWantToRead`) | Part 14 | feed cards; found in passing |
| `pg-boss` teardown errors in the API test log | Part 15 | noise, every queue |

## Tools added

- `src/bench/merge-cost.ts`: merge + undo timing, rolled back. `src/bench/attempt-race.ts`: concurrent starts (throwaway database only). `src/bench/relevance-panel.ts`: the FN-43 panel on a real database (panel code moved unchanged to `src/test/relevance-panel.ts`). `run.ts`: `rate:post` scenario.

## Owner actions

- **Done by the owner (2026-09-27).** Bench cleanup on flyleaf_dev (my attempt was refused by the permission classifier): the `rate:post` runs left 5,170 `finished` activity rows on one bench read and set its rating. To restore:
  ```sql
  DELETE FROM activity WHERE object_id = '4eeb120d-129a-4bf9-ad9b-44dfdca75fc0' AND created_at >= '2026-09-26 13:00+00';
  UPDATE reads SET rating = NULL, updated_at = '2026-01-17 21:57:23.351+00' WHERE id = '4eeb120d-129a-4bf9-ad9b-44dfdca75fc0';
  ```
  (All bench data also goes with `npm run bench:seed -- --clean`.)

## Device checklist additions

- Slider: one save per drag, including a tap on the track (never tested on a device before 26 Sep).
- Book page: a book with no description / no ratings / no series shows none; histogram matches `rating_count`; "Try again" after airplane mode; a merged book's old link opens the survivor.
- Explicit book by link: interstitial once; after a scan's "Continue", no second prompt.
- Finish at 00:30 local time: the finish date is today, not yesterday.
- Want queue: bulk "Remove" removes (offline too) and the books do not come back on refresh.
- Scanner: hold an unknown barcode in view for 10 s: one lookup, one message; airplane mode says "connection".
- Author page from a book and from a Discover result; "Show more" on a prolific author.
- Edition picker: "the copy I own" changes the cover in the reading tab after sync.
