# Audit Part 13 — Social graph (SO-01 … SO-06)

**Read `docs/audit/00-method.md` first.** Part 05 built the cross-resource visibility matrix. Reuse it; don't rebuild it.

Spec: PRD §11 (all: §11.3 relationship states, **§11.4 blocking semantics**, §11.5 muting, **§11.7 anti-abuse limits**), §6.42, §16.3, §25.3, §26.1–26.3, §34.3, AC-n for block/follow in §49. Architecture §3.6 and §3.9.

Code: `apps/api/src/social/index.ts` (about 1,550 lines), `identity/index.ts` (the privacy toggle auto-accepting requests), migrations `0011` (the `follows` table was created **here**, not in 0016 as tasks.md says) and `0016_social_graph.sql`, `jobs/index.ts` (`follows.reconcile`, scheduled nightly since SO-20); mobile `app/user/[id]*.tsx`, `app/profile/{requests,blocked,muted}.tsx`, `src/lib/socialValidation.ts`. Tests: `social-*.test.ts`.

## Confirmed leads

1. **tasks.md describes a schema that doesn't exist.** SO-01 says `follows(follower_id, following_id, …)` and `mutes(muter_id, muted_id, target_work_id)` with a two-column check. The real tables are `follows(follower_id, followee_id, state, created_at)` (**no `updated_at`**) and `mutes(user_id, target_type, target_id)`. Correct the docs (P3). Then check the code and tests don't assume the documented shape anywhere.
2. **§11.7 anti-abuse limits** (follows 50/hour and 200/day; follow-unfollow-refollow of the same user blocked after 3 cycles in 24 h; new accounts ≤ 20 follows in their first 24 h) are almost certainly unimplemented. Record `RL` for Part 15. The cycle rule needs state (a follow-events log or counter), so propose the schema.
3. **Alias routes** (`/v1/blocks/:userId`, `/v1/mutes/...`, `/v1/followers/:userId`, `/v1/following/:userId` alongside the canonical `/v1/users/:id/...`). Are they identical in behaviour, including 404s and pagination? Are they in the spec? Recommend keeping one set. Don't delete routes the mobile app calls: grep first.

## SO-02 — follow, private accounts, requests

State machine: none → pending (private target) / accepted (public target) → none. Test **every** transition:
- Following yourself → 400. Following twice → idempotent (same state, no duplicate activity, no counter double-count). Following a user who has blocked you, or whom you blocked → 404 (identical body).
- **Cancelling a pending request** (DELETE follow while pending). **Rejecting** a request, then the requester re-requesting: allowed immediately? Spec? (Rejected-request spam is a harassment vector.) Accepting a request that was already cancelled → 404.
- A private account switching to public auto-accepts pending requests (claimed). Check **counters and activity**: does each auto-accept write a `followed` activity (a burst of N cards)? Switching public → private: existing followers are kept (spec?), and past public activity drops to followers-only (SO-10 claims it's retroactive).
- A follow targeting a deleted user → 404.
- Counters count only `accepted`. `reconcile_follow_counters()` repairs drift: add a drift-repair test like SO-20's.
- Activity: the `followed` verb is written only for accepted follows, and removed or kept on unfollow (spec? the aggregation in SO-13 depends on it).

## SO-03 / SO-06 — block

§11.4 says: complete, bidirectional, silent, severs follows, and "the blocked user's view of your profile is indistinguishable from an account that does not exist".
- Blocking severs follows **and pending requests** in both directions (test the pending case). Counters update.
- Everything else the blocked pair can reach about each other → 404 or omitted. Use the Part 05 matrix, plus the resources added since SO-06: likes lists and comments (SO-21/22 handle it; verify), shelves saved from the other party, feed (Part 14), and reviews on books (Part 09). Mentions and notifications don't exist yet; note them for SO-3x.
- **"Indistinguishable" in timing too.** Is a 404 for a blocked profile measurably slower or faster than for a missing UUID? It's an enumeration channel if it's large. Measure; P2 at most.
- Idempotent block/unblock. Unblock doesn't restore follows (claimed). Blocking a user you've muted keeps or removes the mute (spec?).
- `GET /v1/me/blocks` lists only your blocks, never who blocked you.

## SO-04 — mute

- Mute a user / mute a work: idempotent, the target must exist (404 otherwise; a mute on a random UUID must not create a row, which the `target_id` column without an FK allows today). Self-mute → 400.
- **Silent**: nothing observable to the muted party (no counter, no list).
- The effect: the muted user's activity disappears from feeds (Part 14 verifies) but they stay followed. A muted work disappears from feeds **and** recommendations (none yet; note it).
- A muted work that gets merged (Part 03).

## SO-05 — followers / following lists

- Pagination is `limit/offset`. For the bench celebrity (2,000+ followers), measure offset 1,900. Keyset pagination would be the fix if it's slow.
- `followedByViewer`/`followsViewer` indicators: computed per row (N+1) or in one query? Count queries per request.
- Third-party blocked users are excluded (claimed). Pending followers never appear. A private account's lists → 404 for non-followers (claimed).
- Ordering is deterministic (newest first, with a tie-break).

## Deliverables

`docs/audit/findings/13-social-graph.md`, the follow state-machine test, fixes, docs corrections, and audit lines under SO-01…06.
