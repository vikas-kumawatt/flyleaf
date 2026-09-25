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
---

# Part 03b — the decisions on Part 03 (D1, D2, D4, D3 routed)

2026-09-25 · CI **green, run in two parts**: `node scripts/ci.mjs` passed api-client build, api typecheck, spec check (OpenAPI drift 0), api tests (894/894) and api build, then stopped at `api · audit` on `getaddrinfo ENOTFOUND registry.npmjs.org` (the network was down, not the code). The four remaining steps were then run exactly as `ci.mjs` defines them, once DNS was back: audit exit 0 (7 moderate, below the `high` threshold), mobile typecheck ✓, mobile offline tests 100/100, migrations on the real Postgres ✓ · tests **870 API + 100 mobile → 894 API + 100 mobile** (`dedupe.test.ts` 67 → 91; 23 deliberate code breaks, all caught by these tests; four inherited Part 03 tests rewritten for D1, listed under "Tests changed"; none deleted or weakened)

Databases: normalisation parity, plans, timings and the dry run are from the **full catalog `flyleaf`** (PostgreSQL 18.6, Alpine/**musl**, `en_US.utf8`). Migrations `0021` and `0022` were applied to `flyleaf` and `flyleaf_dev`. PGlite (PG 18.3, `C.UTF-8`) for correctness tests. Machine: 8 GB, so **timings are indicative only**. Nothing was merged or queued on either real database (`work_merges` 0, `dedupe_queue` 0 before and after).

`secure-design` was not triggered: this run was autonomous by instruction. The one security-relevant change (who can switch merging on) is A-03-021.

## Verdict per task (after 03b)

| Task | Verified | Findings |
|---|---|---|
| FN-50 | ✅ D1 implemented; auto-merge off by default; TS/SQL normalisation agree on the real server | A-03-004, A-03-005, A-03-014, A-03-021, A-03-022 |
| FN-51 | ⚠️ stage 3 runs on the full catalog (D2), cross-record author matching starts from popular, used and newly created works (decided scope limit); queue ordered by impact; D4 confirmed | A-03-006, A-03-023, A-03-024 |
| FN-52 | ✅ the scheduled job detects and queues only, unless the worker has `DEDUPE_AUTO_MERGE=true` | A-03-021 |

## Findings

### A-03-021 · P0 · FIXED · The monthly job would auto-merge unattended on 2026-10-01
- **Where:** `jobs/index.ts` `dedupeJobHandler`, `worker.ts` schedule, `dedupe.ts` CLI.
- **Evidence:** HEAD's `runDedupe` merged by default, and the job passed no switch. Part 03 recommended not letting the 2026-10-01 run merge.
- **Fix:** `runDedupe` takes `autoMerge` (default **false**). The job sets it only from the **worker's environment**: `DEDUPE_AUTO_MERGE === 'true'`, exactly. A job payload cannot turn it on, so nothing that can enqueue a job can make it merge. With it off, the pass detects stages 1–3 and queues what needs review. The CLI needs `--auto-merge` to merge. The schedule payload is now `{}` (the old `{ limit: 1000 }` meant nothing any more).
- **Tests:** *a default pass detects and queues but merges nothing*; *the scheduled job merges only when the worker has DEDUPE_AUTO_MERGE=true* (env unset, `'false'`, `'1'`, `'TRUE'`, plus a payload `{autoMerge: true}` → no merge; `'true'` → merges); *a dry run writes nothing, even with auto-merge on*. Seen failing: yes, by mutation (default-on, any-non-empty env, payload honoured, dry run queueing: all four caught).

### A-03-004 / A-03-005 · RESOLVED by D1 · Stage 1–2 auto-merge only unambiguous pairs
- **Rule (D1):**
  - Stage 1 auto-merges only with the same ISBN-13 **and** the same normalised title **and** at least one shared author.
  - Stage 2 auto-merges only with the same normalised title and a shared author **and** matching subtitles (both absent, or both present and equal after normalisation).
  - Everything else either stage finds goes to the **review queue**.
  - A pair found by both stages is one pair: it auto-merges if either stage's rule says so.
- **Queue:** migration `0021_dedupe_review_queue.sql` widens `dedupe_queue_stage_ck` to 1–4 and adds `impact` (the reads, reviews, shelf items and favourites on either work), with the index `(status, impact DESC, created_at DESC)`. `getDedupeQueue` lists highest impact first. Every queue insert (stages 1–4) is set-based in batches of 2,000 and computes impact in the same statement. A pending pair keeps its row and its impact is refreshed.
- **Cap:** at most **200** merges per run (`DEFAULT_MERGE_CAP`, `--cap`, job `mergeCap`). The rest are reported as `deferred` and merged by the next run, in a deterministic order.
- **Found while implementing (see A-03-022):** a dismissed pair was re-queued by the next pass, and an undone merge would be redone by it.
- PRD §40.3 amended with the evidence from Part 03.
- **Tests:**
  - Rewritten from Part 03: *stage 2 queues two different subtitles*, *stage 2 queues a bare title and its subtitled copy*, *stage 1 queues a shared ISBN between works whose titles differ*, *stage 1 merges … with the same normalised title and a shared author*.
  - New: *stage 1 without a shared author goes to review*, *stage 2 merges identical subtitles, and identical bare titles*, *a pair found by both stages is counted, queued or merged once*, *stops at the merge cap and finishes on the next run*, *the default merge cap is 200*, *pairs where either work has user data come first*, *a user report … carries its impact*, *the queue endpoint serves stage 1-2 items with their impact*.
  - Seen failing by mutation: stage-1 auto without an author, stage-2 auto on a one-sided subtitle, cap ignored, ordering by `created_at`, impact without favourites. All caught.

### A-03-022 · P1 · FIXED · The automated stages ignored reviewers' decisions
- **Evidence (HEAD):** stage 3's insert skipped only *pending* pairs, so a pair an admin had dismissed was queued again the next month. Nothing stopped stage 1–2 from auto-merging a pair a reviewer had dismissed (for example, one reported through stage 4), or re-merging a pair whose merge an admin had just **undone**.
- **Fix:** automated stages (1–3) drop dismissed pairs, in either orientation. A pair with an undone merge is never auto-merged again: it goes to review, with "an earlier merge of this pair was undone" in the reason. A new **user report** (stage 4) of a dismissed pair is still queued, because it is new evidence. Pairs already pending in the other orientation are not queued twice, and a queued pair never names a work merged away earlier in the same run.
- **Tests:** *a dismissed pair is neither re-queued nor merged*, *a pair whose merge was undone is reviewed, never auto-merged again*, *does not re-queue a stage-3 pair a reviewer dismissed*, *a later pass does not queue a pending pair again*. Seen failing: yes, by mutation (removing each exclusion is caught).

### A-03-014 · FIXED · TS and SQL title normalisation now agree on the real server
- **Before (measured, full catalog):** `src/bench/dedupe-parity.ts` ran both implementations over every title. **50,622 of 3,203,575** titles disagreed, plus 296 subtitles. The server is **musl** (Alpine), not glibc as Part 03 assumed. On it, `[[:punct:]]` treats combining marks as punctuation, so the SQL did not accent-fold, it **split words**: "Omisión" (decomposed) → "omisio n", "Người Thái" → "ngươ i tha i". It also dropped bidi marks and zero-width non-joiners, stripped `½`, and lowercased `İ` and final sigma differently from JS.
- **Fix:** both implementations are built from the same explicit pieces, and neither reads the server locale:
  - **NFC** first, so composed and decomposed accents are one title (`normalize(title, NFC)` / `String.prototype.normalize`);
  - **Unicode simple lowercase**: `lower(… COLLATE pg_c_utf8)` (Postgres's built-in provider) and, in TS, per code point with U+0130 → `i`;
  - **one generated separator class**: the code points of `\p{P}\p{S}` plus bidi and zero-width marks (U+061C, U+200B, U+200E/F, U+202A–202E, U+2066–2069), enumerated once at module load (planes 0–3, ~40 ms) and emitted both as a JS regex and as a Postgres bracket expression of `\uXXXX` ranges (351 ranges);
  - whitespace is exactly JS's `\s`, emitted the same way.

  Combining marks are not separators, so accents stay (the documented "never accent-fold" rule now actually holds). `normaliseSubtitle` is new: the TS twin of `SUBTITLE_EXPR`, which stage 2's auto-merge rule now depends on.
- **After (measured, full catalog):** **0** title and **0** subtitle disagreements over 3,203,575 titles, and **0 over all 260,095 code points** of planes 0–3, each tested inside a word, alone, and after a colon. The SQL pass costs more: 53 s vs 24 s for all titles.
- **Tests:**
  - The parity test gains 14 real catalog titles that disagreed, plus NBSP, `½` and a final sigma. Run against HEAD's implementation on PGlite, **13 of the 14 fail** (seen failing: yes).
  - New: *composed and decomposed accents are the same title, and accents are kept*; *subtitles follow the same rules in both implementations*; *the SQL expressions do not depend on the server locale*.
  - Mutation: dropping `normalize` or TS's per-code-point lowercase is caught by the parity test. Dropping `COLLATE pg_c_utf8` is **not observable on PGlite**, whose libc lowercases every test title identically, so the last test pins it structurally. The behavioural check for that case is `dedupe-parity.ts` against the real server: re-run it after any Postgres image or locale change.
- **Behaviour change:** the import matcher (`imports/matcher.ts`) uses `normaliseTitle`, so imports now also treat composed and decomposed accents as equal, and bidi marks as spaces.

### A-03-006 · FIXED (D2) · Stage 3 runs on the full catalog and never compares all pairs
- **Design (D2):** titles are compared only within an author's works.
  - **A. Same author id:** each author's works, pairwise. That is 54.2M comparisons on the full catalog; the largest author has 1,930 works. Identical normalised titles are left to stage 2.
  - **B. The same author under two records:** probe authors are those credited on a *probe work*, meaning `log_count ≥ 100` (`STAGE3_PROBE_MIN_LOGS`) or any Flyleaf user data (read, shelved, favourited): **12,627 authors** on the full catalog. For each, `authors_name_trgm_idx` (`name % name` at 0.9, set locally) gives the credited authors whose name is > 0.9 similar, and their works are compared with the probe author's.
  - Title similarity > 0.85 on the normalised title, years ±2, survivor chosen as in stages 1–2.
- **`authors_name_trgm_idx` is now used and must not be dropped.** It is stage 3's only author index. This answers A-02-027 for this index. `authors_search_trgm_idx` is still not used by dedupe.
- **Why one lookup per name:** written as one query, the planner flattened the lookup into a hash join over all 1.56M credited authors with `%` as a join filter (EXPLAIN cost 1.3e12, index unused). As a LATERAL over a batch of names it seq-scanned authors, or with `enable_seqscan=off` bitmap-scanned the partial `authors_credited_trgm_idx` as a has_works filter (10 s for 2 names). With the name as a constant, and `plan_cache_mode = force_custom_plan` set locally, each lookup is a bitmap scan of `authors_name_trgm_idx` (EXPLAIN verified). Timing: 100 lookups in 29.7 s and 31.7 s, ~300 ms each, cold cache included.
- **Measured full run:** see Performance.
- **Tests:** existing *stage 3 compares normalised titles, and matches authors by name across author records* and *detects Stage 3 fuzzy pairs* still pass. New: *never pairs similar titles by unrelated authors*, *matches a duplicate author record only from a probe work*, *leaves identical normalised titles by the same author to stage 2*, *keeps the 0.9 trigram threshold inside its own transaction*. Seen failing by mutation: removing the probe line; leaking the 0.9 threshold to the session.

### A-03-023 · DECIDED SCOPE LIMIT · Duplicate author records are only looked for from probe works
- **Evidence:** one author lookup costs ~80 ms warm and 1–1.7 s cold (3,200 buffers against a 952 MB index over 15.4M names). Probing all 1.66M credited authors would take **37+ hours** on this machine.
- **Decision (user, 2026-09-25):** accepted as a scope limit. Stage 3 starts from popular works (≥ 100 logs) and works with user data. The long tail is covered by two things:
  - **user reports** (stage 4);
  - **new works, once**: stage 3 also probes every work created (ingested or gap-filled) since the start of the previous **finished** pass. Implemented, because it was small:
    - migration `0022_dedupe_runs.sql` adds a `dedupe_runs` table, one row per pass that writes (never for a dry run);
    - `runDedupe` records the start before detection and `finished_at` plus the report at the end;
    - the probe query adds `OR w.created_at > since`;
    - a pass that dies leaves `finished_at` NULL, so the next pass covers its window again;
    - a first pass has no predecessor and probes nothing extra.

  `works.created_at` is used, not `updated_at`: every monthly ingest upsert rewrites `updated_at` on all 3.2M rows (`MERGE_WORKS`), while both insert paths (ingest, `gapfill.ts`) set `created_at` only on insert.
- **Remaining consequence:** a duplicate under two author records, where neither work is popular, used or new since the last pass, is found only if a user reports it. The moment someone reads, shelves or favourites either work, the next pass looks.
- **Cost risk:** the new-works probe scales with each month's ingest delta, at ~300 ms per new author on this machine. A large re-ingest (tens of thousands of new authors) would add hours to that one pass, still within the 4 h job expiry only up to ~40k new authors. Not measured: `flyleaf` has no `dedupe_runs` history yet, so the first real pass probes nothing extra.
- **If coverage matters later:** a partial trigram index on `authors(name) WHERE has_works` has about 9× fewer rows than `authors_name_trgm_idx` (1.66M vs 15.4M) and would make probes proportionally cheaper.
- **Tests:** *probes, once, works created since the previous finished pass* (first pass: nothing; a work gap-filled afterwards is found and queued by the next pass; the pass after that no longer probes it); *a dry run records no pass, and a pass that fails does not move the window*.

### A-03-024 · CONFIRMED (D4) · Moderators cannot dismiss
- `POST /v1/admin/dedupe/queue/:id/resolve` calls `requireAdmin` for both actions. The existing test *a moderator can review but not merge, dismiss or undo* asserts 403 for `dismiss` and that the item stays pending. **Mutation-checked:** letting moderators dismiss (`requireModerator`, with `requireAdmin` only for merge) makes it fail. The HTML console shows moderators disabled buttons. No code change.

### A-03-019 · partly FIXED · Smaller items from Part 03
- `--dry-run` now evaluates stage 3 and reports its count.
- `held` counted only inside the LIMIT window: fixed, because detection is unbounded and there is no LIMIT.
- `--limit abc` → `LIMIT NaN`: `--limit` is gone. `--cap` and `--sample` are validated ("needs a whole number").
- `limit` applied per stage: replaced by one merge cap per run.
- Still open: pending queue items that name a since-merged work stay listed until resolved (then 409). The automated stages no longer create such items within a run, but an admin merge can still strand one. Undo still resets every queue row for the pair to pending. The audit-log write still happens after the resolve transaction. `mutes`, `profiles.favourite_work_ids` and `reads.work_id` still have no index for the merge's and the impact computation's lookups (see Performance). `previewMerge` still doesn't forecast shelf, mute or favourite collisions.

### Routed to Part 08
- **D3:** reads of a merged work id return the survivor (200 with `merged_into`); writes to a merged id (reads, shelving, progress, favourites, mutes) are applied to the survivor server-side, never 404, so offline replays survive merges. Recorded in `08-catalog-screens-and-reading-core.md`, "Routed from Part 03".
- **A-03-016** (the merge scans `reads` twice per moved read through the ratings trigger) is routed there with L-01, because it is the same scan.

## Full-catalog dry run (auto-merge off)

`npm run dedupe -- --dry-run --sample 25` on `flyleaf`, 2026-09-25 12:24–13:55 UTC, code at the D1/D2 state described above. Per-stage figures come from a second, read-only `detectStage12` pass over the same data; its totals match the CLI's exactly.

**The database was unchanged.** `sum(n_tup_ins + n_tup_upd + n_tup_del)` over `pg_stat_user_tables` was **3,058,122 before and after**. `dedupe_queue` 0 → 0, `work_merges` 0 → 0, merged works 0 → 0, `admin_audit_log` 0 → 0. No other session was connected at the start. `authors_name_trgm_idx.idx_scan` went 203 → 12,829 (+12,626), one per stage-3 author lookup. Migration `0022` was applied only after this check.

| | Pairs | Auto-mergeable (D1) | To review |
|---|---|---|---|
| Stage 1 (shared ISBN-13) | 30,083 | 15,045 | 15,038: 6,321 title differs; 5,813 no shared author; 2,904 both |
| Stage 2 (title + author) | 323,370 | 268,863 | 39,462: 28,355 one-sided subtitle; 11,107 subtitles differ |
| **Distinct pairs** (15,045 found by both stages) | **338,408** | **283,908** | **54,500** |
| Stage 3 (fuzzy, review only) | 82,192 | never | 82,192 |

How to read the counts:
- **Pairs are not merges.** The 283,908 auto-mergeable pairs name **185,557 distinct losers**, because a group of *n* copies yields up to *n*(*n*−1)/2 pairs. That is the number of works an unlimited run would tombstone.
- **Every stage-1 auto pair is also a stage-2 pair**: 15,045 of 15,045. The stage-1 rule (same ISBN, same title, shared author) is a subset of stage 2's key. It adds no pairs; it only makes some pairs auto-mergeable that stage 2 alone would queue, namely those whose subtitles don't match but whose works share an ISBN. That subset was not counted separately.
- **Counts differ slightly from Part 03.** Stage 1 is now one row per pair; Part 03's 30,240 counted pair × ISBN rows. Stage 2 is +668 pairs over Part 03's 322,702, from the normalisation fix (NFC makes composed and decomposed titles meet).
- **The review queue would receive 136,692 items on the first pass:** 54,500 from stages 1–2 and 82,192 from stage 3. It would not be empty, as the old stage-3 LIMIT of 1,000 per run implied.

### Samples (random, from the same run)

**25 random auto-mergeable pairs**

| # | Stage | Why | Keep (survivor) | Merge (loser) |
|---|---|---|---|---|
| 1 | 2 | normalised title "regency valentine" and a shared author | "A Regency Valentine" (?) by Mary Balogh, Emma Lange, Joan Wolf, Patricia Rice, Katherine Kingsley `040ec38a-8312-4d9e-8009-447da61f60dc` | "A Regency valentine" (?) by Mary Balogh `88d64dc3-102c-4e01-83c1-b7ed321e4e1d` |
| 2 | 2 | normalised title "body snatchers" and a shared author | "The Body Snatchers" (1955) by Jack Finney `2f053889-a313-44d8-8357-eee1cba8414c` | "Body Snatchers" (?) by George Finney, Jack Finney `d045e473-20e0-4f3d-8d45-a47a52daa3ff` |
| 3 | 1+2 | shared ISBN-13 9780849378577, same normalised title and a shared author | "Essential Oil Bearing Grasses" (?) by Anand Akhila `7c7bd4da-3fe2-4be8-8f18-ce1c9aa9502f` | "Essential oil-bearing grasses" (?) by Anand Akhila `3fa71e13-7b9f-43ac-9a73-986c92b2974c` |
| 4 | 2 | normalised title "happiness sold separately" and a shared author | "Happiness Sold Separately" (?) by Lolly Winston `3343a4d2-45b8-47a4-9c17-6540ae76ba6f` | "Happiness sold separately" (?) by Lolly Winston `ad3728b0-73f7-4672-aa3f-af712af882ca` |
| 5 | 2 | normalised title "battle angel alita" and a shared author | "Battle Angel Alita" (?) by Yukito Kishiro `1c7d5848-b1ee-4fd0-9311-72398efa861c` | "Battle Angel Alita" (?) by Yukito Kishiro `cb6368e9-fa2e-4e41-88d1-5e61f179e6d4` |
| 6 | 2 | normalised title "mujeres de ojos grandes" and a shared author | "Mujeres De Ojos Grandes" (?) by Ángeles Mastretta `3e9d62ae-47ae-4399-8af5-83cff2d27d09` | "Mujeres de ojos grandes" (?) by Ángeles Mastretta `9183f531-a3e3-4c20-bc50-ca517e17485c` |
| 7 | 2 | normalised title "die drei kids" and a shared author | "Die drei ??? Kids" (?) by Ulf Blanck `011ca8e1-d40e-4966-aacc-7834797eb271` | "Die drei ??? Kids" (?) by Ulf Blanck `3b5d7776-84cb-43de-b882-7733dd5c678c` |
| 8 | 2 | normalised title "race class and gender in the united states" and a shared author | "Race, class, and gender in the United States" (?) by Paula S. Rothenberg `a660be7f-74d2-493a-b9e6-92981d96ec94` | "Race, class, and gender in the United States" (?) by Paula S. Rothenberg `e2a82990-674b-49a9-abad-e78a4df8037b` |
| 9 | 2 | normalised title "evensong" and a shared author | "Evensong" (?) by Gail Godwin `8d65fb89-fa40-4f04-9df0-8bbf84e3d714` | "Evensong" (1999) by Gail Godwin `bb3159f6-69fc-4954-8ea1-55fcd289739f` |
| 10 | 2 | normalised title "computer system architecture" and a shared author | "Computer system architecture" (1976) by M. Morris Mano `cb881db0-2a32-4bb7-9388-3fc3667c1fac` | "Computer system architecture" (1993) by M. Morris Mano `07ef44e4-3d41-4a8d-87d8-cfec29dea36c` |
| 11 | 2 | normalised title "married by morning" and a shared author | "Married by Morning" (?) by Lisa Kleypas `17efa1b9-f4da-4ac2-860d-73ed8b0eea5f` | "Married by Morning" (?) by Lisa Kleypas `943168d0-dccf-47d2-a2fe-4fba718e62fc` |
| 12 | 2 | normalised title "biology" and a shared author | "Biology" (1981) by Cecie Starr, Christine Evers, Lisa Starr `0d18ece3-0c92-4eca-af49-fbfde6ab5320` | "Biology" (?) by Cecie Starr, Ralph Taggart, Christine Evers, Lisa Starr `1c720dac-c1f8-4558-bf5f-5a3e5ccd6590` |
| 13 | 2 | normalised title "atomic audit" and a shared author | "Atomic Audit" (?) by Stephen I. Schwartz `2de84246-8585-4324-9650-5f4e486cc2bb` | "Atomic audit" (?) by Stephen I. Schwartz `63bd7655-c4a4-4957-b720-400e8aa5c076` |
| 14 | 2 | normalised title "kendermore" and a shared author | "Kendermore" (?) by Mary L. Kirchoff `cd5f5fd5-f8e0-412c-abfc-ba7af9f16688` | "Kendermore" (?) by Mary L. Kirchoff `02964fd0-5813-41dc-83e3-295884b774b7` |
| 15 | 2 | normalised title "financial accounting" and a shared author | "Financial Accounting" (?) by Paul D. Kimmel, Donald E. Kieso `0ff66f88-c63b-40d6-a96e-1944f4d1a140` | "Financial accounting" (?) by Paul D. Kimmel `3ada73c4-b769-4faf-93f9-2eef4e1fc32d` |
| 16 | 2 | normalised title "take" and a shared author | "Take" (?) by Martina Cole `599f7fb4-ceba-41dd-ac26-250759fedc7f` | "The take" (?) by Martina Cole `2f9442f5-a68e-473e-9292-f14002ec6134` |
| 17 | 2 | normalised title "psychological theory" and a shared author | "Psychological theory" (?) by Melvin Herman Marx `ac8bf43b-c6ce-4e94-a7d7-6108550fd240` | "Psychological Theory" (?) by Melvin Herman Marx `0bc65051-1f25-47d0-b28f-761d7b6c84c8` |
| 18 | 2 | normalised title "bleach" and a shared author | "Bleach" (?) by Tite Kubo `5c27c1e9-db88-472e-bb91-e9c827802528` | "Bleach" (?) by Tite Kubo `2a4c6396-5918-4e40-b51f-15ff59984e30` |
| 19 | 2 | normalised title "burger" and a shared author | "Burger" (?) by Panda `cde9d077-9510-49e4-b336-958d4e9f4f4e` | "Burger" (?) by Panda `e9edee6f-d8c1-4b3d-a555-767ff3a1e3b2` |
| 20 | 2 | normalised title "stormbringer" and a shared author | "Stormbringer" (?) by Michael Moorcock `cbea8893-c209-4a44-b644-f4e448aa9271` | "Stormbringer" (1992) by Michael Moorcock `68860ea2-d638-49ad-8807-1901fe7498bc` |
| 21 | 2 | normalised title "uncrowned king" and a shared author | "The uncrowned king" (?) by Kenneth Whyte `6f5b57f4-ba1b-4add-9c36-03a749af8097` | "The uncrowned king" (2009) by Kenneth Whyte `42c696fb-23be-4d9a-849d-ec4291ab3605` |
| 22 | 2 | normalised title "dr mukti and other tales of woe" and a shared author | "Dr Mukti and Other Tales of Woe" (?) by Will Self `d1792a6a-78f1-4c45-95ae-67bce24030f5` | "DR MUKTI AND OTHER TALES OF WOE" (?) by Will Self `114d94f9-3b17-4d94-9ceb-39cb6fdb6156` |
| 23 | 2 | normalised title "seventh scroll" and a shared author | "The Seventh Scroll" (?) by Wilbur Smith `04f32ef5-9d81-4612-bfb2-2c979fa3c3c5` | "Seventh Scroll" (?) by Wilbur Smith `a88d8f30-19f8-4fd9-8d8f-129e68cede4d` |
| 24 | 2 | normalised title "freud for beginners" and a shared author | "Freud for beginners" (1979) by Richard Appignanesi, Richard Appignanesi, Oscar Zarate `d64588ac-eca9-49c3-a633-38508d144ea7` | "Freud for beginners" (1979) by Richard Appignanesi `aab743e4-7d62-4c5b-9e33-aad6023266d1` |
| 25 | 2 | normalised title "till we meet again" and a shared author | "Till we meet again" (?) by Eileen Bailey, Elizabeth Merrit `5ce0e65c-fdc3-4093-958d-c53c325c592d` | "Till We Meet Again" (?) by Elizabeth Merrit `950dda8a-b5e4-465a-8f53-62112486dcc2` |

**25 random review-queue pairs**

| # | Stage | Why | Keep (survivor) | Merge (loser) |
|---|---|---|---|---|
| 1 | 2 | normalised title "curious george" and a shared author, but only one has a subtitle ("he was a good little monkey and always very curious") | "Curious George" (?) by Landoll `2c853804-24dd-489d-9e1a-bf56253e1ed9` | "Curious George: He Was a Good Little Monkey and Always Very Curious" (?) by Landoll `4108d71d-f615-431a-99f5-273814283f41` |
| 2 | 2 | normalised title "best books for high school readers" and a shared author, but only one has a subtitle ("grades 9 12") | "Best books for high school readers : grades 9-12" (?) by Catherine Barr `1eb30488-730f-4945-80df-d289e8609315` | "Best books for high school readers" (?) by Catherine Barr `aadbdbf6-83b9-4780-9a28-97e6c5d4942e` |
| 3 | 2 | normalised title "chicken soup for the soul" and a shared author, but only one has a subtitle ("recovering from traumatic brain injuries") | "Chicken soup for the soul" (?) by Jack Canfield, Mark Victor Hansen, Amy Newmark `04961082-70b1-4eaa-933a-91a0a3108ee9` | "Chicken Soup for the Soul : Recovering from Traumatic Brain Injuries" (?) by Amy Newmark, Carolyn Roy-Bornstein, Lee Woodruff `5496ae38-d7be-490c-a116-07bdbb1d1a23` |
| 4 | 2 | normalised title "principles of investments" and a shared author, but only one has a subtitle ("text cases") | "Principles of investments" (?) by Leonard T. Wright `82a1c0b5-00ad-42ad-9429-5e802dbab5ba` | "Principles of investments: text & cases" (?) by Leonard T. Wright `8a7dbc57-72b0-4a24-b34f-db090d8f3da0` |
| 5 | 2 | normalised title "spiderwick chronicles" and a shared author, but only one has a subtitle ("the complete series") | "The Spiderwick Chronicles: The Complete Series" (?) by Tony DiTerlizzi, Holly Black `bf5b8fd6-4fcf-4c22-9309-abf689a5bc8f` | "THE SPIDERWICK CHRONICLES" (?) by Holly Black, Tony DiTerlizzi `92f2a1ab-732c-4867-a330-82a5f37a9ec5` |
| 6 | 2 | normalised title "chicken soup for the soul" and a shared author, but only one has a subtitle ("attitude of gratitude") | "Chicken Soup for the Soul" (?) by Amy Newmark `28e01af3-e987-442e-9b65-7eaa9531fd7c` | "Chicken Soup for the Soul : Attitude of Gratitude" (?) by Amy Newmark `6f898b51-d07c-43dc-8c90-d0359e3fc81e` |
| 7 | 2 | normalised title "chicken soup for the soul" and a shared author, but only one has a subtitle ("teens talk relationships") | "Chicken soup for the soul" (?) by Amy Newmark, Miranda Lambert `1d92717f-9a3a-4b51-8f8d-2bf8364096da` | "Chicken Soup for the Soul : Teens Talk Relationships" (?) by Jack Canfield, Mark Victor Hansen, Amy Newmark `7b925632-5871-49f0-a4e4-3478b9caad39` |
| 8 | 2 | normalised title "twisted threesome" and a shared author, but the subtitles differ ("kiki desires" / "unwilling secrets") | "Twisted Threesome : Kiki Desires" (?) by Anisa Jenkins `2edf518e-276a-414e-93e6-f05a6968c351` | "Twisted Threesome : Unwilling Secrets" (?) by Anisa Jenkins `8442cce6-88e5-4b2d-8740-94043ce96f76` |
| 9 | 2 | normalised title "beast quest" and a shared author, but only one has a subtitle ("space wars strike of the droid dog") | "Beast Quest" (?) by Adam Blade `fd905ce7-a830-42b0-8813-17d21bd3804b` | "Beast Quest : Space Wars : Strike of the Droid Dog" (?) by Adam Blade `3cd73b74-97d1-4bb0-8585-32914b73f1ec` |
| 10 | 2 | normalised title "bundle" and a shared author, but the subtitles differ ("milady standard esthetics" / "workbook for milady standard esthetics") | "Bundle : Milady Standard Esthetics" (?) by Milady `957353e0-0170-4920-be0b-dfcfb9328d99` | "Bundle : Workbook for Milady Standard Esthetics" (?) by Milady `1d7e586e-ad5b-46f1-b113-c0de7c451183` |
| 11 | 2 | normalised title "my life as a foreign country" and a shared author, but only one has a subtitle ("a memoir") | "My Life as a Foreign Country" (?) by Brian Turner `b28ff00a-94f3-46ad-a629-a6bb254bd694` | "My Life as a Foreign Country: A Memoir" (?) by Brian Turner `cd7993c5-2ecd-4f87-9ff6-198f8704ff05` |
| 12 | 2 | normalised title "becoming satisfied" and a shared author, but only one has a subtitle ("a man s guide to sexual fulfillment") | "Becoming satisfied" (1980) by Joseph Nowinski `53b136a1-d6d2-46f2-8ed4-a9985ecf8e7a` | "Becoming satisfied : a man's guide to sexual fulfillment" (?) by Joseph Nowinski `73c03a1b-e2b9-4653-a037-05e320b8fbbf` |
| 13 | 2 | normalised title "rapunzel and the lost lagoon" and a shared author, but only one has a subtitle ("a tangled novel a tangled novel") | "Rapunzel and the lost lagoon" (?) by Leila Howland `d7ea5ca7-574d-41a9-b8a1-17b16211a168` | "Rapunzel and the Lost Lagoon: A Tangled Novel: A Tangled Novel" (?) by Leila Howland `92830cc4-e804-45dd-9b9b-e418931955a5` |
| 14 | 2 | normalised title "magic tree house" and a shared author, but the subtitles differ ("books 33 34" / "books 31 32") | "Magic Tree House: Books 33 & 34" (?) by Mary Pope Osborne `15c21465-82fc-4a4d-a4c4-5b6f132cd05d` | "Magic Tree House: Books 31 & 32" (?) by Mary Pope Osborne `11cbe14a-b4fa-4d9e-b4d9-1fd4c7b7a200` |
| 15 | 2 | normalised title "bungo stray dogs" and a shared author, but only one has a subtitle ("another story vol 1") | "Bungo stray dogs" (?) by 朝霧カフカ `78931561-c05b-4da2-b37c-5437aa2a6a2a` | "Bungo Stray Dogs : Another Story, Vol. 1" (?) by Oyoyoyo, 春河３５, 朝霧カフカ `0c6ae5c2-ab8f-456d-8432-e12d527ce073` |
| 16 | 2 | normalised title "this fabulous century" and a shared author, but only one has a subtitle ("1910 1920") | "This fabulous century:1910-1920" (?) by Time-Life Books `673ce6ef-45ab-4274-a3ef-34ecef8d4269` | "This fabulous century" (?) by Time-Life Books `c3ab81cd-de4a-4234-8813-3e06c291af0f` |
| 17 | 1 | shared ISBN-13 9789004161184, but the normalised titles differ | "Girolamo Zanchi" (?) by Luca Baschera, Girolamo Zanchi `2ebf9f4e-f04b-45ab-a288-c5451626c9aa` | "De religione Christiana fides =" (?) by Girolamo Zanchi `b52adb21-0a32-404c-8c6a-65db12e6e210` |
| 18 | 1 | shared ISBN-13 9780801661969, but the normalised titles differ | "Mosby's 1990 Nursing Drug Reference (Mosby's Nursing Drug Reference)" (?) by Linda Skidmore-Roth `a0690a50-3d7c-445a-8342-a0513c296130` | "Mosby's 1990 nursing drug reference" (?) by Linda Skidmore-Roth `4d7eaf15-a680-4199-a18b-7296efd1dd38` |
| 19 | 1 | shared ISBN-13 9781589978782, but the normalised titles differ | "Light in the Lions' Den" (?) by Marianne Hering `5f5893e9-344b-48a9-a6a4-569da19bde84` | "Light In The Lion's Den" (?) by Marianne Hering `a0407f3a-37ae-4f54-b64f-733625420745` |
| 20 | 2 | normalised title "star wars" and a shared author, but the subtitles differ ("the last of the jedi a tangled web" / "the last of the jedi return of the dark side") | "Star Wars : the Last of the Jedi a Tangled Web" (?) by Jude Watson, Sue Fliess, Jerrod Maruyama `25230349-b487-4aee-99d1-092364fb0ef8` | "Star Wars : the Last of the Jedi Return of the Dark Side" (?) by Jude Watson, Sue Fliess, Jerrod Maruyama `90fc56bd-65b0-4fd5-b738-1fa215cee8e1` |
| 21 | 2 | normalised title "leading for change in early care and education" and a shared author, but only one has a subtitle ("cultivating leadership from within") | "Leading for Change in Early Care and Education" (?) by Anne L. Douglass `b71ed81e-d943-4240-8e29-4b76daa70563` | "Leading for Change in Early Care and Education : Cultivating Leadership from Within" (?) by Anne L. Douglass, Lea J. E. Austin, Sharon Ryan `ef8670ed-09a8-4437-824f-d1bedf0b716c` |
| 22 | 2 | normalised title "everything soapmaking book" and a shared author, but only one has a subtitle ("recipes and techniques for creating colorful and fragrant soaps") | "The Everything Soapmaking Book" (?) by Alicia Grosso `742fedd9-792b-469a-b116-aa847760f4d6` | "Everything Soapmaking Book : Recipes and Techniques for Creating Colorful and Fragrant Soaps" (?) by Alicia Grosso `df8d1040-5585-4ec7-858d-a3a45045cd37` |
| 23 | 2 | normalised title "wiersbe bible study series" and a shared author, but the subtitles differ ("minor prophets vol 2" / "2 samuel and 1 chronicles") | "Wiersbe Bible Study Series : Minor Prophets Vol. 2" (?) by Warren W. Wiersbe `1d854654-1037-415a-8000-f2a3d16f9e14` | "Wiersbe Bible Study Series : 2 Samuel and 1 Chronicles" (?) by Warren W. Wiersbe `31f5c377-8f0e-49f2-a9ac-a2b1d3f65dbd` |
| 24 | 2 | normalised title "cars origins" and a shared author, but only one has a subtitle ("storm chasing disney pixar cars a stepping stone book tm") | "Cars Origins" (?) by Dave Keane `6a61fc02-5da9-4355-af57-1b5e4821f5b8` | "Cars Origins: Storm Chasing (Disney/Pixar Cars) (A Stepping Stone Book(TM))" (?) by Dave Keane `5d1e0507-4067-4442-b98a-596528205041` |
| 25 | 2 | normalised title "naturals" and a shared author, but only one has a subtitle ("all in") | "The Naturals" (?) by Jennifer Lynn Barnes `262e0213-fddc-469d-b184-3a2a207656db` | "Naturals : All In" (?) by Jennifer Lynn Barnes `4909fb88-e1a2-441b-8b03-6c29efbbd705` |

**My read of the samples** (from titles, authors and years only; the catalog wasn't opened):
- **Auto-mergeable: 22 of 25 look like the same book or editions of it. 3 look like different volumes** (#5 *Battle Angel Alita*, #7 *Die drei ??? Kids*, #18 *Bleach*). That's the risk D1 does not cover: **a series whose volumes all carry the series title** with no volume number. Merging them would pool different books' ratings. #10 (*Computer system architecture*, 1976 vs 1993) and #12 (*Biology*) are editions of one textbook, which PRD §7.5 puts on one work.
- **Review queue: 13 of 25 are clearly different books; 10 are probably the same book; 2 are unclear.**
  - Different: #3, #6, #7 *Chicken Soup for the Soul*; #8, #9, #10, #14, #15; #16 *This fabulous century: 1910-1920* (a series volume); #20, #23, #24, #25.
  - Probably the same (one-sided subtitle or punctuation): #2, #4, #11, #12, #13, #17, #18, #19, #21, #22.
  - Unclear: #1, #5.

  So the rule is right to hold them: roughly half would have been wrong merges.

## Performance (Part 03b)

Full catalog `flyleaf`. **Indicative only (8 GB dev machine).**

| Step | Time | Notes |
|---|---|---|
| Stage 1 + 2 detection, **unbounded** | **394 s** (a second, cold-cache pass: > 600 s) | Part 03: 7m31s with LIMIT 1000 per stage. Same plans; normalisation is dearer (NFC + a 351-range class) |
| Normalisation, TS vs SQL, every title | SQL pass 53 s (was 24 s) | the cost of NFC and the explicit class |
| Stage 3 probe set | 75 s | 12,627 authors (`log_count ≥ 100` or user data) |
| Stage 3 author lookups | **4,041 s** (67 min) | 12,627 bitmap scans of `authors_name_trgm_idx`, ~320 ms each, 9,210 similar author records |
| Stage 3 title pairs (A + B) | 954 s | A: hash/merge join of each author's works (54.2M comparisons); B: works of the 9,210 author pairs; 82,192 pairs |
| **Whole dry run** | **5,464 s (91 min)** | inside the 4 h `catalog.dedupe` expiry (A-03-011) |
| Stage 3, old design | not runnable | 3.65M × 3.65M nested loop, cost 1.09e12 |

Two measurements from ruling out plans (full catalog):
- `name % name` written as a join: EXPLAIN cost 1.3e12, with the trigram index unused.
- As a LATERAL over a batch of names: seq scan of 1.56M authors; with `enable_seqscan=off`, a bitmap scan of the whole partial `authors_credited_trgm_idx` (7.5–10.4 s for 2 names).

A non-dry pass adds the queue inserts (136,692 rows, batches of 2,000, each with the impact join) and up to 200 merges. Neither was run on the real database.

## Behaviour changes (Part 03b)

1. **Nothing is merged unless merging is switched on**: `DEDUPE_AUTO_MERGE=true` in the worker's environment, or `--auto-merge` on the CLI. Off, the monthly job and `npm run dedupe` detect and queue.
2. Stage 1 auto-merges only with the same normalised title and a shared author. Stage 2 auto-merges only with matching subtitles. Everything else stages 1–2 find is queued as stage 1 or 2.
3. At most 200 merges per run (`--cap`, job `mergeCap`).
4. Dismissed pairs are never re-queued or merged by the pipeline. An undone merge is never redone automatically.
5. `dedupe_queue` accepts stages 1–4 and has `impact`. `GET /v1/admin/dedupe/queue` returns `impact`, accepts `stage=1|2`, and is ordered by impact, then newest (OpenAPI and api-client updated).
6. Title normalisation (dedupe **and the import matcher**) applies NFC and Unicode simple lowercase, treats bidi and zero-width marks as spaces, and no longer splits combining marks off their letters in SQL.
7. Stage 3 finds duplicates within an author's works, and across two author records only from probe works: popular, used, or created since the previous finished pass. It runs in full on every pass, including dry runs. Passes that write are recorded in `dedupe_runs` (migration `0022`). The report gains `stage3Since`.
8. `DedupeReport` fields changed: `held` removed; `autoMergeable`, `toReview`, `queued`, `stage3`, `autoMerge` and `deferred` added. The CLI `--limit` is replaced by `--cap`; `--sample N` prints random pairs of each kind.

## Tests changed (inherited from Part 03, superseded by D1)

- *stage 2 holds back two different subtitles…* → *stage 2 queues two different subtitles…* (queued instead of held).
- *stage 2 still merges a bare title with its subtitled copy* → *stage 2 queues a bare title and its subtitled copy for review*. D1 reverses this: a one-sided subtitle is reviewed.
- *stage 1 holds back a shared ISBN…* → *stage 1 queues…*; the works gained an author so that only the title rule applies.
- *stage 1 merges a shared ISBN … same normalised title* → gained the shared author D1 requires.
- Five tests that expect merges (*prefers more editions*, *falls back to log count*, *is idempotent* ×2, *a failing stage-3 pass…*) now pass `autoMerge: true`.

## Decisions needed

- **D5: identical titles that are series volumes.** In the auto-mergeable sample, 3 of 25 look like different volumes of one series with the series name as the title (*Bleach*, *Battle Angel Alita*, *Die drei ??? Kids*). n = 25, so the true rate is somewhere around 3–30%, and it wasn't measured over the 283,908 pairs. D1 auto-merges them. Options:
  - (a) enable as is and rely on the 30-day undo;
  - (b) auto-merge only when the (author, normalised title) group has exactly two works, and queue larger groups (series volumes come in groups);
  - (c) also require a matching first-publication year when both are known.

  **Recommendation:** measure (b)'s effect on the auto-mergeable count, sample again, then enable. **Keep `DEDUPE_AUTO_MERGE` off until then.**
- **D6: throughput at a 200 cap.** 185,557 works would be merged away, so a 200-per-month cap takes **77 years**. Options: a larger cap once the samples are trusted; manual CLI batches (`--auto-merge --cap 5000`) reviewed through `/admin/merges`; or a weekly schedule. Recommendation: decide after D5.
- **D7: the first queue fill.** The first non-dry pass would queue **136,692 pairs** (54,500 from stages 1–2, 82,192 from stage 3). It's ordered by impact, so the pairs with user data come first. Confirm that a queue that size is wanted, or cap stage 3's share.

## Deferred

| Item | Owner | Reason |
|---|---|---|
| D3 merged-id reads and writes | Part 08 | routed ("Routed from Part 03") |
| A-03-016 per-read trigger cost during merge | Part 08 (with L-01) | same scan as L-01 |
| `reads.work_id` has no general index (impact computation, merge, stage-3 probe set scan `reads`) | Part 08 | the L-01 rewrite owns `reads` indexing |
