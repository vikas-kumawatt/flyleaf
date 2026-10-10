# Audit 14 — Feed (SO-10 … SO-15), with D-11-1 and D-13-1

2026-10-10 · CI: see "CI result" at the end · Tests: API **1,585 → 1,610** (+25 in the new `feed-audit.test.ts`); mobile **189 → 207** (+12 in `home-feed.test.ts`, +6 in `want-to-read.test.ts`). No test was weakened or skipped. One existing assertion pinned behaviour this part changed on an owner decision (D-13-1) and was updated with a comment (see "Behaviour changes" › "Tests changed").

**How this part ran.** In a cloud sandbox (Linux), not on the laptop. Overrides from the owner for this run:

- **No `flyleaf` / `flyleaf_dev`, no Docker.** A local **PostgreSQL 18.3** (the `@embedded-postgres/linux-x64@18.3.0-beta.16` npm package, as in Parts 12–13) on port 5432 with an empty `flyleaf` database; `npm run migrate` ran clean on it. **MinIO** built from source (`go install github.com/minio/minio@RELEASE.2025-04-22T22-12-26Z`) on :9000, so the S3 contract tests ran in CI.
- **No new migration in this part.** Nothing needed a schema change (the prune uses `activity_visibility_idx`, the friends query `activity_actor_idx`). So there is nothing to apply to `flyleaf` on the laptop from Part 14.
- **No bench data.** The sandbox database got a **synthetic catalog** (30,000 works `Synthetic Work n`, one edition and one author each; script in the session, not committed) and then the **real Part 01 bench seed** on top (`npm run bench:seed`: 3,000 `bench_*` users, 186,014 follows, 142,152 activity rows, the `heavy` persona following 1,158). **Every latency and buffer count below is "sandbox, synthetic"**: only ratios, plan shapes and statement counts are evidence. `npm run bench:seed -- --clean` removes the bench part.
- Branch `audit/14-feed` from `main`, committed, pushed, PR to `main`.

**"Seen failing".** `feed-audit.test.ts` was run against unmodified `main` before any fix (with the prune import made optional so the file loads): **18 of its first 23 tests failed**, each for the reason its finding names (outputs quoted below). The 5 that passed on `main` are guards named as such. The tests added later were each seen failing by reverting the fix or mutating the rule (named per finding). Two bugs cannot show on PGlite and were shown on Postgres instead: the comment cursor (A-14-020: PGlite's clock has millisecond resolution) and every plan.

## Owner decisions recorded at the start of this part

- **D-13-1 = (b):** a single accepted follow request writes a `followed` card; the bulk accept when an account goes public writes none. **Built** here (A-14-016). Recorded in `findings/13-social-graph.md` › Decisions.
- **D-13-2:** existing followers stay when an account goes private. **PRD §11.1 amended** ("turns new follows into requests requiring approval; people who already follow the account stay followers. Amended 10 Oct 2026, audit D-13-2."). No code change. Recorded in `findings/13-social-graph.md` › Decisions.
- **D-13-3 confirmed:** old usernames stay reserved while the account exists. Recorded in `findings/13-social-graph.md` › Decisions.
- **D-11-1 (from Part 11), built here:** the want-to-read swipe is a read with status `want`, written only when the reader has no read of the book; Undo deletes only the read the swipe created (A-14-011).

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| SO-10 | activity on every action, visibility respected, imports excluded, retroactive privacy | ⚠️ writers, import exclusion (Part 12's test) and lifecycle hold (guards); but no 180-day prune, going public left everything followers-only, a single accepted request wrote no card (now D-13-1), and `rated`/`goal_reached`/`quoted` have no writer | A-14-006, A-14-007, A-14-016, A-14-019 |
| SO-11 | cursor-paginated feed, blocks/mutes excluded | ❌ pagination lost and repeated cards; a malformed cursor silently served page one; "followed" cards showed people in a block with the viewer (P0); the friends query seq-scanned `activity` and sorted to disk; Popular has no popularity signal | A-14-001, A-14-004, A-14-008, A-14-009 |
| SO-12 | weights, 36 h decay, affinity, four diversity rules | ⚠️ weights and decay exact; rules 1, 2 and 4 hold; **affinity was never supplied**, so rule 3 ("someone you engage with rarely") was a no-op and the ranking was weight × decay | A-14-002, A-14-018 |
| SO-13 | aggregation of shelf adds, follows, starts | ⚠️ groups correctly; but aggregated shelf cards lost the shelf name, aggregates carried no member ids, follow aggregates named every target "reader" | A-14-004, A-14-005, A-14-021 |
| SO-14 | never empty, 0 / 1–3 / >3 follows | ❌ the 1–3-follows feed **never ended** (Popular re-blended on every page, `has_more` always true) and could repeat a followed reader's card; the editorial card appeared at the end of every feed; `following_count` counted deleted accounts | A-14-001, A-14-003 |
| SO-15 | card types, swipe actions, Home with real cards | ❌ Home rendered **hard-coded samples**; the want-to-read swipe called nothing; Rate & Review opened the generic search; review cards showed no text and no spoiler blur from real payloads; hex colours; the editorial card linked to a nil-UUID profile | A-14-010 … A-14-015, A-14-022 |
| SO-21 (perf only) | `interaction` on feed items in 2 queries | ✅ one query per page (`interactionsFor`), not two; ~1–2 ms | — |

## Findings

### A-14-001 · P1 · Cursor pagination lost and repeated cards; the sparse feed never ended; a bad cursor served page one
- **Where:** `activity/index.ts` `getFriendsFeed` / `getPopularFeed` (before): fetch `max(limit × 3, 60)` by `created_at DESC`, re-rank in TypeScript, return the first `limit`, `next_cursor` = the **last returned item's** `created_at`, `has_more = rows.length > limit`.
- **Evidence (`main`, `feed-audit.test.ts`):** a 200-activity friends feed (12 readers, every verb, pairs sharing a timestamp) walked to its end: at limit 20 the pages served **93 cards, 83 distinct** (`expected 93 to be 83`), at limit 7 **67 served, 46 distinct**, and activities were missing. Cause: ranking reorders, so the last returned card is not the oldest candidate; the next page (`created_at < cursor`) skipped every unreturned candidate newer than it and could serve old ones again; `created_at` alone also skipped rows sharing the cursor's millisecond. The popular feed (guest) failed the same way. A 1–3-follows feed **never ended** (the walk hit its 200-page cap: `Error: feed never ended`), see A-14-003. A malformed cursor (`not-a-cursor`, `2026-13-45T00:00:00Z`) answered 200 with page one (`expected 200 to be 400`), so a client with a damaged cursor looped. On every feed's last page the "never empty" editorial card was appended (it was added whenever a page had no items, cursor or not).
- **Spec:** PRD §12.3 (chronological-first, light re-ranking), §12.7 ("cursor-paginated"), §12.6 (a visible end), §6.13.
- **Fix (option chosen and why):** each page ranks **one chronological window** a quarter larger than the page (`#collect` reads the newest rows after the cursor, cut where the next row would start one card too many, so a page holds whole aggregates). The cards that do not make the page (outranked, or no slot they can take without breaking a hard rule) are **deferred**: their ids ride in the cursor and the next page keeps them a slot (`rankWindow`, `forcedIds`), relaxing a rule only for a card that has already waited one page. The cursor is opaque base64url JSON `{t, i, d, s}`: the last consumed row's `created_at` at **microsecond** precision (`to_char(… 'US')`), its id (tie-break), the deferred ids (≤ 60), and the stream (`p` when a friends feed is showing Popular). Malformed → **400 `invalid_cursor`**. The editorial card is page-one only. Why this option against §12.3/§12.7: it keeps the feed chronological-first (a page is a slice of time, ranked within itself), AC-11's hard rules hold on every page wherever the window allows them, nothing is dropped, and paging stays O(page) with no server state. "Rank page 1 only, chronological after" would have given up §12.4 on every later page; a cursor of "served ids" alone would grow without bound. Ranking is deterministic (ties: newer, then higher id; `now` scales every score alike, so it cannot reorder).
- **Test:** `feed-audit.test.ts` › *walks a 200-activity friends feed at limit 20 / 7: each id once, none missing*, *walks the popular feed exactly once too (guest)*, *a malformed cursor is 400 invalid_cursor*, *the same request twice gives the same order*, *defers what no slot can take instead of dropping it…*. Seen failing before the fix: yes (numbers above). The deferral test fails on `main` (`['s0','s1']` returned, three cards dropped).

### A-14-002 · P1 · `affinity` was never supplied: rule 3 was a no-op and the ranking was weight × decay
- **Where:** both feeds called `rankAndDiversifyFeed(items, limit, { now })`; `affinity()` defaulted to 1.0; rule 3 only runs `if (effectiveOpts.affinities)`.
- **Evidence (`main`):** 18 reviews by five readers the viewer likes and comments on, 2 older DNFs by a reader they never engage with: none of the rare reader's cards in the first 10 (`expected false to be true`). A liked reader and a mutual follow ranked no higher than a plain follow at equal weight and age (`expected 2 to be less than 1`).
- **Spec:** PRD §12.3 (affinity "higher for people whose activity you engage with, and for mutual follows"), §12.4 rule 3, architecture §8.
- **Fix:** `ActivityService.affinitiesFor(viewer, actors)`: one statement for the page's actors: 0.75 for a reader the viewer follows but never engages with (below `LOW_AFFINITY` 0.8: "someone you engage with rarely"), +0.25 for a mutual follow, +0.1 per like or live comment on their reads in the last 90 days (max 5), so 0.75–1.5. Friends feed only (Popular has no "you"). **Spec gap recorded, not built:** §12.3 says "learned from taps"; taps are not recorded server-side (no `feed_card_tapped` ingestion into ranking). Likes, comments and mutual follows are what exists.
- **Test:** *a reader the viewer never engages with gets a card in the first 10*; *engaged and mutual readers outrank a stranger-like follow*. Seen failing before the fix: yes. Mutation: removing the rule-3 branch fails the first.

### A-14-003 · P1 · Cold start: the 1–3-follows feed never ended, repeated readers' cards, and counted deleted follows
- **Where:** `getFriendsFeed` scenario 2 / 3 (before).
- **Evidence (`main`):** for 1–3 follows, every page (cursor or not) called `getPopularFeed(viewer, { limit })` **without a cursor** and blended its newest items in again, so pages never ran out (`has_more` true) and the same Popular cards came back on every page; Popular included the followed readers' own public activity, so a friend's card could appear both as "Popular on Flyleaf" and in the friends stream. `following_count` was `COUNT(*)` of accepted follows including deleted accounts (`expected 4 to be 3`), which can flip a reader between the 1–3 and >3 scenarios.
- **Spec:** PRD §12.5, §12.6 (visible end).
- **Fix:** blending is page one only, from people the viewer does not follow (and not the viewer), taking a quarter of the page; a Popular card that does not fit is dropped, not deferred (it is not part of the friends stream). ">3 follows with nothing in 180 days" serves Popular labelled "While you wait" and continues it page by page (`s: 'p'` cursor), then ends. `following_count` is a live count of accepted follows of live accounts (not the profile counter, which can drift: Part 13).
- **Test:** *1–3 follows: popular cards appear on page 1 only, never from followed readers, and nothing repeats*; *following_count is a live count…*; *the editorial card is page-one only and has no interaction*. Seen failing before the fix: yes (first two); the third is a guard of the nil-UUID card's `interaction: null` (passes on `main`).

### A-14-004 · P0 · "Followed" cards showed people who are in a block with the viewer, and deleted accounts
- **Where:** feed queries (before): a `followed` card was filtered on its **actor** only.
- **Evidence (`main`):** viewer V follows A; A follows B1 (who blocked V), B2 (whom V blocked), a deleted account, and C. V's feed showed all four targets (`expected [ …(4) ] to deeply equal [ Array(1) ]`), each card carrying the target's user id: B1 is visible to someone B1 blocked, which PRD §11.4 rules out (complete bidirectional invisibility; B1's followers list is a 404 to V), and the deleted account appears though accounts are hidden platform-wide (§25.4). Cards also named no one ("followed a reader"): the API sent no target name.
- **Spec:** PRD §11.4, §34.3, §25.4; method: "anything visible that should 404" is P0.
- **Fix:** `followedTargetVisible()` in both feeds: a followed card is shown only if its target is live, in no block with the viewer either way, and not muted by the viewer (guests: live only). The card carries `metadata.target_username` / `target_display_name` from a join on the target's profile, and follow aggregates list each target by name.
- **Test:** *a card about someone in a block with the viewer, or deleted, is not shown; others carry the target*; *aggregated follows list each target with a username*. Seen failing before the fix: yes.

### A-14-005 · P2 · Aggregated cards lost the shelf name and carried no member ids
- **Where:** `ranking.ts` `aggregateFeedItems` read `shelf_name`; `ShelvesService` writes `shelfName`. Aggregates kept only the newest member's id.
- **Evidence (`main`):** three adds to "Monsoon Reading" became one card with `shelf_name: null` ("added 3 books to"); `metadata.activity_ids` absent (`TypeError: card.metadata.activity_ids is not iterable`), so neither the client nor a test could tell which activities a card stood for.
- **Fix:** reads `shelfName` (then the old names); every aggregate carries `metadata.activity_ids`. The grouping key is one function (`aggregationKey`) used by aggregation and by the window cut.
- **Test:** *uses the shelfName the shelves service writes*; the exactly-once walks count aggregate members. Seen failing before the fix: yes.

### A-14-006 · P1 · No 180-day activity prune, and the feed read unbounded history
- **Where:** no job; feed queries had no time bound.
- **Evidence:** `grep activity` in `jobs/` and `worker.ts`: nothing. A 181-day-old card was served (`expected [ …(2) ] to not include …`).
- **Spec:** PRD §23.5 ("`activity` rows: 180 days, then pruned — the feed never looks back further").
- **Fix:** `activity.prune` pg-boss queue, `pruneActivityJobHandler` (batches of 5,000 via `activity_visibility_idx`, each its own short statement, at most 1,000 batches a run), scheduled daily at 03:55 UTC after the reconcilers. Both feed queries bound `created_at > now() - 180 days`, so the feed never looks further even before a prune runs. **Nothing references an activity id:** likes and comments live on reads (SO-21); dedupe's undo log (`catalog/dedupe.ts` `activity_ids`) may name pruned ids, and its `UPDATE … WHERE id = ANY` then matches nothing (harmless).
- **Test:** *deletes activity older than 180 days in batches and keeps the rest; the worker schedules it*; *the feed never shows activity older than 180 days, pruned or not*. Seen failing before the fix: yes.

### A-14-007 · P2 · Going public again left every card followers-only
- **Where:** `ActivityService.setAccountPrivacy` only handled `isPrivate = true`; `IdentityService.updateProfile` called it only then.
- **Evidence (`main`):** a public read's card stayed `followers` after private → public (`expected [ 'followers', 'followers' ] to deeply equal [ 'public', 'followers' ]`), while `canView()` showed the read to everyone: the item was public, its card was not.
- **Spec:** PRD §16.3 (public profile: "per-item visibility"), §26.1; FN-71 (one `canView()`).
- **Fix:** going public widens a card back to `public` only where its item is public: reads (`reads.visibility`), reviews (review and read both public, not deleted), shelf adds (shelf public, not deleted), and follow cards. A followers-only read stays followers-only.
- **Test:** *going public again restores each card to its item's own visibility*. Seen failing before the fix: yes.

### A-14-008 · P1 (budget) · The friends query seq-scanned `activity` and sorted to disk for a heavy follower
- **Where:** friends query (before): `JOIN follows` + hash join over all of `activity`, sort, `LIMIT 60`, display joins first.
- **Evidence (sandbox, synthetic; `EXPLAIN (ANALYZE, BUFFERS)` for `heavy`, 1,158 follows):** `Parallel Seq Scan on activity` (142,152 rows read, 54k joined), `Sort Method: external merge Disk: 5128kB`, shared hit 4,808 + temp read 693 / written 1,099, 54–94 ms execution, to return 60 rows. Its cost grew with **everything those 1,158 people did in the retained history**, not with the page. Bench (10 connections): p95 **494 ms** page 1, 499 ms page 2, over the §12.7 trigger (200 ms; indicative only). A typical viewer's plan joined profiles/works for all 1,937 candidate rows before the limit.
- **Spec:** PRD §12.7 / architecture §8 (p95 < 200 ms migration trigger), §43.
- **Fix:** (1) one statement shape (`feedQuery`): the inner query filters, orders and limits on `activity` alone; display joins run for the page's rows only. (2) For a viewer following ≥ 200, the window is tried at 1, 7 and 30 days back from the cursor before the whole horizon; below 200 one query over the horizon is cheaper than a short try plus a retry (each costs ~8 ms of planning here). After (`heavy`): `activity_actor_idx` probed once per followee within one day (1,158 index scans, 1,947 rows), `top-N heapsort Memory: 61kB`, **no seq scan of `activity`, no temp files**, 12,635 shared hits, 27.5 ms execution, 4.7 ms planning. The buffer count is higher than before (probes per followee instead of one sequential pass) but it grows with the follow count and the day's activity, not with history; the seq scan and spill are gone. `typical` (40 follows): 4,132 buffers, 16.6 ms.
- **Migration trigger (§12.7):** **not hit after the fix in the sandbox** (heavy load p95 161–164 ms); it was hit before (494 ms). Sandbox, synthetic: **rerun on the laptop** (Deferred).
- **Test:** plan evidence above (PGlite does not plan like Postgres). The behaviour is covered by the exactly-once walks.

### A-14-009 · P1 · DECISION NEEDED · Popular is not "popular"
- **Where:** `getPopularFeed`: all recent public activity, ranked in its window by weight × decay.
- **Evidence:** no engagement signal, no "trending books", no per-item exposure ceiling; strangers' `followed`, `started` and `shelved` cards appear in Popular.
- **Spec:** PRD §12.1 ("Highly-engaged reviews and trending books across the whole product"), §12.6 ("Popular is capped by a per-item exposure ceiling"; "Negative ratings are never amplified").
- **Not fixed** (product design, over half a day). **D-14-1** below, with a plan.

### A-14-010 · P1 · Home rendered hard-coded sample items; SO-15's "real feed cards" was false
- **Where:** `apps/mobile/app/(tabs)/index.tsx` (before): `SAMPLE_FEED_ITEMS`, no API call.
- **Fix:** Home calls `GET /v1/feed` through `@flyleaf/api-client` (`getFeed`): Friends / Popular (a signed-in reader opens Friends, a guest Popular; Friends asks a guest to sign in), opaque cursor paging on scroll, pull to refresh, the cold-start banner from `is_cold_start` / `cold_start_reason` (with "Find readers to follow" → Discover), skeleton cards on first load, an inline retry row for a failed first page or later page (never a full-screen error), an offline banner over the cards already shown when a refresh fails, and "You're all caught up" once the server has no more or after ~100 items (§12.6). Responses for a tab or account no longer showing are dropped. The state rules live in `src/lib/homeFeed.ts`. Sample data is gone from the screen (fixtures stay in tests).
- **Test:** `home-feed.test.ts` (tabs, paging and de-duplication, the 100-item end, banners). Seen failing before: the module did not exist; the screen itself is UI (typecheck).
- **Not built (recorded):** the §6.13 inline suggestion carousel (there is no suggested-readers endpoint: the banner links to Discover); a cached feed for cold starts offline (the offline banner covers a failed refresh in the session only). Both under Deferred.

### A-14-011 · P1 · The want-to-read swipe was fake
- **Where:** `index.tsx` `handleWantToRead` showed "Saved to Want to Read" and called nothing; the claimed `POST /v1/shelves/want-to-read/items` does not exist.
- **Fix (D-11-1):** `OfflineRepository.wantToRead(workId)` writes a local `want` read and queues `upsert_read` **only when this device knows no read of the book**, with `if_absent: true`, so the server writes only when it has none either; otherwise **409 `already_in_library`** and nothing changes (new body field on `POST /v1/reads`, checked under the attempts lock). The queue treats that 409 on an `if_absent` write as "already in the library": it drops the local copy instead of a sync issue. Online, the write is sent before the toast, so the toast says what happened: "Added to Want to read" (with Undo), "Added … will sync when you are online" (queued), "Already in your library", or an error. Undo deletes only the read the swipe created (`deleteRead` of its id; a create the server refused leaves a local id that 404s, which the queue treats as gone).
- **Test:** API *if_absent creates a want read when there is none, and is 409 already_in_library otherwise, writing nothing* (on `main`: 200, and the reading read would have been moved back to `want`); mobile `want-to-read.test.ts` (6: added + Undo, known locally, only the server has it, offline + Undo, offline then another device, back-off ordering). Seen failing before the fix: yes (API; 4 of 6 mobile with the queue changes reverted).

### A-14-012 · P2 · The editorial card linked to a nil-UUID profile
- **Where:** `FeedCard` actor header pushed `/user/00000000-…` for the editorial card.
- **Fix:** the editorial card (`isEditorial`) has no profile link, no swipe actions and no footer; its `interaction` is `null` from the API (guard).
- **Test:** `home-feed.test.ts` › *the editorial card has no profile, no like and no swipe*; API guard in A-14-003.

### A-14-013 · P1 · Review cards showed no text and no spoiler blur from real payloads
- **Where:** `FeedCard` read `review_text` / `review_body` / `text` / `description` and `has_spoilers`; the API writes `snippet` and `hasSpoilers` (`reviews/index.ts` `syncReviewActivity`). The mobile tests used the fixture names, so they passed.
- **Evidence:** every real review card rendered without its excerpt, so the §6.13 anatomy ("review excerpt (3 lines)") and the §10.4 spoiler blur never appeared. Shelf cards said "shelved a book" (the API sends `shelfName`), follow cards "followed a reader".
- **Fix:** `cardText()` / `cardHasSpoilers()` read the API's fields first; headlines use `shelfName` and `target_username`; the excerpt is 3 lines (was 6 for reviews; §6.13 says 3); the goal card names the year it was reached, not a year written into the code.
- **Test:** `home-feed.test.ts` › *a review card shows the snippet…*, *shelf and follow cards name…*, *a goal card names the year…*. Seen failing before the fix: yes (the helpers did not exist; the old card had no path to `snippet`).

### A-14-014 · P2 · Hard-coded colours and small touch targets in the card
- **Where:** `FeedCard.tsx` `#3B82F6`, `#10B981`, `#EF4444`, `#FFFFFF`; `feedCard.ts` swipe configs with hex; Home toast `#FFFFFF` / `#000`.
- **Fix:** theme tokens (`accent`, `positive`, `heart`, `surface`, `critical`, `ink`); swipe configs carry token names; card buttons, header buttons, toast Undo and retry rows are at least 44 × 44 dp. Button equivalents for both swipes were already there (guard).
- **Test:** *swipe actions use theme tokens, not hex colours*; `grep '#[0-9A-F]{6}'` in the three files: none.

### A-14-015 · P2 · "Rate & Review" opened the generic search
- **Where:** `/log?workId=…`: `app/log.tsx` ignores params (it is the FAB's search modal).
- **Fix:** both the swipe and the button open `/review/compose/<workId>`, the composer the book page uses (it takes a work id and finds or starts the read).

### A-14-016 · D-13-1 built · A single accepted request writes the requester's card
- **Where:** `social/index.ts` `acceptFollowRequest`.
- **Fix:** in the accept's transaction (under the pair lock), `recordActivity` for the requester: dated at acceptance; followers-only if the requester's account is private. The bulk accept on going public writes none.
- **Test:** *D-13-1: accepting one request writes one followed card; going public writes none*; *a private requester's accepted-follow card is followers-only*. Seen failing before the fix: yes.

### A-14-017 · P2 · The offline queue could send a later write for a read before an earlier one in back-off
- **Where:** `apps/mobile/src/offline/queue.ts` `flush`: eligible rows were chosen by `next_retry_at` per row, `ORDER BY created_at` with no tie-break.
- **Evidence:** a create answered 503 backs off; Undo's delete, queued after it, was eligible at once and sent first; the server answered 404, the queue took that as "already gone", and then the create landed: **the Undo was lost**. Two writes in the same millisecond had no order at all (the offline-then-Undo case sent the delete first in the test).
- **Fix:** a row waits while an earlier pending row for the same entity is still backing off; ties go by insertion order (`rowid`).
- **Test:** `want-to-read.test.ts` › *a create backing off holds back the Undo queued after it*, *offline: queued (and Undo before sync leaves nothing on the server)*. Seen failing before the fix: yes.

### A-14-018 · P2 · Weak tests
- `feed-query.test.ts` › *supports cursor pagination*: 5 finishes by one reader, which ranking leaves in time order, so it passed with the lossy cursor. It still passes (now with the opaque cursor), and the walks in `feed-audit.test.ts` are the real test.
- `feed-ranking.test.ts` › *interleaves consecutive items from the same actor*: **passes with rule 1 removed** (the diversity penalty alone separates them). The unit test *Rule 1: prevents more than 2 consecutive…* does catch the removal. Mutation-checked this part: rule 1 (caught by the unit test and the deferral test), rule 2 (caught by two ranking tests and the AC-11 API test), rule 4 "started" (caught by the unit test and the AC-11 API test), rule 3 low-affinity (caught by A-14-002's test).
- `feed-card.test.ts` builds cards with fields the API never sends (`review_text`, `has_spoilers`, `shelf_name` alone): A-14-013. Left as they are (they test the fallbacks); the new tests use the API's shapes.
- New AC-11 test through the API: *40 items today from people I follow: page one obeys all four rules and aggregates shelf adds*.

### A-14-019 · P3 · Verbs with no writer, and weights the PRD does not list
- `rated`, `goal_reached` and `quoted` are in the CHECK list and weighted (0.8, 0.6, 0.4) but nothing writes them (`grep recordActivity`: started/finished/dnf from reading, reviewed, shelved, followed). `rated` and `quoted` have no row in §12.2. Documented as unused; no change. The weights that §12.2 lists match exactly (unit test).

### A-14-020 · P2 · The comment thread cursor repeated the last comment of every page (Postgres only)
- **Where:** `interactions/index.ts` `encodeCursor(createdAt: Date)`: `toISOString()`, milliseconds.
- **Evidence (sandbox Postgres, `npx tsx src/bench/comment-cursor.ts`):** on `main` a 7-comment thread at limit 2 served **12**: `c0 c1 c1 c2 c2 c3 c3 c4 c4 c5 c5 c6`: the page's last comment sorted after its own millisecond-cut cursor. After the fix: `c0 … c6`, each once. PGlite's clock has millisecond resolution (`clock_timestamp()` → `…812000`), so the suite could not see it (the new API test passes on `main` too: a guard).
- **Fix:** the cursor carries Postgres's text form with microseconds (as the reads cursor already does); older ISO cursors still decode. The feed cursor (A-14-001) carries microseconds for the same reason.
- **Note for Part 15:** any test of a `created_at` cursor on PGlite is blind to this; real-server checks are the evidence.

### A-14-021 · P3 · "Started" aggregation is per UTC day
- Profiles carry no time zone, so "per user per day" (§12.2) is a UTC day. Documented in code. Owner: post-audit if time zones are added.

### A-14-022 · Built · Import progress banner on Home (handed over from Part 12, A-12-023)
- Home shows `ImportProgressBanner` for the newest import in `queued` / `processing` (`GET /v1/imports`, newest first), dismissible per import id (remembered in SecureStore, last 20), with an ETA once there are two progress samples that moved (rows per second × rows left). The banner's dismiss button is now available while the import runs (it was only shown when complete), labelled, and 44 dp; its queued text said "export".
- **Test:** `home-feed.test.ts` › *the newest import, only while queued or processing, unless dismissed*, *an ETA needs two samples that moved*.

### A-14-023 · Note · Verified as claimed (guards)
- **L-14 / lead 5** ("want-to-read shows as started"): already fixed in **Part 08** (A-08, `verbFor('want')` is `null`; test *want writes no started activity; reading does*). No other path writes `started` (imports write no activity; shelves write `shelved`). Guard here: *L-14 / lead 5: a want-to-read write records no activity at all* (passes on `main`).
- **Privacy of a private actor:** a follower sees their cards, a pending requester and a stranger never, in Friends or Popular (*a private actor: followers see…*, passes on `main`).
- **Lifecycle (SO-10):** read deleted → its activity and its review's deleted; read visibility changed → card follows (private deletes); review deleted → removed; shelf deleted or made private → removed / narrowed (Part 11); unfollow and block → `followed` cards removed (Part 13); work merged → `activity.work_id` repointed (Part 03); user deleted → hidden (soft) and cascaded (hard). Double finish, re-finish, re-shelving and follow → unfollow → follow each leave one row (Parts 08, 11, 13 tests). Imports write none (Part 12 `import-export-audit.test.ts` › *imports write no activity*, which imports a rated, reviewed, tagged book).
- **Weights and decay** exact (§12.2, 36 h); aggregation never touches reviewed/finished/dnf (unit tests).

## Performance

Sandbox PostgreSQL 18.3, **synthetic** data (header): `npm run bench -- --only feed` (Part 01 runner), 10 connections × 10 s after a warm-up, unloaded p50 from 15 sequential requests, statements from `x-bench-query-count`. Reports: `docs/audit/perf/14-feed-sandbox-before.md` and `…-after.md`. **Latencies: not measured on flyleaf_dev — rerun on the laptop.**

| Scenario | Load p50 / p95 / p99 ms before → after | Unloaded p50 before → after | Statements before → after | Plan notes |
|---|---|---|---|---|
| friends, `heavy` (1,158 follows) | 304 / **494** / 572 → 111 / **161** / 200 | 65 → 46 | 3 → 4 | before: seq scan of 142k `activity` rows, 5 MB disk sort, 4,808 hits + 1,792 temp blocks; after: 1-day window, 1,158 index probes, 1,947 rows, top-N in 61 kB, 12,635 hits, no temp |
| friends, `heavy`, page 2 | 298 / 499 / 556 → 119 / 164 / 194 | 62 → 59 | 3 → 5 | +1 statement when the cursor carries deferred cards |
| friends, `typical` (40) | 61 / 90 / 100 → 77 / 113 / 131 | 24 → 32 | 3 → 4 | +1 is the affinity statement §12.3 needs; the query reads 76 rows (window + quarter) instead of 60; 4,132 hits, 16.6 ms |
| friends, `typical`, page 2 | 55 / 81 / 93 → 89 / 124 / 141 | 22 → 34 | 3 → 5 | as above, plus the deferred cards |
| friends, `new` (0 follows → Popular) | 155 / 227 / 260 → 52 / 77 / 90 | 58 → 23 | 3 → 3 | |
| friends, `new`, page 2 | 52 / 75 / 88 → 51 / 70 / 81 | 18 → 20 | 3 → 4 | |
| popular, guest | 59 / 86 / 100 → 36 / 52 / 63 | 22 → 15 | 2 → 2 | `activity_visibility_idx` range, display joins after the limit |

Ratios: heavy p95 **3.1× faster**, popular 1.7×, new 2.9×; typical **1.25× slower** under load (the affinity statement and the larger window; both needed for correctness, all well inside the 200 ms trigger). Planning is ~5–8 ms per feed statement here (the query joins ~10 relations); a named prepared statement would cut it but is a platform-wide change (Part 15). `#withInteractions`: one statement, 1–2 ms.

## Behaviour changes

- `GET /v1/feed`: `next_cursor` is an **opaque string** (was an ISO timestamp); a malformed cursor is **400 `invalid_cursor`** (was page one). A page may hold **fewer than `limit` items while `has_more` is true** (cards deferred to the next page), and every activity is served exactly once. `has_more` is false on the last page; no editorial card after page one.
- Ranking now uses affinity (likes, comments, mutual follows); a reader the viewer never engages with gets a card in each block of 10 when one is available. A card that would break a hard rule waits for the next page instead of being dropped or (for a second "started" card) relaxed in place.
- Friends with 1–3 follows: Popular cards on page one only (a quarter of it), never from people the viewer follows; >3 follows with nothing in 180 days: "While you wait" Popular, paged to its end. `following_count` excludes deleted accounts.
- The feed never shows activity older than 180 days; a daily job deletes it.
- `followed` cards are hidden when the target is deleted, in a block with the viewer, or muted by them; they carry `metadata.target_username` / `target_display_name`. Aggregates carry `metadata.activity_ids`; aggregated shelf cards carry the shelf name.
- Accepting a single follow request writes the requester's `followed` card (D-13-1).
- Going public restores each card to its item's visibility.
- `POST /v1/reads` accepts `if_absent: true` → **409 `already_in_library`** when a read exists (new code; the field is optional and changes nothing when absent).
- `GET /v1/reads/:id/comments`: the cursor carries microseconds (old cursors still accepted); pages no longer repeat a comment.
- Mobile: Home is the real feed (see A-14-010); the swipe writes a `want` read with Undo; Rate & Review opens the review composer; review cards show the excerpt (3 lines) and blur spoilers; token colours; the import banner on Home; the offline queue holds a write behind an earlier one for the same read that is backing off.
- **Tests changed:** `social-graph-audit.test.ts` › *accepting: pending → accepted…*: expected 0 cards on accept → **1** (D-13-1), with a comment; the bulk-accept comment reworded. Nothing else.

## Decisions

- D-13-1, D-13-2, D-13-3: owner decisions, recorded in `findings/13-social-graph.md` and above.

## Decisions needed

- **D-14-1 · What makes Popular popular (A-14-009).** Options: (a) as is (recent public activity, ranked by weight × decay in its window); (b) **recommended:** Popular = public `reviewed` / `finished` / `dnf` / `goal_reached` cards from the last 14 days, scored by `weight × decay(age, 72 h) × (1 + log1p(likes + 2 × comments))` with the read's counters (already on `reads`), never by rating (§12.6), a per-read exposure ceiling (a card stops ranking once it has been served N times; needs an impressions counter or a cap by age), keyset-paged on `(score bucket, created_at, id)`; trending books as a separate strip later; (c) (b) without the exposure ceiling for now. Leaving (a) in place: it is safe (public only, blocks and mutes applied) and pages exactly once. About a day for (b) with tests and a migration for the score index.

## Deferred (with reason and owner)

| Item | Why deferred | Owner |
|---|---|---|
| **Rerun the feed bench on the laptop** (`npm run bench -- --only feed`, `DATABASE_URL` → `flyleaf_dev`, `BENCH_COUNT_QUERIES=1`) and the friends EXPLAIN for `heavy` | Numbers above are sandbox, synthetic | Laptop / Part 15 |
| No migration from Part 14 to apply to `flyleaf` | (nothing to do; listed so the absence is explicit) | — |
| D-14-1 Popular definition | Product decision | Owner |
| Affinity from taps (§12.3 "learned from taps") | No tap events reach the server's ranking; likes, comments and mutual follows are used | Post-audit |
| §6.13 inline suggestion carousel on the no-follows banner | No suggested-readers endpoint; the banner links to Discover | Post-audit |
| Cached feed for an offline cold start (§6.13 "cached feed with an offline banner") | The session keeps what it loaded; a persisted cache is new storage | Post-audit |
| Prepared statements for the feed (planning ~5–8 ms per statement) | Platform-wide driver setting | Part 15 |
| PGlite has millisecond timestamps: cursor tests on PGlite cannot catch precision bugs (A-14-020) | Cross-cutting test infrastructure | Part 15 |
| Flaky timing test A-04-006 in `auth-audit.test.ts` | Part 04 code | Part 15 |

## CI result

`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs` in the sandbox, with Postgres 18.3 on 5432 and MinIO on 9000.

- **Run 1: green in 1,119 s, exit 0**, all 9 steps: api-client build, api typecheck, spec check ("openapi.yaml is up to date", drift 0), api tests **1,610 passed / 79 files** (0 skipped: MinIO was up, so the S3 contract block ran), api build, api audit (`--audit-level=high`), mobile typecheck, mobile tests **207 passed**, migrations on a real Postgres ("migrations applied"). This run started a minute before the last code edit (A-14-020's cursor), so its typecheck step did not see it; hence run 2.
- **Run 2 (final tree):** see below.
