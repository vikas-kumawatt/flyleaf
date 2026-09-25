# Audit 05 — Authorization and API contract (FN-70 … FN-72, FN-80 … FN-82, D-04-1)

2026-09-25 · CI **green** (598 s, clean run on the final tree) · tests **927 → 1017 API** (+90: new `authorization-matrix.test.ts`, `authorization-equivalence.test.ts`, `hooks-hardening.test.ts`, one contract test; no test weakened, skipped or removed; three inherited assertions updated to the spec, listed under Behaviour changes) · mobile 100, unchanged

Databases: correctness on PGlite; plans, query counts and latency on **`flyleaf_dev`** (8 GB machine, **timings indicative only**). No migration was added (`npm run migrate` run on both databases: nothing pending). `secure-design` was not triggered: this run was autonomous by instruction, and this part is itself the authorization review.

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| FN-70 | viewer argument on every user-scoped method | ⚠️ the argument exists everywhere, but five services each ran their own profile/block/follow lookups, and several ignored what they fetched (blocks in `getReview`, blocks in saved shelves, follows in lists, `deleted_at` everywhere) | A-05-001, -002, -005, -008, -009 |
| FN-71 | one `canView()` | ❌ `canView()` was right; the SQL list filters and hand-rolled checks next to it disagreed with it (reviews list, reads list, stats, saved shelves). Now one relationship query (`loadRelationship`), one SQL twin (`canViewSql`), proven equivalent over 63 cells | A-05-002, -005, -008, -020 |
| FN-72 | cross-user suite, 404 not 403, every private type | ❌ covered reads only; review PATCH/DELETE answered 403; three routes' 404 bodies differed from a random id's. Now a table-driven matrix: 9 viewer states × public/private/deleted accounts × 3 visibilities over 17 single resources, 7 lists, 20 write routes | A-05-001 … -006 |
| FN-80 | route schemas, `openapi.yaml` generated from them | ⚠️ the generator kept its own plugin list and omitted exports (4 routes); the profile schema stripped three fields the client reads | A-05-007, A-05-014 |
| FN-81 | typed client **generated**, CI-enforced | ❌ hand-written (every feature commit edits `types.ts`), header claimed "generated, do not edit"; CI builds it but cannot detect drift | A-05-021 |
| FN-82 | hook chain, auth never rejects | ⚠️ auth hook correct against real forged / `alg:none` / expired / malformed / 6 KB tokens (now tested on the real app); `x-request-id` taken verbatim; DB constraint errors became 500; no CSP; download tokens logged | A-05-015 … -019 |
| (lead 1) | review PATCH/DELETE 403 | ❌ confirmed | A-05-003 |
| (lead 2) | `GET /v1/reviews/:id` ignores blocks and private accounts | ❌ confirmed (P0) | A-05-001 |
| (lead 3) | work reviews list ignores private accounts and read visibility | ❌ confirmed (P0) | A-05-002 |
| (lead 4) | feed registered twice | ❌ confirmed; nothing called `/feed` | A-05-013 |
| (lead 5) | generator plugin list | ❌ confirmed, exports missing | A-05-014 |
| D-04-1 | restrict unverified accounts | 🚫 → ✅ implemented | A-05-010, A-05-011 |

## Findings

### A-05-001 · P0 · `GET /v1/reviews/:id` ignored blocks, private accounts and deleted owners
- **Where:** `reviews/index.ts` `getReview` (checked only the review's own visibility).
- **Evidence:** matrix run on the pre-fix file: 16 cells returned 200 that must 404, e.g. `blockedBy → public account, public: want 404, got 200`, `stranger → private account, public: want 404, got 200`, `guest → deleted account …`.
- **Spec:** PRD §11.4, §26.1, §25.3, §42 #7.
- **Fix:** one row query (viewer's like folded in as `EXISTS`) + `loadRelationship` + `canViewWith` on the stricter of review and read visibility. Denials are the same 404 as a missing review.
- **Test:** `authorization-matrix.test.ts` › single resources › `GET /v1/reviews/:id`; › `review visibility is the stricter of review and read`. Seen failing before the fix: yes.

### A-05-002 · P0 · `GET /v1/works/:id/reviews` listed private accounts' reviews and ignored the read's visibility
- **Where:** `reviews/index.ts` `listWorkReviews` (hand-rolled SQL: visibility and blocks only).
- **Evidence:** pre-fix: `guest/stranger/pending → private account, public: LEAKED`; a public review on a **private** read was returned to guests (`guest GET: expected 200 to be 404`).
- **Spec:** PRD §26.1, §26.2 ("`reads.visibility` and `reviews.visibility` are checked in canView()"), §16.3.
- **Fix:** the filter is now `canViewSql(viewer, { visibility: mostRestrictiveSql(review, read), … })`. SO-23 ranking untouched.
- **Test:** matrix › lists › `GET /v1/works/:id/reviews`; › stricter-of-two (2 tests). Seen failing before the fix: yes.

### A-05-003 · P1 · Review PATCH/DELETE answered 403 to non-owners
- **Where:** `reviews/index.ts` `updateReview` / `deleteReview`.
- **Evidence:** `PATCH /v1/reviews/:id` as a stranger → `403 {"code":"forbidden","message":"You can only edit your own reviews"}`, confirming the review exists.
- **Spec:** PRD §25.3 "not-found over forbidden".
- **Fix:** 404 `Review not found`, identical to a random id.
- **Test:** matrix › writes › `PATCH /v1/reviews/:id`, `DELETE /v1/reviews/:id`. Seen failing before the fix: yes.

### A-05-004 · P0 · Three routes' denial body differed from a random id's, making blocks and private items confirmable
- **Where:** `shelves/index.ts` `getBySlug` (`/v1/shelves/by-slug/…`, `/v1/users/:username/shelves/slug/…`, `/u/:username/shelves/:slug`) and `getUserShelves` (`/v1/users/:id/shelves`): `assertCanView` with its default message.
- **Evidence:** denied → `{"code":"not_found","message":"Not found."}`; missing → `"Shelf not found."` / `"User not found."`. 55 mismatching cells on by-slug alone, including `blockedBy → public account, public`.
- **Spec:** PRD §11.4 "a block must never be confirmable".
- **Fix:** every denial uses the route's own missing-resource message.
- **Test:** matrix › single resources (by-slug ×2, user shelves, `/u/…` web). Seen failing before the fix: yes.

### A-05-005 · P0 · Saved shelves stayed visible after a block
- **Where:** `shelves/index.ts` `getSavedShelves`: filtered with `canView` but never passed `isBlocked`.
- **Evidence:** pre-fix: `blockedBy → public, public: LEAKED`, `blocker → public, public: LEAKED`.
- **Fix:** filter moved into SQL with `canViewSql` (blocks, deleted owners, followers, private accounts); the follow query and the TS filter are gone.
- **Test:** matrix › lists › `GET /v1/shelves/saved`. Seen failing before the fix: yes.

### A-05-006 · P1 · Private profiles returned 404 to signed-in non-followers (AC-13 violated)
- **Where:** `identity/index.ts` `getProfile` (its own comment promised a "restricted header profile").
- **Evidence:** `stranger/pending/unverified → private: want 200 (restricted), got 404`. A reader could not see "Request to follow" or their own pending state.
- **Spec:** AC-13, PRD §16.3, and the profile screen spec ("Private account, not following → header only, plus a Request to follow button").
- **Fix:** signed-in non-followers get `isRestricted: true`: header, bio, avatar, counts, `followStatus`, `followedBy`; favourites empty. Guests still get 404 (**D-05-2**).
- **Test:** matrix › profiles; `authorization.test.ts` and `social-follow.test.ts` updated (see Behaviour changes). Seen failing before the fix: yes.

### A-05-007 · P1 · The profile response schema stripped `followStatus`, `followedBy` and `isRestricted`
- **Where:** `contract/schemas.ts` `profileSchema`. The service set them; Fastify's serializer dropped them.
- **Evidence:** mobile reads all three (`src/lib/socialValidation.ts`, follow button); the api-client `Profile` type declares them. They never arrived.
- **Fix:** declared (optional) in the schema; spec regenerated.
- **Test:** matrix › profiles asserts `followStatus`/`isRestricted` over HTTP. Seen failing before the fix: yes (the profile cells above).

### A-05-008 · P1 · Accepted followers never saw followers-only reads in lists and stats
- **Where:** `reading/index.ts` `list` (`AND (isOwner OR r.visibility = 'public')`) and `getStats` (called `canView` without `isFollower`).
- **Evidence:** pre-fix: `follower → public, followers: missing`, `follower → private, followers: missing` on `GET /v1/users/:id/reads`. Not a leak, but the list disagreed with `GET /v1/reads/:id`.
- **Fix:** `visibleLevels(viewer, owner, rel)`, derived from `canView()`, drives `r.visibility IN (…)`; stats filter with the loaded relationship.
- **Test:** matrix › lists › `GET /v1/users/:id/reads`; equivalence › `visibleLevels`. Seen failing before the fix: yes.

### A-05-009 · P2 · Soft-deleted accounts stayed visible everywhere
- **Where:** no read path honoured `users.deleted_at`: profile, reads, reviews, shelves, stats, follower lists, likes/comments, browse, feed.
- **Evidence:** every `deleted account` cell failed pre-fix (`… deleted account, public: want 404, got 200`, feed and browse `LEAKED`).
- **Spec:** PRD §25.4 step 4 "all content hidden platform-wide".
- **Severity:** P2 because no deletion route exists yet (latent until §25.4 ships).
- **Fix:** `loadRelationship` treats a deleted owner as missing; `canViewSql` requires a live owner; browse and both feed tabs join `users … deleted_at IS NULL`.
- **Not fixed:** a deleted user's own access token still authenticates for up to 15 minutes (`lookup` is stateless). → with A-04-007, the §25.4 implementation.
- **Test:** matrix (deleted column throughout). Seen failing before the fix: yes.

### A-05-010 · P1 · D-04-1 implemented: unverified accounts cannot review, comment or follow
- **Where:** `authorization/index.ts` `requireVerified` (next to `canView`), called from `ReviewService.upsertReview` (when publishing a new or deleted review, **before** the rating write), `InteractionService.addComment` (first), `SocialService.followUser` (first; covers both `/users/:id/follow` and `/follows/:userId`). 403 `email_unverified`. `GET /v1/me` now has `emailVerified` for the banner.
- **Spec:** PRD §25.3 roles, §6.6, §42 #4.
- **Open:** imports still publish reviews for unverified accounts (**D-05-3**).
- **Test:** matrix › unverified accounts (review refused and nothing written, comment, follow ×2, reading/logging/liking/shelving still open, verified control); hooks-hardening › `/v1/me emailVerified`. Seen failing before the fix: yes (comment, follow ×2, `/me`).

### A-05-011 · P1 · Signing up again with an unverified email now resends verification
- **Where:** `identity/index.ts` `register` → `#resendForExistingUnverified`.
- **Behaviour:** response is the same 409 `email_taken` as for a verified account, so it says nothing about verification. The resend shares the `resend_verification:<user>` limit (1/60 s, silent when limited). Never issues tokens for the existing account.
- **Not done as written:** the brief asked for a response identical to a *fresh* signup. A fresh signup returns 201 with tokens, so identity is impossible without either issuing tokens for someone else's account or inventing a phantom one. → **D-05-1**.
- **Shortcut to know about:** the resend path swallows all errors (`catch {}`) so a mail failure cannot turn the 409 into a 500; a failing mailer is silent here. Timing: the unverified path does two extra writes and a send, a small oracle between verified and unverified (both already reveal "exists").
- **Test:** hooks-hardening › `signing up again with an existing email`. Seen failing before the fix: yes.

### A-05-012 · P1 · A replayed follow demoted an accepted follow to a request
- **Where:** `social/index.ts` `followUser`: `onConflictDoUpdate set { state }` with `state` from the account's *current* privacy.
- **Evidence:** follow a public account, it goes private, the client replays the follow → row becomes `pending`; a second `followed` activity was also written on every replay.
- **Fix:** already-accepted → return `accepted`, no write; the upsert never downgrades (`CASE WHEN state = 'accepted' …`).
- **Test:** matrix › `follow replay is idempotent`. Seen failing before the fix: yes (`expected 'pending' to be 'accepted'`).

### A-05-013 · P1 · The feed was served twice (`/feed` and `/v1/feed`)
- **Evidence:** `app.ts` registered `activityPlugin` with and without the prefix. Nothing in mobile or the client called `/feed` (client base URL is `…/v1`).
- **Fix:** unprefixed registration removed.
- **Test:** matrix › `the feed is served once`. Seen failing before the fix: yes.

### A-05-014 · P1 · The spec generator kept its own plugin list and omitted exports
- **Where:** `contract/generate.ts`.
- **Evidence:** `POST/GET /exports`, `GET /exports/{id}`, `GET /exports/{id}/download` were served but not in `openapi.yaml`.
- **Fix:** the spec is read off `buildApp({ spec: true, … })` with stub services; `/healthz` and `/readyz` schemas moved into `app.ts`. The two HTML share pages are `hide: true`. Regenerated: 4 operations added, every other operation byte-identical except the three profile ones (A-05-007).
- **Test:** `contract.test.ts` › `every route buildApp serves is in openapi.yaml, unless its schema hides it`, capturing routes through the `fastify.initialization` channel as `bench/routes.ts` does. Seen failing before the fix: yes (on the old `openapi.yaml` it lists the four export routes).

### A-05-015 · P2 · `X-Request-Id` was taken verbatim from the client
- **Where:** `app.ts` `requestIdHeader: 'x-request-id'`; the value goes into every log line and a response header.
- **Fix:** `genReqId` keeps it only if it matches `^[A-Za-z0-9._-]{1,64}$`, otherwise a fresh UUID. (Real CR/LF is already rejected by Node's header parser.)
- **Test:** hooks-hardening › `X-Request-Id …` (6). Seen failing before the fix: yes (4 of 6 against the old config).

### A-05-016 · P1 · Database constraint violations became 500
- **Evidence (probe before the fix):** `POST /v1/reads` with a nonexistent `work_id` → 500 (FK); `POST /v1/reads/:id/progress` with `page: 2147483648` → 500 (int4 overflow).
- **Fix:** central mapping in the error handler by SQLSTATE through Drizzle's `cause`: 23505 → 409 `conflict`; 23503 → 422 `invalid_reference`; 23514/23502/22003/22P02/22007/22008/22001 → 422 `invalid_field`. No constraint or column names in the body. Only listed codes map; anything else stays a sanitized 500.
- **Test:** hooks-hardening › `database constraint violations are 4xx` (2). Seen failing before the fix: yes (probe).
- **Note:** better per-route messages (e.g. 404 "Work not found" for the read case) belong to Part 08.

### A-05-017 · P3 · Any 413 said "File exceeds the 10MB limit. Please split your export"
- **Fix:** `FST_ERR_CTP_BODY_TOO_LARGE` → 413 `body_too_large`. **Test:** hooks-hardening. Seen failing before the fix: yes (probe).

### A-05-018 · P2 · No Content-Security-Policy on HTML
- **Where:** admin console pages, shelf share pages (`/shelf/:id`, `/u/…`). `grep` found no CSP anywhere.
- **Fix:** share pages: `default-src 'none'; style-src 'unsafe-inline'; img-src https: data:; …` (they run no script). Every other HTML response: a baseline with `object-src 'none'; base-uri 'none'; frame-ancestors 'none'`, which still allows inline script and style because the admin pages use them. → **Part 06**: move admin scripts to nonces and drop `'unsafe-inline'`.
- **Test:** hooks-hardening › `security headers on HTML` (3). Seen failing before the fix: not run (no header existed to assert against).

### A-05-019 · P1 · Export download tokens were written to logs and error reports
- **Where:** `server.ts` request serializer logged `req.url` (`…/download?token=…`); `telemetry/sentry.ts` `sanitizeContext` did not scrub `query`, nor `newPassword` in bodies (reset-password).
- **Spec:** PRD §42.1 "never log tokens, passwords".
- **Fix:** `redactUrl()` in the serializer; query keys matching `token|secret|password` and body `newPassword` redacted.
- **Test:** hooks-hardening › `secrets never reach logs or error reports`. Seen failing before the fix: yes for `sanitizeContext`; `redactUrl` is new and unit-tested, its wiring in `server.ts` is not exercised by a test.

### A-05-020 · P2 · Authorization lookups were 2–4 sequential queries, one copy per service
- **Fix:** `loadRelationship(db, viewer, owner)`: owner privacy, deletion, block either way, follow state both ways, **one** query; used by reading, reviews, shelves, interactions, social, identity. Plan on `flyleaf_dev`: PK lookups plus three sub-plans, 14 buffers, 0 disk reads warm.
- **Numbers:** see Performance.

### A-05-021 · P3 · The typed client is hand-written, and said otherwise
- **Evidence:** `packages/api-client/src/types.ts` said "Generated … DO NOT EDIT"; no generator exists; `git log` shows it edited in each feature commit. CI's `api-client · build` compiles it but cannot notice drift.
- **Field-by-field, three routes:** `GET /users/{id}`: the client declared `followStatus`/`followedBy`/`isRestricted` that the server stripped (A-05-007), `displayName` required in the client and optional in the spec. `GET /reviews/{id}`: matches. `GET /reads/{id}`: `rating` required in the client, optional in the spec.
- **Fix:** header corrected; `User.emailVerified` added. **Recommendation (not implemented):** generate `types.ts` with `openapi-typescript` (pinned) and check the output in CI the way `spec:check` checks the spec.

### A-05-022 · P2 · CORS `origin: true` with an admin cookie → Part 06
- CORS reflects any origin but sends no `Access-Control-Allow-Credentials`, so cross-origin scripts cannot read credentialed responses. The admin cookie is `SameSite=Lax; path=/admin`, which blocks cross-site POSTs. The real exposure: the cookie is set **from JavaScript** (`admin/routes.ts:387`), so it is not `HttpOnly` and not `Secure`, and with inline script still allowed (A-05-018) an XSS in any admin page can read it. → Part 06: set it server-side `HttpOnly; Secure; SameSite=Strict`, restrict CORS to the app origins, nonce the admin scripts.

### A-05-023 · P3 · `GET /v1/users/:id/reads` answers 200 `[]` where sibling routes 404
- Missing, blocked and private accounts all get `200 {"data":[]}`, identical to a random id (no leak), while stats, shelves and follower lists 404. Left as is (client-visible). → Part 08.

### RL findings → Part 15
Only 4 limiter call sites exist (route inventory). Missing, against PRD §24.4 / §11.7:
- **A-05-RL1** Follows: 50/hour, 200/day, follow-unfollow-refollow ≤ 3 cycles/24 h, new accounts ≤ 20 follows in the first 24 h: none enforced (`POST /v1/users/:id/follow`, `/v1/follows/:userId`).
- **A-05-RL2** Writes (reads, reviews, shelves) 120/min: none.
- **A-05-RL3** Progress events 300/min: none.
- **A-05-RL4** Import 3/day, export 2/day: none.
- **A-05-RL5** Search 60/min signed-in, 20/min anonymous: none.
- **A-05-RL6** Global 1,000/h signed-in, 200/h anonymous: none.
- **A-05-RL7** Profile lookups ("rate-limited profile lookups", §42 #13): none.
- (Register and per-IP auth limits already recorded as A-04-017/018.)

## Performance

`flyleaf_dev`, same machine, back to back after a warm-up, 10 connections × 5 s. Before = HEAD with the changes stashed; after = this tree. **Indicative only (8 GB dev machine).** Full tables: `docs/audit/perf/05-authz-before.md`, `05-authz-after.md`.

| Scenario | Before p50/p95/p99 ms | After p50/p95/p99 ms | Queries before → after | Notes |
|---|---|---|---|---|
| `GET /v1/reviews/:id` | 14 / 17 / 21 | 16 / 19 / 24 | 2 → 2 | now also checks blocks, private account, deletion, read visibility |
| `GET /v1/reads/:id` | 16 / 21 / 24 | 12 / 15 / 18 | 3 → 2 | |
| `GET /v1/users/:id` | 18 / 23 / 27 | 11 / 14 / 18 | 4 → 2 | |
| `GET /v1/users/:id/reads` | 27 / 33 / 40 | 22 / 31 / 49 | 4 → 2 | |
| `GET /v1/users/:id/stats` | 27 / 35 / 40 | 27 / 40 / 56 | 6 → 4 | |
| followers (celebrity) | 112 / 125 / 137 | 114 / 136 / 144 | 6 → 4 | |
| shelf items (big shelf) | 370 / 434 / 454 | 375 / 444 / 492 | 6 → 4 | first after-run showed p95 2.9 s; two re-runs 545 and 444: noise |
| comments thread | 26 / 32 / 38 | 25 / 32 / 39 | 5 → 4 | |
| saved shelves (heavy) | 226 / 283 / 317 | 214 / 232 / 239 | 56 → 55 | N+1 on owner profiles remains → Part 11 |
| work reviews, friends, heavy | 1315 / 1807 / 1857 | 1355 / 1522 / 1548 | 5 → 5 | loads every review of the work, ranks in JS → Part 09 |
| work reviews, friends, guest | 776 / 879 / 1121 | 723 / 877 / 1110 | 2 → 2 | same |
| feed friends (heavy) | 187 / 253 / 286 | 218 / 307 / 351 | 3 → 3 | +1 PK join per row for deleted actors; within noise of this machine, re-judge in Part 14 |
| feed popular (guest) | 37 / 57 / 75 | 45 / 72 / 76 | 2 → 2 | same |

Hardware-independent result: every single-resource authorization path went from 3–4 queries to 2 (row + relationship). The two pre-existing budget breaches (work reviews at ~1.3 s, saved shelves' 55 queries) are not caused by this part and are deferred with plans.

## Behaviour changes (client-observable)

1. `PATCH`/`DELETE /v1/reviews/:id` on someone else's review: **404** `Review not found` (was 403).
2. `GET /v1/reviews/:id` and `GET /v1/works/:id/reviews`: reviews of private accounts are hidden from non-followers; a review on a private (or followers-only) read is hidden like the read; blocked parties see nothing.
3. `GET /v1/users/:id` on a private account, signed-in non-follower: **200** with `isRestricted: true` and no favourites (was 404). Guests still 404.
4. Profile responses now include `followStatus`, `followedBy`, `isRestricted` (were stripped).
5. Accepted followers now see followers-only reads in `GET /v1/users/:id/reads` and in stats.
6. Denial bodies on shelf by-slug routes and `GET /v1/users/:id/shelves` now equal the missing-resource body (`Shelf not found.` / `User not found.`).
7. Saved shelves: shelves of blocked/blocking/deleted owners and ones no longer visible are dropped.
8. Soft-deleted accounts are hidden everywhere (profile, lists, feed, browse).
9. **Unverified accounts:** creating a review, a comment or a follow → **403 `email_unverified`**. `GET /v1/me` has `emailVerified`. Mobile needs a prompt for this code (→ Part 07). Existing dev-database accounts created through register are unverified and are now gated.
10. Re-registering an unverified email resends the verification email (still 409 `email_taken`).
11. A repeated follow of an already-accepted account returns `accepted` and writes nothing.
12. `GET /feed` (no `/v1`) → 404.
13. `X-Request-Id` values outside `[A-Za-z0-9._-]{1,64}` are replaced by a UUID.
14. FK violations → 422 `invalid_reference`; check/range/format → 422 `invalid_field`; unique → 409 `conflict` (were 500).
15. Oversized JSON bodies: 413 `body_too_large` (was `file_too_large`).
16. HTML responses carry a CSP (strict on share pages).
17. `openapi.yaml`: exports added; share pages hidden; profile and user schemas gained optional fields.

Inherited test assertions updated to the spec (Rule 9; each still asserts that nothing extra leaks): `authorization.test.ts` private-profile 404 → restricted header + guest 404 (AC-13); `reviews.test.ts` 403 → 404 plus "body unchanged"; `social-follow.test.ts` `getProfile` → restricted with `followStatus: pending`. Fixture change: seven suites that register users and then follow/review/comment now call `verifyAllUsers(db)`; `makeUser` creates verified users unless `verified: false`.

## Decisions needed

### D-05-1 · "Identical to a fresh signup" cannot be met while signup returns tokens (A-05-011)
- **Option A (implemented, reversible):** same 409 `email_taken` as a verified account, silent throttled resend. Existence is revealed, as it already was (A-04 recorded that as accepted).
- **Option B:** every signup returns 202 `{status: "check_your_email"}` and no tokens; a verified-existing email gets an "you already have an account" email. Truly non-enumerating; costs PRD §6.4's "log in while unverified" flow and needs mobile changes (Part 07).
- **Recommendation:** A now; B only if enumeration via signup becomes a real threat.

### D-05-2 · Private profiles and guests: §4.2 vs §16.3 (A-05-006)
- §16.3 says a private profile's header is visible; §4.2 says private accounts are invisible to guests.
- **Implemented (safest):** guests 404, signed-in non-followers get the header. **Option:** show the header to guests too (share links to private profiles would then render a header).

### D-05-3 · Should imports publish reviews for unverified accounts? (A-05-010)
- `imports/committer.ts` inserts **public** reviews from the CSV regardless of verification: a throwaway account can publish reviews in bulk through an import.
- **Options:** (A, recommended) import them as `private` until the email is verified, then flip; (B) skip reviews until verified; (C) allow (history, not new posting). Left unchanged pending the decision (Part 12 owns imports).

## Deferred (with reason and owner part)

| Item | Owner |
|---|---|
| A-05-RL1 … RL7 rate limits | Part 15 |
| Admin: nonced scripts, drop `'unsafe-inline'`, cookie `HttpOnly; Secure; SameSite=Strict`, CORS allow-list (A-05-018, A-05-022) | Part 06 |
| Mobile prompt for `email_unverified`, banner from `emailVerified`, restricted-profile rendering | Part 07 |
| `GET /v1/users/:id/reads` 200 `[]` vs 404 (A-05-023); per-route messages for FK errors | Part 08 |
| `listWorkReviews` loads and ranks every review in memory (~1.3 s p50 heavy, `flyleaf_dev`); `upsertReview` is several non-transactional writes (a unique race is now a 409, not a 500) | Part 09 |
| Saved shelves N+1 (55 queries); `browse` loads all public shelves before paginating | Part 11 |
| D-05-3 imports and verification | Part 12 |
| Friends-feed and popular-feed latency re-check with the deleted-actor join | Part 14 |
| Deleted user's access token valid ≤ 15 min (A-05-009, with A-04-007) | §25.4 account deletion |
| `openapi-typescript` generation of `types.ts` in CI (A-05-021) | Part 15 |

## CI

`node scripts/ci.mjs`: **green in 598 s**, all 9 steps (client build, typecheck, spec check, 52 files / 1017 API tests, build, audit, mobile typecheck, 100 mobile tests, migrations on real Postgres). An earlier green run overlapped temporary stashes used for the before/after checks and is not counted.

## Answers (25 Sep 2026)

- **D-05-1 → accept as implemented.** 409 `email_taken` plus a silent resend limited to one per minute. The Part 04/05 brief asked for identical responses, which can't work while signup returns tokens; that was the brief's mistake. Signup-based enumeration is accepted, as in most consumer apps; the username check exposes the same thing. The mitigation is a per-IP signup rate limit (Part 15, RL). No "check your email" signup rework.
- **D-05-2 → keep as implemented.** §4.2 is [LOCKED]: guests get 404 and signed-in users get the header. PRD §16.3 amended to match. SO-50's web profile page follows the guest rule.
- **D-05-3 → routed to Part 12.** Reviews by unverified authors are visible only to their author, enforced in `canView` and its SQL twin, so they appear automatically once the email is verified, with no data rewrite. See `12-import-export.md`.
- **Deleted account's 15-minute access token** → accepted for now; Part 15 adds it to the retention/consistency sweep.
