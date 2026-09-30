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
| A-09-009 remaining friends-sort cost (guest cache, capped exact candidates) | **Done in Part 09b** (A-09-039, A-09-040) | approved design change |
| A-09-027 latest rating per user in aggregates | **Done in Part 09b** (A-09-036) | approved; migration + reconcile |
| A-09-029 ten half-star histogram buckets | **Done in Part 09b** (A-09-037) | approved; contract + app grouping |
| A-09-035 root cause of the missing stats rows | **Done in Part 09b** (A-09-038) | devdb:build or trigger |
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

---

# Part 09b — Reviews follow-up (2026-09-30)

2026-09-30 · **CI:** owner's run (`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`) **failed at `api · tests`** after 1,275 s: **1 of 1,406** failed (`dob-confirmation.test.ts` › "a re-run does not un-confirm…", A-09-045); 67 of 68 files and 1,405 tests passed, and api-client build, api typecheck and spec check were green. **After the fix**, run here: the failing file at one worker (14/14), then every step CI had not reached, as `scripts/ci.mjs` defines it: `api · build` (`npm run build`) ✅, `api · audit` (`npm audit --audit-level=high`) ✅, `mobile · typecheck` ✅, `mobile · offline tests` **162/162** ✅, `api · migrations on a real Postgres` (`npm run migrate`, on `flyleaf_dev` and `flyleaf`) ✅. API tests **1,395 → 1,406** (+11 in 09b; the Part 09 CI tail showed no total, and 1,395 is 1,406 − 11); mobile **159 → 162**.

The owner's answers to Part 09's decisions (`docs/audit/09b-reviews-followup.md`), implemented. Day-to-day work and all perf numbers on **`flyleaf_dev`** (8 GB machine: **indicative only**, judged by ratios and plans). Migration **0029** applied to **both** `flyleaf_dev` and `flyleaf`.

**Tests.** API **+11** (`work-counters` +6, `catalog-pages` +1, `reviews-audit` +4); three existing expectations changed because the owner's decisions superseded them (A-09-036, A-09-037). Mobile **159 → 162** (`rating-bars` 3, added to `npm test`). No test weakened, skipped or deleted.

**What was run here** (one worker, a few files at a time, all green at the end): API `tsc --noEmit`; `work-counters`, `catalog-pages`, `reviews-audit`, `reviews`, `review-ranking`, `authorization-matrix`, `authorization-equivalence`, `social-block`, `social-block-equivalence`, `server-wiring`, `dedupe`, `schema`, `contract`, `reading`, `reading-lifecycle`, `profile-stats`, `feed-query`, `jobs`, `shelves-privacy`, `read-likes`, `read-comments`, `activity`; `spec:generate` + `spec:check` (**drift 0**); api-client build (CI's command); mobile `tsc --noEmit` and `npm test` (162/162); `npm run migrate` on both databases. **Not run by me:** the full API suite and `scripts/ci.mjs` (the owner ran CI, above). `devdb:build` was run into a throwaway `flyleaf_verify_dev`, never `flyleaf_dev` (A-09-038, A-09-044).

`secure-design` was not triggered: this run was autonomous by instruction. The one privacy-relevant change (a cached guest list) re-checks visibility per page and is tested and mutation-checked (A-09-039).

## Verdict (09b items)

| Item | Result | Findings |
|---|---|---|
| 1. Latest rating per user | ✅ trigger, reconcile, C and histogram share one definition; parity proven on both databases | A-09-036 |
| 2. Ten half-star buckets | ✅ API, client, app grouping by the filter's rule | A-09-037 |
| 3. Friends-sort cost | ✅ guest cache; capped exact candidates (one deviation, flagged); ~1.9× under load for heavy, ≥ 12× for guests | A-09-039, A-09-040, A-09-041 |
| 4. Missing stats rows | ✅ a missing backfill copied by `devdb:build` with triggers off; not a trigger bug | A-09-038 |

## Findings

### A-09-036 · P3 → FIXED · Rating aggregates count each reader once, at their latest rated attempt (A-09-027)
- **Rule:** per (user, work), the rating of the highest `attempt_no` with `rating IS NOT NULL`. An unrated newer attempt keeps the reader; clearing the newest rating falls back to the previous one. Nothing in the PRD points at "latest attempt, rated or not" (§34.2 gives each attempt its own rating and is silent on aggregates), so no DECISION NEEDED was raised.
- **Where:** `drizzle/0029_latest_rating_per_user.sql`: a view `latest_ratings` (`DISTINCT ON (work_id, user_id) … ORDER BY attempt_no DESC`) read by `recompute_work_stats_for_work()` (the triggers), `reconcile_work_counters()`, `refresh_catalog_rating_mean()` (C) and the histogram in `CatalogService.getWork`. One definition, so the four cannot drift. Functions and a view only; the migration rewrites no data.
- **Plan:** the per-work predicate is pushed into the view: `Bitmap Index Scan on reads_work_idx`, then a 328 kB in-memory sort of the work's rated reads: hot work **3.7–6.0 ms**, 595–601 buffers (cost grows with the work's reads, not the table). Whole-table form on `flyleaf`: 32 ms, 1,785 buffers, 793 kB hash (`reads` is 62k rows on both databases), so no batching was needed for the reconcile itself.
- **Recompute (both databases):** C refreshed, then every work with reads recomputed through `refresh_work_read_stats()` (the trigger's own path) in **26 batches of 500**, each statement with `statement_timeout = 60s` and `work_mem = 32MB` (12,576 works, 13 s per database). Then parity:
  - `reconcile_work_counters()` → `{"work_stats": 0, "reader_count": 0}` on **both**;
  - an independent oracle (`row_number()` window, not the view) against every stored row: **0 mismatches of 12,576** on both;
  - C = Σ over works of `(rating_sum, rating_count)`: equal on both (`flyleaf_dev` 91,330.5 / 25,283; `flyleaf` 91,326.5 / 25,282).
- **Effect:** `flyleaf_dev` 27,164 attempt ratings → **25,283 reader ratings** (1,833 (user, work) pairs had several rated attempts); C 3.6133 → 3.6123; hot work 3,698 → **2,570** ratings (avg 3.61 unchanged, polarisation 1.1416 → 1.1313). `flyleaf` likewise, plus its three missing rows created (A-09-038).
- **Tests** (`work-counters.test.ts` › *ratings count each reader once…*):
  - "a re-reader who rated 5 then 3 counts once, as 3": **seen failing: yes**;
  - "the nightly reconcile computes exactly what the trigger stored" (three readers, re-reads, a cleared newest rating, two works; the reconcile must fix 0): **seen failing: yes**; **mutation-checked**: the reconcile back on the per-attempt rule fails it;
  - "the catalog mean C is taken over the same population": **seen failing: yes**;
  - "clearing the newest rating falls back…; an unrated newer attempt changes nothing" and "two users count twice": **passed before** (the old rule gives the same numbers there). They pin the rule against the alternative "latest attempt, rated or not": a view without `rating IS NOT NULL` **fails** the clearing test (mutation-checked).
- **Inherited expectation changed:** `dedupe.test.ts` › "work_stats is recomputed for the survivor…" expected 3 ratings where one user had rated both merged records; now 2 (that reader's latest, 5.0, plus 3.0; average still 4). Commented in the test.

### A-09-037 · P2 → FIXED · `rating_distribution` is ten half-star buckets (A-09-029, PRD §9.6)
- **API:** keys `"0.5"`, `"1.0"` … `"5.0"` (numeric(2,1) as text), zero-filled, from `latest_ratings`, so the buckets sum to `rating_count`. The field's shape is replaced; no second field (`contract/schemas.ts`; `catalog/index.ts` `RATING_BUCKETS`; `packages/api-client` `RatingBucket`). Spec regenerated, drift 0. **Breaking contract change**, pre-launch, by decision.
- **App:** `src/lib/ratingBars.ts` groups the ten into five bars, bar n = `"n−0.5"` + `"n.0"`. That is the reviews filter's rule (`rating > n−1 AND rating ≤ n`, A-09-015), so the 4★ bar and the 4★ chip both mean 3.5 and 4.0. The book page uses it.
- **Rating filter: meaning unchanged, by choice.** It filters reviews, which are per attempt; the histogram counts readers. The rule matches, but the populations differ where a re-reader reviewed several attempts: the chip lists each review under its own attempt's rating, while the bar counts the reader once at their latest rating. Documented in the filter's contract description.
- **Tests:** `catalog-pages.test.ts` "has ten zero-filled half-star buckets over the same readers as rating_count…" (**seen failing: yes**); the two existing histogram assertions were rewritten from the five-bucket shape to the ten (seen failing, then passing). Mobile `rating-bars.test.ts`: every bucket lands in the bar whose chip lists it (checked against the server's predicate, written independently), sums, empty. **Mutation-checked:** grouping 4.5 with 4★ fails two of three. The screen itself: phone checklist.

### A-09-038 · P3 → ROOT CAUSE + FIX · Why three works had reads but no `work_stats` row (A-09-035)
- **Evidence:** the same three works also lacked a row on **`flyleaf`** (count query, `statement_timeout` 120 s). Their reads were written **2026-09-03 09:59–10:01**. Migration 0011, which created `work_stats` and its trigger, was committed **2026-09-17** (`e421b1d`). Neither 0011 nor 0026 backfilled `work_stats` (0026 backfills only `reader_count`), and no worker runs the nightly `works.reconcile` locally. `devdb:build` copies with `SET LOCAL session_replication_role = replica` (triggers off) and takes `work_stats` as the source has it. Its `finish()` reconciled read, follow and shelf counters but **not** work counters. So the gap started on `flyleaf` and was copied to `flyleaf_dev`.
- **Verdict:** a missing backfill carried over by `devdb:build`, **not a trigger bug**.
- **Fix:** `devdb.ts` `finish()` runs `reconcile_work_counters()` (which also refreshes C), then fails the build if any work has reads but no stats row. `flyleaf`'s three rows were created by the 09b recompute (works with stats 12,573 → 12,576; missing: 0 on both databases).
- **Test:** `work-counters.test.ts` "creates the row for a work whose reads arrived with triggers off (A-09-035: devdb:build)". It inserts a read under `session_replication_role = replica`, asserts no row exists (the reproduction), then the reconcile creates it. - **Build verified (owner's request, `flyleaf_dev` untouched):** `npm run devdb:build -- --works 20000 --target flyleaf_verify_dev` in the foreground from `flyleaf`. The first attempt failed on a pre-existing bug (A-09-044); after that fix it completed in **411 s** (457 MB database; 20,024 works, 540,006 editions, every user table; 52 foreign keys verified). In the target, the work reconcile had run: C was refreshed at the end of the build from the copied reads (25,282 ratings, the latest-rating population; the row is no longer copied). The no-gaps check passed (0 works with reads and no stats row), and a second `reconcile_work_counters()` fixed 0 rows. **Peak memory:** the build's node process 261 MB; the `flyleaf-pg` container +532 MB (1,835 → 2,367 MB); lowest free host RAM 266 MB, 23 s in, while dropping the previous target and computing the slice. The failed first attempt reached +1,688 MB from a cold 174 MB and briefly left **23 MB** free on the host, which the sampler saw for under 6 s. Heavy for this machine, but it completed; run it with other apps closed. `flyleaf_verify_dev` was then dropped (the only database dropped).

### A-09-039 · P1 → FIXED · Guest friends sort: a 60 s cached ranking per work, rating filter and day
- **Where:** `ReviewService.#guestFriendsPage`. The ranked id list (the uncapped `rankAll`) is cached through the injected `Cache`: `serverDependencies`' `MemoryCache`, now also passed to `reviewsPlugin` via `BuildAppOptions.cache`. Key `reviews:friends:guest:<work>:<rating|all>:<guest day key>`, TTL 60 s. Signed-in viewers never reach this path. Without an injected cache (most test apps), nothing is cached.
- **Privacy:** the page's ids are re-checked against live visibility (one indexed query on ≤ `limit` ids) before hydration, so a review deleted or made private within the 60 s drops out at once. Cost: that page is one short and `total` one high until the entry expires. A new review reaches guests within 60 s, as on `GET /works/:id`.
- **Test:** `reviews-audit.test.ts` "caches the guest ranking for 60 s, re-checks visibility, and never serves it to a signed-in viewer". **Seen failing before:** the caching assertion fails on HEAD's code (a new review shows at once). **Mutation-checked:** without the re-check, the private review is served.

### A-09-040 · P1 → FIXED · The signed-in friends sort ranks a capped, exact candidate set
- **Where:** `ReviewService.#friendsPage`, `cappedPrefixIsExact`, `LOWER_BOUND_SLACK` and `scoreAndSort`. `scoreAndSort` is the sort `rankReviews` already did, split out so the exact scores are visible; the formula and the exploration step are unchanged.
- **Candidates:**
  - the top N visible reviews in (friend tier, SQL lower bound) order. The lower bound is the SO-23 score with credibility 0 and every non-friend a stranger, using the same weights (passed from `REVIEW_RANKING_WEIGHTS`) at the same instant;
  - plus the exploration pick, chosen as `rankReviews` chooses it, from the whole pool (non-friend, ≤ 14 days, < 5 likes; read one minute wider).
  N starts at `max(200, 2 × (offset + limit))` and doubles until the page is exact. The ranking context (second degree, credibility) is read for the candidates' authors only.
- **Exactness:** a review left out scores at most the boundary's lower bound + 0.24 (non-friend: credibility 0.10 + second degree 0.35 × 0.4) or + 0.10 (friend: credibility only). The prefix of length `offset + limit` is exact when any of these holds:
  - its last item beats that bound strictly (ties break by date and id, which the bound says nothing about);
  - its last item is a friend while the boundary is not;
  - the candidates are exhausted.
  The exploration slot moves a review only within page one, so an exact prefix stays exact. An epsilon of 1e-9 absorbs the difference in SQL and JS float order.
- **Deviation from the approved plan, CONFIRMED by the owner (2026-09-30):** the plan loaded **every** friend review. The heavy persona follows 1,158 accounts, and 2,007 of the hot work's reviews are theirs, so the friend tier is capped by the same bound (slack 0.10). The order is still exact, and this is tested.
- **Tests** (`reviews-audit.test.ts` › *friends sort: capped candidates…*), all compared with the uncapped `rankAll`, with `Date` frozen:
  - "a signed-in viewer gets exactly the uncapped order, page by page…": 423 reviews; 15 second-degree and credible authors whose lower bounds fall outside the first 200 rank in the first two pages; offsets 0, 20, 40 and 220;
  - "extends by exactly the slack credibility and second-degree proximity can add (0.24)": a fixture where the 20th candidate lies between boundary + 0.14 and + 0.24;
  - "caps the friend tier too, extending by the credibility a friend can add (0.10)";
  - "sort=friends pages through every review exactly once" (Part 09) still passes.
- **Mutation checks:** never extending fails; a non-friend slack of 0.10 fails; 0.14 fails; a friend slack of 0 fails; removing the guest re-check fails. One **equivalent mutant**: dropping `x.tier === 1` in the friend-boundary branch cannot change the result, because with N ≥ 2K the first K candidates are then all friends (kept as the argument written out).
- **Not seen failing before the fix:** the cap is new (HEAD ranked everything, which is the parity oracle).

### A-09-041 · P3 · Recorded · What the friends sort still costs
- Heavy persona, one pass (no extension), `EXPLAIN (ANALYZE, BUFFERS)` warm on `flyleaf_dev`:
  - candidate top-N: 60 ms, 2,787 buffers, `top-N heapsort` 69 kB;
  - `count(*)`: 22 ms, 2,579 buffers;
  - pool: 3.6 ms, 1,838 buffers (`reviews_work_idx` on `published_at`);
  - second degree: **16 ms**, 2,183 buffers (was ~110 ms over all authors);
  - credibility: **15.6 ms**, 2,025 buffers (was 75 ms).
  Queries per request 6 → **8**; one extension adds 3, and the sequential pass saw 8–11.
- The candidate and count queries still evaluate visibility over **all** of the work's reviews (the `visible` predicate hash-joins `reads`, 62k rows, on this data), so their cost grows with the work's review count. The first candidate read now runs in parallel with the others. A `count(*) OVER ()` in place of the count query was tried, **measured slower** (candidate query 161 ms) and reverted.
- Unloaded p50 for heavy is **unchanged** (198 → 207 ms in the final pair): the cap adds a dependent round (candidates → context). The win is under load, from less DB work per request.

### A-09-042 · RL → Part 15 · The book reviews list and book page have only the Global tier
- `GET /works/:id/reviews` (the friends sort is its most expensive read) and `GET /works/:id` fall under PRD §24.4 **Global** (1,000/h signed in, 200/h anonymous), which is not enforced anywhere (A-05-RL6). No limit was added here; Part 15 builds the limiter layer.

### A-09-043 · P2 · Open → Part 10 · The year-stats histogram is still five buckets
- The user's year stats (`reading/index.ts`, `rating_distribution`) bucket that user's own ratings into five with `Math.round`. PRD line 2708 (the stats screen) also asks for "the 10 half-star buckets". This is outside 09b's scope (the owner's decision named the book page); Part 10 owns stats.

### A-09-044 · P2 → FIXED · `devdb:build` has failed on every run since migration 0026
- **Evidence:** the verification build stopped at `copied blocks` with `duplicate key value violates unique constraint "catalog_rating_stats_pkey"`. 0026 ends with `SELECT refresh_catalog_rating_mean()`, which inserts the singleton row into the fresh target during `runMigrations`. `copyAll` then treats `catalog_rating_stats` as user data and copies the source's row in full. `flyleaf_dev` predates 0026, so nobody had hit it.
- **Fix:** `devdb.ts` skips `catalog_rating_stats` (derived: C); `finish()` recomputes it through `reconcile_work_counters()` (A-09-038). **Seen failing before the fix: yes** (the first verification build); passing after (the second).

### A-09-045 · P2 → FIXED · A migration test re-ran "the last migration" instead of 0025
- **Where:** `dob-confirmation.test.ts` › "a re-run does not un-confirm someone who has since confirmed 2000-01-01" ran `migrationFiles().at(-1)` against a database migrated only up to 0025, although the same file's setup says to pick 0025 by name because later migrations exist. Since 0026 it re-ran a migration that never touches `users` (0027, then 0028), so it **passed without testing 0025's re-run**. 0029 needs 0026's `catalog_rating_stats`, which exposed it (the CI failure).
- **Fix:** the test re-runs `0025_dob_confirmation` by tag. **Seen failing before the fix: yes** (CI, and locally). **Mutation-checked:** moving 0025's `UPDATE` outside its `IF NOT EXISTS` guard (so a re-run un-confirms) now fails it; 0025 was restored byte-for-byte and matches HEAD. No other test replays "the last migration".

## Performance (Part 09b, `flyleaf_dev`, indicative only)

Bench runner, 10 connections × 10 s, with warm-up, **back to back**: HEAD's `reviews/index.ts` against 09b's, with the same server build otherwise. The machine's state changed during the session (588 MB of free RAM at one point), so absolute numbers moved about 2× between pairs; the ratios did not. Files: `docs/audit/perf/09b-before*.md` and `09b-after*.md`. `09b-after-5` is the final code; `09b-after-3` and `-4` are the code before the first candidate read ran in parallel.

| Pair | Scenario | Before p50/p95/p99 | After p50/p95/p99 | Unloaded p50 | Queries |
|---|---|---|---|---|---|
| 1 | friends heavy | 416 / 571 / 595 | 226 / 258 / 327 | 96 → 123 | 6 → 8 |
| 1 | friends guest | 285 / 310 / 373 | 20 / 25 / 28 | 68 → 8.7 | 4 → 3 |
| 2 | friends heavy | 414 / 522 / 1,542 | 223 / 253 / 275 | 97 → 119 | 6 → 8 |
| 2 | friends guest | 575 / 671 / 789 | 21 / 25 / 30 | 143 → 9.0 | 4 → 3 |
| 3 | friends heavy | 791 / 925 / 1,085 | 420 / 495 / 595 | 203 → 263 | 6 → 8 |
| 4 (final code) | friends heavy | 793 / 939 / 1,111 | 413 / 475 / 601 | 198 → 207 | 6 → 8 |
| 4 (final code) | friends guest | 585 / 653 / 729 | 44 / 54 / 60 | 137 → 23 | 4 → 3 |

- Heavy: **~1.9× at p50 and 1.9–2.2× at p95** under load in every pair. p95 < 300 ms was met only in the machine's quieter state. Guest: **12–28×** on cache hits; a miss costs what it did before.

## Behaviour changes (Part 09b, client-observable)

1. `work_stats` and `GET /works/:id` (`rating_count`, `avg_rating`, `weighted_rating`), and everything that reads them (search, shelves, feeds), count each reader once, at their latest rated attempt; C changes accordingly.
2. `GET /works/:id` `rating_distribution` has ten keys, `"0.5"` … `"5.0"` (was `"1"` … `"5"`), and counts readers, not attempts, summing to `rating_count`.
3. `GET /works/:id/reviews?sort=friends` for guests: the order can be up to 60 s old. New reviews appear within 60 s; removed ones disappear at once, with the page one short and `total` one high in the meantime.
4. App: the book page's five bars group the ten buckets the way the filter chips do (3.5 counts as 4★, 4.5 as 5★, the same as before for half stars).

## Decisions needed (09b)

None. The one flagged deviation (the friend tier is capped too, A-09-040) was **confirmed by the owner** on 2026-09-30.
