# Audit 10 — Diary, Wall, Profile, Stats, Instrumentation (SL-70 … SL-74, SL-80 … SL-82)

2026-10-05/06 · CI: **green in 785 s**, all 9 steps (owner's run, `FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`, after the Fastify 5.12.5 bump): api-client build, api typecheck, spec check, **api tests 1,466/1,466 (74 files)**, api build, api audit, mobile typecheck, **mobile offline tests 177/177**, migrations on a real Postgres ("migrations applied"). Nothing failed, so nothing was re-run after it. The first run (1,897 s) passed api-client build, api typecheck, spec check, **api tests (1,466/1,466, 74 files)** and api build, then **failed `api · audit`**: two new high advisories against existing dependencies (A-10-032). Fixed here. Then, as `ci.mjs` defines them: `api · audit` (`npm audit --audit-level=high`) exit 0; the three unreached steps `mobile · typecheck` exit 0, `mobile · offline tests` (`npm test`) **177/177**, `api · migrations on a real Postgres` (`npm run migrate`) "migrations applied". Because the fix bumps Fastify, these were also re-run at one worker: api `typecheck`, `spec:check`, `build`, and `contract`, `hooks-hardening`, `content-settings`, `avatar`, `profile-audit`, `telemetry-audit` (68/68). The full API suite on 5.12.5 is the green run above. · Tests: API **1,406 → 1,466** (+60 in six new files: `stats-audit` 17, `avatar` 10, `telemetry-audit` 10, `profile-audit` 9, `content-settings` 8, `search-suggestion` 6); mobile **162 → 177** (`stats-view` 4, `sentry-scrub` 3, `diary-groups` 3, `telemetry-budgets` +4, `auth-validation` +1). No test was weakened or skipped. Five existing assertions were updated because the behaviour they pinned was deliberately changed; each is listed under Behaviour changes.

**How this part ran.** An earlier session started Part 10 and left uncommitted work (stats rewrite, reads pagination, telemetry caps, Sentry scrubbing, profile fixes, migrations 0030/0031, four test files) but no findings file. This session treated that work as unverified. It mutation-checked each fix (re-introducing the old behaviour and watching the test fail), then built the rest. Where a finding says "seen failing", that means one of three things: the test failed before the code existed (content settings, age gate, budgets), the test failed on a mutation that restores HEAD's behaviour, or both.

**Databases.** Migrations **0030–0033** were applied with `npm run migrate` to **both** `flyleaf_dev` and `flyleaf` (full catalog: 22 s). None rewrites a large table: 0030 is a function, 0031 adds a nullable column to `users`, 0032 creates and fills a new 112,554-row table from 74k popular works, and 0033 replaces a check constraint on the small `uploads` table. All perf numbers are from **`flyleaf_dev`** unless they say `flyleaf`, and come from the 8 GB machine: **indicative only**.

**What was run here** (one worker, a few files at a time, all green at the end): API `tsc --noEmit`; `stats-audit`, `profile-stats`, `profile-audit`, `content-settings`, `dob-confirmation`, `telemetry-audit`, `telemetry`, `contract` (**drift 0** after `spec:generate`), `search-suggestion`, `search-route`, `search`, `relevance`, `avatar`, `uploads`, `api-client-upload`, `catalog-source-contract`, `work-counters`, `auth-audit`, `admin-security`, `feed-ranking`, `hooks-hardening`, `isbn`, `outbound`, `review-ranking`; api-client build; mobile `tsc --noEmit`; the **whole mobile unit suite** (177/177, `--test-concurrency=1`). **Not run:** the full API suite, `scripts/ci.mjs`.

**Screens were checked by reading the code and by mobile `tsc`**; there is no React Native renderer. Screen logic changed in this part lives in tested modules where possible (`lib/statsView`, `lib/diaryGroups`, `lib/sentryScrub`, `lib/budgetTracker`, `lib/auth-validation`). The rest is on the phone checklist at the end.

`secure-design` was not triggered: this run was autonomous by instruction. The security-relevant changes (age gate, explicit setting, avatar serving, telemetry ingestion, error scrubbing) each have adversarial tests below.

## Items handed to Part 10 by earlier parts

Found with `grep "Part 10"` over `docs/audit/findings/` and the brief.

| From | Item | Outcome |
|---|---|---|
| 02 A-02-024 / A-02-015 | AC-7 spelling suggestion + `search_zero_results` log | **Built:** A-10-006 |
| 02b decision 4 | `tolkein` must suggest "Tolkien" (required case) | **Passes:** `search-suggestion.test.ts`, suggests "J.R.R. Tolkien"; seen failing |
| 02 (deferred list) | `harry pottr` with the suggestion work | Suggests "Harry Potter and the Philosopher's Stone" on `flyleaf_dev` (prototype panel, A-10-006); not asserted |
| 02 A-02-021 | Flaky `readingVelocity` test | **Already fixed in Part 08** (`629f32f`: rounding before `ceil`, `NOW` pinned). Closed |
| 02 / 07 A-07-036 / 02b A-02-026 | "Show explicit titles in search" has no endpoint or screen | **Built:** A-10-005 |
| 07b D-07b-1 | Neutral age gate (record, refuse later attempts, device flag) | **Built:** A-10-014 |
| 07 A-07-032 | Avatar picker on the PV-0x upload path, purpose `avatar` | **Built:** A-10-016 (device untested) |
| 08 A-08-027 (L-09) | `GET /users/:id/reads` unpaginated | **Fixed:** A-10-015 |
| 08 D-08-3 | Page count with no chosen edition: default edition, else median ignoring < 20, one function | **Fixed:** A-10-011 |
| 08 A-08-013 / A-08-028 | §34.2 delete confirmation for a finished read; per-work attempt history (Diary) | **Not built:** A-10-030 (deferred) |
| 09 A-09-043 | Year-stats histogram still five buckets | **Fixed:** A-10-013 |
| 01 baseline | `GET /me/stats` and `/users/:id/stats` perf | Measured: Performance |
| 12 (brief) | Export `?token=` must never be logged (Sentry redaction) | API: query scrubbed (Audit 05, kept); mobile now scrubs it from messages and stacks: A-10-019 |

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| SL-70 | Diary list · grid · calendar, year jump, filters | ⚠️ partial: undated finishes were filed under the month they were edited, pages summed the bookmark not the book, a 1 March finish showed under February west of UTC; no "Undated" group; no single-read delete | A-10-021, A-10-030 |
| SL-71 | The Wall, filters, 2-col < 340 dp | ❌ broken for other users: their Wall showed **the viewer's own** books. 340 dp switch ✅ | A-10-002, A-10-026 |
| SL-72 | Profile, stats strip, editor | ⚠️ bio limit counted UTF-16 units, no trimming, privacy switch not atomic; no avatar | A-10-020, A-10-016 |
| SL-73 | Favourites (4, ordered, drag) | ✅ server rules hold (≤ 4, unknown refused, merged resolved, repeats collapse, dedupe repoints); ⚠️ "drag" is Up/Down buttons; tasks.md payload claim false | A-10-031 |
| SL-74 | Basic stats | ❌ **P0 privacy leak** (audio hours and streak from private reads), UTC streak days, server-clock years, print assumed for unknown formats, audio double-counted, smallest-edition pages, five buckets, nothing disclosed | A-10-001, A-10-007…A-10-013 |
| SL-80 | `events` table + emitter | ❌ anonymous, uncapped, open name set, **user id taken from the body** | A-10-017, A-10-025, A-10-029 |
| SL-81 | §4.4 budgets instrumented | ❌ false green on both ends: the app invented in-budget durations and a constant tap count; the report counted all time and said "passing" with no samples | A-10-003, A-10-004 |
| SL-82 | Sentry app + API | ⚠️ API scrubbed six top-level keys only; mobile ids invalid, no release, no scrubbing despite the claim | A-10-018, A-10-019 |

## Findings

### A-10-001 · P0 · FIXED · Another viewer's stats included private reads (audio hours, streaks) — PRD §17.5 [LOCKED]
- **Where:** `reading/index.ts` `getStats` (HEAD: the audio and streak queries filtered `WHERE r.user_id = …` only).
- **Evidence:** at HEAD, a stranger's `GET /v1/users/:id/stats` counted the owner's private audiobook in `audio_hours` and the owner's private reading days in `current_streak` and `longest_streak`. The counts and extremes were filtered in JS per read, so they were right.
- **Fix:** every one of the three queries takes the viewer's visibility levels (`visibleLevels`, derived from `canView`). The viewer is an input to each query, not a filter on a shared result.
- **Test:** `stats-audit.test.ts` › "§17.5 [LOCKED]: every field, per viewer". The oracle is a **twin** account holding exactly the reads a given viewer may see; the viewer's response about the owner must deep-equal the twin's own response, field by field, for stranger, guest, pending follower, accepted follower and owner, in `year=all` and `year=2025`. Blocked either way and a random id give the same 404 body; a private account is a 404 to a stranger or guest and 200 to a follower. **Seen failing:** yes. Removing the visibility filter from the audio query (HEAD's form), the streak query (HEAD's form) or the main query fails 5 tests each.

### A-10-002 · P1 · FIXED · Another user's Wall showed the viewer's own books
- **Where:** `apps/mobile/app/wall.tsx` (other-user branch called `api.reads('finished')`, the viewer's own `GET /reads`).
- **Fix:** calls `api.userReads(targetUserId, 'finished')`, which walks `GET /users/:id/reads` pages of 100, up to 3,000. Privacy is the server's.
- **Test:** none automated. There is no screen renderer, and a paging-helper test would not catch the wrong endpoint. Mobile `tsc`; phone checklist.

### A-10-003 · P1 · FIXED (one budget DEFERRED) · The app reported invented §4.4 budget numbers
- **Where:** `apps/mobile/src/lib/budgetTracker.ts`, `app/(tabs)/reading.tsx`, `app/work/[id].tsx`, `app/(tabs)/_layout.tsx`.
- **Evidence:** with no clock started, the tracker sent `duration_ms: 1200` (progress), `start = now − 4 s` (finish) and `duration_ms: 3500` (log sheet), all inside budget. Each progress save re-anchored the clock to the previous save, so it never measured "Reading tab open → saved". Both `book_logged` call sites passed a constant `tapCount: 2`, which can never miss "≤ 2". The log-sheet clock started at a row's "Update" button; the `+` FAB that §4.4 names had no instrumentation.
- **Fix:** no clock, no event. Progress gives one sample per Reading-tab focus. The `+` FAB starts the log-sheet clock, and the next save (work page or Reading tab) ends it. `book_logged` is **not sent** until taps are counted (see Deferred). Its budget now reads `sample_count 0, passing null` (unknown), not green.
- **Test:** `telemetry-budgets.test.ts` › "§4.4 budgets measure, never invent" (4, with a pinned `Date.now`). **Seen failing:** yes, 3 of 4 before the fix.

### A-10-004 · P1 · FIXED · The budget report was green by construction and breakable by one anonymous event
- **Where:** `telemetry/index.ts` `getBudgetMetrics`.
- **Evidence:** every budget read every event ever stored. `passing` was `true` with no samples. One stored `{"duration_ms":"abc"}` (accepted by the old ingestion) made the `::numeric` cast fail the whole report until the row was deleted.
- **Fix:** a window (`?days=`, default 28, 1–365), `passing: null` without samples, and only rows whose measurement is a JSON number are read. Ingestion also refuses bad measurements now (A-10-017).
- **Test:** `telemetry-audit.test.ts` › "no false greens" (3). **Seen failing:** yes. Mutations restoring "true when no samples" and "no window" each fail 1.

### A-10-005 · P1 · FIXED · "Show explicit titles in search" can now be set (A-07-036, PRD §7.8 [LOCKED])
- **Fix:** `PUT /v1/me/content-settings {showExplicit, dateOfBirth?}`. Turning it on requires a confirmed date of birth at 18+ (`403 setting_unavailable` otherwise) and the date re-entered (`422 dob_required` / `dob_mismatch`). Turning it off is always allowed. `GET /me` adds `showExplicit` and `explicitSettingAvailable`, computed with the **same SQL expression** as `CatalogService.#allowsExplicit`, so the control exists exactly when search would honour it. App: Profile → **Content** (`app/profile/content.tsx`). The row and the control are absent for under-18 and unconfirmed accounts.
- **Test:** `content-settings.test.ts` › "Show explicit titles in search" (5): `/me` per account kind, re-entry required and matched, off without a date, under-18 and unconfirmed refused even with their own date, guest 401, malformed 422. `profile-audit` › "only the listed fields are writable" (PATCH cannot set `showExplicit`). **Seen failing:** yes (all 5 before the route existed).

### A-10-006 · P1 · FIXED · AC-7 / §14.7: spelling suggestion and `search_zero_results`
- **Fix:** migration **0032** builds `search_suggestions`: titles and credited authors of non-explicit works with ≥ 20 logs, with weights, and a trigram GIN on `lower(term)` (112,554 terms on both databases). When the local search finds nothing, `#suggest` runs **before** the Open Library gap-fill: `word_similarity ≥ 0.45`, set per transaction, ranked by similarity × ln(2 + weight). There is no second loose trigram pass over the catalog, which A-02-023 removed. `GET /search` returns `suggestion` (null otherwise). A search that ends empty records `search_zero_results{query}` (query capped at 200 characters), **never linked to the viewer** (§23.5: queries are personal data). The vocabulary is rebuilt weekly (`search.suggestions.refresh`, Sundays 04:00) and in `devdb` `finish()` (`devdb` skips copying it, the A-09-044 trap). App: "Did you mean *X*?" on Discover, tapping re-searches.
- **Ranking evidence (`flyleaf_dev` prototype, 24 misspellings):** by similarity alone, `tolkein` → *What Einstein Told His Cook* (0.625 vs 0.50). Weighted, 21/24 are sensible: `tolkein` → J.R.R. Tolkien, `ishigoro` → Kazuo Ishiguro, `harry pottr`, `brandon sandersen`, `agatha christy`, `steven king`, `jane austin`, `orwel`, `gatsbey`, `kafak`, `neil gaimen`, `pride and prejudise`, `the catcher in the ry` and others. Misses: `murakmi` → *Ryū* Murakami, `marquez` → Aguilar Marquez Arturo, `tolstoi` → Tatʹi͡ana Tolstai͡a. `zzqqxx` → none.
- **Test:** `search-suggestion.test.ts` (6): `tolkein` → `{data: [], suggestion: "J.R.R. Tolkien"}` with an obscure closer title present; a hit has no suggestion; nothing close gives null; the zero-result log is user-less and absent for a hit; the vocabulary excludes explicit and unpopular works; the weekly job picks up a newly popular work and the worker schedules it. **Seen failing:** yes (stubbing `#suggest` fails the `tolkein` test). Relevance panel unchanged (`relevance.test.ts` green).
- **Cost:** see Performance (one GIN probe, zero-result searches only).

### A-10-007 · P1 · FIXED · Streak days were UTC days, not the user's (PRD §8.7)
- **Fix:** `tz` query parameter (IANA, checked by `Intl` and a character rule, `422 invalid_timezone`). Progress days are `(at AT TIME ZONE tz)::date`, and the default year is "this year in tz". The app sends the device zone (`deviceTimeZone()`).
- **Test:** `stats-audit` › "§8.7: streak days are the user's local days". 23:50 and 00:10 IST are 2 days in `Asia/Kolkata` and 1 in UTC. **Seen failing:** yes (mutation to `AT TIME ZONE 'UTC'`).
- **Gap:** no 2-day grace yet (§8.7, ST-06). The code says so; the streak is the plain consecutive-day run.

### A-10-008 · P1 · FIXED · Stats years came from the server clock; a bad year silently became this year
- HEAD used `new Date().getFullYear()` and `new Date(finished_at).getFullYear()` in the server's zone, and replaced an invalid `year` with the current one. Now the year comes from the stored date text, the window is computed in SQL, and an invalid year is `422 invalid_year`. **Test:** `stats-audit` › "the year is the finish date…", "a year … not a year is refused". Not separately mutation-checked.

### A-10-009 · P1 · FIXED · Format split counted unknown formats as print and ignored the edition (PRD §17.2)
- HEAD: `formatOverride ?? 'print'`. Now: `format_override`, else the edition format (hardcover and paperback count as print), else **`unknown`**, a new `format_breakdown.unknown`. **Test:** `stats-audit` › "format split…". **Seen failing:** yes (mutation to HEAD's rule).

### A-10-010 · P1 · FIXED · Audio hours summed positions
- `audio_seconds` is a position (§8.3: the latest row is the current point). HEAD summed every event (3 events at 1, 2 and 3 h counted 6 h) and windowed by UTC year of the event. Now: the furthest point reached in the window minus the furthest point before it, per read. A finished audiobook with a known duration has reached its duration on its finish date. **Test:** `stats-audit` › "listening hours…" (3 h, not 6; split across a year boundary). Not mutation-checked.

### A-10-011 · P1 · FIXED · D-08-3: one page-count rule
- **Fix:** migration **0030** `flyleaf_page_count(edition_id, work_id)`: the chosen edition, else the work's default edition, else the median of its editions; counts under 20 ignored at every step. Used by the reads list (progress %), stats, and `GET /works/:id` (`page_count`, new field). Year in Review must use it when it exists.
- **Test:** `stats-audit` › "D-08-3…": editions 96/310/320/1,200 (+ a 5) → 315; a default edition of 100 → 100; the same on the reads list and the book page. **Seen failing:** yes (median→min mutation: 196 ≠ 415).

### A-10-012 · P2 · FIXED · §17.4: exclusions were not disclosed
- Stats now return `excluded {undated, missing_page_count}`. Undated finishes count in "all" and never in a month or year. A book without a page count adds nothing to pages or the extremes. The stats screen says so in one line (`excludedNote`). Re-reads count per attempt in `books_count`, and `distinct_works_count` is reported beside it (§17.2). Imported reads count like any other: nothing in §17 excludes them, and §17.4 covers their missing data. **Test:** `stats-audit` › "§17.4…", "re-reads…"; mobile `stats-view` › "§17.4…".

### A-10-013 · P2 · FIXED · A-09-043: ten half-star buckets in year stats
- `rating_distribution` keys are now `"0.5"`…`"5.0"` (was `"1"`…`"5"`, rounded). The mobile stats screen drew keys `'5'`…`'1'` and would have shown zeros; it now draws the ten buckets (`statsRatingRows`). **Test:** `stats-audit` › "A-09-043…"; `profile-stats` (updated, see Behaviour changes); mobile `stats-view`.

### A-10-014 · P2 · FIXED · D-07b-1 neutral age gate
- **Server:** migration **0031** `users.underage_attempt_at`. `POST /me/date-of-birth` with an under-13 date records the attempt and refuses. Every later attempt on that account is refused with the **identical** body, whatever date it carries, and the account stays unconfirmed (most restricted) until reviewed. The refusal text at signup and confirmation is `AGE_GATE_MESSAGE`, "Sorry, you can't use Flyleaf.", which does not say what would pass.
- **App:** the same words (`auth-validation.ts`). An under-13 date at signup sets a device flag (`ageGate.ts`, SecureStore), after which any date is refused on that device. The confirm prompt now sends an under-13 date to the server (it used to stop on the device, so the server could never record it). The labels "(age 13+)" were removed from signup and the prompt: they named the passing answer.
- **Test:** `content-settings` › "neutral age gate" (3): the words are neutral and equal at signup and confirmation; after an under-13 attempt, 1985-03-14 is refused with an identical body and the row is flagged and unconfirmed; an adult date first records nothing. Mobile `auth-validation` › device gate. **Seen failing:** yes (2 of 3 server tests; the adult case passed before, as it should).
- **Later:** switch to suspension when SO-42 exists (D-07b-1).

### A-10-015 · P2 · FIXED · A-08-027: `GET /users/:id/reads` is cursor-paginated
- `limit` 1–100, default 50, `next_cursor` (opaque base64url of `(updated_at as Postgres text, id)`; microseconds kept, since a JS `Date` would drop rows sharing a millisecond). A forged cursor is `400 invalid_cursor`. Ordered newest update first with `id` as the tie-break, and the page is cut **in SQL** (`LIMIT n+1` in a CTE) before the per-row lookups. `GET /reads` (the owner's sync) is unchanged and unpaginated.
- **Test:** `profile-audit` › "walks every visible read exactly once…" (page sizes 1–3, three rows in one millisecond), "defaults to 50…", "a guest pages the same public reads", "reads one page from the database (limit + 1 rows)". **Seen failing:** yes. Rounding the cursor to ms fails 1. Dropping the SQL `LIMIT` **survived** the first three tests (the pages stay correct, just expensive), so the row-count test was added and seen failing on that mutation.

### A-10-016 · P2 · BUILT · Avatar picker on the PV-02 path (A-07-032, PRD §6.7)
- **Server:** upload purpose `avatar` (JPEG/PNG/WebP, 2 MB; migration **0033** widens `uploads_purpose_ck`). `complete()` checks the magic bytes **match the declared type** (`imageTypeOf`). `PUT /v1/me/avatar {upload_id}` consumes it in one transaction (row-locked; a replay of the same request is 200; an older avatar's upload is `409 upload_consumed`), then deletes the previous object (best effort). `DELETE /v1/me/avatar` removes it. `GET /v1/avatars/uploads/:userId/:uploadId` → 302 to a 1 h signed URL, **only** for a key that is a live account's current `avatar_key` (import CSVs share the key shape), and with §16.3's header rules: a private account's avatar is 404 to a guest, and nobody's is served across a block (same body as a random id). Profiles carry `avatarUrl`. `avatar_url` in feed cards and interactions pointed at a route that never existed (`/avatars/…`, no `/v1`); all builders now use `avatarUrl()`.
- **App:** tap the profile avatar → library, camera or remove. Square crop, resized on the device to 512 px JPEG 0.8 (`expo-image-manipulator`), uploaded, set. The image is requested with the bearer token (§16.3). New native dependencies, each pinned to the version in `bundledNativeModules.json` via `npx expo install` (SL-00): `expo-image-picker ~57.0.20` (no picker existed) and `expo-image-manipulator ~57.0.20` (on-device resize, §6.7). An `expo-image-picker` plugin entry with permission strings was added to `app.json`. **A dev-client rebuild is needed.**
- **Test:** `avatar.test.ts` (10): types and size, magic-byte mismatches (PNG declared JPEG, SVG declared PNG, JPEG declared WebP) refused and deleted, an image is still not an import, set/serve/replay, replace deletes the old object and its upload cannot come back, an import CSV at the avatar path shape is 404, another user's / an import / a pending upload cannot become an avatar, a deleted account's avatar is not served, §16.3 private/guest/block. **Seen failing:** yes. Mutations dropping the current-avatar check (3 fail), the image sniff (1) and the relationship gate (1).
- **Not done:** the follower list and shelf owner still return `avatarKey` only (no URL); see Deferred.

### A-10-017 · P1 · FIXED · `POST /v1/events` stored anything, and attributed events to any user id in the body
- **Evidence:** HEAD `userId: authenticatedUserId || item.userId`. An anonymous caller could write events under someone else's id. Any name, any properties, any timestamp.
- **Fix:** the user is the verified token's subject or null, never the body. Names come from the PRD §28.2 taxonomy plus the §4.4 and shelf events the app sends (`EVENT_NAMES`). Properties: ≤ 20 flat keys of ≤ 64 characters, scalar values, strings ≤ 200, finite numbers. Timestamps: within the last 7 days to 5 minutes ahead. Budget events must carry their measurement as a number in range. The batch cap stays at 100 (whole batch refused above). Refused events are counted in a new `rejected` field.
- **PII (§26.5):** the app's emitters were grepped. Shelf names appear only for the fixed starter shelves (`shelf_created{name}` in `(tabs)/shelves.tsx`); no email, display names or free text.
- **Test:** `telemetry-audit` › "shape caps" (6). **Seen failing:** yes (caps disabled: 4 fail).

### A-10-018 · P1 · FIXED · API error reports scrubbed six top-level keys only
- HEAD redacted `password, newPassword, token, refreshToken, secret, totp, backupCode` at the top level of the body only. `refresh_token`, a nested `password`, and the 6-digit `code` of verification/TOTP steps went to Sentry as sent. Now it is recursive, case- and `_`/`-`-insensitive, and also covers `code`, `otp`, `apikey`, `authorization`, `cookie` and **email** (PII to a third party, §26.5).
- **Test:** `telemetry-audit` › "redacts secrets at any depth…". **Seen failing:** yes (scrub mutation).

### A-10-019 · P2 · FIXED · Mobile crash reports: invalid ids, no release, no scrubbing
- `event_id` was an ~11-character random string, but Sentry's store API takes 32 hex characters, so reports were probably dropped (not verified against a live DSN). There was no `release` or `environment` tag. The header claimed sanitising, but nothing was scrubbed. Now: a UUID-based id, `release flyleaf-mobile@<version>`, `environment`, `app_version` tag, and the message and stack lines are scrubbed of `?token=` and other query secrets, bearer tokens and emails (`sentryScrub.ts`). There are no breadcrumbs at all, so none carry PII. The `ErrorBoundary` reports and offers reset (checked by reading).
- **Test:** `sentry-scrub.test.ts` (3). Written with the extraction; there was no old function to fail against.

### A-10-020 · P2 · FIXED · Profile edits (SL-72)
- The bio limit counted UTF-16 units: 81 emoji were "too long" while the database and schema count characters. Display name and bio were not trimmed, and whitespace-only was stored. Going private (flag + activity re-scoping) and going public (flag + auto-accept) were separate writes, so a failure between them left public activity on a private account or pending requests on a public one. Now: character counts, trim (empty → null), one transaction.
- **Verified unchanged:** only `displayName, bio, isPrivate, favouriteWorkIds` are writable (counters, username, explicit flag ignored). Going public accepts pending requests, and the trigger-kept follower count follows.
- **Test:** `profile-audit` › 5 profile tests. **Seen failing:** yes for trimming and the length rule (mutations). Atomicity is **not tested** (no failure injection exists for these writes).

### A-10-021 · P2 · FIXED · Diary grouping and totals (SL-70)
- Undated finishes were grouped under the month of `updated_at` (a fabricated date, §17.4) instead of "Undated" at the end (§6.18). The volume bar's "pages" summed `page` (bookmark) rather than `page_count`. Month keys came from `new Date('YYYY-MM-DD')`, i.e. UTC midnight, so a 1 March finish showed under **February** west of UTC. Now `groupDiary`/`diaryPages` (`lib/diaryGroups.ts`) work on the date text.
- **Test:** `diary-groups.test.ts` (3, the time zone pinned to Los Angeles in-process; the shell `TZ` is ignored by Node on Windows). **Seen failing:** yes (the `new Date` mutation fails the boundary test).

### A-10-022 · P3 · FIXED · Stats screen showed the DNF rate as "0.12% rate"
- `dnf_rate` is a fraction; the screen now shows `dnfPercent()` (12%). **Test:** mobile `stats-view`.

### A-10-023 · P2 · Recorded · The mobile `profile-stats.test.ts` re-implements the logic it tests
- Its favourites, diary and stats cases copy the screen logic into the test body. Deleting the screens' code would not fail them. Not rewritten (no drive-by), but the stats and diary rules changed in this part now live in imported modules with real tests (`stats-view`, `diary-groups`).

### A-10-024 · P2 · Recorded · Stats cost and the §17.5 cache structure
- **Measured** (Performance): 4 queries per request, unchanged; p50 25 → 28 ms (stats:me), 19 → 26 ms (reads:user); within budget, under the 2× threshold. The extra cost is the median page count per read (~0.1 ms/read warm: 628 reads in 61 ms). The main stats query plans a parallel seq scan of `reads` on `flyleaf_dev` (62k rows, 1,363 pages; 410 kept). That is a planner choice at this size: `reads_user_visibility_idx (user_id, visibility, status, updated_at)` serves it, and the paginated list uses it (bitmap index scan, 535 rows).
- **Plan for Phase 5** (not built): per §17.5, cache aggregates **per visibility tier** (`owner`, `follower`, `public`) and per year, keyed `(user_id, tier, year, tz-day-boundary)`, invalidated by the reads/progress triggers. Never one total per user. Streaks depend on `tz`, so cache the day set in UTC with a 24 h margin, or per zone.

### A-10-025 · P2 · DECIDED (D-10-1, corrected; D-10-3) → Part 15 · `events` has no retention
- No job prunes `events`; `search_zero_results` query text stays indefinitely (stored without a user, A-10-006).
- **Superseded by the correction below.** First decision D-10-1 (owner, 2026-10-06): raw events are kept **13 months**. `search_zero_results` rows are kept **30 days once the weekly summary exists**. The summary keeps the **query text only when enough distinct users searched it**, otherwise counts only. **Implementing the deletion job and the summary belongs to Part 15's retention sweep**, recorded there (Deferred below).
- **Checked against PRD §23.5** ("Search query logs: 30 days, then aggregated and anonymised"; no line for analytics events):
  1. **Conflict, ordering:** §23.5 makes 30 days a limit; the decision starts the 30 days only once the summary exists, so until Part 15 builds it, zero-result queries are kept **longer than 30 days**, against §23.5 (today: indefinitely, since this part). Safest reversible interim, not built here: a plain 30-day delete of `search_zero_results` in Part 15's first sweep, before the summary exists, accepting the lost history.
  2. **Conflict, data needed:** "enough distinct users" cannot be computed from what is stored. A-10-006 stores zero-result events with **no user**, on purpose (§23.5 calls queries personal data), and guests have no user anyway. The summary needs a per-searcher key inside the 30-day window. Recommendation: a salted hash of the user id or, for guests, the client IP, the salt rotated at least every 30 days and the key dropped at aggregation, so the summary itself holds no identifier. That is a change to what the event stores (Part 15, with the summary).
  3. **Threshold not set:** "enough" needs a number. Recommendation: k ≥ 5 distinct searchers per week, the usual small-cell floor.
  4. **No conflict:** §23.5 has no row for analytics events, so 13 months adds a rule rather than breaking one. Signed-in events carry `user_id`, so they are personal data; the privacy policy should state the 13 months (Part 15 / LA).
- **D-10-1 corrected (owner, 2026-10-06): PRD §23.5 wins.** Raw events: 13 months (unchanged). `search_zero_results`: deleted after a **flat 30 days**, independent of the weekly summary; the summary only reads rows inside that window. This resolves conflict 1; there is no interim.
- **D-10-3 · summary threshold and searcher key (owner, 2026-10-06):** a query's text is kept in the weekly summary only if **at least 5 distinct searchers** searched it that week; below that, counts only. Searchers are counted with a **per-week salted hash** of the account id, or the guest session id. The salt rotates weekly and is **deleted as soon as that week's summary is written**, so the stored hashes can no longer be linked to anyone and nothing user-identifying is kept. This resolves conflicts 2 and 3.
- **What Part 15 must build** (routed in `docs/audit/15-cross-cutting-and-wrap-up.md`, "Handed over from Part 10"):
  1. a daily prune: `events` older than 13 months; `search_zero_results` older than 30 days;
  2. a searcher key on each zero-result event: `hmac(week_salt, account id or guest session id)`. The guest session id has to reach the server: `/v1/search` gets no session id today (the app's telemetry `session_id` is only sent with `POST /events`). So either the app sends it on search, or the key falls back to the IP (decide in Part 15; the owner's decision names the session id);
  3. the salt in its own table, one row per week, deleted in the same transaction that writes the week's summary;
  4. the weekly summary `(week, query or null, searches, distinct_searchers)`, with the text only where `distinct_searchers >= 5`.

### A-10-026 · P2 · DEFERRED · Wall and Diary filter on the device
- PRD §6.39 edge cases: "3,000 books → virtualised, filters applied server-side". Both screens load everything and filter locally; another user's Wall now pages up to 3,000 reads (A-10-002). The bench has no 2,000-book persona (largest: 628 reads), so payload at that size was not measured. The Wall's format filter still treats a read with no override as print (no edition format on `LocalRead`). Plan: `GET /users/:id/reads` filters (`year`, `format`, `min_rating`, `hearted`, `sort`) with the same cursor.

### A-10-027 · P3 · Recorded · Pre-existing Expo version drift
- `npx expo install --check` reports `expo-constants 57.0.19 (~57.0.20)`, `expo-router 57.0.23 (~57.0.24)` and `expo-updates 57.0.23 (~57.0.24)`. Not caused here and not changed (no drive-by).

### A-10-028 · P3 · Recorded · `npx tsc` does not resolve in `packages/api-client`
- `npm run build` there fails with "'tsc' is not recognized" on this machine; the client was built with `apps/api/node_modules/.bin/tsc`. CI's own command is unaffected (it passed in Part 09).

### A-10-032 · P1 · FIXED · `api · audit` failed: Fastify 5.12.1 and `source-map-js` 1.2.1 (new high advisories)
- **Evidence:** the owner's CI stopped at `npm audit --audit-level=high`. `fastify <=5.12.4` (high: authentication bypass via malformed URLs reaching encapsulated not-found handlers, request validation bypass via skipped boolean-false schemas, header validation bypass via incomplete case normalisation, body replacement via an async validation collision, HTTP/2 trailer DoS). It is a production dependency, pinned exactly at `5.12.1`, which is why npm offered only `--force`. `source-map-js 1.0.0–1.2.1` (high, event-loop DoS) is dev-only, via vitest → vite → postcss. Neither was introduced by this part.
- **Fix:** `fastify` pin `5.12.1` → **`5.12.5`** (patch release, same major; the security fix), and `npm update source-map-js` → 1.2.2 (lockfile only). Not `npm audit fix`, which would have moved other packages too. Remaining: 9 moderate (the esbuild/drizzle-kit dev chain `ci.mjs` documents, plus fast-uri, ip-address, and uuid via autocannon), below the CI gate. Whether the Fastify advisories were exploitable here (for example, any route schema using boolean `false`) was not assessed; the upgrade removes them either way.
- **Test:** `api · audit` exit 0; the owner's full CI on 5.12.5 is green (1,466/1,466).

### A-10-029 · RL → Part 15 · Missing rate limits (PRD §24.4)
- `POST /v1/events`: anonymous and now capped in shape but not in volume. Anyone can still fill `events` within the caps.
- `GET /v1/search`: a zero-result search now **writes** an event, so an anonymous flood of nonsense queries is also a write flood.
- `PUT /v1/me/content-settings`, `PATCH /v1/me/profile`, `PUT/DELETE /v1/me/avatar` (with A-PV-007 for uploads), `GET /v1/avatars/…` (anonymous), `GET /v1/users/:id/stats`, `GET /v1/users/:id/reads`.

### A-10-030 · P2 · DEFERRED · Diary gaps from Part 08
- No single-read delete in the Diary, so §34.2's confirmation naming what a finished read loses (review, progress history) has no screen to live on. A per-work attempts list is not served. §17.4 "offer repair" (a batch screen to fill missing dates and page counts) is not built either.

### A-10-031 · P3 · FIXED (docs) · tasks.md claims corrected
- SL-73: the picker sends `favouriteWorkIds`, not `favourites: [{work_id, position}]`, and reorders with Up/Down, not drag. SL-74: the histogram was "1★ to 5★"; it is ten half stars now. SL-81: "`+` FAB or Update sheet" (only `+` is §4.4's). SL-82: the mobile wrapper did not sanitise. All struck through with corrections in `docs/tasks.md`.

## Performance

`flyleaf_dev`, Part 01 bench runner, 10 connections × 10 s, sequential pass for query counts (`BENCH_COUNT_QUERIES=1`). Before = HEAD (working tree stashed), after = this part, back to back. Files: `docs/audit/perf/audit10-before.*`, `audit10-after.*`. **Indicative only (8 GB dev machine).**

| Endpoint | Before p50/p95/p99 · q | After p50/p95/p99 · q | Plan notes |
|---|---|---|---|
| `GET /me/stats` (heavy, 628 reads) | 25 / 31 / 40 ms · 4 | 28 / 34 / 42 ms · 4 | 3 queries in parallel + relationship. Main query 410 rows; per-row cover/author subplans; `flyleaf_page_count` ~0.1 ms/read warm |
| `GET /users/:id/stats` | 24 / 30 / 36 · 4 | 27 / 34 / 42 · 4 | same |
| `GET /users/:id/reads` (typical) | 19 / 26 / 33 · 2 | 26 / 34 / 45 · 2 | page cut in SQL: bitmap scan `reads_user_visibility_idx` 535 rows → top-N 51 → lookups for 51 (907 buffers, heavy user) |
| Suggestion probe (`flyleaf`, full catalog) | — | `tolkein` 25 ms cold, 56 buffers; worst case `the` 214 ms cold, 764 buffers | only on zero-result searches; bounded by the 112k-term table, not the catalog |

## Behaviour changes

- `GET /users/:id/reads` returns `{data, next_cursor}`, 50 per page (was every read). `api-client` `getUserReads(userId, {status, cursor, limit})` returns a page.
- Stats: `rating_distribution` keys `"0.5"`…`"5.0"`; `format_breakdown.unknown`; new `distinct_works_count`, `excluded`; `tz` parameter; `422 invalid_year` / `invalid_timezone` (a bad year used to become this year); undated finishes count in "all"; pages use the D-08-3 rule; audio hours count listening, not summed positions; another viewer's audio and streak exclude reads they may not see.
- `GET /works/:id` adds `page_count`. The reads list's `page_count` uses the D-08-3 rule (was the smallest edition).
- `GET /search` adds `suggestion` (`null` with results). Existing `search-route` assertions updated to `{ data: [], suggestion: null }`.
- `GET /me` adds `showExplicit`, `explicitSettingAvailable`. New `PUT /me/content-settings`.
- Under-13 refusal text at signup and confirmation: "Sorry, you can't use Flyleaf." (was "You must be at least 13 years old to use Flyleaf."); later confirmation attempts after an under-13 one are refused. Mobile test assertion updated accordingly.
- Uploads: purpose `avatar`; `uploads.test` used `avatar` as its "unknown purpose" example and now uses `banner`. New `PUT/DELETE /me/avatar`, `GET /avatars/uploads/:userId/:uploadId`; profiles add `avatarUrl`; feed/interaction `avatar_url` now `/v1/avatars/…` (was a dead `/avatars/…`).
- `POST /v1/events` returns `{accepted, rejected}` and drops events outside the caps; the body's user id is ignored.
- `GET /admin/telemetry/budgets`: `?days=` (default 28), `window_days`, `passing`/`abandonment_rate` may be `null`.
- Error reports redact email addresses and nested/snake-case secrets (`telemetry.test` assertion updated: email was expected to pass through).
- `PATCH /me/profile`: trims; whitespace-only → null; bio/display name limits in characters.
- App: other users' Wall shows their books; stats screen ten buckets, unknown format, DNF %, disclosure line; Diary "Undated" group, page totals from page counts; Content settings row (adults only); avatar picker; "Did you mean"; budget events only when measured, `book_logged` not sent; `+` FAB starts the log-sheet clock.

## Decisions (taken by the owner, 2026-10-06)

- **D-10-1 · Event retention (corrected; §23.5 wins):** raw events 13 months; zero-result queries deleted after a flat 30 days, independent of the summary, which only reads inside that window. See A-10-025. Implementation → Part 15.
- **D-10-3 · Zero-result summary:** query text only with ≥ 5 distinct searchers that week, counted by a per-week salted hash of the account id or guest session id; the salt rotates weekly and is deleted once the week's summary is written. See A-10-025. Implementation → Part 15.
- **D-10-2 · Shelve-a-book impression (A-10-003):** the clock starts at the **first render of a screen that offers the shelve action for that work** (a search result or the book page), and stops at **local success** (the optimistic local write), not the server's acknowledgement. **Refined (owner, 2026-10-06):** the impression **carries over from a search row to the book page it opens for the same work** (that tap counts); it ends on navigation elsewhere or after **10 minutes**. Not implemented in this part: `book_logged` stays unsent until it is (Deferred → Part 15's telemetry work).
- **Native rebuild:** `expo-image-picker` and `expo-image-manipulator` are batched with the other native changes after Part 14, and listed in the README's "Native changes waiting for a rebuild".

## Decisions still needed

- None from this part. One implementation choice is left to Part 15: how a guest's session id reaches `/v1/search` for the D-10-3 key (A-10-025, item 2).

## Deferred (with reason and owner)

| Item | Owner | Reason |
|---|---|---|
| `book_logged` tap counter per D-10-2 (A-10-003): starts at the first render of a search row or book page offering the shelve action for a work, carries from the row to that work's page, ends on navigating elsewhere or after 10 min, stops at local success | Part 15 (telemetry) | routed in the Part 15 brief |
| §8.7 two-day streak grace | ST-06 | spec'd for Phase 5 |
| Stats cache per visibility tier (A-10-024) | Phase 5 stats | not needed at measured cost |
| Server-side Wall/Diary filters (A-10-026) | Part 14 | schema + client + UI |
| Diary delete confirmation, attempts list, §17.4 repair screen (A-10-030) | Part 14 | UI work |
| `avatarUrl` on follower lists and shelf owners | Part 13 | list endpoints return keys only |
| Orphaned avatar objects when a delete fails; deleted accounts' avatars | Part 15 | retention sweep (A-PV-008) |
| Rate limits (A-10-029) | Part 15 | one limiter layer |
| Events retention per D-10-1 (corrected) and D-10-3: 13-month raw prune, flat 30-day zero-result delete, weekly summary with k ≥ 5 and a weekly salted searcher hash whose salt is deleted after the summary (A-10-025) | Part 15 (retention) | routed in the Part 15 brief |

## Phone checklist (needs a dev-client rebuild: new native modules)

1. Profile → tap avatar → library, camera, remove; image appears, survives restart; a private account's own avatar loads.
2. Another user's Wall shows their books, not yours; paging with > 100 finished books.
3. Stats: ten bars; "Unknown" format box only when present; disclosure line with an undated import; DNF %; streak around local midnight.
4. Diary: an undated import under "Undated" at the end.
5. Discover: `tolkein` → "Did you mean J.R.R. Tolkien?" → tap re-searches.
6. Profile → Content (adult account only): turn on with the right/wrong date of birth; absent for a 15-year-old account.
7. Signup with an under-13 date, then an adult date on the same device: both refused with the same words.
