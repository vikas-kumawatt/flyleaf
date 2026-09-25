# Audit Part 08 — Catalog screens and the reading core (SL-40 … SL-44, SL-50 … SL-57)

**Read `docs/audit/00-method.md` first.**

Spec: PRD §6.15–6.19, §6.21–6.24, §6.29–6.32, §7.2–7.4 (the work/edition model, **[LOCKED]**), §8 (all; §8.2 status model **[LOCKED]**, §8.3 progress, §8.4 sessions, §8.5 dates), §9.3 (rating optional, **[LOCKED]**), §4.3–4.4, §34.2 reading-record edge cases, §43.1 per-screen performance budgets. Architecture §3.4.

Code: `apps/api/src/reading/index.ts` (the spine), `catalog/index.ts` (work/edition/author/series endpoints), `activity/index.ts` (activity written on reading actions), migrations `0006`, `0010`, `0011`; mobile `app/(tabs)/{reading,discover}.tsx`, `app/work/[id].tsx`, `app/finish/*`, `app/dnf/*`, `app/log.tsx`, `app/scanner.tsx`, `app/author/*`, `app/series/*`, and `src/lib/readingVelocity.ts`. Tests: `reading.test.ts`, `phase1-exit-criteria.test.ts`, and the mobile `__tests__`.

## Moved here from Part 09: L-01 (fix it first)

Part 01 measured it: **every insert, delete or status/rating change on `reads` runs two full scans of the table** (~10–49 ms per write at 62k reads). The main one is the `work_stats` trigger's catalog mean (`recompute_work_stats_for_work()`: `AVG(rating) FROM reads WHERE work_id <> x`). It's on the write path of every action this part audits (start, progress-driven status changes, finish, DNF, rating), so every write measurement in this part includes it until it's fixed. Fix it **here**:
- Replace the per-write scan with a cached catalog mean (a one-row table refreshed by a scheduled job, or a running sum/count maintained incrementally). Record the drift tolerance. Find and remove the second scan too (`EXPLAIN (ANALYZE, BUFFERS)` the trigger's statements).
- Prove equivalence: `work_stats` values before and after the change match on the bench data within the stated tolerance.
- Measure `progress:post` and a finish/rating write, before and after, on `flyleaf_dev`.

### Decided in Part 02 (A-02-013): what `works.log_count` counts. Implement it together with L-01

Today `log_count` mixes Open Library's reading-log baseline (set by the `--popularity` ingest pass) with Flyleaf's own logs (incremented in `ReadingService` on read insert), so it can't be reconciled from `reads`. Imports, deletes and dedupe merges also never adjust it. **Decision (made by the user):**
- Keep the OL baseline in its own column (e.g. `ol_log_count`, backfilled from today's values minus what Flyleaf added, or from the popularity pass), and count Flyleaf readers separately as **distinct users with a read of the work** (e.g. `reader_count`). The latter is maintained by trigger in the same rewrite as L-01 and repaired by a nightly reconcile job (the `reads.reconcile` pattern from SO-20, scheduled in `worker.ts`).
- Ranking uses a documented combination of the two. Keep `log_count` as that combination (a generated column, or maintained by the trigger) so search SQL and the relevance corpus don't have to change shape.
- Re-reads, imports, deletes and dedupe merges must each have a defined effect, with a test for each.
- **The relevance panel (FN-43) must stay ≥ 0.98 with its position rules unchanged.** Run it before and after. Search is on the full catalog, so verify on `flyleaf` as well as `flyleaf_dev`.

### Also routed here from Part 02: the flaky `readingVelocity.test.ts` (SL-52)

It failed CI run 1 during Part 02 for timing reasons (it depends on the wall clock). Fix it first in this part, so CI is reliable for everything after: inject the clock or freeze time, and never weaken what it asserts.

Part 09 keeps the rest of SL-62 (the duplicate TS recompute, §9.7 manipulation rules) and will build on your fix.

## Routed from Part 03 (dedupe)

Findings: `docs/audit/findings/03-dedupe.md` (A-03-008, A-03-016, Part 03b).

### D3 (decided by the user): a merged work id keeps working, for reads AND writes

A dedupe merge tombstones the loser (`works.merged_into_id = survivor`; chains are flattened, so it is always one hop). Today `CatalogService.getWork` filters `merged_into_id IS NULL` (`catalog/index.ts`), so an old link or an already-shared card gives 404, and `ReadingService.upsert` (`reading/index.ts`) and shelf adds accept the merged id and write onto the tombstone, where the read is hidden from the survivor's page and stats (A-03-008). PRD §40.3 and §34.1: "the old ID redirects permanently".

- **Reads of a merged id return the survivor:** `200` with the survivor's body (its own `id`) and a `merged_into` field naming the survivor, on `GET /v1/works/:id`, and the equivalent resolution on every other read that takes a work id (`GET /v1/works/:id/reviews`; take the list from `docs/audit/route-inventory.md`). Not a 308, not a 404. Mobile already navigates by the returned id.
- **Writes to a merged id are applied to the survivor server-side, never 404:** creating or updating a read, logging progress, shelving (`POST`/`PATCH`/`DELETE` on shelf items), favourites, mutes (`/v1/works/:id/mute` and `/v1/mutes/works/:workId`), and reviews via reads. Resolve `COALESCE(merged_into_id, id)` once at the service boundary. The point is that an **offline replay survives a merge**: a client that queued "finished, 4★" against the loser id while offline must land on the survivor when it syncs. Coordinate with Part 07 (the offline queue and `client_event_id`).
- Tests: a read, a progress event, a shelf add and a favourite, each sent to a merged id → stored on the survivor; `GET` of a merged id → 200 with `merged_into`; a write racing a merge (lock order: the merge locks `works` rows `FOR UPDATE`); undo afterwards still refuses with 409 `loser_modified` only if something did land on the loser.
- Once writes resolve to the survivor, `undoMerge`'s 409 `loser_modified` guard (A-03-003) should stop firing in practice; keep it as the safety net.

### The merge scans `reads` twice per moved read, through the ratings trigger (A-03-016, with L-01)

`reads_work_stats_trigger` calls `recompute_work_stats_for_work` for NEW and OLD on every row a merge moves, and that function runs the full-table `AVG(rating) FROM reads WHERE work_id <> x` scan that L-01 removes. Merging a work with N reads is therefore 2N full scans of `reads`. It is the same scan as L-01, so **fixing L-01 fixes this**. After the fix, measure a merge of a work with many reads on `flyleaf_dev` (for example a bench work with 500 reads, merged and then undone with `undoMerge`, in a transaction you roll back) and record the before/after. Also consider whether the merge should recompute `work_stats` once per work at the end, set-based, instead of per row.

## Server: SL-50 … SL-57

- **Status transitions** (PRD §8.2 [LOCKED]): build the full want/reading/paused/finished/dnf × target matrix and test every cell against the spec. Starting a finished or DNF book creates a **new attempt** (claimed). Test the other transitions: finished → want, dnf → finished directly, reading → want.
- **Attempt races (SL-56)**: two concurrent "start" requests for a finished book both compute `attempt_no + 1` → unique violation → 500? Test it with concurrent requests and fix it (retry, or `SELECT … FOR UPDATE`).
- **Dates (§8.5)**: `finished_at` in the future, before `started_at` (a DB check exists, so the API must return 422, not 500), timezone of "today" (server UTC vs user local; a finish logged at 00:30 IST must land on the user's date), partial dates if the spec allows them, imported reads without dates.
- **Progress (SL-51, SL-53)**: page > `page_count` (which edition's page count?), negative, percent > 100, audio seconds for non-audio editions, going backwards (allowed? spec?), progress on a finished/DNF/want read (allowed?), progress on someone else's read → 404, the `client_event_id` behaviour (see Part 07 lead 3, coordinate, don't duplicate), note ≤ 280, optional minutes ≥ 0 and upper bound. **Append-only** (§8.3): grep for any UPDATE/DELETE on `progress_events` outside cascades.
- **Finish flow (SL-54)**: finish + rating + heart + review + format + visibility. Is it **one atomic operation** server-side, or several requests the client chains? What if the review request fails after the finish succeeded? Double-tap Finish: one activity row or two? Re-finishing an already-finished read: is `finished_at` overwritten and is duplicate activity written?
- **DNF (SL-55)**: `abandoned_page` pre-fill, reason chips, `abandoned_at`, neutral copy, DNF → re-start creates a new attempt.
- **Visibility changes after the fact**: switching a read to private must update its activity row (SO-10 has `updateActivityVisibility`; check the reading path calls it) and hide likes/comments from others (SO-21 resolves via `canView`, so verify end to end).
- **`works.log_count`** increments on read insert (see Part 02). Check it's in the same transaction and not double-counted on re-reads, if the spec says a re-read doesn't count again.
- **SL-57 want-to-read queue**: sort, filter and bulk operations. Is bulk one request or N? Partial failure?
- Deleting a read (is there an endpoint?) cascades progress, likes, comments and activity, and updates `work_stats` and `log_count`.

## Mobile: SL-40 … SL-44, SL-52, SL-53

- **SL-40 search screen**: 250 ms debounce, **stale-response race** (a slow response for "ha" arriving after "harry" must not overwrite it; look for AbortController or a request sequence id), recents persisted and capped, filters actually sent to the API (or the tabs are cosmetic?).
- **SL-41 book detail**: count the requests on open. A waterfall of dependent requests on the most-visited screen is a perf finding against §43.1. Measure the API side with the bench. Histogram data: where does the rating distribution come from? Is it real (`work_stats`) or computed client-side from a page of reviews?
- **SL-43 author page**: `apps/mobile/src/lib/api.ts` implements `author(nameOrId)` by **calling search with the name** ("Queries search for books by this author"). That's not an author page: it finds books whose titles match the name, and misses works under alias names. Check whether an author endpoint exists server-side. If not, the task claim is ❌. Record the fix plan, or implement a proper `GET /v1/authors/:id` (works by author, ordered by popularity, using `work_authors`) if that's under half a day. Same review for the series page and "your progress" in it.
- **SL-42 edition picker**: cover-forward, "the copy I own" persisted where?
- **SL-44 scanner**: permission denied → manual entry, unknown ISBN → graceful path (gap-fill?), and repeated scans debounced.
- **SL-52 reading tab**: slider auto-save throttling (one request per drag, not per pixel), +10 button at `page_count`, predicted finish correctness with sparse data (`readingVelocity.ts` tests), reading-tab load cost.

## Performance

Bench scenarios: `GET /v1/reads?status=reading` for a heavy reader (hundreds of reads), `GET /v1/users/:id/reads`, `POST /v1/reads/:id/progress`, `GET /v1/works/:id`. `EXPLAIN` the reads list (is `reads_user_status_idx` used? How is "latest progress per read" computed: `DISTINCT ON`, `LATERAL`, or N+1?).

## Deliverables

`docs/audit/findings/08-catalog-reading.md`, the status-transition matrix test, fixes, the manual device checklist additions, and audit lines under each task.
