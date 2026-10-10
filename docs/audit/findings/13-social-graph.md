# Audit 13 — Social graph (SO-01 … SO-06), with D-11-2 and D-12-2

2026-10-10 · CI: **green in 1,057 s** (sandbox, second run; first run hit a pre-existing flake, below) · Tests: API **1,547 → 1,585** (+27 in the new `social-graph-audit.test.ts`, +10 in `slug-history.test.ts`, +1 in `import-export-audit.test.ts` for D-12-2); mobile **187 → 189** (+2 in `social-follow.test.ts`). No test was weakened or skipped. Two existing assertions pinned behaviour this part changed on an owner decision and were updated with a comment (list under "Behaviour changes" › "Tests changed").

**How this part ran.** In a cloud sandbox (Linux), not on the laptop. Overrides from the owner for this run:

- **No `flyleaf` / `flyleaf_dev`.** A local **PostgreSQL 18.3** (the `@embedded-postgres/linux-x64@18.3.0-beta.16` npm package; apt is blocked by the sandbox proxy) on port 5432 with an empty `flyleaf` database. `npm run migrate` ran clean on it, including 0036 and 0037, and again after their journal rows were removed (idempotent on a database that already had them).
- **MinIO** built from source as in Part 12 (`go install github.com/minio/minio@RELEASE.2025-04-22T22-12-26Z`) and run on :9000, so the S3 contract tests ran in CI.
- **No bench data.** Pagination and 404 timing were measured on **synthetic users** seeded into the sandbox database by the new `src/bench/social-graph.ts --seed` (7,012 users: one public account with 2,000 + 10 followers, a viewer following 300 of them, 20 blocks by and 10 against the viewer, 5,000 background users following ~20 each: 100,691 follows). **Every latency below is "sandbox, synthetic"**; only ratios, plan shapes, buffer and statement counts are evidence. `--clean` removes all of it.
- **Migrations 0036 and 0037** applied to PGlite (every test) and the sandbox Postgres only. **Not applied to `flyleaf` or `flyleaf_dev`** (see Deferred).
- Branch `audit/13-social-graph` from `main`, committed, pushed, PR to `main`.

**"Seen failing".** The two new API test files were copied onto unmodified `main` (a separate worktree) and run there: **9 of the 26 tests in `social-graph-audit.test.ts`** (the 27th, A-13-014's unmute test, was seen failing by removing the unmute delete) and **9 of the 10 in `slug-history.test.ts`** fail on `main`; the D-12-2 test fails on `main`. The tests that pass on `main` are guards that confirm a claim held, each named in its section. Concurrency cannot be reproduced on PGlite (one connection): A-13-001 and A-13-006 were seen failing with `src/bench/social-graph.ts --race` against Postgres, on `main`'s code and then on this branch.

## Owner decisions recorded at the start of this part

- **D-12-1 confirmed:** imports merge; no replace mode now; "import replace mode" added to the post-audit list in `PENDING.md`. Recorded in `findings/12-import-export.md` › Decisions.
- **D-12-2 = (b):** a Calibre book imports as want-to-read unless a tag says read, reading or DNF. **Built** (`imports/configs/calibre.ts` `calibreStatus()`: whole tags, case-insensitive; DNF before reading before read). Test *D-12-2: a Calibre book is want-to-read unless a whole tag says read, reading or DNF* (`import-export-audit.test.ts`), seen failing on `main` (`fiction, owned` imported as finished; `reading-list` matched `reading` as a substring). Recorded in `findings/12-import-export.md` › Decisions.

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| SO-01 | follows/blocks/mutes migration 0016, trigger-maintained counters | ⚠️ the documented schema does not exist (`follows` is from 0011, no `updated_at`, `followee_id`; `mutes(user_id, target_type, target_id)`); the counter trigger lost updates under concurrency and deadlocked mutual follows; the reconcile rewrote every profile nightly | A-13-001, A-13-002, A-13-003 |
| SO-02 | follow, private requests, accept/reject, auto-accept on going public | ⚠️ state machine correct on every transition (tests below); but unfollow and mute answered 200 for a user who blocked you (block confirmable), a follow could land after a block, deleted accounts were acceptable and listed, and no §11.7 limit exists | A-13-005, A-13-006, A-13-007, A-13-008, A-13-011, D-13-1, D-13-2 |
| SO-03 | block: bidirectional, complete, silent, severs follows | ⚠️ severs follows and pending requests both ways with counters (guard tests); but the pair's `followed` cards survived, blocking someone who blocked you answered 200, a concurrent follow survived the block (19–33 %), and a blocked profile's 404 was a statement slower than a random id's | A-13-004, A-13-005, A-13-006, A-13-012 |
| SO-04 | mute user / mute book, silent | ✅ idempotent, self 400, random user or work 404 with no row, merged work → survivor (Part 03), silent (the muted user's view is byte-identical); the unmute tests could not fail; a deleted account was mutable and listed | A-13-005, A-13-011, A-13-014, A-13-015 |
| SO-05 | followers/following lists, paginated, private 404, blocked excluded, indicators | ⚠️ privacy and indicators correct; but every page loaded and sorted **all** followers in memory, ties had no order, deleted accounts were listed and counted; the app showed the first 50 only | A-13-010, A-13-011, A-13-013 |
| SO-06 | blocked view ≡ non-existent account (8 surfaces) | ⚠️ the 8 bodies are identical (guard); not covered: follow/unfollow/mute/block writes (A-13-005), 404 timing (A-13-012). Likes, comments, saved shelves, reviews and feed are in Part 05's matrix and pass | A-13-005, A-13-012 |
| D-11-2 | (owner decision) slug and username history with 301s | **Built** | A-13-020 |

**Aliases (lead 3):** `/v1/follows/:userId`, `/v1/follows/requests…`, `/v1/blocks…`, `/v1/mutes…`, `/v1/followers/:userId`, `/v1/following/:userId` share the canonical handlers; a test now proves identical status and body for lists, 404s, paging edge values and writes (A-13-009). Neither the app nor `@flyleaf/api-client` calls any alias.

## Findings

### A-13-001 · P1 · Follow counters lost concurrent updates, and mutual follows deadlocked
- **Where:** `drizzle/0016_social_graph.sql` `follows_counter_trigger_fn` → `refresh_profile_follow_counts()` (a `COUNT(*)` recount of both users per changed row).
- **Evidence (sandbox Postgres, `npx tsx src/bench/social-graph.ts --race`):** 50 concurrent follows of one user → `follower_count` **2**, truth 50 (each transaction counted without the others' uncommitted rows; the last writer won). 25 pairs following each other at the same moment → **13 and 17 deadlocks** in two runs (each transaction locked the follower's profile, then the followee's: opposite orders), each a 500 to the client, and 9 of 51 profiles drifted. The nightly reconcile hid it until the next night.
- **Spec:** architecture §3.9 (counters exact, reconciled nightly as a safety net); §33 reliability.
- **Fix:** 0036: the trigger is incremental (`±1` on transitions into or out of `accepted`, nothing on a no-op update) and locks both profile rows in `user_id` order before writing (`follows_count_delta()`). An increment is applied to the newest row version, and one lock order cannot cycle. 0016's `refresh_profile_follow_counts()` is dropped. Backfill: `SELECT reconcile_follow_counters()`.
- **After:** 50/50, **0 deadlocks**, 0 drifted, in each of 4 runs.
- **Test:** `social-graph-audit.test.ts` › *follow and unfollow counters follow every state transition, and nothing else* (a regression guard; passes on `main` too: PGlite cannot run two transactions). Seen failing before the fix: yes, on Postgres with the bench (above).

### A-13-002 · P2 · `reconcile_follow_counters()` rewrote every profile nightly and reported nothing
- **Where:** 0016; `jobs/index.ts` `reconcileFollowsJobHandler`.
- **Evidence:** an unconditional `UPDATE profiles` of every row (two correlated counts each), returning `void`; the job logged `reconciled: true` whatever happened, so drift (A-13-001) was invisible.
- **Fix:** 0036: one aggregate, writes only drifted rows, returns how many (like `reconcile_read_counters()`); the job returns and logs `corrected`.
- **Test:** *reconcile_follow_counters() repairs drift, touches only drifted rows, and reports how many* (checks `xmin` of an untouched row). Seen failing before the fix: yes.

### A-13-003 · P3 · tasks.md describes a schema that does not exist
- SO-01 claimed `follows(follower_id, following_id, …, updated_at)` created in 0016, and `mutes(muter_id, muted_id, target_work_id)` with a two-column check. Real: `follows(follower_id, followee_id, state, created_at)` created in **0011**, no `updated_at`; `mutes(user_id, target_type, target_id)` with `target_type IN ('user','work')` and no FK on `target_id`. No code or test uses the documented names (`grep following_id|muter_id|muted_id|target_work_id`: none). Struck through and corrected.

### A-13-004 · P1 · A block left the pair's "followed" cards in the feed
- **Where:** `social/index.ts` `blockUser` (before: deleted the follows, not their activity; `unfollowUser` deletes both).
- **Evidence:** A follows B (card "A followed B", public), A blocks B: the follow is gone but the card stays in A's followers' feeds, asserting a follow that no longer exists between two people who blocked each other.
- **Spec:** PRD §11.4 ("severed"), §34.3.
- **Fix:** the block deletes both directions' `followed` cards in the same transaction.
- **Test:** *removes the pair's 'followed' cards in both directions, as an unfollow does*. Seen failing before the fix: yes.

### A-13-005 · P0 · Writes confirmed a block: unfollow, mute and block of a user who blocked you answered 200
- **Where:** `social/index.ts` `unfollowUser`, `muteUser`, `blockUser` (before: "exists" meant a `users` row, soft-deleted included, and ignored blocks).
- **Evidence:** B is blocked by A. `GET /v1/users/A` → 404 (as a random id), but `DELETE /v1/users/A/follow` → **200** `{status:"none"}`, `POST /v1/users/A/mute` → **200** (and a mute row), `POST /v1/users/A/block` → **200**; for a random id all three are 404. Two requests tell B that A exists and has blocked them. A soft-deleted account answered 200 the same way.
- **Spec:** PRD §11.4 ("the block must never be confirmable"), §16.3, AC-12; 00-method "check writes as well as reads".
- **Fix:** follow, unfollow and mute share one guard: missing, soft-deleted or blocked either way → the random-id 404. Block: missing, soft-deleted or **blocked by the target** → 404; blocking someone you already blocked stays idempotent (their block already hides both ways). `loadRelationship()` gained `blockedByOwner` (one more `EXISTS` in the same statement). Unblock, unmute and reject stay 200 for any id (they act on the caller's own rows and answer the same for every id).
- **Test:** *follow, unfollow and mute of a user who blocked you, whom you blocked, or who is deleted: the random-id 404*; *blocking a user who has blocked you is the random-id 404; blocking someone you blocked stays idempotent*. Seen failing before the fix: yes (both).

### A-13-006 · P1 · A follow (or an accept) racing a block survived it; follow and card were separate writes
- **Where:** `followUser`, `acceptFollowRequest`, `blockUser`.
- **Evidence (sandbox Postgres, `--race`):** 100 pairs where B follows A while A blocks B: **33, 19 and 28** follows left between blocked users in three runs on `main` (the follow checked "not blocked", then inserted after the block's delete had run). Separately, the follow row and its `followed` card were two autocommitted statements, and two concurrent follows each wrote a card.
- **Spec:** PRD §11.4; 00-method "concurrency and idempotency".
- **Fix:** follow, accept and block of a pair run in one transaction under a pair advisory lock (`lockPair()`), and the follow re-reads the relationship inside it. The follow is `INSERT … ON CONFLICT DO UPDATE … WHERE state <> 'accepted' RETURNING`, so only the statement that created or upgraded the row writes the card, in the same transaction. Unfollow deletes row and card together.
- **After:** **0** of 100 in each of three runs.
- **Test:** *two follows submitted together write one card* (a guard on PGlite); the race was seen failing on Postgres with the bench (above).

### A-13-007 · RL · PRD §11.7 anti-abuse limits are not implemented
- **Evidence:** no limiter call anywhere in `social/` (`grep -n limiter`): unlimited follows per hour and day, follow-unfollow-refollow cycles, and no new-account cap. §24.4 repeats follows 50/hour, 200/day.
- **Proposed for Part 15 (no new table needed):** the existing `PgRateLimiter` (`rate_limits` fixed windows), checked in `followUser` before the insert and counting **every follow and request attempt**, refused with 429 `rate_limited`:
  - `follow:h:<viewer>` 50 per 3,600 s and `follow:d:<viewer>` 200 per 86,400 s;
  - the cycle rule: `follow:pair:<viewer>:<target>` 3 per 86,400 s (a re-request after a reject counts, see A-13-008);
  - new accounts: `follow:new:<viewer>` 20 per 86,400 s while `users.created_at > now() - 24 h`.
  - If an exact sliding 24 h is wanted instead of fixed windows: `follow_events(follower_id uuid, followee_id uuid, kind text CHECK (kind IN ('follow','request')), created_at timestamptz, FK users ON DELETE CASCADE)`, indexed `(follower_id, created_at DESC)` and `(follower_id, followee_id, created_at DESC)`, purged after 7 days by the nightly sweep. Recommendation: the limiter keys (no schema, consistent with comments).
- **Fix:** `DEFERRED → Part 15`.

### A-13-008 · RL · A rejected request can be re-sent at once, forever
- **Evidence:** reject deletes the row; the requester's next `POST …/follow` is a fresh request (test *rejecting removes the request; the requester may ask again at once*, a guard documenting today's behaviour). A harassment vector: a private account can be re-requested every second.
- **Spec:** none specific; §11.7's cycle limit is the natural cover.
- **Fix:** `DEFERRED → Part 15` with A-13-007's pair key (requests count as cycles).

### A-13-009 · P3 · Alias routes duplicate every social route
- **Evidence:** 15 alias routes (route inventory lines 50–70) share the canonical handlers; nothing calls them; each doubles the surface Part 15's limiter must cover. Proven identical by *aliases answer exactly as the canonical routes* (lists, 404s, paging edge values `limit=0`, `offset=-1`, writes).
- **Spec:** the PRD and architecture name only `/v1/users/:id/…` and `/v1/me/…`.
- **Recommendation:** keep the canonical set, remove the aliases in Part 15 together with the route inventory refresh (a breaking change for no known client; the mobile app and api-client use only canonical paths). Not removed here (no drive-by API removals).

### A-13-010 · P2 · Followers/following lists read every follower into memory for every page
- **Where:** `getFollowers` / `getFollowing` (before: all accepted edges joined to users and profiles, sorted, then the viewer's blocks filtered and the page sliced in JS).
- **Evidence (sandbox, synthetic, 2,010 followers):** every page read and sorted **2,010 joined rows: 10,090 shared buffers**, 4 statements, p50 18–22 ms whatever the offset. `ORDER BY created_at DESC` with no tie-break: follows made in the same instant (bulk accepts, imports) came back in arbitrary order, so pages could repeat or skip a user.
- **Fix:** paged in SQL. The page's ids come from new partial indexes `follows_followee_list_idx` / `follows_follower_list_idx` `(user, created_at DESC, other_id DESC) WHERE state = 'accepted'` (index-only), with deleted accounts (new `users_deleted_idx`, a tiny partial index) and the viewer's blocks (one hashed set) filtered there; profiles and both indicators are joined for the page only, in the same statement; the total is one `count(*)` over the same filter, run in parallel. Order is newest first with the listed user's id as tie-break.
- **After:** 3 statements; page query **633 buffers**, count 149; p50 **7.8–9.0 ms** at offsets 0/1,000/1,900 (**2.3–2.8×** faster, same machine, back to back). Offset 1,900 still walks 1,950 index entries (~1 ms); keyset paging is not needed at this size (see Deferred for 10×).
- **Test:** *pages are newest first with an id tie-break: every follower exactly once, none twice*. Seen failing before the fix: yes.

### A-13-011 · P2 · Soft-deleted accounts were listed, counted and acceptable
- **Where:** lists, pending requests, blocks list, mutes list, `acceptFollowRequest`.
- **Evidence:** with `deleted_at` set, the account still appeared in followers/following pages and totals, in the owner's pending requests (and could be accepted, re-counting it), in `/v1/me/blocks` and `/v1/me/mutes`. PRD §25.4: "all content hidden platform-wide".
- **Fix:** all five leave out deleted accounts; accepting one is the random requester's 404. (Account deletion itself is not built yet; Part 15.)
- **Test:** *accepting a request from an account deleted since…*, *pending followers, deleted accounts and anyone blocked … are left out of the page and the total*, *GET /v1/me/blocks lists only your own blocks…*, *GET /v1/me/mutes leaves out deleted accounts*. Seen failing before the fix: yes (all four).

### A-13-012 · P2 · A blocked profile's 404 took one statement more than a random id's
- **Where:** `identity/index.ts` `getProfile` (before: read the profile row, then the relationship; a random id stopped after the first).
- **Evidence (sandbox, synthetic, 500 alternating requests each after 20 warm-up):** blocked p50 **2.95 ms (2 statements)** vs random p50 **1.83 ms (1 statement)**, Δ **1.12 ms**: a timing channel to tell "blocked" from "does not exist". The followers list was already level (Δ 0.05 ms, 1 statement each).
- **Fix:** the relationship query (which also answers "exists") runs first; missing, deleted and blocked all stop after that one statement.
- **After:** blocked 3.08 ms vs random 3.01 ms (1 statement each), Δ **0.07 ms** (within noise). Bodies identical before and after.
- **Test:** statement counts and timings from `--timing` (above); the identical bodies are guarded by `social-block-equivalence.test.ts`.

### A-13-013 · P2 · The app's followers/following screens showed the first 50 only
- **Where:** `apps/mobile/app/user/[id]/followers.tsx`, `following.tsx` (`api.getFollowers(id)` once, no paging), while the header showed the full total.
- **Fix:** a "Show more" button loads the next page (`offset = rows shown`); `appendFollowPage()` drops a row shown already (offset paging shifts by one when someone follows between pages); `hasMoreFollows()` stops on an empty page.
- **Test:** `social-follow.test.ts` › *followers / following paging (A-13-013)*. New helpers (the code was inline); evidence for the bug is the code above.

### A-13-014 · P2 · Weak tests
- `social-mute.test.ts` *unmutes a user cleanly* / *unmutes a book cleanly* assert only the response: with the `DELETE` removed from `unmuteUser`, the whole SO-04 suite still passed (tried). New: *unmuting removes the mute row, for a user and a work* — seen failing with the delete removed: yes.
- `social-graph-migration.test.ts` reconcile test could not see a reconcile that rewrites every row (A-13-002); replaced by the `xmin` test.
- SO-06 covers reads only; the write paths are now in A-13-005's tests.

### A-13-015 · P3 · Mutes and claims of a hard-deleted account
- `mutes.target_id` has no FK (polymorphic). A user mute or block-list row pointing at an account that is later hard-deleted stays as an orphan (lists inner-join and hide it). Account hard deletion does not exist yet → Part 15 retention sweep (delete `mutes` where `target_type='user'` and the target is gone).

### A-13-016 · P3 · Counters still include soft-deleted accounts
- Lists now leave deleted accounts out (A-13-011) but `follower_count`/`following_count` still count their follows, so for up to 30 days a header can say one more than the list. Fix with the account-deletion flow (Part 15): either remove the deleted account's follows at deletion (restored from a snapshot on undo) or have the counter trigger and reconcile ignore deleted accounts.

### A-13-017 · P3 · Pending requests list is unbounded
- `GET /v1/me/follow-requests` returns every request in one response. Fine at today's sizes; with A-13-007/8 limits in place the list is bounded in practice. → Post-audit (paging when a private account with thousands of requests exists).

### A-13-018 · Note · Not built yet, for later parts
- Mentions and notifications (§11.3 "they are notified", §34.3 mention of a user who later blocks you) do not exist → SO-3x.
- A muted **work** is excluded from feeds (Part 14 verifies); recommendations do not exist yet, so "and from recommendations" (§11.5) cannot be checked → whichever part builds recommendations.

### A-13-019 · Note · Verified as claimed (guards)
- Follow state machine: none → accepted (public) / pending (private) → none; idempotent re-follow (no second row, card or count); self 400; pending not counted, no card; cancel; accept after cancel 404; going public accepts pending requests and counts them; going private keeps existing followers, makes new follows requests and narrows the account's past public cards to followers (SO-10's retroactive claim holds).
- Block severs accepted follows **and pending requests** in both directions with counters; unblock restores nothing; the blocks list never shows who blocked you; likes and comments by a blocked user are hidden (`read-likes`/`read-comments` tests); Part 05's matrix covers likes lists, comments, saved shelves, reviews, slug routes and the feed for `blockedBy`/`blocker` viewers and passes.
- Mute is silent: the muted user's profile, followers and following responses are byte-identical before and after.

### A-13-020 · D-11-2 built · Slug and username history, 301 on every slug route
- **Design (0037):** two claims tables, one per kind, holding **every value ever used, the current one included**, with the primary key as the reservation: `shelf_slugs(user_id, slug) → shelf_id` and `username_claims(username) → user_id`. Triggers on `shelves` (insert / update of slug) and `profiles` (insert / update of username) write them, so every path (API, import, admin, a hand-run `UPDATE`) is covered; a value claimed by another shelf of the same owner, or by another account, raises a unique violation, which the existing handlers already turn into a new slug (`generateUniqueSlug` now reads `shelf_slugs`, and `#withSlugRetry` retries) or 409 `username_taken`. Backfilled from today's shelves and profiles.
- **Shelves:** a renamed shelf keeps its old slugs; the owner's next shelf of the old name gets `-1`; a shelf may take back its own old slug. A deleted shelf keeps its claims, so its links 404 while deleted and work again on restore; a purge (Part 15) cascades them.
- **Usernames:** new `PATCH /v1/me/username` (PRD §6.43 lists username under Account; there was no way to change it). The old name stays with the account: not registrable, offered as taken by `username-available`, refused to a change by another account (409), and its owner may take it back.
- **Routes:** `/u/:username/shelves/:slug`, `/v1/users/:username/shelves/slug/:slug`, `/v1/shelves/by-slug/:username/:slug` answer an old username, an old slug or both with **one** `301` to the same route with the current pair, `Cache-Control: no-store` (a cached `a → b` would loop once the shelf is renamed back to `a`), empty body. The redirect is decided **after** the visibility check: a viewer who may not see the shelf (guest or stranger on a private account or shelf, blocked either way, a deleted account) gets the random slug's 404 byte for byte, never a `Location`. There is no profile-by-username route yet (`flyleaf.app/@username`, PRD §16.5, is Phase 2), so the shelf routes are the only vanity routes today; the claims table is what that page will read.
- **Reservation period (decision taken, D-13-3):** for the account's lifetime. Any expiry reopens the hazard the owner wanted closed (a freed name opening someone else's links). Hoarding (changing name repeatedly to reserve many) is bounded by a change limit, which belongs to Part 15's limiter (A-13-021).
- **Tests:** `slug-history.test.ts` (10). Seen failing on `main`: 9 of 10 (the tenth, another owner's shelf of the same name is unaffected, is a guard).

### A-13-021 · RL · No limit on username changes
- With old names reserved for the account's lifetime (D-13-3), unlimited changes let one account reserve many names. Proposed for Part 15: `username:<user>` 1 per 30 days (and at most 10 claims per account, if wanted). `DEFERRED → Part 15`.

## Performance

Sandbox PostgreSQL 18.3, synthetic users (header). **Not measured on `flyleaf_dev` — rerun on the laptop** (`npx tsx src/bench/social-graph.ts --seed --lists --timing --race`, then `--clean`). In-process `inject()`, 40 sequential requests per row after 5 warm-up, `BENCH_COUNT_QUERIES=1`.

| Endpoint / query | Before p50 / p95 | After p50 / p95 | Plan notes |
|---|---|---|---|
| `GET /v1/users/:id/followers` offset 0 (2,010 followers, viewer with 30 blocks) | 22.4 / 29.2 ms · 4 statements | 8.1 / 10.7 ms · 3 statements | before: bitmap scan of all 2,010 edges, 2,010 users + profiles probes, quicksort 173 kB, **10,090 buffers**, JS filter + slice |
| … offset 1,000 | 18.1 / 24.1 ms | 7.8 / 10.4 ms | after: index-only scan of `follows_followee_list_idx`, anti-joins on hashed blocks and `users_deleted_idx`, 50 profile probes: **633 buffers** page + **149** count |
| … offset 1,900 | 20.3 / 25.2 ms | 9.0 / 13.2 ms | 1,950 index entries walked (~1 ms); grows with offset, not with table size |
| `GET /v1/users/:id` 404, blocked vs random | 2.95 vs 1.83 ms (2 vs 1 statements), Δ 1.12 ms | 3.08 vs 3.01 ms (1 vs 1), Δ 0.07 ms | the blocked path now stops after the relationship query |
| `GET /v1/users/:id/followers` 404, blocked vs random | 1.73 vs 1.68 ms, Δ 0.05 ms | 3.06 vs 2.94 ms, Δ 0.12 ms | unchanged (1 statement each); absolute numbers moved with machine load, the Δ is the evidence |
| 50 concurrent follows of one user | counter 2 / truth 50 | 50 / 50 | A-13-001 |
| 25 pairs following each other at once | 13–17 deadlocks, 9 / 51 profiles drifted | 0 deadlocks, 0 drifted | A-13-001 |
| 100 follow-vs-block races | 19–33 follows survive the block | 0 | A-13-006 |

PRD budgets (p95 < 300 ms) are met with a wide margin; indicative only (sandbox, synthetic).

## Behaviour changes

1. `DELETE /v1/users/:id/follow` and `POST /v1/users/:id/mute` (and aliases): 404 `not_found` (the random-id body) for a soft-deleted account and for one blocked either way (were 200). `POST /v1/users/:id/block`: 404 for a soft-deleted account and for one who has blocked the caller (was 200). (A-13-005)
2. Blocking removes both users' `followed` cards about each other. (A-13-004)
3. Follow, accept and block of the same pair are serialized; a follow and its card are written together; a concurrent duplicate follow writes no second card. (A-13-006)
4. Followers/following: deleted accounts left out of pages and `total`; order is newest first then user id descending (ties were arbitrary). Pending requests, blocks and mutes lists leave out deleted accounts and break ties by id. Accepting a deleted account's request → 404. (A-13-010, A-13-011)
5. `GET /v1/users/:id` runs the relationship query first (no visible change; timing only). (A-13-012)
6. Counters: `profiles.follower_count`/`following_count` are maintained incrementally; `reconcile_follow_counters()` returns an integer (was `void`); `follows.reconcile` job result gains `corrected`. (A-13-001, A-13-002)
7. **New:** `PATCH /v1/me/username` (200 profile, 409 `username_taken`, 422 `invalid_field`); api-client `changeUsername()`. (A-13-020)
8. **New:** the three slug routes answer `301` with `Location` and `Cache-Control: no-store` for an old slug or an old username of a shelf the viewer may see. (A-13-020)
9. A slug a shelf used to have is no longer reused by another shelf of the same owner (gets `-1`); a username another account had is refused at registration and by `username-available`. (A-13-020)
10. Calibre imports: a book with no read/reading/DNF tag is want-to-read (was finished); tags are matched whole (`reading-list` no longer means reading). (D-12-2)
11. App: followers/following screens load further pages ("Show more"). (A-13-013)

**Tests changed** (assertions pinning behaviour changed above, each commented in place): `import-mapping.test.ts` (Calibre row 1 with tags `sci-fi, classic` now expects `want`, D-12-2).

## Decisions

### D-13-1 · Taken (owner, 2026-10-10, recorded in Part 14): option (b)
- A single accepted follow request writes a `followed` card, dated at the acceptance and owned by the requester (visibility as `recordActivity` decides: followers-only if the requester's account is private). The bulk accept when an account goes public writes **none** (a settings change; N cards at once would be a burst).
- **Built in Part 14:** `social/index.ts` `acceptFollowRequest` records the card in the accept's transaction. Tests: `feed-audit.test.ts` › *D-13-1: accepting one request writes one followed card; going public writes none*; the Part 13 assertion that pinned "no card on accept" is updated with a comment (`social-graph-audit.test.ts`). See `findings/14-feed.md` A-14-016.

### D-13-2 · Taken (owner, 2026-10-10, recorded in Part 14): keep existing followers when an account goes private
- Code unchanged (existing followers stay accepted; new follows become requests). **PRD §11.1 amended** to say so ("setting an account private makes new follows requests requiring approval; existing followers are kept").

### D-13-3 · Taken: old usernames are reserved for the account's lifetime (confirmed by the owner, 2026-10-10)
- Options: (a) lifetime of the account (built); (b) N days, then freed; (c) never reserved. (b) and (c) let a freed name open someone else's links, which D-11-2 rules out. Released only when the account is hard-deleted (its claims cascade). **Owner confirmed (a)** at the start of Part 14; nothing to change.

## Decisions needed

None open (D-13-1 and D-13-2 decided above).

## Deferred (with reason and owner)

| Item | Why deferred | Owner |
|---|---|---|
| **Apply migrations 0036 and 0037 to `flyleaf` on the laptop** (and to `flyleaf_dev` with the other audit migrations at Part 15) | Sandbox has neither; `flyleaf_dev` stays unchanged until Part 15. Both are safe any time: 0036 replaces a trigger function, builds three indexes (follows ≈ 186k rows on the bench data: seconds) and reconciles counters; 0037 adds two tables and two triggers and backfills from `shelves` and `profiles` | Laptop / Part 15 |
| **Rerun the social bench on the laptop** (`npx tsx src/bench/social-graph.ts --seed --lists --timing --race --clean`, `DATABASE_URL` → `flyleaf_dev`, `BENCH_COUNT_QUERIES=1`); also the Part 01 bench celebrity's followers at offset 1,900 with `npm run bench -- --only followers` | Latencies above are sandbox, synthetic | Laptop / Part 15 |
| §11.7 follow limits, refollow cycles, new-account cap, re-request after reject, username change limit (A-13-007, A-13-008, A-13-021) | One limiter layer | Part 15 |
| Remove the 15 alias routes (A-13-009) | Recommendation; route inventory refresh | Part 15 |
| Counters vs deleted accounts; orphan mutes after hard delete (A-13-015, A-13-016) | Account deletion flow not built | Part 15 |
| ~~D-13-1, D-13-2~~ decided 2026-10-10 (above); D-13-1 built in Part 14 | Owner decisions | Owner |
| Username field in the app's Account settings (calls `changeUsername()`) | UI; the API and links are done | Post-audit |
| Keyset paging for followers at 10× (offset 19,000 walks 19,000 index entries; ~10 ms) and the `total` count (O(followers) per page) | Not needed at today's sizes; plan: cursor `(created_at, id)` alongside `offset`, total from the counter minus the viewer's few blocked | Post-audit |
| Owner `avatar_url` on shelves (A-11-029) | Consistency, no screen affected | Part 15 |
| Pending requests paging (A-13-017) | Small lists today | Post-audit |
| Flaky timing test A-04-006 in `auth-audit.test.ts` (fails 2/6 on `main` in the sandbox) | Part 04 code, not this part's | Part 15 |

## CI result

`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs` in the sandbox, with Postgres 18.3 on 5432 and MinIO on 9000: **green in 1,057 s, exit 0**, all 9 steps (api-client build, api typecheck, spec check, api tests **1,585 passed / 78 files**, api build, api audit, mobile typecheck, mobile tests **189 passed**, migrations on a real Postgres). GitHub Actions (`check`) on the PR: green.

The **first** run failed one test, `auth-audit.test.ts` › *login for an unknown email costs about as much as a wrong password (A-04-006)* (`expected 56.6 to be greater than 84.9`), after 1,019 s. Not this part's: it fails **2 of 6** runs alone on unmodified `main` in this sandbox and 1 of 3 on this branch; the two code paths do the same argon2 work, and the test compares the sum of 3 samples of ~30 ms on a loaded 2-worker machine. Untouched here (Part 04 code). → **Part 15:** make it robust (median of more samples, or compare argon2 calls counted instead of wall time). The rerun was green.
