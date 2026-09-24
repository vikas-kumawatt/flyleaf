# Audit Part 07 — Mobile foundation, offline, auth screens, guest mode (SL-00 … SL-05, SL-10 … SL-14, SL-20 … SL-22, SL-30 … SL-33)

**Read `docs/audit/00-method.md` first.** This part is mostly `apps/mobile`, plus the server endpoints the offline queue replays against.

Spec: PRD §4.2 guest mode (**[LOCKED]**), §4.4 budgets, §5.2 navigation (**[LOCKED]**), §6.1–6.6, §8.3 (append-only progress), §34.5 client and network edge cases, §35 offline and mobile (the §35.1 capability matrix and §35.2 sync architecture are the checklist for SL-1x), §36/§38 accessibility. Architecture §10 (client). `docs/design.md` for the design system.

Mobile verification: `npm run typecheck`, `npm test` (node test runner). **UI behaviour you can't run must be verified by reading the code.** At the end, list the manual on-device checks I should do on my Android phone, as a short checklist in the findings.

## Confirmed leads, verify and fix

1. **Any 409 is treated as "synced" and the mutation is dropped** (`offline/queue.ts`: "2xx or 409 dup → mark synced"). A 409 means "duplicate replay" only for idempotent writes (progress on a used `client_event_id`). Other 409s are real refusals that the user must hear about: `not_likeable`, `not_commentable`, `thread_locked`, `duplicate_import`, shelf conflicts. Silently dropping them loses user intent. Distinguish by error `code`, and send real conflicts to the dead-letter queue with a user-visible surface. **P1.**
2. **The queue isn't cleared or scoped on logout / account switch** (no clear on logout found). User A's pending mutations could replay under user B's token. Scope queue rows by user id, or purge on logout (with a warning when unsynced items exist). **P0.**
3. **`progress_events.client_event_id` is globally `UNIQUE` and the insert is `ON CONFLICT DO NOTHING`** (`reading/index.ts`). A replay reusing an id that belongs to **another read or another user** silently succeeds without writing. Decide the right behaviour (409 with a code when the existing row's `read_id` differs), implement it server-side, and make the client handle it per lead 1. Test cross-read and cross-user reuse.

## SL-00 … SL-05 — client foundation

- SL-00: run `npx expo install --check` and `npx expo-doctor` and record the output. Every native module is pinned to SDK 57's `bundledNativeModules.json`.
- SL-03: TanStack Query error surface. Are errors shown, retried sensibly (no retry on 4xx), and not swallowed? Grep for `catch {}` / `catch { // Ignore }` around user-facing mutations. Silent failures where the UI shows success are findings.
- **SL-04 refresh interceptor**: single-flight (claimed: a mutex). Test **N parallel 401s → exactly one refresh call**. Given Part 04's finding on concurrent refresh and reuse detection, this is what stops random logouts. Refresh failure → clean logout, with the queue handled per lead 2. The refresh token lives only in SecureStore, never in AsyncStorage/SQLite/logs.
- SL-05 theme: both palettes, no hard-coded colours (design rule: "a literal in a component is a bug"). Grep for `#` hex literals and `rgb(` in `apps/mobile/app` and `src/ui`, excluding `tokens.ts`. The SO-15 FeedCard has literals (`'#3B82F6'`, `'#EF4444'`), so count and list them all.
- SL-01: the tab set matches PRD §5.2 [LOCKED].

## SL-10 … SL-14 — offline

Check against the PRD §35.1 matrix (what must work offline) and §35.2 (how sync works):
- SQLite schema mirrors reads and progress. Migrations for the local DB: what happens to an existing install when the local schema changes? Is there a versioned migration, or does it crash or wipe?
- For **each mutation type** in the queue, list: whether it's replay-safe **server-side** (idempotency key or natural idempotency), and what happens on 404/409/422. Non-idempotent replays are findings (e.g. a "create shelf" replay creating two shelves).
- Per-entity FIFO; backoff; the dead-letter queue **surfaced to the user** (is there UI, or does the data silently rot?); process death during replay; a mutation half-applied (request succeeded, response lost) → the replay must be safe.
- Which writes bypass the queue? PRD §34.5 says follow/like/comment are "queued, with an optimistic UI". Today likes and comments call the API directly (SO-21/22). Record the gap, and recommend whether to route them through the queue now that like/unlike are idempotent.
- SL-14: sync on foreground and reconnect is debounced (no storm when flapping), and the unsynced indicator is accurate.
- Run and extend the process-death tests (`src/offline/__tests__`).

## SL-20 … SL-22 — auth screens

- Client validation **matches the server exactly** (username regex, reserved words, password rules, DOB). Put the lists side by side. Drift in either direction is a finding.
- Username availability: debounce 400 ms (PRD §6.3), stale responses discarded (an older response must not overwrite a newer one), and offline handled.
- Forgot/reset/verify flows handle expired and used tokens with clear copy. Deep links for verify/reset land on the right screen.
- Avatar upload: size and type limits, and what the server accepts.

## SL-30 … SL-33 — guest mode

- Guest routing lands on Home in browse mode (PRD §4.2). **Every** gated action shows the contextual prompt: log, rate, follow, like, comment, shelve, save shelf, review, mute, block. Build the list from the UI code and check each call site. An ungated action that hits the API and fails with 401 is a finding.
- Local want-to-read: cap of 20, dedupe, persistence across restarts.
- **SL-33 migration on signup**: idempotent (retry after a partial failure doesn't duplicate), works on **login** to an existing account too (or the spec says otherwise, so check), handles works that no longer exist or were merged, and shows the confirmation copy with correct counts. What happens to the local shelf if the user signs up, then logs out?

## Deliverables

`docs/audit/findings/07-mobile-foundation.md` (including the manual device checklist), fixes, tests, and audit lines under each SL task listed above.
