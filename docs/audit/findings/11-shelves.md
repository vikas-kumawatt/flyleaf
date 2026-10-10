# Audit 11 — Shelves and lists (SH-01 … SH-10)

2026-10-10 · CI: see **CI result** below · Tests: API **1,466 → 1,502** (+34 in the new `shelves-audit.test.ts`, +2 rows in `authorization-matrix.test.ts`); mobile **177 → 182** (+5 in `shelves.test.ts`). No test was weakened or skipped. One existing assertion was changed because the behaviour it pinned was deliberately changed (`shelves.test.ts`, PATCH position; see Behaviour changes).

**How this part ran.** In a cloud sandbox (Linux), not on the laptop. Overrides from the owner for this run:

- **No `flyleaf` / `flyleaf_dev`.** A local **PostgreSQL 18.3** was installed from the `@embedded-postgres/linux-x64@18.3.0-beta.16` npm package (the apt repository was blocked by the sandbox proxy) and run on port 5432 with the default `flyleaf` database. `npm run migrate` ran clean on it, before and after 0034.
- **Bench data.** The Part 01 bench needs the full catalog. Instead, synthetic data of the same shape as the bench's shelves was inserted directly into the sandbox database: 20,000 works, 2,000 users (5% private), **4,005 shelves** (10 with 569–1,190 items, 1 in 9 private, 1 in 13 followers-only, 1 in 25 soft-deleted), **84,708 items** (1 in 7 with a note), **1,500 saves**, and one user following 1,100 others. Statement counts and EXPLAIN plans below come from it. **Every latency number in this file is "not measured on flyleaf_dev — rerun on the laptop"**; they are sandbox timings from one machine, run back to back, and only their ratios mean anything.
- **Migration 0034** was applied to PGlite (every test) and the sandbox Postgres only. **Not applied to `flyleaf_dev` or `flyleaf`** (see Deferred).
- Branch `audit/11-shelves` from `main`, committed and pushed, PR to `main`.

**"Seen failing".** Every test in `shelves-audit.test.ts` was run against unmodified `main` (a separate worktree): **28 of 34 fail there**. The six that pass on `main` are guards whose evidence is elsewhere, each named in its finding: the two concurrency tests (PGlite runs one statement at a time, so the races were reproduced on the sandbox Postgres instead), the 1,000-item reorder timing (the trigger's cost was measured on the sandbox Postgres), the items `limit=200` contract test (it documents the API the mobile fix depends on), the tie-order pagination test (not reproduced; see A-11-020), and the private-account case of A-11-001 (it held before by accident: nothing changed the activity at all). The two new matrix rows were run against `main`: `DELETE …/save (hidden shelf)` fails there.

## Items handed to Part 11 by earlier parts

Found with `grep -rn "Part 11" docs/audit/findings/` and the handoff.

| From | Item | Outcome |
|---|---|---|
| 01 L-18 | `GET /v1/shelves/browse`: 26 statements, loads all public shelves before paginating | **Fixed:** A-11-019. 26 → 1 statement |
| 01 L-18 | `GET /v1/shelves/:id/items` on the 1,192-item shelf p95 419 ms | Items were already paginated (max 100). The per-row cost was an `avg()` over every read of each work; it now reads `work_stats` (A-11-013). Latency → laptop |
| 01 L-10, 05 | `GET /v1/shelves/saved` N+1 on owner profiles (55–56 statements), fake `username: 'user'` fallback, unpaginated | **Fixed:** A-11-016. 25 → 1 statement on the sandbox (one per owner before) |
| Brief, lead 1 | Browse ranking's `views` term is hard-coded to 0 | **Spec gap recorded**, tasks.md corrected: A-11-024 |
| Brief, lead 2 / handoff | How want-to-read relates to shelves (Part 14 needs it for the swipe) | **Decided: D-11-1** |
| Brief | Why the `55f72e3` regression "passed CI" | **It did not:** A-11-027 |

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| SH-01 | migrations, counters, nightly reconcile | ⚠️ counters correct, but the row-level trigger recounted the whole shelf once per changed row (a 1,190-item reorder: 1,190 recounts, 1.56 s); reconcile rewrote every shelf nightly and reported nothing; name non-blank and description ≤ 2,000 were API-only | A-11-010, -021, -023 |
| SH-02 | create/edit, unique slugs, 30-day soft delete | ❌ privacy change and delete never reached the feed (P0); no restore although the app promises one; no 200-shelf cap; a concurrent same-name create 409'd; non-Latin names lost their words in the slug; lengths counted in UTF-16 units | A-11-001, -003, -004, -005, -006, -007, -028 |
| SH-03 | detail, ranked numbering, notes, mosaic | ⚠️ item ratings were wrong (every attempt and private reads); the app showed only the first 100 books; ranked numbers had gaps after a removal | A-11-011, -012, -013 |
| SH-04 | add-to-shelf, membership | ❌ adding the 101st book answered 500 after committing it; no 1,000-book cap; concurrent adds all took position 1; a duplicate add un-ticked the box in the app; membership by a merged work id said "not on shelf" | A-11-002, -003, -009, -014, -025 |
| SH-05 | reorder (`PUT …/order`), move to position | ❌ partial or padded lists accepted (two books at #1), up to any length; the reorder screen asked for `limit=200` and the API refused it (422), so the screen never opened; PATCH position created duplicate positions | A-11-008, -010, -011, -012 |
| SH-06 | my shelves, starters | ⚠️ works; §6.35 duplicate-name warning missing | A-11-026 |
| SH-07 | save (reference, stays in sync) | ⚠️ sync and dynamic privacy hold; unsave leaked a hidden shelf's save count (P0 by the method's rule); saved list was an N+1 and unpaginated | A-11-015, -016 |
| SH-08 | browse, §15.5 ranking | ⚠️ views term missing; whole candidate set loaded and scored in Node; mutes ignored; `%` matched everything; no id tie-break | A-11-017, -018, -019, -020, -024, -032 |
| SH-09 | privacy on every read path | ✅ every read path, both slug aliases, the user list, saved, browse and both share pages are in the Part 05 matrix (8 viewers × 3 visibilities × 2 account types, bodies equal to a random id). Re-run here: 60/60. One write leaked: A-11-015 | A-11-015 |
| SH-10 | share pages, vanity URLs | ⚠️ escaping complete; base URL hard-coded, no canonical link, no cache headers; rename and username change break links (decision) | A-11-022, -028, -030 |

## Findings

### A-11-001 · P0 · Making a shelf private, or deleting it, left its books in followers' feeds
- **Where:** `shelves/index.ts` `update()` and `delete()` (before: no activity handling at all).
- **Evidence:** `addItem` writes a `shelved` activity row per book with `visibility = shelf.privacy` and `object_id = shelf id`. Neither the privacy change nor the delete touched those rows. Test: owner adds a book to a public shelf, a follower sees it in `GET /v1/feed?tab=friends`; owner sets the shelf to private; the follower still saw the card, with the shelf's name and the book (`expected 1 to be +0`). The same for a deleted shelf, and for a removed book (its card stayed).
- **Spec:** PRD §26.2 (a private item generates no activity), §26.1 ("switching to private retroactively restricts existing content"), §34.3.
- **Fix:** in one transaction with the update: private removes the shelf's activity, followers/public sets it (narrowed to followers on a private account, as `recordActivity` writes it), using the existing `updateActivityVisibility`. Delete removes the shelf's activity. Removing a book removes that book's card. A rename updates the cards' `shelfName`/`shelfSlug`. As with reads, making the shelf public again does not bring removed cards back.
- **Test:** `shelves-audit.test.ts` › *privacy changes and deletion reach the feed activity* (4 tests). Seen failing before the fix: yes (3 of 4; the private-account case held by accident, see the header).

### A-11-002 · P1 · Adding the 101st book answered 500, after committing it
- **Where:** `addItem` and `updateItem` (before: `getItems(viewer, shelfId, { limit: 100 })` then `.find()` the new item).
- **Evidence:** on a 100-book shelf, `POST …/items` → **500** `shelf_item_create_failed`. The insert had committed, so the book was on the shelf, the client showed an error, and the `shelved` activity (written after the lookup) was never recorded. `PATCH …/items/:workId` on item 101 → 404 after updating it.
- **Spec:** PRD §15.6 (shelves hold up to 1,000).
- **Fix:** both read back the one item by `work_id`.
- **Test:** *adding the 101st book returns the new item instead of a 500*. Seen failing before the fix: yes (`expected 500 to be 201`).

### A-11-003 · P1 · No limit on shelves per user or books per shelf
- **Where:** `create`, `addItem` (before: none).
- **Evidence:** 200 shelves → the 201st `POST /v1/shelves` was 201; a 1,000-book shelf accepted a 1,001st (it 500'd only because of A-11-002).
- **Spec:** PRD §15.6: max 200 shelves per user, 1,000 items per shelf.
- **Fix:** `409 shelf_limit_reached` at 200 live shelves (deleted ones do not count; restore checks it too) and `409 shelf_full` at 1,000 books. Both checks run under a lock (the user's advisory lock for shelves, the shelf's row lock for items), so concurrent requests cannot overshoot.
- **Test:** *refuses a 201st shelf*, *refuses a 1,001st book*, *restoring is refused at the 200-shelf limit*. Seen failing before the fix: yes.

### A-11-004 · P1 · "30-day recovery" had no way to recover
- **Where:** API (no endpoint), `app/shelf/[id]/edit.tsx` (the delete dialog says "You can recover it within 30 days").
- **Evidence:** `grep restore` found nothing; a deleted shelf was visible only by id to its owner.
- **Spec:** PRD §15.6: soft delete, 30-day recovery.
- **Fix:** `GET /v1/shelves/deleted` (the owner's shelves deleted in the last 30 days, with `deleted_at` and `purge_after`) and `POST /v1/shelves/:id/restore` (404 unless it is the viewer's, deleted, and within 30 days; 409 at the shelf limit). The slug was never released, so share links work again. New mobile screen `app/shelf/deleted.tsx`, linked from the bottom of **Shelves › Mine** ("Recently deleted shelves"). The hard purge after 30 days is not built: → Part 15 (retention sweep).
- **Test:** *soft delete is recoverable for 30 days* (3 tests) and the matrix row `POST /v1/shelves/:id/restore`. Seen failing before the fix: yes (routes absent).

### A-11-005 · P2 · Two creates with the same name: one 201, the rest 409
- **Where:** `create` (before: `generateUniqueSlug` then `INSERT`, no lock, no retry).
- **Evidence:** on the sandbox Postgres against `main`, 4 parallel `POST /v1/shelves {"name":"Dup …"}`: `201 409:conflict 409:conflict 409:conflict`, 5 runs out of 5. (Since Part 05 the unique violation maps to 409, not 500.) After the fix: `201 201 201 201`, 5 out of 5.
- **Fix:** creates and renames take a per-user advisory lock for the slug choice and the limit check, and retry on a unique violation (up to 3 times) for writers that do not take it.
- **Test:** *a create that loses the slug race … retries* (simulates the other writer with a one-shot trigger; seen failing before the fix: yes, `expected 409 to be 201`) and *concurrent creates with the same name all succeed* (PGlite serialises them, so this one passed on `main`; the real-Postgres repro above is the evidence).

### A-11-006 · P2 · Slugs dropped every non-Latin letter
- **Where:** `slugify` (before: `[^a-z0-9]+ → -`).
- **Evidence:** `Книги 2026` → `2026`; `本` and `हिन्दी किताबें` → `shelf`, so every such shelf of a user was `shelf`, `shelf-1`, `shelf-2`…
- **Fix:** keep letters, digits and combining marks of every script (`\p{L}\p{N}\p{M}`); fold only Latin diacritics (`Café` → `cafe`); NFC. Emoji-only names are still `shelf`. Applies to new slugs and renames; existing slugs are unchanged. `getBySlug` lowercases as before; Fastify decodes the percent-encoded path.
- **Checked, not a problem:** reserved words. Slugs are always the last path segment (`/u/:username/shelves/:slug`, `/v1/users/:username/shelves/slug/:slug`, `/v1/shelves/by-slug/:username/:slug`, mobile `app/u/[username]/shelves/[slug]`), so `new`, `edit`, `saved`, `browse` or `mine` cannot collide with a route.
- **Test:** *keeps non-Latin letters in slugs*. Seen failing before the fix: yes.

### A-11-007 · P2 · Length limits counted UTF-16 units, the schema and the database count characters
- **Where:** `create`/`update` name (`trimmedName.length > 60`), description, note; mobile `validateShelfName`, `validateShelfForm`, `validateShelfNote`.
- **Evidence:** a 60-emoji name passes the request schema (Ajv counts characters) and the `char_length(name) <= 60` check, but the service answered `400 invalid_shelf_name` (120 units).
- **Fix:** count code points on both sides.
- **Test:** API *counts the 60-character name limit in characters*; mobile *name and note limits count characters as the server does*. Seen failing before the fix: yes (both).

### A-11-008 · P1 · Reorder accepted a list that was not the shelf
- **Where:** `reorder` (before: one `UPDATE … WHERE work_id = ?` per id sent).
- **Evidence:** sending 3 of a shelf's 4 ids → 200; the missing book kept position 4… or, after a previous reorder, collided with a renumbered one (two books at the same rank). An id not on the shelf was silently ignored. No upper bound: 1,001 random ids → 200 (one UPDATE each). Empty array: 422 (schema), as claimed. Duplicates: 400, as claimed.
- **Spec:** brief; PRD §6.36.
- **Fix:** under the shelf's row lock, the list must be exactly the shelf's current set, else `409 order_mismatch` ("Reload and try again"); the app reloads on it. `maxItems: 1000` in the body schema. Positions are written in one statement.
- **Test:** *reorder takes exactly the shelf's current set* (missing, extra, duplicates/empty/1,001). Seen failing before the fix: yes.

### A-11-009 · P2 · Concurrent adds got the same position
- **Where:** `addItem` (before: `max(position) + 1` read outside the insert's transaction).
- **Evidence:** sandbox Postgres against `main`, 8 parallel adds to a new shelf: positions `1,1,1,1,1,1,1,1` in 4 of 5 runs (`1,2,2,2,2,2,2,2` in the fifth). After the fix: `1,2,…,8`, 5 of 5.
- **Fix:** the add runs in one transaction under the shelf's row lock (`SELECT … FOR UPDATE`), with the duplicate check, the cap and the position. `position` in the body now inserts at that rank (the rest shift).
- **Test:** *concurrent adds get distinct, consecutive positions* (PGlite serialises, so it passed on `main`; the repro above is the evidence).

### A-11-010 · P1 (perf) · A reorder recounted the shelf once per book
- **Where:** `0013` `shelf_items_counter_trigger` (row-level, recounts `item_count` and rebuilds the mosaic on every insert/update/delete) × `reorder` (one UPDATE per book).
- **Evidence (sandbox Postgres, the 1,190-item shelf, one statement reversing every position, rolled back):** old trigger **1,190 calls, 1,526 ms in the trigger, 1,561 ms total**; new trigger **1 call, 5.8 ms, 34.8 ms total** (45×). The old `reorder` also sent 1,190 separate UPDATEs. Architecture §3.9 already warns about exactly this on `reads`.
- **Fix:** migration **0034**: statement-level triggers with transition tables (`AFTER INSERT/UPDATE/DELETE … FOR EACH STATEMENT`), recounting each touched shelf once and writing only when something changed; the mosaic breaks ties on `work_id`. `reorder`, moves and gap-closing write all positions in one `UPDATE … FROM unnest(…) WITH ORDINALITY`.
- **Test:** *the exact set reorders to 1..n … in a bounded number of statements* (40 books: ≤ 12 statements; seen failing before the fix: yes) and *a reorder of 1,000 items* (timing guard, passed on `main` on PGlite; the sandbox measurement is the evidence). The existing trigger tests in `shelves-migration.test.ts` (insert, delete, mosaic cap) still pass on the new trigger.

### A-11-011 · P2 · Ranked numbers had gaps and duplicates
- **Where:** `removeItem` (left a gap), `updateItem` (stored any `position` as given).
- **Evidence:** removing #2 of 4 → the app showed #1, #3, #4 (`app/shelf/[id].tsx` shows `item.position`). `PATCH {position: 1}` on #4 → two books at #1.
- **Fix:** a removal shifts the books below it up one; `PATCH position` is a move within 1..n (past the end means the end).
- **Test:** *moving one item with PATCH position shifts the others*, *removing a book closes the gap*. Seen failing before the fix: yes.

### A-11-012 · P1 · The reorder screen could not open, and shelf detail stopped at 100 books
- **Where:** `app/shelf/[id]/reorder.tsx` (`getShelfItems(id, { limit: 200 })`), `app/shelf/[id].tsx` (`limit: 100`, no paging).
- **Evidence:** `GET …/items?limit=200` → **422** (schema maximum 100), so the reorder screen alerted and closed for every shelf. Detail showed the first 100 books of a 1,000-book shelf with no way to see the rest.
- **Fix:** `fetchAllShelfItems` (pages of 100, stops on a short page) for reorder, which must send the whole list (A-11-008); a "Show more (N more)" button on detail.
- **Test:** API *the items limit is capped at 100: the reorder screen's limit=200 is refused* (documents the contract); mobile *fetchAllShelfItems pages by 100…*, *…stops on a short page*. Seen failing before the fix: yes (mobile; the helper did not exist).

### A-11-013 · P1 · Shelf items showed a different rating from the work page
- **Where:** `getItems` SQL (before: `avg(r.rating)` over every row of `reads` for the work, per item).
- **Evidence:** one reader rated a book 1.0, re-read it and rated it 5.0: the work page (`work_stats.avg_rating`) says 5.0, the shelf said 3.0. It also counted private reads' ratings individually and cost a scan of the work's reads per row.
- **Fix:** `LEFT JOIN work_stats`, rounded to one decimal as before.
- **Test:** *an item's rating is the work page's rating*. Seen failing before the fix: yes (`expected 3 to be 5`).

### A-11-014 · P2 · "Is this book on my shelves?" said no for a merged work id
- **Where:** `getMyShelves(viewer, workId)`.
- **Evidence:** D3 (Part 03/08) moves shelf items to the survivor; a client holding the loser id saw every box unticked.
- **Fix:** resolve the id first, as the other shelf writes already do.
- **Test:** *GET /shelves/mine?work_id= with a merged work id*. Seen failing before the fix: yes.

### A-11-015 · P0 · Unsaving a hidden shelf answered 200 with its save count
- **Where:** `unsave` (before: checked only `deleted_at`).
- **Evidence:** `DELETE /v1/shelves/{private shelf}/save` → `200 {"saved":false,"save_count":N}`; a random id → 404. So any signed-in user holding a private or followers-only shelf's id learnt it exists and how many saves it has. The Part 05 matrix covered `POST …/save` but not `DELETE`. P0 by the method's rule ("anything visible that should 404"); the practical exposure is small (it needs the uuid).
- **Decision taken (safest, reversible):** the viewer's own save row is always removed (they lose nothing they could see), then a shelf they cannot see answers the random-id 404.
- **Test:** *unsaving a shelf you can no longer see…* and matrix row `DELETE /v1/shelves/:id/save (hidden shelf)` (5 viewer relationships × 2 account types). Seen failing before the fix: yes (both).

### A-11-016 · P2 · Saved shelves: one statement per owner, a fake owner on error, no paging (L-10)
- **Where:** `getSavedShelves`.
- **Evidence:** sandbox, a user with 25 saves: **25 statements** (owner lookups in a sequential loop plus covers); a broad `catch` substituted `username: 'user'`.
- **Fix:** one statement: owners joined, covers as an ordered `ARRAY(…)` subquery, `is_saved`, `count(*) OVER ()`; `canViewSql` unchanged. `limit` (default 50, max 100) and `offset`, and `total` in the response; the app's Saved tab shows "Show more saved shelves". **25 → 1 statement.**
- **Test:** *GET /shelves/saved costs the same number of statements for 2 owners as for 12* (`expected 13 to be 3` before), *…pages with limit and offset and reports the total*. Seen failing before the fix: yes.

### A-11-017 · P2 · Browse showed shelves of muted users
- **Where:** `browse` (blocks were filtered, mutes were not).
- **Spec:** method "Mutes hide the target"; PRD §26.3.
- **Fix:** the viewer's user mutes join the blocks in one `NOT IN` set. Nothing tells the muted user.
- **Test:** *hides shelves of users the viewer muted*. Seen failing before the fix: yes.

### A-11-018 · P2 · `%` and `_` in the browse search were wildcards
- **Evidence:** `?query=%` returned every public shelf; `?query=_` matched any name.
- **Fix:** escape `\ % _`, `ESCAPE '\'`.
- **Test:** *treats % and _ in the search as literal characters*. Seen failing before the fix: yes.

### A-11-019 · P1 (perf) · Browse loaded and scored every public shelf in Node (L-18)
- **Where:** `browse` (before: select all candidates, a notes `GROUP BY` over all their items, sort in JS, slice, then one profile query per owner on the page).
- **Evidence (sandbox, 4,005 shelves):** **26 statements** for a signed-in viewer (23 for a guest). The candidate query shipped 2,989 full rows; the notes query seq-scanned all 84,708 items (801 buffers). See Performance.
- **Fix:** one statement: the candidate filter, the §15.5 score, `count(*) OVER ()`, `ORDER BY … LIMIT/OFFSET` on bare rows, then cards (owner, covers, saved) built for the page only. "Has per-entry notes" is an index-only probe of the new partial index `shelf_items_noted_idx`. Trigram indexes on `name` and `description` for the search (the planner seq-scans at 4k shelves, which is right at that size). **26 → 1 statement**; plan total 276 shared buffers.
- **Same results:** old and new servers side by side on the same sandbox data: the first 50 of `popular` and `recent` have identical sort-key sequences, and the first 50 of `ranked` (guest) identical score sequences; the order differs only inside exact ties, which the new code breaks by `id` (A-11-020). Totals equal (2,989; 86 for `shelf 12`).
- **Test:** *costs a constant number of statements however many shelves and owners exist* (`expected 22 to be ≤ 4` before). The ranking itself is pinned by the existing SH-08 tests (curation, social proximity, popular/recent), which pass unchanged. Seen failing before the fix: yes.
- **Remaining risk → A-11-032.**

### A-11-020 · P3 · Browse pages had no total order
- **Evidence:** by code reading. `recent` ordered by `created_at` only; `popular` by saves then `created_at`; `ranked` used an epsilon comparator (`|a-b| > 0.0001`), which is not transitive. Shelves created in the same transaction tie. Not reproduced: the JS sort is stable and the candidate query happened to return a stable order.
- **Fix:** every order ends on `id`; the ranked score is rounded to 4 places in SQL, then saves, `created_at`, `id`.
- **Test:** *pages are disjoint and complete under every sort, even when shelves tie on every key* (a guard; passed on `main`).

### A-11-021 · P2 · `reconcile_shelf_counters()` rewrote every shelf every night and reported nothing
- **Evidence:** an unconditional `UPDATE shelves` over all rows (a dead tuple per shelf per night); `RETURNS void`, so the job could not log drift. SO-20 established "writes only drifted rows and returns how many" for `reconcile_read_counters()`.
- **Fix:** 0034 replaces it: `RETURNS integer`, `IS DISTINCT FROM` guard. The job handler is unchanged (it ignores the value; logging it is a one-line follow-up for Part 15's job pass). After 0034 on the sandbox: `0` drifted.
- **Test:** *reconcile_shelf_counters returns how many shelves it fixed and writes only drifted rows*. Seen failing before the fix: yes. The existing drift test in `shelves-migration.test.ts` still passes.

### A-11-022 · P3 · Share pages: hard-coded host, no canonical link, no cache policy
- **Where:** `renderShelfHtml` (`baseUrl = 'https://flyleaf.app'`), `shelvesWebPlugin`.
- **Evidence:** every interpolation was already escaped (`escapeHtml` on name, username, display name, description); the canonical URL used `encodeURIComponent` only, ids were raw (uuids from the database, so not exploitable). There is no `og:image` field at all, so nothing to escape there. No `cache-control`.
- **Fix:** `config.appBaseUrl` (production default unchanged), `<link rel="canonical">`, `escapeHtml` on the canonical URL and ids too; `cache-control: public, max-age=300` for a guest viewing a public shelf, `private, no-store` otherwise (5 minutes bounds how long a shelf made private stays in a shared cache, PRD §34.3).
- **Test:** *uses the configured base URL, a canonical link, and cache headers by audience*. Seen failing before the fix: yes.

### A-11-023 · P3 · Name non-blank and description ≤ 2,000 were API-only
- **Fix:** 0034 adds `shelves_name_not_blank_ck` and `shelves_description_length_ck`, both `NOT VALID` so applying them never fails on an old row; every new write is checked. Note ≤ 280 and name ≤ 60 were already DB checks.

### A-11-024 · P1 (spec gap) · The ranking's `views` term is always 0
- **Evidence:** there is no view counter, so `0.20·log(1+views)` contributes nothing; tasks.md claimed the full formula.
- **Decision (taken here, reversible):** record it as a **spec gap** rather than build a counter in this part. A counter is a write on every shelf view (a hot read path) and needs abuse resistance; the cheap shape is one row per (shelf, viewer or guest session, day) in an unlogged-tolerant table, rolled up nightly into `shelves.view_count`, and it belongs with Part 15's telemetry and retention work. Until then the other weights are unchanged (they are not renormalised), so ranking order is the formula's with views = 0 for every shelf. tasks.md SH-08 corrected.

### A-11-025 · P2 · A duplicate add un-ticked the box
- **Where:** `src/ui/AddToShelfSheet.tsx`.
- **Evidence:** tapping an unticked shelf that already holds the book (another device, a stale list) → `409 duplicate_shelf_item` → the optimistic tick was reverted and an error haptic played, although the book is on the shelf.
- **Fix:** `isAlreadyOnShelf(err)` keeps it ticked (and restores the count).
- **Test:** mobile *isAlreadyOnShelf: a duplicate add means the book is on the shelf*. Seen failing before the fix: yes (helper absent).

### A-11-026 · P2 · No warning for a duplicate shelf name
- **Spec:** PRD §6.35 "Name collision within a user's own shelves → allowed but warned".
- **Fix:** `app/shelf/create.tsx` loads the user's shelf names and asks "Create anyway?" on a case-insensitive match (`findNameCollision`).
- **Test:** mobile *findNameCollision…* (new helper; written with it, not seen failing).

### A-11-027 · P2 (process) · The `55f72e3` regression did not pass CI; main stayed red for seven pushes
- **Evidence:** `d8f7c73` (22 Sep) dropped `.where(and(...whereConditions))` from `browse`. Its GitHub Actions run **failed**, as did the next six pushes to `main` (`780905d` … `55d1d83`); `55f72e3` restored the line and was the first green run. Checked out `d8f7c73` here: **5 browse tests fail** (`shelves.test.ts` ×4, `shelves-privacy.test.ts` ×1). So the tests caught it; work simply continued on a red `main`. Today, removing the line again fails 6 tests, including the Part 05 matrix row for browse.
- **Fix / recommendation:** turn on branch protection for `main` requiring the `CI` check (or merge only through PRs). A GitHub setting, owner's call: **DEFERRED → owner**.

### A-11-028 · DECISION NEEDED · Renaming a shelf or a user breaks its share link, and the old link can later open a different shelf
- **Evidence:** a rename regenerates the slug; `/u/alice/shelves/old-name` then 404s, and the freed slug can be taken by Alice's next shelf with that name, so an old link opens the wrong list. A username change breaks every vanity link of that user. Links by id (`/shelf/:id`, `flyleaf://shelf/:id`) are unaffected.
- **Spec:** PRD §15.2 ("Slug for future web URLs"), §29.1 (share links must not be dead). Nothing on renames.
- **Options:** (a) keep the slug fixed at creation (simplest; slugs drift from names); (b) a `shelf_slugs` history table, old slugs reserved and redirected (301) to the current one; (c) as is, document it. Username changes need the same for profiles (Part 13).
- **Recommendation:** (b), with the profile equivalent in Part 13. **Left as is** until decided.

### A-11-029 · P3 · Shelf owners carry `avatarKey`, not a URL
- Every other surface (feed, profiles) returns `avatar_url` via `avatarUrl()`. No screen renders a shelf owner's avatar today. → Part 13 (profile/social consistency) or Part 15.

### A-11-030 · P3 · `https://flyleaf.app/u/…/shelves/…` does not open the app
- `app.json` declares App Links only for `/verify-email` and `/reset-password`. The share page's "Open in Flyleaf App" button uses `flyleaf://shelf/:id`, which works. Adding the path is a native change: batched with the post-Part 14 rebuild (README pending native changes).

### A-11-031 · RL · No rate limits on shelf writes
- Create, add, reorder, save and unsave have none (PRD §24.4; A-05-RL2 "writes 120/min"). → Part 15.

### A-11-032 · P2 (perf, 10×) · Browse still scores every public shelf per request
- **Evidence:** the ranked plan computes the score for all 2,989 candidates (WindowAgg over the join, 17 ms in the sandbox) before taking 20. Cost grows with the number of public shelves, not the page.
- **Plan (proportional to the next order of magnitude):** a `browse_base_score` column for the viewer- and time-independent part (`0.30·ln(1+saves) + 0.15·curation`), kept by the item/save triggers and the nightly reconcile, with an index; then take the top few hundred by base score plus the viewer's followed owners' shelves, and finish the exact score on that set (social ≤ 0.20 and freshness ≤ 0.15 bound how far a shelf can move). `total` would become an estimate or a cached count. → Part 15 (perf comparison) or post-audit.

### A-11-033 · P3 · Deleted shelves are never purged
- Restore stops at 30 days, but the rows stay. → Part 15 retention sweep (with `rate_limits`, uploads, deleted accounts).

### A-11-034 · P3 · The unranking warning says the order will be lost; it is kept
- PRD §6.35 asks for that warning, and `edit.tsx` shows it, but the server keeps positions, so switching back restores the order. Harmless; left as the spec words it.

## Decided here

### D-11-1 · Want-to-read is a read status, not a shelf (for Part 14's feed swipe)
- **Rule:** PRD §15.1 (and §8.2): `Want to read` is a status on the read record; shelves are only user-curated lists. There is no want-to-read shelf, and `POST /v1/shelves/want-to-read/items` (claimed in SO-15) does not exist.
- **Wiring for Part 14:** the swipe calls `POST /v1/reads {work_id, status: 'want'}` **only when the viewer has no read of that work**. If they have one (reading, paused, finished, dnf, or already want), the swipe does not write: setting `want` would move a book being read back to want-to-read, or start a re-read of a finished one (Part 07, A-07-012). Show "Already in your library" instead. Undo deletes the read the swipe created (`DELETE /v1/reads/:id`, available since Part 08), and only that one. Offline: through the existing reads queue.
- tasks.md SO-15 corrected.

## Performance

Sandbox PostgreSQL 18.3, synthetic data (header). Statement counts from `BENCH_COUNT_QUERIES=1` (`x-bench-query-count`), one request at a time; 30 requests per row after one warm-up. **Latencies: not measured on flyleaf_dev — rerun on the laptop.**

| Endpoint | Statements before → after | Sandbox p50 / p95 ms before → after | Plan notes |
|---|---|---|---|
| `GET /v1/shelves/browse` ranked, viewer following 1,100 | **26 → 1** | 117.8 / 144.7 → 19.1 / 28.0 | before: 2,989 rows to Node (228 buffers) + notes seq scan of 84,708 items (801 buffers) + 20 owner lookups. After: one plan, 276 shared buffers; notes via `shelf_items_noted_idx` (index-only, 24 buffers); follows and blocks/mutes as hashed subplans |
| browse ranked, guest | **23 → 1** | 93.9 / 123.5 → 22.1 / 26.4 | |
| browse popular, page 3 | **26 → 1** | 106.8 / 135.2 → 7.2 / 9.7 | |
| browse search `shelf 1` | **26 → 1** | 53.8 / 68.1 → 14.2 / 20.4 | seq scan at 4k rows (planner's choice); trigram indexes in place for scale |
| `GET /v1/shelves/saved`, 25 saves | **25 → 1** | 23.7 / 36.4 → 4.6 / 8.5 | |
| `GET /v1/shelves/:big/items` p1 (1,190 items) | 4 → 4 | 5.6 / 8.4 → 6.9 / 15.2 | the sandbox has no reads, so the old per-row `avg(reads)` cost nothing here; on `flyleaf_dev` it was the L-18 cost. Rerun on the laptop |
| same, offset 950 | 4 → 4 | 12.6 / 18.9 → 14.1 / 21.7 | OFFSET over ≤ 1,000 rows of one shelf, on `shelf_items_order_idx` |
| Reverse a 1,190-item shelf (one UPDATE, trigger cost) | 1,190 trigger calls → 1 | 1,561 → 34.8 (EXPLAIN ANALYZE) | 45×, hardware-independent: the call count |

## Behaviour changes

1. A shelf made private removes its books' feed cards; followers-only narrows them; deleting a shelf removes them; removing a book removes its card; a rename updates the cards' shelf name and link. Cards removed are not restored by making the shelf public again or by restoring it.
2. `POST /v1/shelves` → `409 shelf_limit_reached` at 200 live shelves. `POST /v1/shelves/:id/items` → `409 shelf_full` at 1,000 books.
3. New: `GET /v1/shelves/deleted`, `POST /v1/shelves/:id/restore` (api-client `getDeletedShelves`, `restoreShelf`).
4. `PUT /v1/shelves/:id/order` → `409 order_mismatch` unless the list is exactly the shelf's books; more than 1,000 ids → 422.
5. `PATCH /v1/shelves/:id/items/:workId {position}` moves the book (others shift, clamped to 1..n); it used to store the number as given. `POST …/items {position}` inserts at that rank. Removing a book shifts the ones below it up.
6. Adding a book past the first 100 returns 201 with the item (was 500).
7. Item `rating` is the work page's `avg_rating` (one decimal).
8. `GET /v1/shelves/mine?work_id=` accepts a merged work id.
9. `DELETE /v1/shelves/:id/save` on a shelf the viewer cannot see → 404 (the random-id body), after removing their save.
10. `GET /v1/shelves/saved` is paged (`limit` default 50, max 100; `offset`) and returns `total`. Shelves of owners whose profile lookup failed are no longer shown as `@user`.
11. Browse hides muted users' shelves; `%`, `_`, `\` are literal; every sort has a total order.
12. Slugs keep non-Latin letters (new shelves and renames only).
13. Length limits count characters (an emoji is one) in the API and the app.
14. Share pages: canonical link, `cache-control`, base URL from `APP_BASE_URL`.
15. Concurrent same-name creates all succeed (`name`, `name-1`, …).
16. App: reorder loads every book (it could not open before); shelf detail pages with "Show more"; Saved tab pages; a duplicate add stays ticked; duplicate-name warning on create; "Recently deleted shelves" screen.

## Decisions needed

- **A-11-028:** slug and username changes break share links, and a freed slug can be reused. Recommendation: slug history with redirects (b).
- **A-11-027:** branch protection on `main` (owner's GitHub setting).

## Deferred (with reason and owner)

| Item | Why deferred | Owner |
|---|---|---|
| **Apply migration 0034 to `flyleaf_dev` and `flyleaf` on the laptop** | Sandbox has neither; `flyleaf_dev` must stay unchanged until Part 15's perf comparison is taken, so apply 0034 to it only as part of Part 15's "after" run (or right after its "before"). On `flyleaf` it is safe any time: small tables, the two new CHECKs are `NOT VALID` | Laptop session / Part 15 |
| **Rerun the shelf latencies on `flyleaf_dev`** (browse, big-shelf items, saved; Part 01 personas) | All latency numbers here are "not measured on flyleaf_dev — rerun on the laptop" | Part 15 perf comparison |
| Views counter for §15.5 (A-11-024) | Needs a write path on views and abuse resistance | Part 15 |
| Browse at 10× (A-11-032) | Plan above; not needed at today's volume | Part 15 / post-audit |
| Purge shelves deleted > 30 days (A-11-033) | Retention sweep is built once | Part 15 |
| Rate limits on shelf writes (A-11-031) | One limiter layer | Part 15 |
| Log `reconcile_shelf_counters()`'s count in the job | One line; with the job pass | Part 15 |
| Owner `avatar_url` on shelves (A-11-029) | Consistency, no screen affected | Part 13 |
| App Links for shelf URLs (A-11-030) | Native change | After Part 14 (batched rebuild) |
| Want-to-read swipe wiring per D-11-1 | Swipe belongs to Part 14 | Part 14 |

## CI result

See the PR. `node scripts/ci.mjs` in the sandbox (`FLYLEAF_TEST_WORKERS=2`, Postgres 18.3 reachable, so step 9 ran): result recorded in the commit/PR description and below.

## Phone checklist (no native change; a JS reload is enough)

1. Shelves › a shelf with > 100 books: "Show more" loads the rest; ranked numbers continue (#101…).
2. Reorder screen opens on any shelf (it used to bounce); move a book; save; numbers are 1..n.
3. Remove a book from a ranked shelf: no gap in the numbers.
4. Delete a shelf → Shelves › Mine › "Recently deleted shelves" → Restore → it opens.
5. Add a book from the book page on a second device to the same shelf, then tap that shelf in the sheet on the first: stays ticked.
6. Create a shelf with the name of an existing one: "Create anyway?".
7. Saved tab with > 50 saved shelves: "Show more saved shelves".
8. Make a shelf private: its books disappear from a follower's Home feed.
