# Audit 07 — Mobile foundation, offline, auth screens, guest mode (SL-00 … SL-05, SL-10 … SL-14, SL-20 … SL-22, SL-30 … SL-33)

> **Part 07b (owner decisions D-07-1, D-07-2, D-07-3) is at the end of this file.** Entries below that 07b changed carry a "07b:" note; nothing was removed.

2026-09-26 · CI **green in 497 s** (`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`, owner's run: all 9 steps; API 62 files, **1,221 passed, 0 skipped**; mobile **121 passed**; migrations applied on the real Postgres) · tests **mobile 100 → 121**, **API 1,215 → 1,221** (+1 in `reading.test.ts`, +5 in the new `username-availability.test.ts`). No test was weakened, skipped or deleted. Two inherited mobile assertions were updated to the spec (Rule 9, listed under Behaviour changes).

What was run here, all at one worker: every mobile test file (3 batches, `--test-concurrency=1`), mobile `tsc --noEmit`, API `tsc --noEmit`, `spec:check` (0 drift), api-client build, and the API files `reading`, `username-availability`, `contract`, `identity`, `hooks-hardening`, `authorization-matrix`. No database migration was added (server side), so `npm run migrate` was not needed. The mobile local database gains a migration (see A-07-007).

Scope notes:
- **UI behaviour I could not run was checked by reading the code.** The new screens (sync issues, verify email, reset password), the banner, the prompt and the guest gates have no automated test: the mobile suite is `node --test` with no React Native renderer. The pure logic behind them (queue, migrations, refresh, username check, guest migration, DOB) is tested. The device checklist at the end covers the rest.
- `secure-design` was not triggered: this run was autonomous by instruction. The audit itself covers the security-relevant parts (token refresh, session scoping, per-user queue).
- Handed over from Part 04: the verify/reset screens (A-07-016) and single-flight coverage (A-07-009). From Part 05: the `email_unverified` prompt, the banner and the restricted profile (A-07-017, A-07-018). From PV: the client upload path (see "PV-0x client side").

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| SL-00 | native modules pinned to SDK 57 | ⚠️ 6 patch versions behind what SDK 57 now expects; `expo-doctor` 20/21. **07b:** updated, `expo-doctor` 21/21 | A-07-022 |
| SL-01 | 5 tabs + FAB | ✅ Home, Reading, Discover, Shelves, Profile + centre FAB (PRD §5.2); the FAB is gated for guests | — |
| SL-02 | design-system components | ✅ exported and used (Button, Card, BottomSheet, Cover, Stars, Heart, ProgressBar, Skeleton, EmptyState); checked for existence only | A-07-021 |
| SL-03 | error surface, no retry on 4xx | ⚠️ the query client never retries a 4xx, but several user-facing writes swallow errors or leave the rejection unhandled | A-07-020 |
| SL-04 | SecureStore refresh + single-flight 401 interceptor | ❌ single-flight held in-process, but a 429/5xx on refresh logged the user out, and opening the app offline cleared the tokens | A-07-009 |
| SL-05 | both palettes, tokens only | ⚠️ tokens are complete for both palettes; 66 hard-coded colour literals in 18 files | A-07-021 |
| SL-10 | SQLite mirror of reads + progress | ❌ no user scoping of local reads; no schema versioning | A-07-002, A-07-007 |
| SL-11 | persist, replay, backoff, dead-letter | ❌ any 409 was treated as synced; 4xx were retried; being offline used up attempts, so 2–3 minutes offline dead-lettered everything; dead letters were counted and never shown; no user scoping; concurrent flushes; reads created offline kept a local id forever | A-07-001, -002, -005, -008 |
| SL-12 | `client_event_id` + idempotent replay | ⚠️ client side correct; the server accepted a reused id on another read or user as success | A-07-015 |
| SL-13 | queue test suite incl. process death | ⚠️ process death covered; one test asserted the 409 bug; nothing covered users, concurrency, migrations or local→server ids | A-07-001, A-07-026 |
| SL-14 | sync on foreground and reconnect; indicator | ⚠️ foreground yes; there is **no** reconnect listener; polling every 30 s whether or not anything was pending; the indicator counted every user's rows. **07b:** NetInfo reconnect flush and an offline state | A-07-014, A-07-002, A-07-034 |
| SL-20 | welcome carousel, "Look around first" | ✅ | — |
| SL-21 | sign up / log in / forgot / reset / verify | ❌ the entered DOB was never sent (always `2000-01-01`) and the field was pre-filled; no screen for the emailed verify/reset links; `email_unverified` unhandled; no verification banner | A-07-004, -011, -016, -017 |
| SL-22 | username + avatar; live availability; reserved words | ❌ no availability check existed (no endpoint, no request); the avatar is a typographic preview only; reserved words match the server | A-07-010, A-07-032 |
| SL-30 | no session → Home in browse mode | ✅ no redirect to auth; the Reading tab shows the guest upsell | — |
| SL-31 | contextual gate at Log/Rate/Follow/Like | ⚠️ gated: log, rate, review, shelve, comment, like on review/work pages. Ungated: follow/block/mute on profiles, follow in follower lists, mute a book, like on feed cards; shelf save used an alert with no sign-in action | A-07-013 |
| SL-32 | local want-to-read, cap 20 | ✅ cap, dedupe and SQLite persistence (existing tests) | — |
| SL-33 | migrate on signup + confirmation copy | ❌ cleared the local shelf even when saving failed; set 'want' on books already in the library (a book being read went back to want-to-read; a finished one started a re-read); ran twice concurrently; counted failures as kept | A-07-012, A-07-024 |

## Findings

### A-07-001 · P1 · The queue dropped refusals as "synced", retried validation errors, and dead-lettered everything after a few minutes offline
- **Where:** `apps/mobile/src/offline/queue.ts` `processMutation` (before)
- **Evidence:** `isDuplicate = status === 409 || message.includes('duplicate') || code === 'conflict'` → `markSuccess`. The server's progress endpoint answers a replay of the same event with **200** (ON CONFLICT DO NOTHING), so no 409 the queue can receive is a duplicate: every 409 was a real refusal, silently deleted. Every other error, network included, did `attempts + 1` with backoff 1, 2, 4, 8 s, and the 30 s poll kept flushing, so a phone offline for about 2.5 minutes turned all its progress into dead letters. A 404/422/403 was retried five times for nothing. Dead letters were counted by `SyncIndicator` ("N updates could not sync"), but "Sync now" only flushed pending rows, and nothing listed, retried or discarded them.
- **Spec:** PRD §35.2 (network → persist and wait; 4xx → surface conflict; max 5 attempts then surfaced with a retry action), architecture §10
- **Fix:** `classifyFailure`: network (`TypeError`) and 401 → wait 15 s, no attempt used, and stop the flush. 408/429/5xx → backoff, dead-letter after 5 attempts. Any other 4xx, 409 included → dead-letter at once, storing the server's `error_code`. New `app/sync-issues.tsx`, opened from the indicator, lists dead letters with the book title, a reason per code (`src/offline/syncIssues.ts`), **Retry** and **Discard**.
- **Test:** `queue.test.ts` › 2 (409), 2b (403/404/409/410/422), 2c (offline and 401 wait); `phase1-exit-criteria` › criterion 3 asserts attempts stay 0 offline. Seen failing: yes. The inherited test 2 asserted "409 → synced" (updated, Rule 9). With the mutations "all 4xx retried" and "network uses attempts", 2 tests fail each.

### A-07-002 · P0 · One user's queued writes replayed under the next user's token; local reads showed across accounts
- **Where:** `mutation_queue` (no owner column), `OfflineRepository.getLocalReads` (no user filter), `api.logout` (queue untouched)
- **Evidence:** by reading. A signs out with unsynced progress, B signs in: the next flush sends A's rows with B's bearer token. A's rows then 404 (not B's read) and are retried; with a `upsert_read` row, B gets A's book in B's library. B's Reading tab, Wall, Diary and Profile read `SELECT * FROM reads`, so they list A's reads, private ones included, on a shared phone.
- **Spec:** audit lead 2; PRD §26 privacy
- **Fix:** local migration 2 adds `mutation_queue.user_id`. `MutationQueue(db, userId)` and `OfflineRepository(db, userId)`: enqueue stamps the owner; flush, counts, retry and discard are per user; local reads are filtered by `user_id`. Rows wait for their owner to sign in again. I chose scoping over purging so a *forced* sign-out (refresh refused) does not lose offline progress. Sign-out warns when N updates are still waiting ("sent next time you sign in here"). `SyncProvider` swaps the repository when the user changes.
- **Test:** `queue-audit.test.ts` › "user B never replays or sees user A's writes…". Seen failing with the flush's user filter removed: yes.

### A-07-003 · P0 · The query cache survived sign-out and account switch
- **Where:** `src/lib/session.tsx`, `src/lib/query.tsx` (gcTime 24 h)
- **Evidence:** by reading. `signOut` and a forced session end cleared tokens only. Any screen whose query key has no user in it (`['reads', 'all']`, `['work', id]`, which carries `your_read`) showed the previous account's data to the next one until a refetch.
- **Fix:** `queryClient.clear()` on sign-in, sign-out and forced session end.
- **Test:** none automated (needs a React renderer). Device check 3.

### A-07-004 · P1 · Signup discarded the date of birth the user entered, and pre-filled an adult one
- **Where:** `app/auth.tsx` (`useState('2000-01-01')`), `session.signUp(email, username, password)`, `api.register(…, dateOfBirth = '2000-01-01')`
- **Evidence:** the DOB field was never passed on. Every app signup sent `2000-01-01`, so the server's age gate (A-04-008) never saw the real date, and the pre-filled value let anyone tap through the client gate. `flyleaf_dev`: 2 of 2 non-bench accounts have DOB `2000-01-01`. That is consistent with this bug, but the sample is too small to prove it.
- **Spec:** PRD §26.6 age gate, §6.3
- **Fix:** the field starts empty; `signUp(…, dateOfBirth)` and `api.register(…, dateOfBirth)` both require it (the type checker enforces it at every call site).
- **Test:** enforced by the type checker; no runtime test (screen state). **Data note:** accounts created through the app before this fix have a DOB of `2000-01-01` that the person never entered. Nothing is changed here; whether to ask those users again is an owner decision (D-07-3). **07b:** asked again, see A-07-035.

### A-07-005 · P1 · A read created offline kept its local id: its progress and finish were refused forever, and a ghost row stayed on the Reading tab
- **Where:** `OfflineRepository.saveReadStatus` (new attempt → `randomUUID()`), queue `upsert_read` keyed by **work** id while progress and finish were keyed by **read** id
- **Evidence:** a re-read started offline gets local id L. The server creates its own id S. Progress and finish are sent to `/reads/L/…` → 404 → five retries → dead letter. `cacheServerReads` then adds row S next to L, so the book is listed twice. And because upsert and progress were different FIFO groups, progress could be sent before the read existed.
- **Fix:** `upsert_read` is keyed by the read (local or existing id) and carries `work_id` in its payload. On success, when the server id differs, `remapRead` moves the read row, its progress events and its queued writes to S, and records `read_aliases(L → S)`. The repository resolves aliases inside each write's transaction, and the queue resolves them again at send time, for screens still holding L. `synced` is set only when nothing else is waiting for the read.
- **Test:** `phase1-exit-criteria` › criterion 3 (server id differs from the local one: progress and finish go to it; one row; a late write through the old id is re-keyed); `queue-audit` › migration test. Seen failing with the remap disabled: yes (2 tests). Running criterion 1 exposed a real race (a finish resolving the alias before a concurrent remap and writing a deleted row), which is why the lookup moved inside the transaction; criterion 1 then passed 5 of 5 runs.

### A-07-006 · P1 · A review written in the finish flow was silently lost
- **Where:** `app/finish/[id].tsx` → `repo.finishRead({review})` → `POST /reads/:id/finish`; server `ReadingService.finish` ignores `opts.review`
- **Evidence:** the route parses `review` and passes it on; the service never uses it. The client then deletes the draft. The text is gone.
- **Spec:** PRD §6.17 (finish with an optional review)
- **Fix (client):** `finishRead` queues a `save_review` for the same read after the finish, so it replays in order, goes through `requireVerified` and, if refused, lands on the sync-issues screen. **Server:** `review` is still accepted and ignored by `/finish` → **Part 08** (honour it or drop it from the contract).
- **Test:** `queue-audit` › "a finish with review text queues the review after the finish". Seen failing with the enqueue removed: yes.

### A-07-007 · P2 · The local database had no migrations
- **Where:** `src/offline/db.ts`: `exec(SCHEMA_SQL)` with `CREATE TABLE IF NOT EXISTS` only
- **Evidence:** a column added in a later release would never reach existing installs; the first insert naming it would throw. PRD §34.5: "Local database migrations run before the first render."
- **Fix:** `src/offline/migrations.ts`, which records applied steps in `PRAGMA user_version`, one transaction per step. Step 1 is the old schema, step 2 is this audit's changes. Rows queued by older installs are adopted: the owner comes from their read when exactly one user matches, and old upserts are re-keyed to their read. Rows with no provable owner are **not** replayed for whoever signs in: they become dead letters with `owner_unknown`, shown with Discard only.
- **Test:** `queue-audit` › "upgrades in place…" (a pre-versioning database with an old upsert, an owned row and an orphan; a second run is a no-op; the migrated rows replay in order).

### A-07-008 · P2 · Concurrent flushes could send the same write twice
- **Where:** each screen did `new OfflineRepository(db)` → its own `MutationQueue` with its own `processing` flag
- **Evidence:** the Reading tab, the finish sheet and `SyncProvider` flushed the same table at once. Progress is safe (idempotent); finish, review and upsert replays were not guarded (see A-07-023 for the duplicate activity this causes).
- **Fix:** one flush at a time per database (module-level `WeakSet`), whatever the number of queue objects.
- **Test:** `queue-audit` › "two repositories flushing at once send each mutation exactly once". Seen failing with the lock removed: yes.

### A-07-009 · P1 · Refresh failures and offline starts signed people out (SL-04; the Part 04 handoff)
- **Where:** `src/lib/api.ts` `executeRefresh` (before), `session.tsx` boot
- **Evidence:** `if (!res.ok) { clearAllTokens(); notifyAuthFailed(); }`, so a 429 or 503 from `/auth/refresh` ended the session. At boot, `api.me()` failing for any reason, offline included, ran `clearAllTokens()`: opening the app on a plane signed the user out, and their queued writes then had no token. PRD §6.1: "Network failure → route to Home in cached/offline mode, never block."
- **Fix:** the interceptor moved to `src/lib/authFetch.ts`, which is pure and tested. Only 400/401/403/422 from refresh ends the session; network errors, 429 and 5xx keep it. A 401 on a request sent with an already-replaced token is retried with the current token instead of refreshing again. Boot keeps the session with the last known user (`flyleaf.session_user` in SecureStore) unless the refresh token is gone.
- **Single-flight coverage (A-04-005 handoff):** every API call in the app goes through the one `client` in `api.ts`: screens, TanStack queries, the offline queue's handlers, telemetry, and flushes on foreground and resume. `grep new FlyleafClient apps/mobile` → 1. There are no background tasks (no `expo-task-manager` or `expo-background-fetch`), and nothing else calls `/auth/refresh`. So single-flight holds for every caller, and **the D-04 fallback (grace window) is not needed**. The case it cannot cover is the one Part 04 accepted: the app is killed after the server rotates the token and before `saveTokens` runs.
- **Test:** `auth-fetch.test.ts` (5): 8 parallel 401s → 1 refresh and 8 retries; a late 401 → no second refresh; 503/429/network → session kept; refused → session ended once; guest and auth endpoints not intercepted. Seen failing: the old rules (logout on any non-OK, no stale-token check) fail 2; removing single-flight fails 2. Offline boot: by reading (device check 1).
- **Tokens:** the refresh token is only ever in SecureStore (`flyleaf.refresh_token`). Nothing writes it to SQLite or AsyncStorage (there is none), and nothing logs it.

### A-07-010 · P1 · "Live availability" did not exist (SL-22)
- **Where:** `app/auth.tsx` step 2: local regex and reserved check only. The server had no availability endpoint.
- **Spec:** PRD §6.7 (debounced 400 ms check with tick/cross; "Taken → suggest three alternatives")
- **Fix:** `GET /v1/auth/username-available?username=` (public). It trims and lowercases like register and returns `{username, available, reason?: invalid|reserved|taken, suggestions?}`, with up to 3 free alternatives found in one `IN` query. It reveals nothing beyond register's existing 409 `username_taken`. Mobile: `src/lib/usernameCheck.ts` checks 400 ms after typing stops, aborts the older request, drops any response that isn't the latest, and treats offline as "unknown" (the server decides at submit). The UI shows a spinner, tick or cross, and tappable suggestions; submit is disabled while the name is known to be unavailable. Rate limit → A-07-030.
- **Test:** `username-availability.test.ts` (5, API; seen failing: yes, route missing); `username-check.test.ts` (3, mobile; seen failing with the stale guard removed: yes).

### A-07-011 · P2 · Client DOB validation disagreed with the server
- **Where:** `src/lib/auth-validation.ts` `validateDob`
- **Evidence:** the client accepted `2001-02-29`, `2001-02-30`, `2001-02-31`, `1899-12-31` and `1000-01-01`, all refused by the server's `dobSchema`, and it computed age in local time where the server uses UTC. The user found out only after choosing a username.
- **Fix:** the same rules as `dobSchema`: a real calendar date, 1900 or later, age in UTC calendar days.
- **Test:** `auth-validation.test.ts` › 2 new tests. Seen failing: yes.
- **Side by side:** username: identical regex, trim and lowercase, and reserved list (parity test from A-04-010). Password: minimum 10 on both; the common-password check (server only) and the 1,024 maximum are not mirrored, so the server's 422 message is shown. Email: the client checks `includes('@')`, the server checks format; the server's message is shown.

### A-07-012 · P1 · Guest-shelf migration lost books and overwrote library state (SL-33)
- **Where:** `src/lib/guest.ts` `migrateToServer` (before)
- **Evidence:** failed `setStatus` calls were swallowed, then `clear()` emptied the shelf anyway, and the copy said "We've kept the N books" counting the failures. Calling `setStatus(work, 'want')` on a book already in the library turned **reading** into want-to-read, and turned **finished** into a new re-read attempt (the server starts a new attempt on want after finished). Boot and sign-in could both run it at once.
- **Fix:** read the library first (if that fails, change nothing). Books already there are kept as they are and counted. A book leaves the device only once it is saved. Network, 5xx, 401, 408 and 429 keep it for the next sign-in; other 4xx (no such work) drop it. The count covers only books actually kept. Concurrent calls share one run. It runs on login as well as signup (as before): a guest who logs into an existing account keeps their saved books, and with the library check that is now safe.
- **Test:** `guest.test.ts` › 5 new tests. Seen failing against the previous `guest.ts`: yes, all 5.
- **Sign up, then sign out:** the shelf was migrated, so the device shelf is empty; the books are in the account.

### A-07-013 · P2 · Guest actions that hit the API and failed with 401 (SL-31)
- **Where / fix:** `app/user/[id].tsx` follow, block, mute; `app/user/[id]/followers.tsx` and `following.tsx` follow; `app/work/[id].tsx` mute a book; `src/ui/FeedCard.tsx` like; `app/shelf/[id].tsx` save (was a dead-end alert). Each now opens the contextual prompt ("Sign up to follow @x"). A 401 for a guest did not reach the refresh path harmfully, since there was no token, but the action silently reverted or showed "Failed".
- **Checked and already gated:** Log (FAB, work page), Rate, Review, Shelve, Comment, like on review and work pages, Reading tab (upsell), import and export (routes to sign-in).
- **Test:** none automated (UI). Device check 6.

### A-07-014 · P2 · SL-14: no reconnect trigger, and polling that never stopped
- **Where:** `src/offline/sync.tsx` (before)
- **Evidence:** triggers were foreground plus a 30 s `setInterval` that ran for the life of the app whether or not anything was pending (PRD §35.3: "no polling"). Nothing listens for connectivity. The indicator counted every user's rows.
- **Fix:** the timer runs only while this user has pending rows (it doubles as the reconnect retry, within 30 s). Counts update when a screen queues a write (`onQueueChange`). **Not done:** a real reconnect listener needs `@react-native-community/netinfo`, a native module (dev-client rebuild). Recommended; deferred (D-07-2). **07b:** done, see A-07-034.
- **Test:** by reading.

### A-07-015 · P1 · A reused `client_event_id` on another read or user was a silent success (lead 3)
- **Where:** `apps/api/src/reading/index.ts` `addProgress`: `ON CONFLICT (client_event_id) DO NOTHING`, then 200
- **Evidence:** test below, before the fix: the cross-read replay → 200, and nothing written.
- **Fix:** `RETURNING read_id`. When nothing was inserted and the existing row belongs to another read → **409 `client_event_conflict`**. A replay onto the same read stays 200. Route schema gains the 409; spec regenerated. The mobile queue dead-letters it (A-07-001), and the sync-issues screen explains it.
- **Test:** `reading.test.ts` › "POST /v1/reads/:id/progress refuses a client_event_id used by another read or user" (same-read replay 200; cross-read 409; cross-user 409; exactly one row). Seen failing: yes (200).

### A-07-016 · P2 · The emailed verify and reset links led nowhere in the app (A-04-014 handoff)
- **Fix:** `app/verify-email.tsx` verifies once on arrival. On success it refreshes `/me` (the banner disappears). On `400 invalid_or_expired_token` it shows "This link has expired" with **Send a new link** (resend when signed in, otherwise sign in first). `app/reset-password.tsx` asks for the new password twice, shows the server's 422 message for a common password, and on success says every device was signed out and offers Sign in. On an expired link it offers **Send a new link** (`/auth?mode=forgot`). Both open as `flyleaf://verify-email?token=…` and `flyleaf://reset-password?token=…`.
- **Open:** the emails link to `${APP_BASE_URL}/…` (https in production, `http://localhost:8081` in dev), which a phone opens in the browser, not the app, until App Links are set up → **D-07-1**. **07b:** App Links config and fallback pages, see A-07-033.
- **Test:** none automated (UI). Device check 4.

### A-07-017 · P2 · `403 email_unverified` had no handling, and there was no verification banner (A-05-011 handoff)
- **Evidence:** a follow refused with `email_unverified` was swallowed (`catch { reload }`). A comment or review showed a generic error, or a queued review was retried five times.
- **Fix:** `api.ts` spots `email_unverified` on any response and signals `VerifyEmailProvider`, which opens "Verify your email first" with Resend (60 s cooldown), "I've verified" (re-reads `/me`) and Not now. `VerifyEmailBanner` is persistent under the sync indicator while `/me` says `emailVerified: false` (PRD §6.4). `signIn` and `signUp` read `/me` after authenticating, because the login and register bodies lack `emailVerified`. Queued reviews refused this way land on the sync-issues screen with "Verify your email address to post reviews. Then retry."
- **Test:** none automated (UI). Device check 5.

### A-07-018 · P2 · Restricted profile: button said "Follow" (A-05-006 handoff)
- **Evidence:** `app/user/[id].tsx` already rendered `isRestricted` as header only with a private notice and a pending state.
- **Fix:** a private, not-followed profile shows **Request to follow**, and **Requested** once pending. Follow errors other than `email_unverified` now show a message.
- **Test:** by reading. Device check 7.

### A-07-019 · P2 · Writes that bypass the queue
- **Evidence:** the work page's Want/Reading status, rating and "add pages" call the API directly (`app/work/[id].tsx:230,247,259`): offline they reject unhandled, and progress from the book page is not offline-capable, contrary to PRD §35.1 "Update progress: Full". Likes, comments and follows call the API directly, though PRD §34.5/§35.1 say "queued, with an optimistic UI".
- **Recommendation:** route the work page's status, rating and progress through `OfflineRepository` (Part 08 owns that screen). Queue like/unlike and follow/unfollow: they are idempotent by desired state (`setLiked` sends the state, never a flip). Do **not** queue comments until the server accepts a client idempotency key, because a lost response would post twice. → **Part 08** (work page), **D-07-2** (social writes). **07b:** likes and follows are queued (A-07-034); the work page's status, rating and progress are still Part 08; comments are still not queued.

### A-07-020 · P2 · Swallowed or unhandled errors on user-facing writes (SL-03)
- **Fixed here:** follow in the profile and the follower/following lists (was `// Ignore network error`).
- **Remaining:** `app/work/[id].tsx:143` review like `catch { // Ignore }`; `work/[id].tsx` `setStatus`/`rate`/`submitProgress` have `try/finally` with no catch (the rejection is unhandled and the user sees nothing). Read-only loaders with silent fallbacks (discover, shelves, blocked, muted, requests) are acceptable offline behaviour. → **Part 08** (work page).

### A-07-021 · P2 · 66 hard-coded colour literals (SL-05)
- **Evidence:** `grep` for hex and `rgb(` literals in `app/` and `src/ui/`, excluding `tokens.ts`: **66 lines in 18 files.** The ones that break dark mode: `import/index.tsx` 410–430 (`#ffebee`, `#d32f2f`), `import/unmatched.tsx` 268–279, `shelf/create.tsx:396` and `shelf/[id]/edit.tsx:516` (`#fff` backgrounds), `FeedCard.tsx` 133/143/169/179/360 (`#3B82F6`, `#10B981`, `#FFFFFF`, `#EF4444`), `stats.tsx:247`, `wall.tsx` 261/426/465/472/480, `DiaryView.tsx` 247/455/628/638/688/751–764, `ErrorBoundary.tsx` 88–132 (dark-only styling), `ShareShelfModal.tsx`, `scanner.tsx` (camera overlay, arguably fixed by design). Scrims use literal `rgba(0,0,0,…)` although an `overlay` token exists (`ActionGate.tsx:142`). Shadows use `#000` (7 sites). The new screens in this part use tokens only.
- **Fix:** `DEFERRED` (over 30 minutes across 18 files; some need new tokens such as `onAccent` and `scrim`). Suggested owner: a design pass in Part 15.

### A-07-022 · P3 · SL-00: patch versions behind SDK 57
- **Evidence:** `npx expo install --check` and `npx expo-doctor` (20/21 checks): `@expo/metro-runtime` 57.0.15 (want ~57.0.16), `expo` 57.0.23 (~57.0.25), `expo-constants` 57.0.18 (~57.0.19), `expo-linking` 57.0.10 (~57.0.11), `expo-router` 57.0.21 (~57.0.23), `expo-updates` 57.0.22 (~57.0.23). These are patch releases published after the pin; nothing is on npm `latest`.
- **Fix:** not applied. `npx expo install --fix` changes native modules (`expo-updates`, `expo-constants`) and needs a dev-client rebuild on your phone, so that's your call. **07b:** applied (`npx expo install --fix`); `expo install --check` clean, `expo-doctor` 21/21. Rebuild pending on your phone (README › Native changes waiting for a rebuild).

### A-07-023 · P2 · Every replayed read write records another activity row
- **Where:** `ActivityService.recordActivity` (no dedupe), called by `upsert` and `finish`
- **Evidence:** by reading. A finish whose response was lost is replayed and inserts a second "finished" card; so does any `POST /reads` repeating the same status.
- **Fix:** `DEFERRED → Part 14` (feed) / **Part 08**. Suggested: skip when the actor's latest activity for the same object and verb exists within a short window, or key activity by (object, verb, attempt).

### A-07-024 · P1 · `POST /reads` does not follow merged works
- **Where:** `ReadingService.upsert` uses the given `work_id` as is; merged works keep their row with `merged_into_id`
- **Evidence:** by reading `catalog/dedupe.ts` and `reading/index.ts`. A guest-shelf book, a stale cached work page or an old deep link to a merged work creates a read on the loser, which the survivor's page and stats do not see.
- **Fix:** `DEFERRED → Part 08` (reading core). Proposed: resolve `COALESCE(merged_into_id, id)`, following the chain, at the start of `upsert` and in shelf adds, with a test that logs a merged id.

### A-07-025 · P3 · Mobile Sentry's header claims token scrubbing that does not exist
- **Where:** `src/lib/sentry.ts:3` ("sanitizes sensitive tokens/keys"); `captureMobileException` sends `context.extra` as is. No caller passes tokens today. → Part 15.

### A-07-026 · P2 · Tautological tests in the Phase 1 suite
- **Where:** `phase1-exit-criteria.test.ts` criterion 4 asserts accessibility labels and sizes it defines itself; it would pass with every screen deleted. Criterion 2 computes p75 from durations the test itself writes into the event queue.
- **Fix:** left in place (never delete a test). Replace with render-level checks when a React Native test renderer exists (Part 15).

### A-07-027 · P1 · Author and series screens show fabricated data (handoff)
- **Where:** `src/lib/api.ts` `author()` (an invented bio: "an acclaimed author whose books explore memory, identity…", mock works when search is empty) and `series()` (hard-coded "The Locked Tomb" / "Earthsea Cycle")
- **Spec:** PRD §4.2 [LOCKED]: "Guests are shown the app, not a demo. A fake preview would be worse than a wall."
- **Fix:** `DEFERRED → Part 08` (catalog screens).

### A-07-028 · P3 · Offline reviews are not posted "with the original timestamp"
- PRD §34.5. The server stamps `now()`; there is no field for the client time. → **Part 09**.

### A-07-029 · P3 · The access token is also written to a legacy key
- `flyleaf.token` (`api.ts` `LEGACY_TOKEN_KEY`) is written on every save and read as a fallback. It is harmless (SecureStore, cleared on logout); remove it once no install predates the split. → Part 15.

### A-07-030 · P2 · RL · `GET /v1/auth/username-available` has no rate limit
- A public endpoint (new in this part). Enumeration is no worse than register's 409, but it is cheaper to call. Suggested: a per-IP bucket in the anonymous tier (PRD §24.4). → **Part 15**.

### A-07-031 · P3 · "Email already registered" offers no next step
- PRD §6.3: offer log-in and password reset. The client shows "An account with that email already exists." with no action. Small; → Part 15 UX sweep.

### A-07-032 · P2 · No avatar picker (SL-22 "avatar")
- Only the typographic default exists. There is no `avatar` upload purpose (`UploadPurpose = 'import'`), although `profiles.avatar_key` exists. PRD §6.7: camera/library/generated, resized on the client, a failure never blocks. → **Part 10** (profile), which needs the upload purpose plus an image picker/manipulator (new native dependencies, per SL-00).

## PV-0x client side (precondition)

| Check | Result |
|---|---|
| `uploadFile(purpose, file)`: intent → direct upload → complete; only the upload retried | ✅ `client.ts` 813–851; retries only the storage PUT/POST (408/429/5xx or network), never intent or complete (PV tests) |
| Progress reported | ✅ `onProgress` over XHR; the import screen shows a percentage |
| A cancelled or failed upload leaves no intent the user can't recover from | ✅ an abandoned intent stays `pending` and is deleted after 1 h (PV `storage.cleanup`); the user simply starts again, since nothing reuses a pending intent. "Import anyway" reuses the *completed* upload |
| Online-only, never queued | ✅ not in the queue; **fixed** here: offline now says "Importing needs an internet connection. Your text is still here" (was the raw network error) |
| Pending uploads cleared per user at logout | ✅ `cancelPendingUploads()` on logout; **fixed** here: also when the session ends by a refused refresh. Nothing caches presigned URLs |
| Guests can't create intents | ✅ the import screen sends guests to sign-in before any call; the server would 401 anyway |
| Export download opens the presigned URL, never one built on the client | ✅ opens the server's `download_url` (`/v1/exports/:id/download?token=…` → 302 to storage) |

## Offline mutation table (SL-11)

| Action | Server endpoint | Replay-safe server-side? | 404 / 409 / 422 now |
|---|---|---|---|
| `add_progress` | `POST /reads/:id/progress` | ✅ `client_event_id`; same read → 200; other read → 409 (A-07-015) | dead letter with code, shown with reason |
| `upsert_read` | `POST /reads` | ⚠️ same status on the same attempt is idempotent (the row is updated); a replay *after* a later finish would start a new attempt, prevented on the client by per-read FIFO; each call records activity (A-07-023) | dead letter |
| `finish_read` | `POST /reads/:id/finish` | ⚠️ idempotent state; duplicate activity row (A-07-023) | dead letter |
| `dnf_read` | `POST /reads/:id/dnf` | ⚠️ idempotent except `abandoned_at = CURRENT_DATE` moves if replayed another day; activity duplicated | dead letter |
| `save_review` | `POST /reads/:id/review` | ✅ one review per read (upsert) | 403 `email_unverified` → dead letter + prompt |
| `set_like` (07b) | `POST` / `DELETE /reads/:id/like` | ✅ desired state; both idempotent (SO-21) | 404 or 409 `not_likeable` → dead letter |
| `set_follow` (07b) | `POST` / `DELETE /users/:id/follow` | ✅ desired state; a replayed follow keeps an accepted follow, a replayed request stays one pending row, a replayed unfollow is 200 (tests) | 404 → dead letter; unverified accounts are stopped in the app first |

Process death: the queue is SQLite; rows survive (tests 6 and criterion 3). If the request succeeded and the response was lost, the replay is covered by the rows above. A killed flush leaves rows `pending` (there is no "processing" state to get stuck in).

## Performance

The only server change on a request path: `addProgress` gains `RETURNING read_id`. On a replay (nothing inserted), there is one extra `SELECT read_id FROM progress_events WHERE client_event_id = $1`, which uses the unique index on `client_event_id`. The happy path is unchanged. `usernameAvailability` is one `SELECT … WHERE username IN (≤7 values)` on the unique index `profiles.username`. Nothing measured on the database: neither change adds a scan, and there is no hot path to time.

## Behaviour changes

1. `POST /v1/reads/:id/progress` with a `client_event_id` already used on another read or by another user → **409 `client_event_conflict`** (was 200 with nothing written).
2. New public route `GET /v1/auth/username-available?username=` (api-client `checkUsername`, type `UsernameAvailability`).
3. Mobile queue: a 409 is a refusal (was "synced"); 4xx dead-letter at once; offline and 401 no longer use up attempts; dead letters are listed on **Couldn't sync** (tap the indicator) with Retry and Discard.
4. Queued writes and local reads belong to the signed-in user; switching account hides the other's and never replays them. Signing out with unsynced writes asks first.
5. The query cache is cleared at sign-in, sign-out and forced sign-out.
6. A 429, 5xx or network failure on token refresh no longer signs the user out; starting the app offline keeps the session.
7. Signup sends the entered date of birth; the field starts empty; the client rejects impossible dates and pre-1900 years like the server.
8. A review written in the finish flow is posted (queued after the finish).
9. New screens: `/verify-email`, `/reset-password`, `/sync-issues`; `/auth?mode=forgot|login`; persistent "verify your email" banner; `email_unverified` prompt from any screen.
10. Guest follow, block and mute, feed-card like, mute a book, and save shelf open the sign-up prompt; private profiles say "Request to follow".
11. Guest-shelf migration keeps unsaved books, leaves books already in the library untouched, and counts only kept books.
12. The sync timer runs only while writes are pending.
13. The local database now has migrations: first launch after this update runs step 2 (adds columns and a table, adopts queued rows).
14. Inherited assertions updated (Rule 9): `queue.test.ts` test 2 (was "409 → synced") and test 7 (the review body no longer carries `client_event_id`, which the server ignored); `phase1` criterion 3 now uses a server id that differs from the local one, and a `TypeError` as the offline signal.

## Decisions (answered by the owner, 2026-09-26; implemented in Part 07b, below)

- **D-07-1 · Yes:** Android App Links, plus fallback web pages at `/verify-email` and `/reset-password` that hand off to `flyleaf://`. The pages must take **no action on GET** (no token is spent by a link preview or scanner): verifying or resetting happens only in the app, or on an explicit submit.
- **D-07-2 · Yes:** queue likes and follows, **coalescing** repeated toggles on the same target into the last desired state; add NetInfo for reconnect; do it in **one native rebuild together with the Expo patch updates** (A-07-022).
- **D-07-3 · Ask affected users:** accounts whose DOB was never entered are asked to confirm it, and until they do they get the **most restricted** treatment (as an under-18 would).

The original options and recommendations:

- **D-07-1 · How should emailed links open the app?** Today they are `https://flyleaf.app/…` (dev: `http://localhost:8081/…`) and open in the browser. Options: (a) Android App Links, meaning `intentFilters` with `autoVerify` in `app.json` plus `/.well-known/assetlinks.json` on the domain (needs the domain and the signing-key fingerprint; native rebuild); (b) a tiny web page at those paths that redirects to `flyleaf://…` (works in any mail client, no verification); (c) put `flyleaf://` in the email directly (many mail clients don't make custom schemes clickable). **Recommend (a) + (b)**: (b) is the fallback for iOS and unverified installs. Until then, test with `adb shell am start -d "flyleaf://verify-email?token=…"`.
- **D-07-2 · Queue social writes?** PRD §35.1 says follow, like and comment are queued. **Recommend** queueing like/unlike and follow/unfollow (idempotent by desired state) and adding NetInfo for reconnect; comments only after the server takes an idempotency key.
- **D-07-3 · Accounts with a DOB the user never entered** (A-07-004): leave, or ask existing app-created accounts to confirm their date of birth. Not touched.

## Deferred (with reason and owner part)

- Work-page writes through the queue, swallowed errors there, and merged-work resolution in `POST /reads` → **Part 08** (A-07-019, -020, -024).
- Server `/finish` ignoring `review` → **Part 08** (A-07-006).
- Author and series fabricated data → **Part 08** (A-07-027).
- Offline review timestamp → **Part 09** (A-07-028).
- Avatar picker and upload purpose → **Part 10** (A-07-032).
- Duplicate activity on replay → **Part 14** (A-07-023).
- Colour literals, Sentry scrubbing, the legacy token key, tautological tests, the email-exists UX, and the username-check rate limit (RL) → **Part 15** (A-07-021, -025, -026, -029, -030, -031).
- ~~`expo install --fix` → **Part 07b**, in the same native rebuild as NetInfo (A-07-022, D-07-2).~~ Done in 07b.
- ~~App Links and fallback pages (D-07-1), queued likes/follows with coalescing plus NetInfo (D-07-2), DOB confirmation with most-restricted default (D-07-3) → **Part 07b**.~~ Done in 07b; what 07b defers is listed in its own section.

## Manual checks on your Android phone

Checks 1–12 need only a JS reload. Checks 13–20 (Part 07b) need the native rebuild first: README › Native changes waiting for a rebuild.

1. **Offline start:** sign in, enable airplane mode, kill the app, reopen it → still signed in, and the Reading tab shows your books.
2. **Offline progress:** in airplane mode, add pages to two books, then wait 3 minutes → the indicator says "N updates will sync" (not "could not sync"). Turn the network on → within about 30 s (or on reopen) the count drops to 0 and the server shows the progress.
3. **Account switch:** make an offline progress update as A, go online, and sign out → you are warned. Sign in as B → Reading tab, Wall and Diary show none of A's books, and the indicator shows 0. Sign back in as A → A's update syncs.
4. **Links:** `adb shell am start -d "flyleaf://reset-password?token=bad"` → "This link has expired" → Send a new link opens the forgot form. With a real token from the dev console mailer, the password changes and you are asked to sign in. Repeat with `verify-email`.
5. **Unverified:** a fresh signup shows the banner. Follow someone → the "Verify your email first" prompt. Verify through the link → the banner disappears.
6. **Guest gates:** signed out, on a profile tap Follow, Block and Mute, on a follower list tap Follow, on a feed card tap Like, on a book mute it, and on a shelf tap Save → each shows the sign-up prompt, and Not now returns you where you were.
7. **Private profile:** signed in, open a private account you don't follow → header only, a **Request to follow** button, then **Requested**.
8. **Username:** on signup step 2, type `reader` slowly and quickly → one check about 400 ms after you stop. A taken name shows a cross and three suggestions; tapping one fills the field.
9. **Guest shelf:** as a guest save 3 books (one you already read on this account), then sign in → "We've kept the 3 books"; the one you had finished is still finished.
10. **Finish with review:** finish a book with review text → the review appears on the book page (or, if unverified, on Couldn't sync with a verify message).
11. **Couldn't sync:** force a refusal (for example finish a book while unverified with a review) → tap the indicator → the item shows its reason; Retry after verifying works; Discard removes it.
12. **Dark mode:** check the import screen, new-shelf and edit-shelf backgrounds, and the new sync-issues, verify and reset screens, in both palettes.
13. **Rebuild first** (07b), from `apps\mobile`: `npx expo prebuild --platform android --clean; if ($?) { ..\..\scripts\fix-gradle.ps1 }; if ($?) { npx expo run:android }`. The first launch runs no local migration (07b adds none).
14. **Offline state:** enable airplane mode → the top bar says "Offline · changes will sync when you're back" with no Sync now button. Turn it off → the bar goes away.
15. **Queued likes:** in airplane mode, like a feed card and a review on a book page → the hearts fill and the bar says "Offline · 2 updates will sync when you reconnect". Turn the network on → within a few seconds, without tapping anything, the count drops to 0 and another device shows the likes.
16. **Coalescing:** in airplane mode, like then unlike the same card → the bar shows no pending update. Turn the network on → the like count seen from another device never changed.
17. **Queued follows:** in airplane mode, follow a public account (button says Following) and a private one (Requested), and follow then unfollow a third from a followers list. Reconnect → the server shows one follow, one request, and nothing for the third.
18. **Unverified follow:** on an unverified account, tap Follow → the "Verify your email first" prompt, and the button stays Follow (nothing is queued).
19. **Date of birth:** sign in to one of the two flagged accounts (created 3 Sep and 19 Sep) → "Confirm your date of birth" at launch. Not now → it stays away until the next launch. A date under 13 → the signup error. A real date → it closes, and the next launch does not ask again.
20. **Email links:** start the API with `APP_BASE_URL=http://<LAN-IP>:3000`. Request a password reset, open the emailed link on the phone → the browser shows the form; reload it twice, then submit → "Password changed", and **Sign in in the app** opens the app. Do the same with a verification email. For the in-app path: Settings → Apps → Flyleaf → Open by default → Add link → `flyleaf.app`, then `adb shell am start -a android.intent.action.VIEW -d "https://flyleaf.app/verify-email?token=<token>"` → the app's verify screen opens (the token is spent there, not by the page).

---

# Part 07b — owner decisions D-07-1, D-07-2, D-07-3

2026-09-26 · CI **green in 516 s** (`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`, owner's run: all 9 steps; API 64 files, **1,248 passed**; mobile **130 passed**; migrations applied on the real Postgres) · tests **API 1,221 → 1,249** (+14 `dob-confirmation.test.ts`, +12 `link-pages.test.ts`, +2 in `authorization-matrix.test.ts`; the 12th link-pages test is the D-07b-2 host check, added after the CI run and run on its own at one worker), **mobile 121 → 130** (+9 `social-queue.test.ts`). No test was weakened, skipped or deleted. One inherited allowlist was extended (the hidden-routes list in `contract.test.ts`, listed under Behaviour changes).

What was run here, all in the foreground at one worker: the new and touched API files (`dob-confirmation`, `link-pages`, `authorization-matrix`, `identity`, `contract`, `schema`, `search-route`, `server-wiring`, `read-likes`, `hooks-hardening`, `username-availability`, `social-follow`, `auth-audit`), every mobile test file (3 batches), API and mobile `tsc --noEmit`, api-client build, `spec:generate` then `spec:check` (0 drift), `npx expo install --check` (clean), `npx expo-doctor` (21/21), `npx expo config --type introspect` (the manifest gets the intent filter). `npm run migrate` applied 0025 to **both** `flyleaf_dev` and `flyleaf`. (Note: this shell's user-level `DATABASE_URL` points at `flyleaf_dev`, so a bare `npm run migrate` goes there, not to the full catalog.)

Not run by me: the full suite or CI (the owner's run is above), the native rebuild (yours, checks 13–20), App Links verification against a real domain, and any UI rendering (no React Native renderer; the screens were checked by reading and by the typechecker).

`secure-design` was not triggered: autonomous by instruction. The security-relevant parts were reviewed inline and are tested: a GET never spends a token, token escaping, the nonce CSP, no-referrer, no password echo, the form parser's scope, the well-known config validation, and the one-shot DOB update under a race.

## Verdict per decision

| Decision | Asked | Delivered | Findings |
|---|---|---|---|
| D-07-1 | App Links + iOS config; well-known files from env (404 when unset); fallback pages with nonce CSP and no-referrer; GET never consumes | ✅ all, tested; the domain is `flyleaf.app`, fixed at build time | A-07-033, A-07-037 |
| D-07-2 | like/unlike/follow/unfollow through the queue with coalescing; idempotent replay; NetInfo reconnect and offline state; Expo patches; native changes in README | ✅ all; server replay idempotency confirmed by tests (no server change needed) | A-07-034, A-07-039, A-07-040 |
| D-07-3 | migration + backfill; most restricted until confirmed; `/me` exposes it; prompt at launch; same validation as signup | ✅ all, tested; it exposed that the explicit setting has no endpoint at all | A-07-035, A-07-036, A-07-038 |

## Findings

### A-07-033 · P2 · The emailed verify and reset links opened only in the browser (D-07-1)
- **Where:** `app.json` (no intent filter), API (nothing served at `/verify-email`, `/reset-password` or `/.well-known/*`)
- **Fix:**
  - `app.json`: `android.intentFilters` for `https://flyleaf.app/verify-email` and `/reset-password` with `autoVerify: true`; `ios.associatedDomains: ["applinks:flyleaf.app"]`. Expo Router maps the https path to the existing `app/verify-email.tsx` and `app/reset-password.tsx`.
  - `apps/api/src/identity/link-pages.ts` (registered at the root in `buildApp` beside the JSON routes):
    - `GET /verify-email` shows a "Verify my email" button that POSTs, and `GET /reset-password` shows a form (password twice) that POSTs. A missing, empty or oversized token gives "This link is incomplete" (400).
    - The POSTs call the same `IdentityService.verifyEmail` and `resetPassword` as the JSON API. An expired or used token gives "This link has expired" (400). A mismatch or a weak password re-renders the form (422) and never echoes the password.
    - Every page offers **Open in the app** (`flyleaf://verify-email?token=…`, `flyleaf://reset-password?token=…`), and the result pages link to `flyleaf://auth?mode=login|forgot`.
  - Headers: `Content-Security-Policy` with a per-response nonce (`script-src 'nonce-…'` only; the one script is the reset form's match check). Also `Referrer-Policy: no-referrer` plus `<meta name="referrer">`, `Cache-Control: no-store` and `X-Robots-Tag: noindex`.
  - The urlencoded body parser is added inside this plugin only: `/v1/auth/reset-password` still answers 415 to a form body (tested).
  - `/.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` come from `config.appLinks` (`parseAppLinks`). The inputs are `ANDROID_APP_PACKAGE` + `ANDROID_CERT_SHA256` (comma-separated) and `IOS_TEAM_ID` + `IOS_BUNDLE_ID`. A platform with either value unset gives 404; a malformed value stops the API at start-up. The AASA uses the `components` format, limited to the two paths.
- **Test:** `link-pages.test.ts` (11): repeated GET and HEAD leave the token unused and the account unchanged; the POST spends it once, and a second POST is the expired page; headers and nonce on every page; no inline handlers; a hostile token comes back escaped; mismatch and common password leave the token unused; the reset changes the hash once; the parser's scope; well-known 404 unset and exact JSON when set; half and malformed configurations. Seen failing: yes. A GET that verifies fails 1, removing `Referrer-Policy` fails 5, and a script without the nonce fails 2.

### A-07-034 · P2 · Likes and follows bypassed the offline queue; no reconnect trigger; no offline state (D-07-2; closes A-07-014's open part and A-07-019's social part)
- **Where:** `src/ui/FeedCard.tsx`, `app/review/[id].tsx`, `app/work/[id].tsx` (review like), `app/user/[id].tsx`, `app/user/[id]/followers.tsx`, `following.tsx`; `src/offline/sync.tsx`
- **Fix:**
  - New queue actions `set_like` and `set_follow` carry the **desired state** (`{liked}` / `{following}`), never a toggle. `MutationQueue.enqueueDesiredState` looks at this user's latest *pending* row for the same action and target. The same state is `unchanged` (nothing new queued); the opposite state deletes that row (`cancelled`), so like then unlike offline sends nothing; with nothing pending, a row is `queued`.
  - **Claim:** a flush now marks the row it is sending `processing` with a conditional update, and coalescing deletes only `status = 'pending'`. A like already on the wire is therefore never "cancelled"; the unlike queues behind it. A row left `processing` by a killed process is reset to `pending` when the next flush starts. That is safe because only one flush runs per database, and it replays safely because the server is idempotent. `getPendingCount` counts `processing` too.
  - **Flush again:** a flush requested while one is running now runs once more when it ends. Before, a write queued during a flush waited up to 30 s for the timer.
  - `OfflineRepository.setLiked` and `setFollowing` enqueue and flush. `SyncProvider` exposes `setLiked`, `setFollowing` and `isOnline`. Without a local database (still opening, or it failed to open) they call the API directly, as before, and a failure reaches the screen.
  - The screens update optimistically. They revert only if the write could not be queued. A follow shows Requested for a private account and Following otherwise.
  - **NetInfo** (`@react-native-community/netinfo` 12.0.1, the SDK 57 version from `expo install`) runs a forced flush when the connection comes back (`connectivity.ts`: only a definite "no" counts as offline). The 30 s timer stays as the fallback.
  - `SyncIndicator` shows "Offline · …" whenever NetInfo says offline, with no Sync now button then.
  - Sync issues: "Like/Unlike/Follow/Unfollow" labels; `not_found` and `email_unverified` reasons worded per action; `not_likeable` explained.
  - An unverified account's follow now opens the verify prompt instead of queuing a write the server refuses (D-04-1).
- **Server replay:** like/unlike (SO-21, `read-likes.test.ts`) and an accepted follow (Audit 05) were already tested idempotent. Added: a replayed request to a private account stays one pending row; a replayed unfollow is 200 `none`. Both pass on the existing server code: no server change was needed.
- **Test:** `social-queue.test.ts` (9): like/unlike offline sends nothing, also after reconnect; follow/unfollow/follow sends one; only the same user, action and target coalesce; an unlike during the like's send queues behind it and goes out with no other trigger; a row left mid-send is counted and resent; refusals are labelled; follow-specific unverified wording; `isOnline`; reconnect detection. Seen failing: yes, each mechanism removed in turn. No claim fails 1; no flush-again fails 1; no stale-claim reset fails 1; no coalescing fails 2.

### A-07-035 · P2 · A date of birth nobody entered counted as an adult's (D-07-3; A-07-004 data)
- **Where:** `users` (no way to tell an entered date from the 2000-01-01 placeholder); `CatalogService #allowsExplicit`
- **Evidence:** `flyleaf` and `flyleaf_dev` each had **2** role `user` accounts at exactly 2000-01-01 (created 3 and 19 Sep 2026, both before the 26 Sep fix) and no bench accounts. Stored 2000-01-01 is 18+, so the filter would have let those accounts see explicit titles once the setting was on. It cannot be switched on today: see A-07-036. Hence P2, not P0.
- **Fix:**
  - Migration `0025_dob_confirmation.sql` adds `users.dob_confirmed boolean NOT NULL DEFAULT true`, and backfills `false` for role `user` with DOB exactly 2000-01-01. That covers every such account that exists when the migration runs, a superset of "before the fix" (a real 2000-01-01 is asked once more). The backfill runs only in the step that adds the column, so a re-run never un-confirms anyone.
  - `#allowsExplicit` requires `u.dob_confirmed`. That is the only age rule in the code (`grep` for `date_of_birth` and `18 years`): search, the ISBN typed into search, and the scan's `content_warning` all go through it.
  - `GET /v1/me` returns `dobConfirmed`.
  - `POST /v1/me/date-of-birth {dateOfBirth}` uses the signup field's JSON schema and the same zod `dobSchema`, so it refuses with the same words. It works once: a conditional update on `dob_confirmed = false`, and `409 dob_already_confirmed` afterwards (a confirmed date is not editable here). It returns the `/me` user.
  - Mobile: `ConfirmDobPrompt` (`src/ui/ConfirmDob.tsx`), mounted in the root layout, asks at launch while `/me` says `dobConfirmed: false`. "Not now" hides it until the next launch. It validates with `validateDob` (the server's rules) and shows the server's 422 message.
- **Test:** `dob-confirmation.test.ts` (14):
  - the backfill picks exactly the placeholder accounts, deleted ones included, and not a real 2000-01-02 or staff; a re-run keeps a later confirmation; a new account is confirmed;
  - `/me` exposes the flag;
  - an adult-dated, opted-in, unconfirmed account gets no explicit results in search and gets `content_warning` on the scan, then gets them after confirming;
  - confirming an under-18 date keeps the filter;
  - 5 invalid inputs are refused with **the same message as signup** and stay unconfirmed; missing date → 422; guest → 401; once → 409; two at once → one 200 and one 409.
  - Seen failing: yes. The filter without `dob_confirmed` fails 1, the update without its guard fails 2, and the backfill outside the add-column step fails 1.
- **Performance:** `#allowsExplicit` stays two primary-key index scans (`flyleaf_dev`, `EXPLAIN (ANALYZE, BUFFERS)`: 8 buffers, 1.2 ms). The new column is on a row it already reads. Nothing else is on a request path.

### A-07-036 · P2 · "Show explicit titles in search" has no endpoint and no screen (PRD §7.8 [LOCKED], §6 Settings → Content)
- **Evidence:** `profiles.show_explicit` is read by `#allowsExplicit` and written by nothing (`grep showExplicit|show_explicit` over `apps/api/src` and `apps/mobile`). Every adult gets the filtered catalogue in search, with no way to change it. The PRD requires the toggle, only for accounts registered as 18+, only after re-entering the date of birth, and hidden entirely under 18. It is not in any `/v1/me` response either.
- **Fix:** `DEFERRED → Part 10` (profile and settings). When built, it must refuse while `dobConfirmed` is false (A-07-035), and the DOB re-entry it requires should compare against the confirmed date.
- **Also handed to Part 10 (D-07b-1, owner's answer):** a date under 13 stays refused, as a **neutral age gate**. The refusal must not say which answer would pass. Part 10 builds:
  - **At confirmation** (`POST /v1/me/date-of-birth`): record the under-13 attempt on the account. Refuse every later attempt, and keep the account restricted until it is reviewed.
  - **At signup:** keep a local device flag for the same case, so a retry on that device is refused too.
  - **Later:** switch to suspension when SO-42 exists.
  - Today's behaviour is unchanged: 422 with the signup message, the account stays unconfirmed, and later attempts are not yet refused.

### A-07-037 · P2 · RL · The emailed-link pages have no rate limit
- `GET`/`POST /verify-email` and `/reset-password` are the anonymous auth tier (PRD §24.4: 20/min per IP), like their JSON twins (A-04-019). Guessing a 256-bit token is not the risk; volume is. A POST to `/reset-password` with a valid token spends an argon2 hash, and a bogus one does not (the token is checked first). → **Part 15**.

### A-07-038 · P3 · RL · `POST /v1/me/date-of-birth` has no rate limit
- Auth tier (10/min per account). Low risk: it succeeds once per account, and a refusal costs one indexed update. → **Part 15**.

### A-07-039 · P2 · A 429 during a reconnect burst would dead-letter queued writes within about 15 s
- **Where:** `classifyFailure` (429 → `retry`, backoff 1, 2, 4, 8 s, dead letter at 5 attempts); `authFetch`
- **Evidence:** by reading. Queued likes and follows now replay together on reconnect. Once Part 15 enforces §24.4 (follows 50/hour), a long offline session could meet 429s, and five attempts in about 15 s turn them into dead letters instead of waiting out the window.
- **Fix:** `DEFERRED → Part 15`. The limiter should send `Retry-After`, and the queue should treat 429 as "wait until then" without using an attempt.

### A-07-040 · P3 · Optimistic social state is not reconciled when the queued write is refused
- A like or follow the server refuses (the read or account is gone or blocked, or `not_likeable`) lands on **Couldn't sync**. The screen keeps its optimistic heart, count or button until it reloads. The follow state is a guess, Requested vs Following from `isPrivate`, and the server's answer is not read back. Accepted as the cost of queueing: the refusal is visible on Couldn't sync, and the next load shows the truth. `FeedCard`'s `onLike` prop still bypasses the queue, but no caller passes it (`grep onLike=`: none). → **Part 15** if it matters on device.

## Behaviour changes

1. New root routes: `GET`/`POST /verify-email` and `/reset-password` (HTML), and `GET /.well-known/assetlinks.json` and `/.well-known/apple-app-site-association` (404 unless configured). New env vars: `ANDROID_APP_PACKAGE`, `ANDROID_CERT_SHA256`, `IOS_TEAM_ID`, `IOS_BUNDLE_ID`; a malformed value stops the API at start-up.
2. `GET /v1/me` gains `dobConfirmed`. New `POST /v1/me/date-of-birth` (api-client `confirmDateOfBirth`). `userSchema` gains the optional field; spec regenerated.
3. Migration 0025: `users.dob_confirmed`. The 2 existing placeholder accounts (in each database) are asked for their date of birth, and until then search hides explicit works from them and the scan shows the interstitial.
4. The app asks for the date of birth at launch while it is unconfirmed.
5. Likes and follows are queued: optimistic, sent now if online, after reconnect otherwise. Opposite taps before sending cancel out. Refusals appear on Couldn't sync. An unverified account's Follow opens the verify prompt.
6. The queue has a `processing` state while a row is being sent; a flush asked for during a flush runs once more afterwards.
7. The top bar shows "Offline · …" whenever the phone is offline, even with nothing pending. Sync now is hidden while offline.
8. The app opens `https://flyleaf.app/verify-email|reset-password` links itself once the domain verifies (native rebuild).
9. Expo patch updates (6 packages) and NetInfo: native rebuild (README › Native changes waiting for a rebuild).
10. Inherited allowlist extended (Rule 9): `contract.test.ts` › hidden routes now also lists the four link-page routes and the two `/.well-known` files. They are HTML or platform-defined JSON, not API.

## Decisions (answered by the owner, 2026-09-26)

- **D-07b-1 · A date under 13 entered at confirmation → keep refusing, as a neutral age gate; handed to Part 10** (see A-07-036). Part 10 records the attempt on the account and refuses later ones (restricted until reviewed), adds a local device flag for the same case at signup, and moves to suspension once SO-42 exists. Nothing changed here.
  - *Original question:* today it is a 422 (the signup rule), and the account stays unconfirmed, the most restricted. PRD §26.6 says under-age accounts "detected later are suspended pending verification", but there was no suspension state. Options were (a) keep, or (b) accept the date and suspend.
- **D-07b-2 · The link domain → keep `flyleaf.app` fixed at build time. Done:** `PRODUCTION_APP_BASE_URL` is now exported from `platform/index.ts` (the same literal as before, now named). `link-pages.test.ts` › "the app's App Links and associated domains name the production APP_BASE_URL host" reads `apps/mobile/app.json` and fails if any https intent-filter host or associated domain differs from it. Seen failing: yes (`applinks:www.flyleaf.app` → 1 failure).
  - *Original question:* `app.json` names the host at build time, while the emails use `APP_BASE_URL` at run time. Options were (a) keep it fixed, or (b) `app.config.ts` reading the host at build time.

## Deferred (with reason and owner part)

- The explicit-titles setting (endpoint and screen), and the neutral under-13 gate (D-07b-1: attempt recorded, later attempts refused, device flag at signup, suspension with SO-42) → **Part 10** (A-07-036).
- Rate limits for the link pages and the DOB endpoint, and 429 handling in the queue → **Part 15** (A-07-037, -038, -039).
- Reconciling optimistic social state after a refusal → **Part 15**, if the device checks show it matters (A-07-040).
