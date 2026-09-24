# Audit Part 03 — Dedupe (FN-50, FN-51, FN-52)

**Read `docs/audit/00-method.md` first.**

Spec: PRD §40.3 (ingest and dedupe), §7.1–7.7 (work/edition model, provisional records), §34.1 catalog edge cases, §27.5 admin console. Architecture §3.1, §5, §9 (jobs), §13.

Code: `apps/api/src/catalog/dedupe.ts`, `src/dedupe.ts` (CLI), `admin/dedupe.ts`, migrations `0004_work_merges.sql` and `0008_dedupe_queue.sql`, `jobs/index.ts` (`catalog.dedupe`), `worker.ts`, and `src/test/dedupe.test.ts`.

## The big lead: merges only repoint tables that existed when the code was written

Dedupe was written in Phase 0. **Confirmed:** `catalog/dedupe.ts` never mentions any of the tables added since. List every table and column that references `works.id` or `editions.id` **today** (query `information_schema` / `pg_constraint` on the real DB, don't guess) and check that merge **and undo** handle each one:

| Must check | Collision to handle |
|---|---|
| `reads` | `UNIQUE (user_id, work_id, attempt_no)` → attempts renumbered (claimed) |
| `reviews` (`work_id` is denormalised from the read) | Moving the read must also update `reviews.work_id` |
| `shelf_items` (PK `shelf_id, work_id`) | A user shelved **both** duplicates on the same shelf. Also `position` gaps, and `shelves.cover_work_ids` mosaics that hold the loser's id |
| `activity.work_id` | Feed cards pointing at a dead work |
| `mutes` (`target_type='work'`) | A muted duplicate must stay muted after the merge (PK collision if both were muted) |
| `profiles` favourites (whatever column/table SL-73 uses) | Duplicate favourite slot |
| `import_rows.work_id` | |
| `work_stats` | Recomputed for the survivor (claimed) |
| `external_ids`, `field_provenance`, `work_authors`, `work_subjects`, `series_entries`, `editions` | Claimed handled; verify |
| `read_likes` / `read_comments` | They hang off reads, so they move with the read. Verify the counters survive |
| `works.log_count` | Survivor should gain the loser's count |

For each table that isn't handled, write a failing test (merge two works that both carry data in that table) and then fix merge **and** undo. Undo must restore the exact prior state. `work_merges.moved` jsonb has to record whatever you need to reverse.

## FN-50 — stages 1–2

- Stage 1 (ISBN-13) and stage 2 (normalised title + shared author). Test near-misses that must **not** merge: translations with the same title, different works by the same author with the same normalised title ("Collected Poems"), omnibus vs volume (PRD §7.6), a series volume vs the series.
- The TypeScript and SQL normalisation must agree. There's a 15-title parity test; extend it with unicode, punctuation, articles (`The`, `A`, `Le`, `Der`), and numerals.
- **Merge chains** are flattened, and resolving an old id is one hop.
- **Concurrency.** Two merges touching the same work at once (the admin UI and the monthly job). Is there a lock (advisory lock or `SELECT … FOR UPDATE`)? Two admins undoing at once?
- **Atomicity.** Is each merge a single transaction? Kill it mid-way (throw after half the repoints) and check the DB is unchanged.

## FN-51 — stage 3–4 queue, 30-day undo, admin review UI

- Stage 3 thresholds (title trigram > 0.85, author > 0.9, year ±2) come from the claim. Check the SQL actually applies all three, and that it never auto-merges.
- **Undo** after 30 days is refused; exactly at the boundary is covered by a test; undoing twice is refused; undoing a merge whose survivor has since been merged again (a chain) works or is refused cleanly, and never corrupts.
- Reports (stage 4) from users: validation, and a duplicate report of the same pair.
- Admin UI and endpoints: role gating (moderator can review but not merge or undo), audit log entry on every action including dismissals, and XSS-safe rendering of titles and authors. `escapeHtml` exists; check every interpolation uses it, including attribute contexts and JSON embedded in `<script>`.

## FN-52 — monthly job

- `catalog.dedupe` is scheduled (`0 0 1 * *`) and registered. Is it **resumable/idempotent** if the worker dies mid-run? Is `limit` honoured?
- Runtime on the real 3.2M-work catalog: run stage 1–2 detection with `--dry-run` and time it, and `EXPLAIN` the candidate queries. If it's long, record it (it's monthly, so minutes are fine; hours holding locks are not).
- Does `--dry-run` write **nothing** (including the queue and the audit log)? Prove it with a row-count diff.

## Deliverables

`docs/audit/findings/03-dedupe.md` and a **table-coverage matrix** (every table referencing `works`/`editions` × merge handled × undo handled × tested). Plus fixes, tests, and audit lines under FN-50…52.
