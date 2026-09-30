# Audit 09 — Ratings and reviews (SL-60 … SL-64)

2026-09-29/30 · CI: owner's run (`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`) **green in 734 s**, all 9 steps: api-client build, api typecheck, spec check, api tests, api build, api audit, mobile typecheck, mobile offline tests (**158/158**), migrations on a real Postgres. After CI, decision 2 (A-09-026) was implemented. Its files were re-run here at one worker (`reviews-audit`, `reviews`, `review-ranking`, `activity`, `feed-query`, `social-block-equivalence`, `read-likes`, `read-comments`, `authorization-matrix`, `hooks-hardening`: 210/210; mobile `review-payload`, `stars`, `gesture-threads`: 11/11), with API `tsc`, `spec:check` (drift 0) and mobile `tsc`, all green. Tests: API **+39** (`reviews-audit.test.ts` 41 new; `reviews.test.ts` −2, see A-09-018); the pasted tail shows no API total. Mobile **147 → 158** in CI (`stars` 5, `gesture-threads` 2, `review-payload` 3, `reading-audit` +1), **159** with the `canReview` test added after CI. No test was weakened or skipped; the two removed tests covered a deleted function, and their cases moved to the SQL implementation (A-09-018).

**Databases.** No migration in this part (code and contract only); `npm run migrate` on `flyleaf_dev` confirmed nothing pending, so `flyleaf` needed nothing either. All perf numbers are from **`flyleaf_dev`** (8 GB machine: **indicative only**).

**What was run here** (one worker, a few files at a time, all green at the end): API `tsc --noEmit`; `reviews-audit`, `reviews`, `review-ranking`, `activity`, `reading`, `reading-lifecycle`, `authorization-matrix`, `authorization-equivalence`, `social-block`, `social-block-equivalence`, `catalog-pages`, `shelves`, `shelves-privacy`, `feed-query`, `read-likes`, `read-comments`, `contract`, `server-wiring`; `spec:generate` + `spec:check` (**drift 0**); api-client build (CI's command); mobile `tsc --noEmit`; mobile `stars`, `gesture-threads`, `review-payload`, `reading-audit`, `queue-audit`. **Not run:** the full API suite, the rest of the mobile suite, `scripts/ci.mjs`.

**Screens were checked by reading the code.** The mobile suite has no React Native renderer. The logic behind each screen change is in a tested module (`lib/stars`, `lib/reviewPayload`, `offline/repository`), gestures are pinned structurally, and the rest is on the **phone checklist** at the end.

`secure-design` was not triggered: this run was autonomous by instruction. The privacy paths (feed activity, read visibility) are covered by tests below.

## Items handed to Part 09 by earlier parts

| From | Item | Outcome |
|---|---|---|
| 01 L-16 · 05 perf table | `GET /works/:hot/reviews?sort=friends` loads and ranks every review in memory (~1.3 s p50 heavy on `flyleaf_dev`) | A-09-009 (3.7× unloaded, rest deferred with a plan), A-09-019 |
| 01 L-12 | `work_stats` had no backfill | Covered by Part 08's code (0026 triggers + nightly `works.reconcile`), but 3 old works were still missing on `flyleaf_dev` because the job never ran locally; repaired by running it (A-09-035) |
| 03 A-03-016 | a merge paid two full `reads` scans per moved read | Fixed by Part 08 (statement triggers, cached C; verified by reading 0026). Not re-measured |
| 05 | `upsertReview` is several non-transactional writes (a unique race is a 409, not a 500) | A-09-003, A-09-016 |
| 07 A-07-028 | offline reviews are not posted "with the original timestamp" (PRD §34.5) | A-09-025 (decision) |
| 08 A-08-001 | whether `ReviewService.recomputeWorkStats` is needed at all | A-09-018: removed |
| 08 L-01 | catalog-mean scan | Verified fixed by Part 08 (`catalog_rating_stats`, `flyleaf_weighted_rating`); not redone |
| 04 D-04-1 / 05 A-05-010 | unverified accounts cannot publish reviews | Kept: checked in the new transaction before any write (`reviews.test.ts`, matrix). Imports: D-05-3, Part 12 |
| 13 (brief) | reviews on books between a blocked pair | The list and detail use `canViewSql` / `canViewWith` (Part 05 matrix). A-09-019 changed the SQL form; equivalence and matrix suites pass, and a mutation of the new form is caught |

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| SL-60 | Half-star control: drag, 44×44 targets, haptic per step, `adjustable` | ❌ the drag's callbacks ran on the UI thread and called JS there (most likely throws on a device); a rating could not be cleared; half-star tap targets are ~16 pt wide, not 44 | A-09-006, A-09-007, A-09-031 |
| SL-61 | Heart independent of rating | ⚠️ independent in API and UI (tested); the per-work `heart_count` (§9.4 [LOCKED]) was computed but never shown | A-09-011 |
| SL-62 | Bayesian rating, trigger-maintained `work_stats` | ⚠️ one SQL implementation (Part 08) is correct; the TS duplicate and its tests were dead code; `review_count` never existed; §9.7 not built (fast-follow) | A-09-018, A-09-021, A-09-027, A-09-028, A-09-031 |
| SL-63 | Composer: autosave, spoiler, visibility, offline | ❌ edits reset visibility to public and spoilers off; the review write was not atomic; feed cards kept stale privacy and text (**P0**); a review of an unlogged book was queued against the book's id and refused | A-09-001, A-09-002, A-09-003, A-09-004, A-09-005, A-09-008, A-09-012 … A-09-017 |
| SL-64 | Review detail and the book reviews list, friends-first | ⚠️ visibility right (Part 05); the list loaded every review and ranked ties nondeterministically (pages repeated and skipped); the rating filter could not reach half stars; no tombstone; no "load more" | A-09-009, A-09-010, A-09-015, A-09-024, A-09-033 |

## Findings

### A-09-001 · P0 · FIXED · Review feed cards ignored the review's current privacy
- **Where:** `reviews/index.ts` (`upsertReview`, `updateReview`), `activity/index.ts` `updateActivityVisibility`. The Popular feed trusts `activity.visibility = 'public'` alone (`getPopularFeed`), so the activity row is the privacy control for review cards, snippet included.
- **Evidence (PGlite, `reviews-audit.test.ts`, before the fix):**
  - `PATCH /reviews/:id {visibility: 'private'}` never touched the activity: the review id stayed in `GET /feed?tab=popular` for guests, with its 200-character snippet.
  - On a **private account**, an edit set the activity to `public` (`updateActivityVisibility` wrote the requested value and skipped the account rule that `recordActivity` applies): `expected ['public'] to equal ['followers']`.
  - A public review on a **private read** got a public activity, and appeared in the Popular feed, while `GET /reviews/:id` answered 404 to the same guest.
  - A followers review on a followers read was a `public` activity.
  - Private → public never recreated the activity (it had been deleted), so the review never reached feeds.
- **Spec:** PRD §10.5, §26.1–26.2, §16.3; AC on 404-not-403 (Part 05).
- **Fix:** `syncReviewActivity(tx, reviewId)` derives the activity from current state in the write's transaction. None for a deleted, imported or effectively private review. Otherwise the stricter of review and read visibility, `followers` for a private account, with the current snippet and spoiler flag. It updates the row in place (keeping `created_at`) or creates it. Called from upsert, PATCH, DELETE and, new, from the reading service when a **read's** visibility changes. Turning an **account** private was already handled (`setAccountPrivacy` downgrades all public activity); it now has a test.
- **Tests:** `reviews-audit.test.ts` › *the review activity follows the review*: "PATCH to private removes the review from every feed", "a private account never gets a public review activity, on create or edit", "a public review on a private read stays out of feeds", "a followers review on a followers read…", "PATCH back to public…", "making the read private afterwards takes its review out of feeds…", "turning the account private…". **Seen failing before the fix: yes** for all but the account test, which passed before (existing behaviour, now guarded). The read-visibility path was **mutation-checked**: removing the new call fails it.

### A-09-002 · P0 · FIXED · Any status change, finish or DNF that omitted `visibility` made a private read public
- **Where:** `contract/schemas.ts` `upsertReadBodySchema`, `finishReadBodySchema`, `dnfReadBodySchema`: `visibility: { …, default: 'public' }`. Fastify's AJV fills defaults, so the services' `visibility ?? read.visibility` never saw an omission.
- **Evidence:** a `reading` read with `visibility: private`, then `POST /reads {work_id, status: 'finished'}` → 200 `visibility: "public"`. The same for `POST /reads/:id/finish {}` and `/dnf {}`. The app sends no visibility on these paths (`api.setStatus`, the queued finish sends `null`), so **every status change in the app published a private read**, and, until A-09-001, its review.
- **Spec:** PRD §10.5, §26.2. The schemas are Part 08's code; found here because read visibility now drives review visibility.
- **Fix:** the three defaults removed. The services already fall back to the read's own visibility (or public for a new read). Documented in the contract.
- **Tests:** "a status change that does not mention visibility keeps a private read private", "POST /reads/:id/finish|dnf without a visibility keeps a private read private". **Seen failing before the fix: yes** (all three).

### A-09-003 · P1 · FIXED · The review write was not one transaction
- **Where:** `upsertReview` wrote the rating, recomputed stats, wrote the review, then the activity, as separate statements; `updateReview` and `deleteReview` likewise.
- **Evidence:** a trigger that fails the activity insert → 500 with the read's rating already changed (`expected '1.5' to be '5.0'`).
- **Fix:** each write is one transaction that locks the read row (`FOR UPDATE`), so two writes of one read serialise.
- **Test:** "is one transaction: a failure after the rating write leaves nothing behind". **Seen failing: yes.**

### A-09-004 · P1 · FIXED · Editing a review reset its visibility to public and its spoilers to off
- **Where:** `createReviewBodySchema` had `default: 'public'` / `default: false`, and `upsertReview` set `?? 'public'` / `?? false` on the existing review. The composer never loaded the existing review, so every edit from the app sent Public and no spoilers. The offline finish flow queues `save_review` with only the body.
- **Evidence:** a followers review with spoilers, then `POST /reads/:id/review {body}` → `visibility: public, has_spoilers: false, spoiler_after_page: null`.
- **Fix:** API: no schema defaults; omitted fields keep the live review's values (defaults only for a new review). App: `GET /works/:id` now returns `your_read.review_id`, and the composer loads the review (body, spoilers, visibility; a newer local draft wins) and titles itself "Edit Review".
- **Tests:** "an edit that omits visibility and spoilers keeps them". **Seen failing: yes.** "your_read carries the id of your live review…" (seen failing: yes; the first version rendered `${reads.id}` unqualified and matched nothing, fixed and commented). The composer's loading is on the phone checklist.

### A-09-005 · P1 · FIXED · Marking spoilers or editing text after posting left the feed card unchanged
- **Evidence:** `PATCH {has_spoilers: true, body: 'Big reveal…'}` left `metadata = {hasSpoilers: false, snippet: 'The butler did it.'}`.
- **Fix:** A-09-001's sync writes the current snippet and flag. (Real feed cards show no review text at all: A-09-020.)
- **Test:** "marking spoilers or editing the text after posting updates the feed card". **Seen failing: yes.**

### A-09-006 · P1 · FIXED · A rating could not be cleared anywhere (PRD §9.3 [LOCKED]: a rating is optional)
- **Evidence:** `Stars` had no path to "no rating": `onChange(v: number)`, minimum 0.5, and the accessibility decrement stopped at 0.5. The API could not do it either from the book page: `POST /reads` writes `rating = COALESCE(new, rating)`, and the offline queue sends `rating: null` with every status change to mean "unchanged", so `null` cannot mean "clear" there.
- **Fix:**
  - `POST /reads` accepts `clear_rating: true` (422 with a rating).
  - The review endpoints already took `rating: null`; this is now documented and tested.
  - App: tapping the current value, or stepping below half a star with a screen reader, clears (`lib/stars.ts`). The book page calls the new `OfflineRepository.clearRating`, which clears locally and queues `upsert_read` with `clear_rating`.
- **Tests:** API "POST /reads clears a rating with clear_rating; a status change alone keeps it" (**mutation-checked**: restoring the `COALESCE` fails it; also checks `work_stats.rating_count` drops to 0) and "rating: null clears the rating, through POST and PATCH". Mobile `stars.test.ts` (tap-to-clear, decrement to null) and `reading-audit.test.ts` "clearing a rating … sends clear_rating with the status". Not seen failing before: the functions and the flag are new.

### A-09-007 · P1 · FIXED (needs a device) · The Stars drag ran JS on the UI thread; so did the Sheet's swipe-to-dismiss
- **Evidence (static):** `react-native-worklets/plugin` (0.10.1, Reanimated 4.5.1) workletizes `onStart/onUpdate/onEnd` of any `Gesture.*()` chain. `Stars` called `calculateTarget`, `Haptics.selectionAsync()` and a ref from those callbacks, and `Sheet` called `onClose()` from `onEnd`. A synchronous call to a non-worklet function on the UI thread is an error in Worklets. Taps still worked through the Pressables. **Not observed on a device.**
- **Fix:** `Stars` uses `.runOnJS(true)`, since all its state is JS. `Sheet` uses `runOnJS(onClose)()`. `ProgressSlider` was already correct.
- **Test:** `gesture-threads.test.ts`: every gesture chain either opts into the JS thread or calls JS only through `runOnJS`; the Stars chain opts in. **Seen failing against HEAD's `components.tsx`: yes** (both). Device proof: phone checklist.

### A-09-008 · P1 · FIXED · "Write a review" on an unlogged book posted the book's id as a read id
- **Where:** `app/work/[id].tsx` passed `work.your_read?.id ?? work.id`; the composer posted `read?.id ?? id`.
- **Evidence (code):** with no read, the queued `POST /reads/<workId>/review` is refused (404) on replay and dead-lettered to "Couldn't sync". The composer had already deleted the draft and closed.
- **Fix:** the composer resolves the read (local, or the book's `your_read`). With none, it shows "Log this book as reading or read before posting", keeps the draft and refuses to post. It also fetches the book by the read's `work_id` (it asked for `/works/<readId>`, which 404s).
- **Test:** none possible without a renderer; phone checklist.

### A-09-009 · P1 · PARTLY FIXED · The book reviews list loaded, mapped and ranked every review of the work
- **Evidence (`flyleaf_dev`, hot work: 5,303 reviews, 3,885 visible to heavy):** full rows with bodies for every review, two ranking-context queries with a ~3,000-uuid `IN` list each, a viewer-likes query with a 5,000-id `IN` list. The list query alone: 284 ms, `Seq Scan on reads` (62k rows) plus 10,364 correlated scans of `blocks` (20,728 buffers).
- **Fix:**
  - likes, newest, highest and lowest sort and page in SQL (`ORDER BY …, published_at DESC, id DESC LIMIT/OFFSET`) with a count query.
  - friends ranks narrow rows (id, author, date, likes, comments, `char_length(body)`) with the unchanged SO-23 ranking, then loads only the page.
  - The ranking context takes the work id as a subquery, and viewer likes are read for the page only.
  - Plus A-09-019.
- **Numbers:** see Performance. Unloaded: heavy **748 → 203 ms (3.7×)**, guest **341 → 141 ms (2.4×)**.
- **Owner decision (2026-09-30): the plan below (guest per-book cache + capped exact candidate set) is approved → Part 09b.**
- **Still over budget under load** (indicative): friends p95 1,033 ms heavy, 693 ms guest. Every request still ranks all visible reviews of the work, so cost grows with the work's review count (bounded by one work, not the table). **DEFERRED, plan (Part 15 or a follow-up):**
  - (a) For guests the ranking is viewer-independent within a day (the exploration key is daily): cache the ranked id list per work for 60 s like `GET /works/:id`.
  - (b) For signed-in viewers, cap candidates in SQL: all followed accounts' reviews, plus the top N by a SQL lower-bound score, plus the ≤ 14-day exploration pool. Extend N while the page's last exact score is below the (N)th lower bound + 0.24, the most credibility and second-degree proximity can add.
  - Both keep SO-23's order exact. The cap is a ranking design change, so not done here.

### A-09-010 · P1 · FIXED · Friends-first order was nondeterministic for ties, so pages repeated and skipped reviews
- **Evidence:** 24 reviews with equal date and likes, paged 7 at a time: 23 (then 22) distinct in 3 of 4 runs. A probe showed the guest order differed between two identical requests. **Cause:** `calculateReviewRankingScore` read `new Date()` once **per item**, so tied reviews got recency scores from instants microseconds apart, and the tie-breaks (date, id) never ran.
- **Fix:** `rankReviews` pins one clock per ranking. The formula (SO-23) is unchanged.
- **Test:** "sort=friends pages through every review exactly once" (with the other four sorts). **Seen failing before the fix: yes** (intermittent, 3 of 4 runs); 3 repeated probe runs after: identical order.

### A-09-011 · P1 · FIXED · `heart_count` was never shown (PRD §9.4 [LOCKED])
- **Evidence:** the trigger kept `work_stats.heart_count`; `GET /works/:id` projected only average, weighted and count.
- **Fix:** `heart_count` on `GET /works/:id` (contract, client); the book page shows "N ratings · M hearts". Same place: below 5 ratings the page drew the **average** as stars, against §9.5 ("the count instead of an average"); now only the count.
- **Test:** "GET /works/:id carries heart_count next to rating_count". **Seen failing: yes.** The screen: phone checklist.

### A-09-012 · P2 · FIXED · The review API accepted ratings that are not half steps
- **Evidence:** `rating: 4.04` → 200, stored as 4.0 (`numeric(2,1)` rounds before the CHECK). `rating: 3.7` → 422 `invalid_field` "A value is out of range", with no field.
- **Fix:** `multipleOf: 0.5` on both review schemas → 422 naming `rating`. (`POST /reads` already enforced it in zod.)
- **Test:** "refuses the rating %s with a field error, never stores it rounded" (3.7, 4.04, 0.25). **Seen failing: yes** (3.7 and 4.04).

### A-09-013 · P2 · FIXED · The 10,000 limit counted UTF-16 units, not characters
- **Evidence:** 6,000 emoji (6,000 characters, which `char_length` and the schema's `maxLength` accept) → 400 `body_too_long`.
- **Fix:** counted in code points, server and composer counter.
- **Test:** "counts the 10,000 limit in characters…". **Seen failing: yes.**

### A-09-014 · P2 · FIXED · `spoiler_after_page` was unchecked
- **Evidence:** page 301 on a 300-page edition → 200. A page sent with `has_spoilers: false` was stored. The composer keeps the page text after the switch goes off and sent it.
- **Fix:** 422 `spoiler_page_out_of_range` (field `spoiler_after_page`) past the read's edition page count (no check without an edition). The page is dropped without the flag, server and app (`lib/reviewPayload`).
- **Tests:** "spoiler_after_page: beyond the edition is refused; without the spoiler flag it is not stored" (**seen failing: yes**); `review-payload.test.ts`.

### A-09-015 · P2 · FIXED · The rating filter compared exactly, so half stars were unreachable
- **Evidence:** `?rating=4` returned only 4.0. The chips are 5★ … 1★, so 3.5 and 4.5 reviews matched no chip, and the filter disagreed with the histogram beside it (which counts 3.5 in bucket 4).
- **Fix:** `rating` is the histogram bucket, an integer 1–5: `rating > n−1 AND rating ≤ n`. **Behaviour change.**
- **Test:** "the rating filter is the histogram bucket: 4 means 3.5 and 4.0". **Seen failing: yes.**

### A-09-016 · P2 · FIXED · A double submit raced
- **Evidence (reading):** two concurrent upserts of one read both saw no review; the second insert hit the unique index → 409, which the offline queue dead-letters although the review exists.
- **Fix:** the read-row lock (A-09-003).
- **Test:** "a double submit … is one review and one activity, both 200". **Seen failing: no.** PGlite serialises transactions and cannot show this race (as Part 08 found). The lock was verified by reading, not by a real-Postgres race run.

### A-09-017 · P2 · FIXED · Writing over a deleted review revived it as an old, "edited" review without a feed card
- **Decision taken (safe, reversible):** writing again on the read is a new publication. `published_at = now`, `edited_at = null`, visibility and spoilers from the request (defaults otherwise, not the deleted review's), activity recreated. The id is kept, so the read's comments (SO-22) reopen with it. The verified-email gate applies as for a new review.
- **Test:** "deleting removes the activity; writing again publishes it again as a new review". **Seen failing: yes.**

### A-09-018 · P2 · FIXED · Duplicate TS rating code; the SL-62 tests covered dead code
- **Evidence:** `ReviewService.recomputeWorkStats` ran after every rating change although the reads statement trigger (0026) already recomputes the work in the same statement. `calculateBayesianRating` had no production caller; the two SL-62 "Bayesian" tests exercised only it.
- **Parity:** the TS recompute already called the SQL function (Part 08), so the two could not diverge. The proof that the trigger alone suffices is "leaves work_stats exact with the trigger alone" (stored row = a fresh aggregate over `reads`, after POST, PATCH and a heart). **Mutation-checked** on the trigger path in Part 08's `work-counters.test.ts`.
- **Fix:** both removed. The Bayesian cases (3.94, 4.28, null, one 5★ vs a classic) now run against `flyleaf_weighted_rating` in `reviews-audit.test.ts`.

### A-09-019 · P2 · FIXED · `canViewSql` scanned `blocks` once per candidate row
- **Evidence:** the list plan: `SubPlan: Seq Scan on blocks … loops=10364`, 20,728 buffers, 284 ms. Cost grows with candidates × blocks table size.
- **Fix:** the block check is one uncorrelated set (`owner NOT IN (blocked by viewer UNION ALL blocking viewer)`), hashed once: `loops=2`, **284 → 77 ms** for the same query. Exact because block ids are NOT NULL primary-key columns. Also used by shelves.
- **Tests:** `authorization-equivalence` (63 cells), `authorization-matrix`, `social-block`, `shelves-privacy`, `shelves` pass. **Mutation-checked:** dropping the "owner blocked the viewer" half fails equivalence.

### A-09-020 · P2 · DEFERRED → Part 14 · Real feed review cards show no text and no spoiler gate
- **Evidence:** the server writes review activity metadata `{readId, hasSpoilers, snippet}`. `FeedCard.tsx` renders `meta.review_text || meta.review_body || …` and gates on `meta.has_spoilers`, and `lib/feedCard.ts` detects review cards the same way. Only the sample data on the home screen uses those keys.
- **Why deferred:** the fix spans the render and the spoiler gate in `FeedCard.tsx` (no renderer to test) plus the card logic, and Part 14 owns the feed contract. Proposal: one metadata shape (snake_case `snippet`, `has_spoilers`, as the rest of the API), with a batched rewrite of existing rows and a test on `feedCard.ts`.

### A-09-021 · P2 · DEFERRED (owner decision, 2026-09-30) · §9.7 manipulation exclusion is not implemented
- **Evidence:** `recompute_work_stats_for_work`, the histogram and the reconcile count every rating. Nothing excludes accounts under 7 days old or with fewer than 5 ratings.
- **Spec:** §9.7 marks all its mitigations **P1**, "the first fast-follow" (PRD line 14), and requires only that the schema support them without migration (it does: `users.created_at`, per-user counts from `reads`).
- **Decision (owner):** defer as the PRD's fast-follow. Tracked as a task in `docs/tasks.md` (§9.7 under SL-62). Plan: a `rating_eligible` predicate joined in the trigger aggregate, the histogram and the reconcile. A daily job recomputes works rated by accounts that turned 7 days old. The trigger recomputes a user's rated works when their count crosses 5. The launch-week effect (every rating hidden for 7 days) needs a product answer first. Unverified accounts: D-05-3, Part 12.

### A-09-022 · P2 · RL → Part 15 · Review writes have no rate limit
- PRD §10.6: 10 reviews/hour, 30/day. `POST /reads/:id/review` (create and revive) has none; PATCH (edits) has none either. Follow the injected `RateLimiter` pattern.

### A-09-023 · P3 · Observation · One review edited by 10 connections at once has a long tail
- `review:post` under load: p50 166 ms, 3 of 183 requests at the 10 s cap. No errors, no deadlocks in the server log. All ten connections edit **one** read: the row lock (A-09-003) serialises them, and the pool is 10, so transactions waiting on the lock can hold every connection while the finished request's `getReview` waits. At one connection: **p50 72 / p95 86 / p99 88 ms**, 10 queries. Real edits are one user on one read; recorded, not changed.

### A-09-024 · P3 · Open · Review detail: no tombstone (PRD §6.26)
- A missing, deleted or hidden review is one 404 (correct: Part 05). The app shows an alert and goes back instead of "This review was removed". Telling "deleted" from "never visible" needs a server signal that must not leak existence. Proposal: a tombstone only for the author, and for readers of a thread they commented on (SO-22).

### A-09-025 · P3 · DECIDED (owner, 2026-09-30): keep the server time · Offline reviews and "the original timestamp" (A-07-028)
- PRD §34.5 says an offline review is "posted on reconnect with the original timestamp", and in the same table "server timestamps are authoritative for ordering; client timestamps are informational only".
- **Options:**
  - (a) keep the server stamp (today);
  - (b) accept an informational `written_at`, stored and shown, never used for ordering or feeds (a column, so a migration);
  - (c) use the client time as `published_at`, clamped to [now − 7 days, now].
- **Recommendation:** (a) now, (b) if users notice.
- **Decision (owner, 2026-09-30): (a).** `published_at` stays the server's time; §34.5's clock-skew rule wins. No change.

### A-09-026 · P3 · DECIDED and FIXED (owner, 2026-09-30): refuse only "want" · Reviews on non-terminal reads
- `upsertReview` accepts any read the user owns, including `want`. PRD §6.27 names only "Review on a DNF → allowed, labelled"; §10.3 makes only finished/DNF reads likeable and commentable, so a review on a `want` or `reading` read can never be liked.
- **Options:**
  - (a) allow all (today);
  - (b) refuse `want` only;
  - (c) finished and DNF only.
- **Recommendation:** (b). Separately, the review item has no read status, so the app cannot show the "DNF" label §6.27 asks for; add `read_status` to the review item when this is decided.
- **Decision (owner, 2026-09-30): (b).** Implemented after CI:
  - `POST /reads/:id/review` on a `want` read → 422 `review_needs_reading` (field `status`), nothing written. Reading, paused, finished and DNF are accepted.
  - The composer checks `canReview(status)` (`lib/reviewPayload`) and shows the "log it first" notice rather than queueing a write the server refuses.
- **Tests:** "a book on the want list cannot be reviewed; reading, paused, finished and DNF can". **Mutation-checked:** without the rule it fails; the test was added with the rule, so no pre-fix run. Also `review-payload.test.ts` › canReview.
- **Still open:** the "DNF" label (§6.27) needs `read_status` on the review item; not in the decision, left for 09b or SL-6x.

### A-09-027 · P3 · DECIDED (owner, 2026-09-30) → Part 09b · Re-reads count twice in the rating aggregates
- `rating_count`, `rating_sum`, the average and the histogram count every **attempt**. `heart_count`, `read_count` and `dnf_count` count distinct **users**. A reader who rated three re-reads 5★ counts three times. §34.2 gives each attempt its own rating but says nothing on aggregates.
- **Recommendation:** each user's latest rated attempt. That is a change to the trigger and the reconcile, with a nightly recompute: a migration and a product call, so not done here.
- **Decision (owner): approved**: count each user's latest rating only. Implementation in Part 09b (`docs/audit/09b-reviews-followup.md`).

### A-09-028 · P3 · Recorded · `polarisation` is computed and unused
- Kept by the trigger (stddev, §9.6 [ASSUMPTION]); nothing reads it and no "Divisive" badge exists.

### A-09-029 · P2 · DECIDED (owner, 2026-09-30) → Part 09b · The histogram has 5 buckets; §9.6 says ten half-star buckets
- `rating_distribution` (Part 08) buckets by `CEIL(rating)`. Ten buckets change the contract and the 5-bar UI.
- **Decision:** the API returns ten half-star buckets per §9.6; the app may group them for display. Implementation in Part 09b.

### A-09-030 · P3 · Recorded · Composer drafts in SecureStore
- The brief's concern was size. `expo-secure-store` 57.0.4 validates only that the value is a string, and its CHANGELOG (55.0.0) removed the iOS byte-limit warning (#40187), so a 10,000-character draft is not blocked by any limit in the installed code. **Not verified on a device.** The keychain keeps drafts after logout (keyed by read id); drafts are not secrets. Move them when a local drafts table exists.

### A-09-031 · P3 · FIXED (docs) · False claims in tasks.md
- SL-62: `work_stats` has no `review_count` column; "C excluding target work" changed in Part 08; the "12 unit tests" were 3.
- SL-60: half-star targets are `size/2` (~16–17 pt) wide plus 4 pt slop, not 44×44 (the row is 44 tall; the drag is the wide target).
- Struck through and corrected in `docs/tasks.md`.

### A-09-032 · P3 · Recorded · Share sends text, not a link
- Review detail share sends a 200-character quote plus "…" (appended even to short reviews) and no link, so nothing points at a page that 404s. A public review page is SO-50.

### A-09-033 · P2 · Open · The Reviews tab shows the first 20 reviews only
- `app/work/[id].tsx` loads one page with no "load more". The API pages correctly now (A-09-009/-010). About 30 minutes; not done to keep this part's diff to the audit items. → Part 15 sweep, or the next SL-6x touch.

### A-09-034 · P3 · Recorded · "Spoilers after page N" by the reader's progress (§10.4) is not built
- The page is stored and shown as text. Blurring by the reader's own progress is marked P1 in the PRD (fast-follow).

### A-09-035 · P3 · REPAIRED (data) · L-12 was still open on `flyleaf_dev`: 3 works with reads and no stats
- **Evidence:** 12,576 works have reads; **3** had no `work_stats` row. Their reads date from 3 Sep, before the trigger, and were never touched since. `catalog_rating_stats.refreshed_at` was 26 Sep (the 0026 migration), so the nightly `works.reconcile` has never run on this database: no worker runs locally.
- **Repair:** ran the designed job once, `SELECT reconcile_work_counters()` (statement_timeout 120 s, work_mem 32 MB) → `{"work_stats": 9, "reader_count": 0, "catalog_mean": 3.613}` (the 3 missing rows, plus 6 weighted ratings moved by the refreshed C). Missing now: **0**. Not run on `flyleaf`; the worker's nightly job does the same there once it runs.
- **Open → Part 09b (owner):** *why* the three were missing. The trigger should have covered any read written after 0011. Check whether `npm run devdb:build` copies `reads` with triggers off and skips the `work_stats` reconcile (then the fix belongs in devdb:build); otherwise it is a trigger bug.

## Performance (`flyleaf_dev`, indicative only: 8 GB machine)

Bench runner, 10 connections × 10 s, after a warm-up, back to back. Files: `docs/audit/perf/09-before.md`, `09-after.md`, `09-after-review-post-c1.md`.

| Endpoint | Before p50/p95/p99 (load) | After p50/p95/p99 (load) | Unloaded p50 before → after | Queries | Plan notes |
|---|---|---|---|---|---|
| `GET /works/:hot/reviews?sort=friends` heavy | 2,378 / 2,634 / 2,681 | 792 / 1,033 / 1,177 | 748 → **203** (3.7×) | 6 → 6 | narrow rows; blocks hashed once (284 → 77 ms, `loops 10364 → 2`); page hydrated only |
| same, guest | 1,220 / 1,466 / 1,844 | 567 / 693 / 755 | 341 → **141** (2.4×) | 3 → 4 | no follow/block work; ranking of 5k narrow rows remains |
| `GET /works/:hot/reviews?sort=newest` guest | — (no scenario) | 170 / 231 / 272 | 74 | 4 | `ORDER BY … LIMIT`, count query |
| `GET /reviews/:id` | 32 / 39 / 46 | 31 / 39 / 45 | 17 → 17 | 2 → 2 | unchanged |
| `POST /reads/:id/review` (edit + rating change) | — (no scenario) | 166 / 1,369 / 10,000 (single-row contention, A-09-023); **1 connection: 72 / 86 / 88** | 112 | 10 | one transaction; trigger recompute via `reads_work_idx` |

- Ranking context on the hot work: credibility 75 ms (hash joins over `reviews`/`reads` of the work's authors); second-degree ~110 ms (`Parallel Seq Scan on follows` on dev: 65k of 177k rows are the viewer's 2-hop neighbourhood; grows with the neighbourhood, not the table).
- Still over the PRD p95 budget under load for the friends sort (see A-09-009's plan).

## Behaviour changes (client-observable)

1. Editing a review keeps visibility, spoilers and spoiler page unless sent; a revived review is a new publication (`published_at` now, `edited_at` null, defaults for omitted fields).
2. `POST /reads`, `/reads/:id/finish`, `/reads/:id/dnf` without `visibility` keep the read's visibility (was: set to public).
3. Review feed activity follows the review, the read and the account on every write (visibility, snippet, spoiler flag).
4. `rating` on the review endpoints must be a half step (422 `invalid_field`, field `rating`); `rating: null` clears.
5. `POST /reads` accepts `clear_rating: true` (422 together with a rating).
6. `spoiler_after_page` past the edition's page count → 422 `spoiler_page_out_of_range`; without `has_spoilers` it is stored as null.
7. Review body limit counted in characters (emoji count once).
8. `GET /works/:id/reviews?rating=` is an integer star bucket 1–5 (4 lists 3.5 and 4.0); 4.5 is now a 400.
9. Friends-sort ties are ordered stably; length quality is measured in characters (differs only for astral characters).
10. `GET /works/:id`: `heart_count`; `your_read.review_id`.
11. `POST /reads/:id/review` on a `want` read → 422 `review_needs_reading` (field `status`), after CI (A-09-026).
12. App: tap the current star value (or step below half a star with a screen reader) to clear a rating; the composer edits the existing review, refuses to post without a started read (none, or a want-list read; draft kept), sends rating and heart only when changed; the book page shows hearts and, below 5 ratings, no average stars; Sheet swipe-to-dismiss closes through `runOnJS`.

## Decisions (answered by the owner, 2026-09-30)

1. **A-09-025** offline review timestamp: **keep the server time.** No change.
2. **A-09-026** reviews on non-terminal reads: **refuse only `want`.** Implemented here (422 `review_needs_reading`; composer notice).
3. **A-09-027** re-reads in rating aggregates: **count each user's latest rating only.** → Part 09b.
4. **A-09-009** guest per-book cache + capped exact candidate set: **approved.** → Part 09b.
5. **A-09-029** histogram: **the API returns ten half-star buckets per §9.6; the app may group them for display.** → Part 09b.
6. **A-09-021** §9.7 exclusion: **deferred as the PRD's fast-follow** (tasks.md SL-62b). Unverified accounts: D-05-3, Part 12.
7. **A-09-035** why three `flyleaf_dev` works had reads but no stats row: → Part 09b (devdb:build vs trigger).

No decisions are outstanding for Part 09.

## Deferred (reason, owner)

| Item | Owner | Reason |
|---|---|---|
| A-09-009 remaining friends-sort cost (guest cache, capped exact candidates) | **Part 09b** | approved design change |
| A-09-027 latest rating per user in aggregates | **Part 09b** | approved; migration + reconcile |
| A-09-029 ten half-star histogram buckets | **Part 09b** | approved; contract + app grouping |
| A-09-035 root cause of the missing stats rows | **Part 09b** | devdb:build or trigger |
| A-09-020 feed metadata keys | Part 14 | feed contract; renderer untestable here |
| A-09-021 §9.7 exclusion | fast-follow (tasks.md) | owner decision |
| A-09-022 review rate limits | Part 15 | RL |
| A-09-024 tombstone | SO-50 / Part 15 | needs a non-leaking signal |
| A-09-033 reviews "load more" | Part 15 sweep | outside the audit items |
| Imports publishing reviews for unverified accounts (D-05-3) | Part 12 | owner |

## Phone checklist (Part 09)

1. Book page: drag across the stars. The value follows the finger, a haptic tick per half step, no red box; release saves.
2. Tap the current star value → the rating clears (book page and composer). VoiceOver/TalkBack: swipe down past half a star → "Not rated".
3. Any bottom sheet: swipe down → closes, no red box.
4. Book with your followers-only review with spoilers → "Write a review": the composer says "Edit Review" and shows your text, spoilers on, Followers. Post without changes → still Followers.
5. Book you have not logged → "Write a review": the notice shows, Post refuses with "Log this book first", and the draft survives leaving and coming back.
6. Composer: turn spoilers on, type a page, turn spoilers off, post → the review has no page.
7. Book page with ≥ 5 ratings and some hearts: "N ratings · M hearts". With 1–4 ratings: the count, no average stars.
8. A 10,000-character draft (non-Latin text) survives killing the app (SecureStore, A-09-030).
