# Audit Part 10 — Diary, Wall, Profile, Stats, Instrumentation (SL-70 … SL-74, SL-80 … SL-82)

**Read `docs/audit/00-method.md` first.**

Spec: PRD §6.20 (Diary), §6.37/§6.37a (Profile, Wall), §6.38–6.40, §16 (profiles; §16.3 privacy), §17 (statistics; **§17.4 handling incomplete data honestly**, **§17.5 private reads and statistics [LOCKED]**), §8.7 streaks, §4.4 budgets, §28 analytics (§28.2 event taxonomy), §33.4 observability, §26.5 data minimisation. Architecture §3.7 (events).

Code: `apps/api/src/reading/index.ts` (`getStats`), `identity/index.ts` (profile GET/PATCH, favourites), `telemetry/{index,sentry}.ts`, migration `0012_events.sql`; mobile `app/diary.tsx`, `src/ui/DiaryView.tsx`, `app/wall*.tsx`, `app/(tabs)/profile.tsx`, `app/user/[id].tsx`, `app/profile/favourites.tsx`, `app/stats*.tsx`, `src/lib/{events,budgetTracker,sentry}.ts`, `src/ui/ErrorBoundary.tsx`. Tests: `profile-stats.test.ts`, `telemetry.test.ts`, mobile `profile-stats` and `telemetry-budgets`.

## Routed here from Part 02 (A-02-024): search spelling suggestion and `search_zero_results`

AC-7 and PRD §14.7 step 1 ask for a spelling suggestion on a search with no results, plus a `search_zero_results` log. Neither exists. Part 02b's findings (A-02-024) explain why it isn't cheap and propose an approach: log zero results first, then suggest from credited-author names and popular titles only.
- **Required test case: `tolkein` must suggest "Tolkien".** Today it returns nothing: its word similarity to "Tolkien" is 0.50, under the author-typo arm's 0.6, and lowering that threshold flooded results (measured in Part 02b). Add it as a test that fails before the suggestion exists.
- The relevance panel (FN-43) must stay ≥ 0.98 and search must not gain a second loose trigram pass on the request path (A-02-023 removed exactly that cost).

## SL-74 — stats (the highest-risk task in this part)

- **§17.5 [LOCKED]**: the owner's stats include their private reads; **anyone else's view must not**, including counts, totals, extremes ("longest book") and the most-read author. A private read leaking through `GET /v1/users/:id/stats` is **P0**. Build fixtures with private and followers-only reads and check every stat field for owner, follower, stranger and guest. (ST-01 in Phase 5 formalises this, but the endpoint is live now.)
- Imported reads (`source = 'import'`): do they count in stats? Check the spec. Reads without dates: excluded from temporal stats but counted in totals, and **disclosed** per §17.4 ("never fabricate"). Does the response tell the client how much data was excluded?
- **Re-reads**: pages read counted per attempt? Books finished per attempt or per work? Match the spec.
- **Streaks (§8.7)**: timezone. The day boundary must be the user's local day, not UTC. A user in IST finishing at 00:30 local breaks or continues their streak correctly. Check the 2-day grace (ST-06 is later, so note the gap if the current code claims a streak without it).
- Audio hours use audiobook duration or `audio_seconds`; the format split uses `format_override`, falling back to the edition's format.
- **Cost**: stats are computed with aggregation queries on every request. Measure `GET /v1/me/stats` for a heavy reader with the bench, and `EXPLAIN` each query. If it's over budget, record a caching or precompute plan (Phase 5 will extend stats, so propose the structure).

## SL-72 / SL-73 — profile and favourites

- `PATCH /v1/me/profile`: display name and bio limits (bio 160), unicode, trimming, HTML in bio (rendered anywhere as HTML? The OG pages of Part 11/SO-50 will). Only allowed fields are writable: can a client set `follower_count`, `is_private` via the wrong path, or `username` without availability checks?
- **Favourites**: at most 4, unique works, positions 1–4 with no duplicates, works that exist and aren't merged, and atomic replacement. What happens to a favourite whose work is later merged (Part 03's table list)?
- Public profile (`GET /v1/users/:id`): the private-account view shows only what §16.3 allows. Counts: follower/following from counters. Are they correct after blocks and the privacy auto-accept (Part 13 checks the counters themselves)?

## SL-70 / SL-71 — Diary and Wall (mobile)

- Data source: does the Diary fetch **all** reads and filter client-side? A 2,000-book library through the bench persona: measure payload size and time. Year, format, rating and heart filters and the calendar with no dates. The 340 dp column switch on the Wall.
- Another user's Diary/Wall (`/wall/[id]`) goes through `GET /v1/users/:id/reads`, so it gets the same privacy guarantees. Verify with the Part 05 matrix.

## SL-80 / SL-81 — events and budgets

- **`POST /v1/events` is unauthenticated with no rate limit** (confirmed: "Unauthenticated/anonymous telemetry allowed"). Check the batch size cap, per-event `properties` size cap, allowed event names (a whitelist from §28.2 vs arbitrary strings), and timestamp sanity (far future/past). Anyone can currently fill the `events` table. Record `RL` for the rate limit (Part 15); **fix the size and shape caps now**.
- `user_id` comes from the verified token, never from the body (check for spoofing). Properties must not carry PII (§26.5): grep the mobile emitters for email, names and free text.
- Retention: is there a pruning job for `events`? If not, record it.
- The budget admin endpoint (`GET /v1/admin/telemetry/budgets`): `percentile_cont` over which window? Indexed? Does it measure what §4.4 defines: `progress_updated` from Reading-tab focus to save, tap counts, finish duration, abandonment? Check the mobile instrumentation starts and stops the clocks where the spec says. A budget measured from the wrong start point is a false green (P1).

## SL-82 — Sentry

- Redaction covers nested body fields (`password`, `token`, `refresh_token`, `totp`, `code`), query strings with tokens (export download `?token=`), and headers. Test with a crafted error.
- The mobile `ErrorBoundary` reports and recovers. Release/version tags exist. No PII in breadcrumbs.

## Deliverables

`docs/audit/findings/10-profile-stats-telemetry.md`, the stats privacy test matrix, fixes, and audit lines under SL-70…74 and SL-80…82.
