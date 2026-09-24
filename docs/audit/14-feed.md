# Audit Part 14 — Feed (SO-10 … SO-15)

**Read `docs/audit/00-method.md` first.** SO-21 added `interaction` to feed items and the `#withInteractions` enrichment. It's already tested; audit it only for performance.

Spec: PRD §12 (all: §12.1 structure, §12.2 activity types and weights, §12.3 ranking, §12.4 diversity rules, **§12.5 cold start**, §12.6 avoiding a toxic engagement system, **§12.7 technical design**), §6.13 home feed, §23.5 data retention (the **180-day activity prune**), §26.2, AC-11 in §49. Architecture §8 (fan-out on read, **p95 < 200 ms migration trigger**).

Code: `apps/api/src/activity/{index,ranking}.ts`, migration `0017_activity.sql`, the `recordActivity` call sites (reading, reviews, shelves, social, identity); mobile `app/(tabs)/index.tsx`, `src/ui/FeedCard.tsx`, `src/lib/feedCard.ts`. Tests: `activity.test.ts`, `feed-{query,ranking,cold-start}.test.ts`, mobile `feed-card.test.ts`.

## Confirmed leads, verify and fix

1. **Cursor pagination loses and duplicates items.** Both feeds fetch `max(limit × 3, 60)` candidates by `created_at DESC`, re-rank and diversify them in TypeScript, return the first `limit`, and set `next_cursor` to the **last returned item's `created_at`**. Ranking reorders, so the last returned item isn't the oldest candidate. The next page (`created_at < cursor`) **skips** every unreturned candidate newer than the cursor, and can **repeat** items when the reordering pulls old ones forward. `has_more = rows.length > limit` is also wrong (almost always true). Write a test that walks all pages of a 200-activity feed and asserts every eligible activity appears **exactly once**. It will fail. Then fix it. Options: rank within fixed time windows and cursor on the window boundary; or a cursor encoding `(window_end, served ids)`; or rank only page 1 and serve chronologically after. Pick one, justify it against §12.3/§12.7, and document the behaviour change.
2. **`affinity` is never supplied.** `rankAndDiversifyFeed(items, limit, { now })` is called without `affinities`, so `affinity(viewer, actor)` is always 1.0. The "min 1 low-affinity card per 10" rule is therefore meaningless, and the ranking claimed in SO-12 is `weight × decay` only. Implement affinity per the spec (from recent interactions: likes, comments, profile visits if tracked; computed in one query for the page's actors), or record it as a spec gap and correct the claim.
3. **The home screen doesn't call the API.** `app/(tabs)/index.tsx` renders **hard-coded sample items**, yet SO-15 claims "real feed cards" and tasks.md reports "92/92 mobile tests". Wire it to `GET /v1/feed` (`client.getFeed` exists since SO-21): Friends/Popular tabs, cursor paging (after lead 1 is fixed), pull to refresh, cold-start banners from `is_cold_start`/`cold_start_reason`, empty and error states, and guest mode (Popular only, with the Friends tab gated). Keep the sample data only in tests or storybook-style fixtures.
4. **The "Want to read" swipe is fake.** `handleWantToRead` shows the toast "Saved to Want to Read" and **calls nothing**. The claimed endpoint `POST /v1/shelves/want-to-read/items` doesn't exist. Want-to-read is a read status (PRD §8.2), so wire the swipe to the existing reads upsert (`status: 'want'`) through the offline queue, with a real success/failure toast. The "Rate & Review" swipe goes to `/log?workId=`: verify that route exists and opens the right flow.
5. **L-14 from Part 01: adding a book to want-to-read shows up as "started" in the feed.** Find which path writes `started` for a `want` status (reading upsert, imports, the shelves layer?) and fix it: want-to-read isn't reading, and PRD §12.2 has no "wants to read" card. Add a test that a `want` upsert writes no `started` activity. Do this together with lead 4, since the fixed swipe goes through the same path.
6. **No 180-day activity prune** (§23.5). No job exists. Add a pg-boss job (daily, batched deletes so it never locks `activity` for long), following the reconcile jobs' pattern, and schedule it in `worker.ts`. Likes and comments are on reads, so they survive (SO-21's rationale). Verify nothing else references pruned activity ids.

## SO-10 — activity write-on-action

- Every verb in the CHECK list has a writer, or is documented as unused (`rated`, `quoted`, `goal_reached` today?).
- **Lifecycle**: a read deleted → its activity deleted. A read switched to private/followers → activity visibility updated (the reading path must call `updateActivityVisibility`, Part 08 checks the caller). A review deleted → removed (claimed). A shelf deleted or made private → shelved activity hidden. Unfollow → `followed` activity removed? A work merged (Part 03) → `activity.work_id` repointed. A user deleted → cascade.
- **Imports** write nothing (claimed). Test a large import produces zero rows.
- Duplicate writes: a double finish, a re-finish, re-shelving the same book, follow → unfollow → follow. How many rows does each produce? Match the spec's intent (no spam).
- Retroactive private-account toggling (claimed): does switching back to public re-publicise old activity, or keep it followers-only? Check the spec.

## SO-11 — the feed query

- Friends: accepted follows only (pending never leaks), `public` + `followers` activity from followed actors, blocks both ways, muted users and muted works excluded (claimed), and **private-account actors**: rely on activity visibility being correct (see SO-10). Test a private actor the viewer follows vs one they don't.
- Popular: what makes it "popular"? Today it looks like recent public activity with no popularity signal. Compare with §12.1/§12.5 and record the gap. Guests allowed; blocks/mutes applied when signed in; private accounts never appear.
- **Performance (the §12.7 / architecture §8 trigger is p95 > 200 ms)**: `EXPLAIN (ANALYZE, BUFFERS)` the friends query for bench `heavy` (1,000+ follows). The query uses a correlated subquery **per row** for the first author name and `NOT EXISTS` against `blocks` and `mutes` per row, fetches `limit × 3` rows, then runs `#withInteractions` (2 queries). Is `activity_actor_idx (actor_id, created_at desc)` used via a follows join, or does it scan `activity`? Measure page 1 and page 2 for `heavy`, `typical` and `new`, and the popular feed for a guest. Fix what's over budget. (The fan-out-on-write migration is out of scope; record whether the trigger has been hit.)

## SO-12 / SO-13 — ranking, diversity, aggregation

- Weights match §12.2 exactly. Decay is 36 h. Diversity (AC-11): max 2 consecutive by the same person, max 3 per book per 20, max 1 "started" per 10 (with a fallback for thin feeds). Each rule has a test that would fail if the rule were removed. Mutation-check at least two.
- **Determinism**: the same inputs give the same order (important for pagination and for tests).
- Aggregation: shelf adds by the same actor to the same shelf; follows; same-day starts, "day" in whose timezone? Aggregated cards keep enough ids for the client to render (works list, shelf id). They interact correctly with pagination (an aggregate spanning a page boundary?).
- High-value verbs are never aggregated (claimed).

## SO-14 — cold start

- 0 follows → popular (and the response labels it). 1–3 → blended. More than 3 with no recent activity → backfill. Empty DB → editorial card. **Check `following_count`**: is it the profile counter (can drift) or a live count? Does blending call `getPopularFeed` more than once per request? Count the queries.
- The editorial card uses a nil UUID for actor and id. Does the client handle it (no profile link, no like button: `interaction` must be `null`, so check)?

## SO-15 — feed cards (mobile)

- After wiring (lead 3): every card type renders from **real** API payloads (aggregated, blended, editorial). Spoiler blur. Accessibility: swipe actions have button equivalents (claimed), labels, 44 dp targets, and **no hard-coded colours** (FeedCard uses `'#3B82F6'`, `'#EF4444'` and others; move them to tokens per the design rule).

## Deliverables

`docs/audit/findings/14-feed.md`, the pagination exactly-once test, the prune job, the wired home screen, perf before/after for every feed scenario, and audit lines under SO-10…15.
