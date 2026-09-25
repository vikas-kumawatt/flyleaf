# Audit 03 — Dedupe (FN-50, FN-51, FN-52)

2026-09-25 · CI **green** (429 s) · tests **840 API + 100 mobile → 870 API + 100 mobile** (+29 `dedupe.test.ts`, +1 `jobs.test.ts`; no test weakened or removed)

Databases: the table inventory was read from **both** `flyleaf` (full catalog, 3.2M works) and `flyleaf_dev`; they have identical references. Detection plans, pair counts and dry-run timings are from the **full catalog** `flyleaf`. PGlite was used only for correctness tests. Machine: 8 GB, so **timings are indicative only**. No merge was ever run on either real database (`work_merges` = 0, `dedupe_queue` = 0 on both), so none of the defects below has corrupted existing data yet.

`secure-design` was not triggered: this run was autonomous by instruction. The security-relevant items (report endpoint auth, admin role gating, XSS in the review page) are covered as findings and tests below.

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| FN-50 | Stage 1–2 auto-merge; seven repoints with collision handling; chains flattened; atomic; TS/SQL normalisation agree | ❌ broken: merge skipped 7 of the tables that reference a work today; no lock or liveness check; stage 1 is live (not inert) and both stages auto-merge thousands of distinct books on the real catalog; normalisation drifts on the real locale | A-03-001, A-03-003, A-03-004, A-03-005, A-03-014, A-03-015, A-03-018, A-03-020 |
| FN-51 | Stage 3–4 queue; 30-day exact undo; admin review UI with role gating | ⚠️ partial: undo was not exact and not race-safe; stage 3 used raw titles and cannot run on the full catalog; guests could file reports; role gating, audit log and HTML escaping verified correct | A-03-002, A-03-003, A-03-006, A-03-007, A-03-009, A-03-013, A-03-017 |
| FN-52 | Monthly `catalog.dedupe` job registered and scheduled | ⚠️ partial: scheduled and registered correctly; `--dry-run` writes nothing (proved on the full catalog); but the 15-min pg-boss expiry is shorter than a full pass, and stage 3 ran before the merges | A-03-011, A-03-012 |

## Table-coverage matrix

Every column that holds a work or edition id **today**. FK rows come from `pg_constraint` (`confrelid IN ('works','editions')`) on both databases (17 constraints). Non-FK rows come from an `information_schema.columns` scan for `work|edition|entity|target` columns, `uuid[]` columns and jsonb. "Before" is HEAD `592f47b`.

| Table.column | Kind | Merge before | Merge now | Undo before | Undo now | Tested by (`dedupe.test.ts`) |
|---|---|---|---|---|---|---|
| `reads.work_id` | FK | ✅ renumbered | ✅ | ✅ (per-row loop) | ✅ set-based, attempt numbers restored | *repoints reads and RENUMBERS…*, snapshot |
| `reads.edition_id` → editions | FK | n/a (edition ids never change) | n/a | n/a | n/a | snapshot (via `editions`) |
| `read_likes`, `read_comments` (via `read_id`) | FK to reads | ✅ untouched, counters intact | ✅ | ✅ | ✅ | *likes and comments stay on their read* |
| `reviews.work_id` | FK, denormalised | ❌ stayed on loser | ✅ follows its read | ❌ | ✅ | *reviews follow their read*, snapshot |
| `shelf_items.work_id` | FK, PK `(shelf_id, work_id)` | ❌ | ✅ repoint; on collision the survivor's item is kept, the loser's recorded and dropped | ❌ | ✅ repointed back; dropped item re-created (if the shelf still exists) | *shelf items repoint…*, snapshot |
| `shelves.cover_work_ids`, `item_count` | derived by `shelf_items` trigger | ❌ mosaic kept loser id | ✅ via trigger | ❌ | ✅ via trigger | same, snapshot |
| `activity.work_id` | FK | ❌ | ✅ | ❌ | ✅ | *feed activity points at the survivor*, snapshot |
| `mutes.target_id` (`target_type='work'`) | polymorphic, no FK; PK `(user, type, target)` | ❌ muted loser stopped working | ✅ repoint; muted both → one row | ❌ | ✅ | *a muted duplicate stays muted…*, snapshot |
| `profiles.favourite_work_ids` | `uuid[]`, no FK | ❌ rendered the tombstone | ✅ swapped in place; duplicate slot collapsed (first slot wins) | ❌ | ✅ restored **only if** the list is unchanged since the merge | *favourites swap…*, snapshot |
| `import_rows.work_id` | FK | ❌ | ✅ | ❌ | ✅ | *import rows point at the survivor*, snapshot |
| `import_rows.edition_id` | FK | n/a | n/a | n/a | n/a | — |
| `editions.work_id` | FK | ✅ | ✅ | ✅ (per-row loop) | ✅ set-based | *repoints editions…*, snapshot |
| `work_authors` | FK, PK collision | ✅ | ✅ records rows the survivor **gained** | ⚠️ survivor kept the gained rows | ✅ gained rows removed | snapshot |
| `work_subjects` | FK, PK collision | ✅ | ✅ same | ⚠️ same | ✅ | snapshot |
| `series_entries` | FK, PK collision | ✅ | ✅ same | ⚠️ same | ✅ | snapshot |
| `work_stats` | FK | ✅ loser row dropped; survivor recomputed by the `reads` trigger | ✅ | ⚠️ loser recomputed only if it had reads | ✅ both recomputed | *work_stats is recomputed…*, snapshot |
| `works.log_count` | counter | ❌ survivor did not gain loser's count | ✅ `+= loser.log_count` | ❌ | ✅ subtracted | *the survivor gains the loser's log count*, snapshot |
| `works.merged_into_id` (chains) | FK self | ✅ flattened | ✅ | ⚠️ out-of-order undo corrupted a chain | ✅ newest-first enforced (409) | *flattens a merge chain*, *a chain undoes newest-first* |
| `works.default_edition_id` | no FK | loser's value left on the tombstone | unchanged | n/a | restores naturally (edition ids unchanged) | snapshot (`works`) |
| `external_ids.entity_id` | polymorphic, no FK; PK `(provider, external_id, entity_type)` | ✅ moved (the "collision" branch was dead code: the PK makes it impossible) | ✅ moved, keys recorded | ❌ never moved back | ✅ | snapshot |
| `field_provenance.entity_id` | polymorphic, no FK | ⚠️ moved or **deleted unrecorded** | **not moved** (A-03-015) | ❌ deleted rows lost | n/a | *the loser keeps its own field provenance*, snapshot |
| `dedupe_queue.survivor_id/loser_id` | FK | not repointed; resolving a stale pair merged into a tombstone | not repointed; stale pair → 409 `work_merged` | pair reset to pending | unchanged | *refuses to merge into a work that has itself been merged away* |
| `work_merges.survivor_id/loser_id` | FK | the log itself | — | — | — | — |
| `events.properties`, `admin_audit_log.subject_id` | jsonb / uuid, no FK | history: deliberately not repointed | same | — | — | — |

The oracle for "undo restores the exact prior state" is `snapshot()` in `dedupe.test.ts`: it reads all 18 referencing tables. *undo restores the exact prior state of every referencing table* merges and undoes a pair that has data **and** a collision in every one of them (`richPair`), then compares table by table.

## Findings

### A-03-001 · P0 · FIXED · Merge skipped seven of the tables that reference a work today
- **Where:** `apps/api/src/catalog/dedupe.ts` `mergeWorks` (HEAD: "SEVEN tables reference `works.id`").
- **Evidence:** 17 FK constraints plus 5 non-FK references exist today (matrix above). HEAD never touched `reviews`, `shelf_items`, `activity`, `mutes`, `profiles.favourite_work_ids`, `import_rows` or `works.log_count`. After a merge: the loser's reviews kept `work_id = loser` while their reads moved (so `reviews.work_id ≠ reads.work_id`, and the review vanished from the survivor's page); shelves and the cover mosaic pointed at a tombstone; a muted loser stopped being muted; favourites rendered the tombstone; the survivor's `log_count` ignored the loser's logs.
- **Spec:** PRD §40.3 and §34.1 ("every `reads`, `reviews` and `shelf_items` row repoints").
- **Fix:** every reference is repointed in the same transaction, with collision rules for `shelf_items` (survivor's item kept) and `mutes` (one row), and in-place de-duplication for favourites. Everything moved or dropped is recorded in `work_merges.moved`.
- **Test:** 9 tests under *merge coverage: every table that references a work (Audit 03)*. Seen failing before the fix: **yes** for reviews, shelves, activity, mutes, favourites, import rows and log count. *work_stats is recomputed* and *likes and comments stay on their read* passed before the fix: those claims were already true and the tests now guard them.

### A-03-002 · P0 · FIXED · Undo did not restore the prior state
- **Where:** `undoMerge`.
- **Evidence:** besides the tables of A-03-001, undo re-inserted the loser's authors, subjects and series but never removed the rows the merge had **added** to the survivor (a translator credited to the survivor stayed there for good). The loser's OL key in `external_ids` was never moved back, and `field_provenance` rows deleted by the merge were not recorded, so they were lost.
- **Fix:** the merge records exactly what the survivor gained (`INSERT … ON CONFLICT DO NOTHING RETURNING`), which keys moved, and which rows it dropped. Undo reverses each one set-based: one statement per table instead of one per row, since the old per-row loops were N round trips for a popular work. It also recomputes `work_stats` for both works.
- **Test:** *undo restores the exact prior state of every referencing table* (snapshot equality over 18 tables). Seen failing before the fix: **yes** (first diff: `work_authors`).
- **Follow-up, found in self-review:** dropped shelf items and mutes recorded their timestamps through a JS `Date`, so undo restored `…05.654` for `…05.654321`. PGlite's `now()` has only millisecond resolution, which hid it. The fixture now sets microsecond timestamps, the snapshot compares them as text (seen failing: yes), and the merge records them as text.

### A-03-003 · P1 · FIXED · No locking; merge into a tombstone; racing undo and resolve
- **Evidence (each seen before the fix):**
  - `mergeWorks(survivor = an already-merged work)` succeeded and moved reads onto the tombstone.
  - Two concurrent `undoMerge` of one merge both succeeded: the 30-day and `undone_at` checks ran before, and outside, the transaction.
  - Two concurrent resolves of one queue item: the second died with a raw `23505` (a 500).
  - Undoing B→A after A→C succeeded, leaving B live while its reads sat on C. A later undo of A→C then re-chained B onto A.
  - Undo after a read was logged onto the tombstone hit `reads_user_work_attempt` (a 500).
- **Spec:** 00-method "Concurrency", 03-dedupe "two merges touching the same work at once… two admins undoing at once… a chain works or is refused cleanly".
- **Fix:** `mergeWorks` locks both works (`FOR UPDATE`, id order, so there's no deadlock) and returns 409 `work_merged` if either is merged. `undoMerge` locks the merge row and both works, and checks everything inside the transaction. It returns 409 `survivor_merged` (undo newest-first) or 409 `loser_modified`. `resolveQueueItem` locks the queue row and runs the merge as a savepoint in the same transaction. `runDedupe` counts a 409 `work_merged` as skipped, so an admin merging during the monthly pass no longer aborts it.
- **Tests:** *refuses to merge into a work that has itself been merged away*, *two undos of the same merge at once…* (seen failing against HEAD's `dedupe.ts`: both undos fulfilled), *resolving the same queue item twice merges once*, *a chain undoes newest-first…*, *refuses undo when the loser has gained reads…*. All seen failing before the fix.
- **Not covered:** PGlite serialises on one connection, so these tests prove the interleavings it produces, not true parallel backends. The locks are standard `FOR UPDATE` and were not exercised on two real Postgres connections.

### A-03-004 · P0 · FIXED (interim) + DECISION NEEDED · Stage 2 auto-merges distinct books that share a main title
- **Evidence (full catalog):** stage 2 finds **322,702** pairs (5m04s unbounded). Of these, 10,572 have both subtitles present and different by a raw `split_part` comparison (11,110 by the new normalised `SUBTITLE_EXPR`). **25/25** randomly sampled were different books: *Harry Potter: Diagon Alley* / *Harry Potter: Magical Creatures*, *Forbidden Worlds: Volume 15* / *Volume 8*, *Pathways … 4* / *… 3*, *Loki: Agent of Asgard Volume 1* / *Volume 2*. HEAD would have auto-merged them on the next monthly run (**2026-10-01**), up to 1,000 per run.
- **Spec conflict:** PRD §40.3's stage 2 rule strips subtitles, while its stage 3 row says series entries with near-identical titles must never be auto-merged.
- **Interim fix (safest reversible):** stage 2 **holds** a pair whose subtitles are both present and differ. The pair is detected and counted in `report.held`, but not merged. Mergeable pairs sort first so held pairs can't fill the LIMIT.
- **Not fixed:** **28,682** non-held pairs have a subtitle on one side only. That group is the intended case (*Dune* / *Dune: A Novel*), but it also contains *Chicken soup for the soul* / *Chicken Soup for the Soul: Like Mother, Like Daughter*. Same-author same-title distinct books ("Collected Poems") also still merge, per the rule as written.
- **Tests:** *stage 2 holds back two different subtitles…* (seen failing: yes), *stage 2 still merges a bare title with its subtitled copy* (guards against over-holding).

### A-03-005 · P0 · FIXED (interim) + DECISION NEEDED · Stage 1 is live and merges unrelated books sharing a re-used ISBN
- **Evidence (full catalog):** the claim "INERT, 102 ISBNs" is stale: 4,939,345 editions carry an ISBN-13. Stage 1 finds **30,240** pairs (2m18s unbounded): 19,708 with identical titles, and **9,309** whose normalised titles differ. Of 25 sampled from the different-title group, about 6 were clearly different books: *Bidirectional Control of DC Motor…* / *Behaviour of Concrete…* (ISBN 9788193323519), *The Charlie Brown Dictionary Volume 2* / *Volume 5*, *Wagons West* / *LOUISIANA (Wagon's West No 16)*, *The war* / *Blackwater IV: the War*. Others were legitimate: translations (§7.5) and title variants.
- **Spec conflict:** PRD §40.3 says "an ISBN identifies one edition; two works claiming it are one work". The dump contradicts the premise.
- **Interim fix:** stage 1 holds a pair whose normalised titles differ.
- **Tests:** *stage 1 holds back a shared ISBN between works whose titles differ* and *stage 1 merges a shared ISBN between works with the same normalised title* (both seen failing: yes). The inherited test *finds nothing on stage 1 today* is misnamed and uses a false-positive pair (*Dune* / *Dune Messiah*). It still passes, because `stage1` counts detections and that pair is now held. Left unchanged, since renaming it would edit an inherited test without need.

### A-03-006 · P1 · DEFERRED + DECISION NEEDED · Stage 3 cannot run on the full catalog; it uses neither author trigram index (answers A-02-027)
- **Evidence:** `EXPLAIN STAGE3_SQL` on `flyleaf`: `Nested Loop` over `CTE Scan live_works a` × `CTE Scan live_works b` (3,650,397 rows each), with `similarity()` in the join filter. Cost **1.09 × 10¹²**, estimated 4.8 × 10¹¹ rows. It was not run (it wouldn't finish).
- **A-02-027 answer: no.** Stage 3 uses neither `authors_name_trgm_idx` nor `authors_search_trgm_idx`. The author comparison is `similarity(a.author_name, b.author_name)` over a column computed inside a CTE, which no index can serve, and the plan contains no author index at all. `pg_stat_user_indexes` (never reset): `authors_name_trgm_idx` idx_scan **0** (952 MB); `authors_search_trgm_idx` 1,724 (all pre-02b search). Dedupe therefore gives no reason to keep either index. But if D2 option (c) below is chosen, `authors_name_trgm_idx` would gain its first user, so don't drop it until D2 is decided.
- **Interim:** `runDedupe` runs stage 3 **after** the stage 1–2 merges, so it can't block them (A-03-012). The code comment on `STAGE3_SQL` records that it is correct at test scale only.

### A-03-007 · P1 · FIXED · Stage 3 compared raw titles, not normalised titles
- **Spec:** PRD §40.3 ("trigram similarity on **normalised** title").
- **Evidence:** *The Hobbit: or There and Back Again* / *Hobbit* by *J.R.R. Tolkien* / *J. R. R. Tolkien* (two author records) is exactly the stage-3 case, and wasn't found.
- **Fix:** `similarity(a.norm, b.norm)`.
- **Test:** *stage 3 compares normalised titles…*. Seen failing: yes. The existing *Jonathan Strange* stage-3 test still passes.

### A-03-008 · P1 · DEFERRED → Part 08 + DECISION NEEDED · A merged work's id does not redirect; writes land on tombstones
- **Evidence:** `CatalogService.getWork` filters `merged_into_id IS NULL` (`catalog/index.ts:564`), so an old link or shared card gives 404. PRD §40.3/§34.1 say "the old ID redirects permanently". `ReadingService.upsert` (`reading/index.ts:143`) and shelf adds accept a merged work id, so a client holding a stale id logs a read onto the tombstone, hidden from the survivor's stats. Profile favourites join `works` without filtering merged works.
- **Mitigation here:** undo refuses with 409 `loser_modified` instead of a 500 (A-03-003).
- **Proposed fix (Part 08):** resolve `COALESCE(merged_into_id, id)` (one hop, since chains are flattened) in `getWork` and in every write that takes a work id (read upsert, shelf add, favourites, mutes, reviews via reads). The response shape for a redirected id is D3.

### A-03-009 · P1 · FIXED · Guests could file duplicate reports
- **Evidence:** `POST /v1/admin/dedupe/report` with no credentials → **200** and a `dedupe_queue` row. The handler did `req.admin?.id ?? req.viewer ?? undefined`.
- **Spec:** PRD §40.3 stage 4 comes from the correction flow (§6.46, signed-in users); §4.2 guests are read-only.
- **Fix:** admin or signed-in user required (`requireViewer`), 401 otherwise; 401 added to the route schema (OpenAPI regenerated, +24 lines, no client change needed).
- **Test:** *refuses a report from a guest with 401*. Seen failing: yes (200).
- **RL:** the endpoint has no rate limit (§24.4). DEFERRED → Part 15.

### A-03-010 · P2 · FIXED · Undo failed with a unique violation when the loser had gained reads
Merged into A-03-003 (evidence, fix and test there). Its cause is A-03-008.

### A-03-011 · P2 · FIXED · The monthly job's expiry was shorter than a full pass
- **Evidence:** `catalog.dedupe` was created with pg-boss defaults: `expireInSeconds` **900**, with retries. Stage 1–2 detection alone took **7m31s** on the full catalog, before any of up to 2,000 merges, so a run could be expired and retried while still merging, giving two overlapping passes.
- **Fix:** `registerQueues` sets `expireInSeconds` to 4 h with `updateQueue`, so queues that already exist are fixed too.
- **Test:** `jobs.test.ts` *gives catalog.dedupe an expiry long enough for a full-catalog pass*. Seen failing: yes (900).

### A-03-012 · P2 · FIXED · Stage 3 ran before the merges
- **Evidence:** `runDedupe` queued stage 3 first. A stage 3 failure or timeout (A-03-006) therefore prevented every stage 1–2 merge.
- **Fix:** merges first (each commits on its own, so a re-run resumes), stage 3 last.
- **Test:** *a failing stage-3 pass does not undo or block the stage 1–2 merges*. Seen failing: yes.

### A-03-013 · P2 · FIXED · Two identical reports at once → 500
- **Evidence:** find-then-insert; the second insert hit `dedupe_queue_pending_pair_idx` (`23505`).
- **Fix:** `INSERT … ON CONFLICT … WHERE status = 'pending' DO NOTHING`, then return the existing id.
- **Test:** *two identical reports at once queue one item and both succeed*. Seen failing: yes.

### A-03-014 · P2 · DEFERRED + proposal · TS and SQL title normalisation disagree on the real database's locale
- **Evidence:** `flyleaf` is `en_US.utf8`. Enumerating every BMP code point, glibc's `[[:punct:]]` and JS `[\p{P}\p{S}]` disagree on **961**. SQL-only: 481 `Mn` (combining accents, but also Devanagari/Thai/Arabic vowel signs), 300 `No` (`½ ² ³`), 38 `Cf`, 14 `Mc`, 13 `Me`. JS-only: 84 `So`, 9 `Po`, 8 `Ps/Pe`. `lower()` disagrees on 40 (for example `İ`). **48,360** catalog titles contain combining marks. For those, stage 2's SQL partially accent-folds ("Café" → "cafe"), contradicting the documented "never accent-fold" rule, and Indic titles lose their vowel signs. The TS side is used by the import matcher (`imports/matcher.ts:229, 388`).
- **Why the existing parity test can't catch it:** PGlite runs in a different locale. The test was extended with 15 unicode, punctuation, article and numeral titles (all agree on PGlite), but locale drift is only observable on the real server.
- **Proposal:** apply `normalize(title, NFC)` in both implementations, then replace `[[:punct:]]` and `\p{P}\p{S}` with one explicit shared character class. Re-measure the stage 2 pair count on the full catalog before and after, since this changes which pairs match. More than 30 minutes of work because of the revalidation.

### A-03-015 · P2 · FIXED · `field_provenance` was moved to the survivor
- **Evidence:** provenance describes where a work's **own** field value came from. A merge never copies values, so moving the loser's `title` provenance (possibly `is_locked`, §6.46/§7.9) to the survivor claims a source and a lock the survivor's field doesn't have. Where the survivor already had a row for the field, the loser's was deleted without a record.
- **Fix:** provenance stays with the loser (which is never deleted).
- **Test:** *the loser keeps its own field provenance…*. Seen failing: yes.

### A-03-016 · P2 · DEFERRED → Part 09 · Merge cost is two full `reads` scans per moved read
- **Evidence:** the row trigger `reads_work_stats_trigger` calls `recompute_work_stats_for_work` for NEW and OLD on every moved read, and that function runs `SELECT AVG(rating) FROM reads WHERE rating IS NOT NULL AND work_id <> target` (the 00-method full-scan trigger). Merging a work with N reads is 2N scans of `reads`. Not measured on the full catalog, because no real merges were run on the dev databases. Owner: the ratings trigger fix (Part 09).

### A-03-017 · P2 · DEFERRED → Part 06 · Stage 4 reports are not weighted by reporter reputation
PRD §40.3 says "Queue, weighted by reporter reputation". No reputation signal exists. Reports are stored with `reportedByUserId` only.

### A-03-018 · P3 · FIXED · Stale claims in code and tasks.md
"SEVEN tables", "Stage 1 is written and INERT", and "`stats.workstats` recomputes" (no such job: the `reads` trigger does it) are corrected in `dedupe.ts` comments and struck through in `tasks.md`.

### A-03-019 · P3 · NOT FIXED · Smaller items
- `--dry-run` never evaluates stage 3, so the dry-run report can't show what it would queue.
- `held` counts only within the LIMIT window (mergeable pairs sort first).
- `--limit abc` → `LIMIT NaN` SQL error.
- `limit` applies per stage: up to 2×`limit` merges plus `limit` queued.
- Pending queue items that name a since-merged work stay listed until resolved (then 409).
- Undo resets **every** queue row for the pair to pending, which can collide with a newer pending row.
- The admin audit-log write happens after the resolve transaction commits.
- `mutes` and `profiles.favourite_work_ids` have no index for the merge's lookups (one sequential scan per merge).
- `previewMerge` doesn't forecast shelf, mute or favourite collisions.

### A-03-020 · P3 · NO CHANGE · "Translations with the same title must not merge" contradicts PRD §7.5
PRD §7.5 models translations as editions of one work whose ratings pool, and §34.1 repeats it. A same-title, same-author pair merging in stage 2 is therefore the specified behaviour. No guard was added.

## Claims verified correct (with a test that would fail if broken)

- `reads` renumbering on collision.
- Chain flattening.
- A second live merge of one loser is refused.
- Each merge is one transaction: *a failure part-way through a merge leaves nothing changed* (trigger raises on the final tombstone update; snapshot unchanged, no `work_merges` row; passed before any change).
- 30-day boundary ±1 minute.
- Stage 3 never auto-merges.
- `0 0 1 * *` schedule registered.
- Moderator can read but gets 403 on merge, dismiss and undo.
- Every resolve, including dismissals, writes `admin_audit_log`.
- Every catalog string in `/admin/merges` goes through `escapeHtml`. Mutation-checked: removing `escapeHtml` from one `<h3>` makes *escapes catalog text in the review page* fail. The only other interpolations are DB uuids, ISO dates, numbers and the role enum, and no data is embedded in `<script>`.

## Performance

Full catalog (`flyleaf`). **Indicative only (8 GB dev machine).** No API route is on a hot path here, so latency budgets don't apply. These are monthly-job timings.

| Query | Time | Plan notes |
|---|---|---|
| `npm run dedupe -- --dry-run` (stage 1 + 2 detection, LIMIT 1000 each) | **7m31s** | the whole candidate set is built before LIMIT |
| Stage 2, unbounded, into a temp table | 5m04s (API tests running concurrently) | `Hash Join` of seq scans of `work_authors` (3.79M) and `works` (3.65M), `HashAggregate` on (author, norm) in 8 partitions; cost grows linearly with the catalog |
| Stage 1, unbounded | 2m18s | `Merge Join` on `editions_isbn13_idx` (two parallel index scans, 4.9M ISBNs), `Memoize` on `works_pkey` |
| Stage 1 + 2 with the new `held` columns, unbounded | 8m50s | same plans plus a join to `works` for titles |
| Stage 3 | **not runnable** | nested loop 3.65M × 3.65M, cost 1.09e12 (A-03-006) |

**Dry-run writes nothing (FN-52), proved by a counter diff:** `sum(n_tup_ins + n_tup_upd + n_tup_del)` over `pg_stat_user_tables` was **3,058,121 before and after** the 7m31s run. `work_merges` 0 → 0, `dedupe_queue` 0 → 0, `admin_audit_log` 0 → 0, merged works 0 → 0. No other session was connected (`pg_stat_activity`).

## Behaviour changes

1. A merge now also moves reviews, shelf items (and so shelf counts and mosaics), feed activity, work mutes, profile favourites and import rows, and adds the loser's `log_count` to the survivor.
2. `field_provenance` is no longer moved to the survivor.
3. Undo is exact for everything above, and is refused with **409** `survivor_merged` (undo the later merge first) or **409** `loser_modified`. A merge whose survivor or loser is already merged is refused with **409** `work_merged` (the resolve endpoint surfaces this, where before it merged into a tombstone).
4. Stage 1 and 2 **hold** (don't auto-merge) pairs with differing normalised titles (stage 1) or two different subtitles (stage 2). The report, CLI output and job log gain `held`.
5. Stage 3 compares normalised titles, and runs after the stage 1–2 merges.
6. `POST /v1/admin/dedupe/report` requires an admin or a signed-in user: guests get **401** (OpenAPI updated).
7. Duplicate concurrent reports of one pair return the same id instead of a 500.
8. `catalog.dedupe` jobs expire after 4 h instead of 15 min.

## Decisions needed

- **D1 (A-03-004, A-03-005): stage 1–2 auto-merge rules.** Options:
  - (a) keep the interim hold (held pairs are never merged, only counted);
  - (b) route held pairs to the review queue (a migration widening `dedupe_queue_stage_ck` to 1–4; about 20k items);
  - (c) apply the PRD rule as written.

  Separately: the 28,682 one-sided-subtitle pairs still auto-merge. Options are to add a year gap or a series signal, or to queue them.

  **Recommendation:** (b), plus sampling the one-sided group before the first non-dry run. **Until decided, don't let the 2026-10-01 scheduled run merge unattended**: it will auto-merge up to 2,000 non-held pairs, including one-sided subtitle pairs. Merges are now fully reversible for 30 days.
- **D2 (A-03-006): stage 3 design.** Options:
  - (a) block by shared author id and compare normalised titles within each author's works, capping group size;
  - (b) candidate generation from a trigram expression index on the normalised title (`%` at 0.85): 3.2M probes and a new multi-GB index;
  - (c) cross-record author matching through `authors_name_trgm_idx` (`name % name` at 0.9), which would make it that index's only user;
  - (d) drop automated stage 3 and rely on stage 4 reports.

  **Recommendation:** (a) + (c), limited first to works with `log_count > 0`. Decide before acting on A-02-027's index drop.
- **D3 (A-03-008): response shape for a merged id.** 200 with the survivor's body (different `id`), a 308 with `Location`, or a 404 carrying `merged_into`. **Recommendation:** 200 with the survivor, because mobile already navigates by the returned id. Owner: Part 08.
- **D4: moderator dismissals.** Moderators currently can't dismiss. The spec only says "review but not merge or undo". **Recommendation:** keep as is (conservative).

## Deferred (with reason and owner part)

| Item | Owner | Reason |
|---|---|---|
| A-03-006 stage 3 redesign | Part 03 follow-up after D2 | design decision; well over half a day |
| A-03-008 merged-id redirect and tombstone writes | Part 08 | book-detail and reading-core paths; needs D3 |
| A-03-009 report rate limit (RL) | Part 15 | one coherent limiter layer |
| A-03-014 normalisation drift | Part 03 follow-up | needs full-catalog revalidation of stage 2 |
| A-03-016 per-read trigger cost during merge | Part 09 | the `recompute_work_stats_for_work` full scan |
| A-03-017 reporter reputation | Part 06 | no reputation signal exists |

## CI after

`node scripts/ci.mjs` on the final tree: **green in 429 s**.

| Step | Result |
|---|---|
| api-client build, api typecheck, spec check (OpenAPI drift 0) | ✓ |
| api tests | ✓ **870 passed** (48 files); baseline before any change: 840 passed (48 files) |
| api build, api audit (`--audit-level=high`) | ✓ |
| mobile typecheck | ✓ |
| mobile offline tests | ✓ **100 passed** |
| migrations on the real Postgres | ✓ `migrations applied` (this part adds no migration) |
