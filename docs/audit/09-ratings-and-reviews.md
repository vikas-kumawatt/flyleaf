# Audit Part 09 — Ratings and reviews (SL-60 … SL-64)

**Read `docs/audit/00-method.md` first.** Part 05 fixes the review **visibility** leaks (403 → 404, blocks and private accounts in `getReview` and the list). Check it has been done, and don't redo it. This part covers everything else.

Spec: PRD §9 (all; §9.2–9.4 **[LOCKED]**, §9.5 Bayesian, §9.6 distribution, **§9.7 manipulation prevention**), §10 (all; §10.3 **[LOCKED]**, §10.4 spoilers, §10.5 visibility, §10.6 content requirements, §10.7 ranking), §6.24–6.27, §34.2. Architecture §3.5, §3.9.

Code: `apps/api/src/reviews/index.ts`, migration `0011_ratings_reviews.sql` (the `work_stats` trigger), `0018` (which narrowed that trigger's UPDATE columns), `catalog/index.ts` (the stats projection); mobile `src/ui/components.tsx` (`Stars`, `Heart`), `app/review/compose/[id].tsx`, `app/review/[id].tsx`, `app/work/[id].tsx` (reviews tab), `src/offline/*` (`save_review`). Tests: `reviews.test.ts`, `review-ranking.test.ts`.

**Already reworked in SO-23; don't redo:** the ranking formula, friends-first tier, exploration slot and credibility (`rankReviews`, `rankingContext`). You may audit their **performance** below.

## SL-62 — Bayesian rating and `work_stats`

- **Two implementations of one rule**: the SQL trigger `recompute_work_stats_for_work()` and TypeScript `ReviewService.recomputeWorkStats()` (called after every rating change in `upsertReview`/`updateReview`). They run back to back, so the work is done twice, and any divergence is a bug. Prove they agree on a fixture set (like the dedupe normalisation parity test), then remove the redundant TS call from the request path, or record why it must stay.
- **(Moved to Part 08 as L-01.)** Check Part 08 fixed the catalog-mean scan; don't redo it. The original note follows for context. **The catalog mean `C`** is `AVG(rating) FROM reads WHERE work_id <> x` — a scan of all rated reads **on every rating change** (via the trigger). Measure it on the real DB with the bench data. At scale it grows with the reads table. Replace it with a cached global mean (a small table refreshed by a job, or a running sum/count), and record the drift tolerance.
- **§9.7 manipulation prevention**: "ratings from accounts under 7 days old or with fewer than 5 total ratings are **excluded from aggregates**". Is that implemented? Almost certainly not. If it's missing, it's P1: the aggregate is computed in the trigger, so the fix belongs there (and changes when a user crosses the threshold, so a job must recompute that user's works).
- Half-step ratings enforced at the API **and** the DB check. Ratings on non-terminal reads: does the spec allow rating a book you're still reading? Check and test.
- `heart_count`, `read_count` and `dnf_count` semantics: distinct users vs attempts (re-reads). Match the spec.
- `polarisation` (stddev): is it used anywhere? If not, record it.

## SL-63 — review composer and review writes

- **Validation**: empty or whitespace, 10,000 cap (server) and 5,000 soft warning (client), `spoiler_after_page` ≥ 0 and ≤ the edition's page count, and `spoiler_after_page` without `has_spoilers`.
- **Reviewing a non-terminal read**: allowed? Check PRD §10. `upsertReview` currently accepts any read the user owns.
- **Rate limit** (§10.6): 10 reviews/hour, 30/day. Record as `RL` for Part 15.
- **Atomicity**: `upsertReview` updates the read's rating/heart, recomputes stats, then inserts or updates the review, then writes activity, all as separate statements outside a transaction. Crash between steps → inconsistent state. Wrap it in one transaction.
- **Resurrection**: upserting over a soft-deleted review sets `deletedAt = null`. Is that intended? Does its activity come back? Does the SO-22 thread-lock lift? Decide and test.
- **Visibility change** on edit propagates to the activity row (`updateActivityVisibility`), in both the `upsertReview` and `updateReview` paths. The latter doesn't call it today: verify.
- `source = 'import'` reviews write no activity (IM-07). Test it.
- **Mobile autosave (SL-63)**: drafts are saved to **`expo-secure-store` every 3 s**. SecureStore is meant for small secrets, and large values can fail on some platforms; check the Expo SDK 57 docs for the size limit. A 10,000-character draft (~10–40 KB in UTF-8 with non-Latin text) may not save. Test the limit in code or docs, and move drafts to SQLite/AsyncStorage if needed.
- The offline `save_review` mutation replays idempotently (upsert keyed by read, so it should be). Verify.

## SL-60 / SL-61 — stars and heart (mobile)

- `Stars`: 0.5-step drag, 44×44 targets, haptics per step, `accessibilityRole="adjustable"` with increment/decrement. **Clearing a rating** (back to NULL, which PRD §9.3 requires to be possible): how? Test the path end to end, API included (does `rating: null` clear it?).
- The heart is independent of rating (§9.4 [LOCKED]): heart without a rating, and un-heart.

## SL-64 — review detail and the book reviews list

- **List performance**: `listWorkReviews` loads **every** review of the work, maps and sorts them in JS, then slices. `total` is the full count. For the bench hot work (5,000+ reviews), measure p95 and memory. Fix: cap the candidate set in SQL (e.g. top N by a pre-score, plus the viewer's friends' reviews fetched separately), and paginate the non-ranked sorts (`newest`/`highest`/`lowest`/`likes`) in SQL with keyset cursors.
- `sort=likes|newest|highest|lowest` tie-breaks are deterministic (id as the final key), so pagination never repeats or skips.
- **The rating filter** compares `reads.rating` to `String(query.rating)`. Does `4` match `4.0`? Are half-star filters possible? Test it.
- Spoilers in list and detail: blurred until tapped, **never remembered globally** (§10.4). Check the mobile code.
- Deleted reviews: a detail request → 404; a list excludes them; `review_count` in `work_stats` excludes them (does the trigger know about soft deletes?).
- Review detail share: the link format and whether a public page exists (SO-50 later). The link shouldn't point at something that 404s today without saying so.

## Performance

Bench: `GET /v1/works/:hot/reviews?sort=friends` as `heavy` and as a guest, `GET /v1/reviews/:id`, `POST /v1/reads/:id/review`. `EXPLAIN` the list query and the `rankingContext` queries (the second-degree follow join and the credibility median) on the hot work. Target p95 < 300 ms; record before and after.

## Deliverables

`docs/audit/findings/09-reviews.md`, fixes, tests, and audit lines under SL-60…64.
