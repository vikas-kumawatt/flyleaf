# Flyleaf

A reading tracker. Log what you read, rate it in half-stars, see it on a profile.

**Stack:** TypeScript · Node 22 · Fastify 5 · Drizzle · Postgres 18 · pg-boss · Expo SDK 57 · React Native 0.86 · expo-sqlite. Full locked stack in [`docs/architecture.md`](docs/architecture.md) §0.

**Where it is:** Phases 0–3 (Foundation, Solo loop, Shelves & lists, Import & export) and Phase 4's social graph, feed, likes and comments (`SO-01`…`SO-06`, `SO-10`…`SO-15`, `SO-20`…`SO-23`) are built.

A 15-part audit (25 Sep – 10 Oct 2026) re-verified every task from `FN-40` to `SO-15`. Several "complete" claims did not hold. Each one is now fixed, or recorded as deferred with an owner. Start with [`docs/audit/SUMMARY.md`](docs/audit/SUMMARY.md). Questions waiting on the owner are in [`docs/audit/DECISIONS.md`](docs/audit/DECISIONS.md). Work after the audit is in [`docs/audit/PENDING.md`](docs/audit/PENDING.md).

The audit's last measurements run on the laptop (`docs/audit/15b-laptop.md`). Next after that: notifications (`SO-3x`). Live state is always [`docs/tasks.md`](docs/tasks.md).

## The documents

They live in `docs/`, in this repo, so a decision and the code implementing it land in the same history. They are the project's memory and are worth more than the code — the code is reconstructable from them.

| Document | What it is |
|---|---|
| [`docs/PRD.md`](docs/PRD.md) | Product requirements. The what and the why |
| [`docs/architecture.md`](docs/architecture.md) | The locked stack, schema, and system design |
| [`docs/design.md`](docs/design.md) | Design system — tokens, motion, the interaction vocabulary |
| [`docs/phases.md`](docs/phases.md) | Phase plan and the exit criteria for each |
| [`docs/tasks.md`](docs/tasks.md) | Task breakdown with stable IDs, and the running record of what each one actually cost |
| [`docs/surprises.md`](docs/surprises.md) | What was not true in the plan. Read this one first |

> **Phase 0, Phase 1, Phase 2, and Phase 3 are done.** The foundation (auth, catalog, search, dedupe, admin console, typed API contract, CI), the full native mobile experience (offline-first SQLite, typography and design system, barcode scanner, reading lifecycle, reviews, diary, wall, stats, and telemetry budgets), curated shelves & lists (`SH-01` through `SH-10`), and complete library import & export (`IM-01` through `IM-12`) are complete and verified with 100% round-trip fidelity. Currently building **Phase 4 — Social** (`SO-01` through `SO-06`, `SO-10` through `SO-15`, and `SO-20` through `SO-23` completed).

---

## What works

```
sign up / guest  →  search 3.2M books / barcode scan  →  book detail & edition picker
                 →  mark reading / want to read       →  log progress & velocity
                 →  finish (half-stars, heart, notes) →  reviews & spoiler gating
                 →  profile (diary, wall, reading stats)
```

**Offline-first local mirror:**
- Optimistic writes never block the UI: all reads, progress updates, finishes, and reviews write to local SQLite first.
- Background `mutation_queue`: strict per-entity FIFO, exponential backoff and dead letters shown on a sync-issues screen. Replays are idempotent on the server, so a 409 is a real refusal, never treated as synced (Audit 07). A 429 waits for `Retry-After` (Audit 15).
- Survived process death and database close/reopen across disk restart with zero data loss.

**Guest mode:**
- Search, scanner, and book pages work with no account.
- Local Want to Read shelf (up to 20 books) with zero data loss — migrated automatically upon account creation.
- Contextual signup prompt appears at the action with clear rationale naming what you were trying to do.

**Auth:** JWT + rotating refresh tokens with reuse detection (entire family revoked on replay), email verification, password reset, session list with per-device revoke, and a 10-character minimum with common-password rejection. argon2id, never bcrypt.

**Authorization:** `canView()` enforces public/followers/private/blocked/guest on every read path. Cross-user access returns 404, never 403.

**Admin console:** Isolated from app accounts (separate JWT audience), mandatory RFC 6238 TOTP, role-based (admin/moderator), server-rendered HTML dashboard. Dedupe review, maturity override, ingestion status, and a non-negotiable audit log on every action.

**Telemetry & Budgets:** instrumentation for the PRD §4.4 interaction budgets: finish p75 < 20 s, progress p75 < 5 s, book shelved ≤ 2 taps (counted from the impression, D-10-2), log sheet p75 < 15 s, abandonment < 8 %. An event is a measurement or nothing; no default durations are sent (Audit 10). Events reach `POST /v1/events`; before Audit 15 they were sent to a path that did not exist. Error reporting goes through a port, with Sentry as one adapter and scrubbing before any adapter (PV-06).

**Shelves & Lists (SH-01 through SH-10):** `shelves`, `shelf_items`, and `shelf_saves` tables with check constraints, denormalized counters (`item_count`, `save_count`, 4-cover mosaic), nightly reconciliation worker job, per-user unique slugs with auto-disambiguation, strict 3-tier privacy (public, followers, private) returning 404 on access denial, 30-day soft delete, mobile create/edit screens with ranked warning, shelf detail screen with ranked numbering (#1..#N), per-entry notes (up to 280 chars), 4-cover mosaic cards, interactive Add-to-Shelf sheet (`GET /v1/shelves/mine`, `DELETE /v1/shelves/:id/items/:workId`, `PATCH /v1/shelves/:id/items/:workId`) integrated into book pages, search cards, and long-press gestures, comprehensive reordering (`PUT /v1/shelves/:id/order`) with pan drag handles, step arrows, and accessible "move to position" numeric dialog (PRD §6.36, §46.2), responsive My Shelves 2-column grid with 4-cover mosaic cards, multi-criteria sorting (recent, alphabetical, book count), grid/list toggle, 1-tap starter suggestions on empty states ("Favourites of 2026", "Comfort reads", "Recommended to me") (PRD §6.33), shelf saving (`POST /v1/shelves/:id/save`, `DELETE /v1/shelves/:id/save`, `GET /v1/shelves/saved`) with reference semantics (stays live and dynamically in sync as curator adds or reorders books), forbidden own-shelf saving, mobile "Save Shelf" / "Saved to Library" button with optimistic rollback, dedicated Saved tab in the Shelves screen with curator attribution and 2-column mosaic rendering (PRD §6.34, §15.6), public shelf browsing (`GET /v1/shelves/browse`) ranked by PRD §15.5's composite (`0.30·log(1+saves) + 0.20·log(1+views) + 0.20·social_proximity + 0.15·curation_quality + 0.15·freshness`; **views is always 0**: there is no view counter, `docs/audit/DECISIONS.md` 3), guest access, ILIKE search, mobile Curated / Discover Lists integration with 2-column mosaic cards and Featured/Popular/Recent sort pills, and comprehensive shelf privacy (`SH-09`) enforcing strict 3-tier privacy (`public`, `followers`, `private`), private account hierarchy (`profiles.isPrivate = true` masks all shelves with 404 and excludes from browse), 404 obscure masking (never 403), user shelves endpoint `GET /v1/shelves/mine`, and dynamic saved shelves filtering upon privacy change.

**Import & Export (IM-01 through IM-12):**
- Schema & migrations for `imports` and `import_rows` (`0014_imports.sql`) with check constraints across 6 sources (`goodreads`, `storygraph`, `librarything`, `calibre`, `openlibrary`, `openreads`) and states (`queued`, `processing`, `completed`, `failed`), non-negative counter checks, cascade deletions, and index on `(user_id, content_hash)` for duplicate import detection (IM-11).
- Uploads go straight to object storage through a presigned URL (`POST /v1/uploads` → PUT → `POST /v1/uploads/:id/complete`, up to 10 MB, PRD §6.8). `POST /v1/imports {upload_id, source}` then enqueues `imports.process` and returns the queued import (PV-02; the multipart route and `DiskFileStorage` are gone).
- Status inspection `GET /v1/imports/:id` with strict 404 cross-user privacy barrier, and import history listing `GET /v1/imports`.
- Fully typed `@flyleaf/api-client` methods (`uploadImport`, `getImport`, `listImports`, `getImportRows`, `resolveImportRow`, `skipImportRow`) supporting standard web `Blob`, `File`, and `Uint8Array`.
- Declarative column mapping engine (`IM-03`) with zero source coupling: pure RFC 4180 CSV parser handling multiline quotes and BOM, reusable field transformers (Goodreads ISBN `=".."` cleansing, half-star rating normalisation with `0` → `null`, status mapping, flexible date parser with local calendar preservation, shelf parsing, format mapping), signature-based header auto-detection (`detectSourceFromHeaders`), and full Goodreads reference configuration.
- Six source maps (`IM-04`): Full declarative configs for Goodreads, StoryGraph (quarter-star rounding to nearest half, format mapping, dates read ranges), LibraryThing (`Last, First` author inversion, bracketed ISBNs, collections-to-status mapping), Calibre (`&` author splitting, identifiers `isbn:...`, tag-based statuses), OpenLibrary (OL work keys, reading log status mapping), and OpenReads (native tracker statuses, half-stars, format mapping). All preserve raw rows in `import_rows.raw` and map 0 ratings to NULL per PRD AC-9.
- Multi-stage catalog matching engine (`IM-05`): Waterfall pipeline resolving imported rows against catalog works and editions: Stage 1 exact ISBN-10/13 match (confidence 1.0), Stage 2 Open Library work/edition key match (confidence 0.98), Stage 3 exact title + author match with subtitle normalization (confidence 0.92), and Stage 4 trigram fuzzy title + author match. Non-negotiable ambiguity rule (PRD §34.4, §5141, AC-9): multiple matching works or runner-up score margin < 0.15 are never guessed—flagged `state = 'unmatched'`, `work_id = null`, `failure_reason = 'ambiguous_match'` and routed to user review list. Preserves original row dictionary in `import_rows.raw` and updates parent `imports` counters.
- Rating normalisation (`IM-06`): Normalizes unrated books from Goodreads (`My Rating = 0`), empty ratings, and invalid values strictly to `rating = NULL` in `reads` (`normalizeRatingForPersistence`). Prevents violation of Postgres check constraint `reads_rating_ck`, preserving unrated reading entries with 100% fidelity without dropping books from readers' libraries. Validates 0.5–5.0 half-step bounds and rounds StoryGraph quarter-stars.
- Import provenance & activity feed exclusion (`IM-07`): Enforces `source = 'import'` on all created reads (`reads_source_ck`), and strictly excludes imported reads from social activity feeds (`feedExcludesImportsSql()`) and follower streams so importing a 1,000-book library never floods timelines (PRD §34.4, §4410, Architecture §8, §9). Transactional committer (`commitImportRow`, `commitImportBatch`) persists reads, linked reviews, and custom shelves with automatic re-read attempt numbering (`attempt_no`).
- Background processing worker (`IM-08`): Full chunked (`chunkSize = 50`), resumable, and progress-reported background processor (`apps/api/src/imports/processor.ts`, `processImport`) registered with pg-boss (`imports.process`). Handles 5,000+ row library imports without blocking the client (PRD §34.4, §4404), updates `imports` counters after each committed chunk, and safely resumes from `last_committed_row + 1` if interrupted without duplicate writes (PRD §4408).
- Import UI, progress banner & unmatched review queue (`IM-09`): Complete client and mobile experience (`apps/mobile/app/import/index.tsx`, `apps/mobile/src/ui/ImportProgressBanner.tsx`, `apps/mobile/app/import/unmatched.tsx`). Real-time polling of active imports with animated progress bar, 6-source selector, dual CSV upload (direct paste & file picker), profile integration under "DATA & IMPORTS", and unmatched review queue allowing readers to inspect raw unparsed rows, search the catalog (`GET /v1/search`), and manually resolve (`POST /v1/imports/:id/rows/:rowNo/resolve`) or skip (`POST /v1/imports/:id/rows/:rowNo/skip`) with live counter updates.
- Full data export & emailed link (`IM-10`): Schema & migration for `exports` (`0015_exports.sql`) supporting CSV and JSON with secure random download tokens and 48-hour expiration. High-fidelity RFC 4180 CSV export (`Title,Author,ISBN,ISBN13,My Rating,Exclusive Shelf,Date Read,Date Added,Bookshelves,My Review,Format`) and structured JSON format. Endpoints `POST /v1/exports`, `GET /v1/exports`, `GET /v1/exports/:id`, and dual-access `GET /v1/exports/:id/download` (Bearer auth or emailed token without login). Dispatches email notification with 48h valid download link (PRD §1290, §3424). Mobile export screen in `apps/mobile/app/import/index.tsx` with format picker and download history. Verified 100% round-trip library fidelity (Phases §217): exported library re-imported into a clean account restores all reads, ratings, reviews, custom shelves, and statuses with zero data loss.
- Duplicate-import detection by content hash (`IM-11`): Computes SHA-256 `content_hash` from file buffers and checks existing user imports using the `imports_user_hash_idx` index (`(user_id, content_hash)`). Automatically rejects identical files with `409 Conflict` (`duplicate_import`) to prevent accidental duplicate reads and shelves. Allows intentional re-imports via `force=true` query parameter or multipart field. Scoped per user so different users importing sample files never conflict, and failed imports do not block re-uploads. Mobile import screen prompts readers with a confirmation dialog to "Import Anyway" (`force: true`) or cancel upon duplicate detection.
- Real library import & Phase 3 exit criteria verification (`IM-12`): Validated using realistic 25-book Goodreads and 5-book StoryGraph export fixtures. Phase 3 Exit Criterion 1 verified: Goodreads export achieves 92.0% match rate (23/25 matched, satisfying the >=85% threshold), preserving `source = 'import'`, `rating = NULL` for unrated books, multiline reviews, and custom shelves. Phase 3 Exit Criterion 2 verified: unmatched ambiguous and unknown rows are reviewable via `GET /v1/imports/:id/rows?state=unmatched` and resolvable via `POST /v1/imports/:id/rows/:rowNo/resolve` with live counter updates. Phase 3 Exit Criterion 3 verified: complete round-trip export to CSV, re-import into clean account, and verification that all reads, ratings, shelves, reviews, and reading dates remain 100% intact. StoryGraph quarter-star ratings properly normalized to half-stars per `reads_rating_ck` constraint.

**Social Graph, Activity Feed, Follows, Blocking, Muting & Lists (SO-01 through SO-06, SO-10 through SO-15):**
- Asymmetric follow graph (`follows` table with state `pending` vs `accepted`), `blocks`, and `mutes` schema (`0016_social_graph.sql`).
- DB triggers (`follows_counter_trigger_fn`) maintaining atomic `follower_count` and `following_count` on `profiles` upon INSERT/UPDATE/DELETE of accepted follows.
- Follow, pending request, blocking, muting, and follower/following list API routes (`POST /v1/users/:id/follow`, `DELETE /v1/users/:id/follow`, `GET /v1/me/follow-requests`, `POST /v1/users/:id/block`, `DELETE /v1/users/:id/block`, `GET /v1/me/blocks`, `POST /v1/users/:id/mute`, `DELETE /v1/users/:id/mute`, `POST /v1/works/:id/mute`, `DELETE /v1/works/:id/mute`, `GET /v1/me/mutes`, `GET /v1/users/:id/followers`, `GET /v1/users/:id/following`) synchronized with 0 OpenAPI contract drift.
- Complete bidirectional, silent blocking semantics (PRD §11.4, §26.3): blocking immediately severs follows in both directions and returns HTTP 404 Not Found (never 403 Forbidden) on all lookups, making blocked profiles completely indistinguishable from non-existent accounts.
- Silent, low-stakes muting semantics (PRD §11.5): user muting hides activity without unfollowing; book muting removes book activity from feeds.
- Enforced 3-tier profile privacy returning 404 Not Found (never 403) to non-followers/guests viewing private accounts (PRD §25.3, FN-72, SH-09). Auto-accepts pending requests when switching profile privacy from private to public.
- Activity feed table & write-on-action (`SO-10`): Drizzle schema (`activity` table) and migration `0017_activity.sql` with covering index `(actor_id, created_at desc)` (Architecture §3.5, PRD §23.3) and CHECK constraints on verbs (`started`, `finished`, `rated`, `reviewed`, `dnf`, `shelved`, `followed`, `goal_reached`, `quoted`) and visibility (`public`, `followers`, `private`). Centralized `ActivityService` (`apps/api/src/activity/index.ts`) handling write-on-action logging (`recordActivity`), visibility updates (`updateActivityVisibility`), entity deletion cascading (`deleteActivity`), and retroactive privacy updates (`setAccountPrivacy`). Enforces strict import feed exclusion (IM-07, PRD §4410: `source = 'import'` generates no activity), per-item privacy exclusion (PRD §26.2: private reads, reviews, and shelves generate no activity rows), private profile restriction (`isPrivate = true` forces `followers` visibility), and retroactive account privacy toggling. Integrated across `ReadingService`, `ReviewService`, `ShelvesService`, `SocialService`, and `IdentityService`.
- Cursor-paginated Feed Query (`SO-11`): `GET /v1/feed` (the unprefixed `/feed` was removed in Audit 05). `tab=friends` is the default: fan-out on read for accepted follows (PRD §12.7, Architecture §8). `tab=popular` serves public reviews and finishes from the last 14 days, scored by likes and comments, never by rating, with a per-card exposure cap (D-14-1, Audit 15). The cursor is opaque; every card is served exactly once (Audit 14). Strict SQL exclusion filtering: bidirectional block filtering (`blocks` table) and user & book mute filtering (`mutes` table).
- Feed Ranking & Diversity engine (`SO-12`): TypeScript re-ranking engine (`apps/api/src/activity/ranking.ts`) implementing composite scoring (`rank = activity_weight * recency_decay * affinity * diversity_penalty`), 36-hour exponential decay (`exp(-age_hours / 36)`), activity verb weighting (`reviewed`: 1.0, `finished`: 0.9, `rated`: 0.8, `dnf`: 0.5, `shelved`: 0.3, `started`: 0.2), and 4 hard diversity rules: max 2 consecutive cards from same actor (AC-11), max 3 cards about same book per 20-item window (AC-11), max 1 "started" card per 10-item block, min 1 low-affinity card per 10-item block.
- Feed Activity Aggregation (`SO-13`): Aggregation engine (`aggregateFeedItems` in `apps/api/src/activity/ranking.ts`) collapsing repetitive low-weight activities by the same actor prior to ranking: shelf adds ("user A added 6 books to Monsoon Reading"), follows ("user A followed 4 readers"), and same-day book starts. High-value activities (`reviewed`, `finished`, `dnf`, `goal_reached`, `quoted`) are explicitly excluded from aggregation.
- Feed Cold Start & Blending Engine (`SO-14`): Full cold start engine (`ActivityService.getFriendsFeed`) delivering a "Never Empty Feed" guarantee (PRD §12.5): 0 follows auto-switches to Popular feed with `cold_start_reason: 'no_follows'`, 1–3 follows blends Friends feed with Popular activities (`is_blended_popular: true`, `label: 'Popular on Flyleaf'`, `cold_start_reason: 'sparse_follows'`), >3 follows with zero recent friend activity backfills with Popular activities (`label: 'While you wait'`, `cold_start_reason: 'no_activity'`), and an empty database gets an editorial welcome card on page one only (`is_editorial: true`; Audit 14).
- Mobile Feed Cards & Swipe Actions (`SO-15`): Interactive `FeedCard` component (`apps/mobile/src/ui/FeedCard.tsx`) rendering distinct card types (`review`, `finish`, `rated`, `dnf`, `shelved`, `followed`, `started`, `goal_reached`, `quoted`, `editorial`) with aggregated collections, spoiler blur overlays, and cold-start badge banners. Integrated `Swipeable` gesture actions (PRD §4673–4674): **Swipe Right** reveals green **"Want to read"** action with bookmark icon and toast feedback; **Swipe Left** reveals blue **"Rate & Review"** action with star icon. Accessible fallback action buttons provided for non-gesture callers and VoiceOver/TalkBack screen readers (PRD §4682).

**Likes, Comments & Review Ranking (SO-20 through SO-23):**
- **Likes and comments target the read, not the review** (PRD §10.3, LOCKED) — so a finish with no review is fully likeable and commentable. Only terminal reads (`finished`, `dnf`) are social objects; anything else is `409 not_likeable` / `not_commentable`.
- Migration `0018_read_interactions.sql`: `read_comments` (no `parent_id` — single-level by construction), and `reads.like_count` / `reads.comment_count` maintained by **triggers** instead of application code (incremental, so concurrent likes never lose a count; `comment_count` tracks live comments across soft delete and restore). `reconcile_read_counters()` runs nightly as `reads.reconcile` and reports how many rows it corrected.
- `POST /v1/reads/:id/like` is an **idempotent like** and `DELETE` an idempotent unlike — the SL-64 toggle was unsafe under offline replay. `GET /v1/reads/:id/likes` lists likers, hiding anyone in a block relationship with the viewer.
- `GET`/`POST /v1/reads/:id/comments` (oldest first, cursor-paginated) and `DELETE /v1/comments/:id` (own comments only). **5 comments per minute** per user through the Postgres-backed `RateLimiter`. A deleted review turns its thread read-only (`409 thread_locked`, `locked: true`).
- Every denial — private read, followers-only, private account, blocked either way — is the **same 404 as a read that does not exist**.
- Feed items carry `interaction: { read_id, like_count, comment_count, viewer_has_liked }` on finished, DNF and review cards, and `null` on cards that are not social objects.
- **Review ranking (PRD §10.7):** social proximity 1.0 / 0.6 follower-of-follower / 0.2, log-scaled likes and comments, 45-day recency, author credibility from the reviewer's median likes, length quality. People you follow always rank first — the PRD weights alone cannot guarantee that (measured), so friends-first is a tier. New, unproven reviews from outside your follows get **one exploration slot** directly below your friends for a deterministic ~20% of viewers.
- Mobile: comment thread screen (`app/read/[id]/comments.tsx`), comment button on Review Detail, and `FeedCard` likes that send the wanted state (POST or DELETE) and target the read.
- Mobile screens: `UserProfileScreen` (`apps/mobile/app/user/[id].tsx`) with haptic follow toggle, mutual follow indicator ("Follows you"), Block action, Mute action, pressable follower/following counts, and restricted private view; `WorkScreen` (`apps/mobile/app/work/[id].tsx`) with "Mute book" action; `FollowRequestsScreen` (`apps/mobile/app/profile/requests.tsx`) for managing incoming follow requests; `BlockedUsersScreen` (`apps/mobile/app/profile/blocked.tsx`) for viewing and unblocking accounts; `MutedItemsScreen` (`apps/mobile/app/profile/muted.tsx`) with segmented tabs for Users and Books with 1-tap unmute actions; `FollowersScreen` (`apps/mobile/app/user/[id]/followers.tsx`) and `FollowingScreen` (`apps/mobile/app/user/[id]/following.tsx`) with 1-tap follow toggles and user profile links.

Behind it: the full Open Library catalog, ISBN lookup, dedupe pipeline, a background worker, and CI that runs everything below on every push.

---

## Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Docker Desktop | any current | For Postgres + MinIO |
| Node | **22 LTS+** | `winget install OpenJS.NodeJS.LTS` |
| An **Android phone** | Android 10+ | A real device. Not an emulator — that is the point of SK-07 |
| A **development build** | — | **Expo Go cannot run this project** (it supports one SDK version only). See §4 |

---

## Run it

### 1. Database

```powershell
cd D:\Bookmarked\flyleaf
docker compose up -d
```

Postgres 18. **Nothing is applied automatically any more** — see the next step.

> If you ran the Phase −1 stack, the old volume holds a Postgres 16 data directory and the skeleton schema. Start clean once: `docker compose down -v` then `docker compose up -d`.

Check it actually came up before moving on — a container can report `Started` and then exit:

```powershell
docker compose ps
docker compose logs postgres --tail 30
```

You want `database system is ready to accept connections`.

> **Postgres 18 moved its data directory.** `PGDATA` is now version-specific (`/var/lib/postgresql/18/docker`) and the image's volume is `/var/lib/postgresql`, one level up from the `≤17` convention. The compose file mounts the new path. Mounting the old `/var/lib/postgresql/data` on 18 is worse than an error: the server writes inside the container layer instead, **with no warning**, so data survives restarts and disappears on `docker compose down`.

### 2. Migrate, then seed

```powershell
cd apps\api
npm install
npm run migrate
npm run seed -- ..\..\db\skeleton\books.csv
```

Expect `migrations applied`, then `seed complete — inserted=102 skipped=0`.

`migrate` creates the extensions and the `flyleaf_unaccent` function first, then runs the drizzle journal in `apps/api/drizzle/` (14 migrations: `0000_phase0_catalog` through `0013_shelves`). Both steps are idempotent, so re-running is safe.

**Changing the schema:** edit `src/db/schema.ts` — it is the source of truth — then `npm run db:generate` and `npm run migrate`. Never hand-write SQL against the database. The Phase −1 arrangement (a `.sql` file mounted into the container's init directory) is gone: it only ran on a brand-new volume, so every schema change cost you all your local data.

### 2b. A real catalog — Open Library ingest

The CSV above is 102 books, enough to develop against. This replaces it with the actual Open Library.

```powershell
npm run ingest:fetch -- authors works reading-log ratings
```

~3.5 GB into `data/` (gitignored). **Resumable** — Ctrl+C and re-run the same command; it continues with a Range request. It also checks the gzip magic bytes, because a saved HTML error page is still a file and otherwise fails three commands later in the middle of `gunzip`.

| File | Size | Why |
|---|---|---|
| `ol_dump_authors_latest.txt.gz` | 0.5 GB | Must be ingested first — works link to authors by key |
| `ol_dump_works_latest.txt.gz` | 2.9 GB | Titles, covers, subjects |
| `ol_dump_reading-log_latest.txt.gz` | 65 MB | Popularity slice |
| `ol_dump_ratings_latest.txt.gz` | 9 MB | Popularity slice — **701,043 distinct works on its own** |

Over a slow connection, [the torrents](https://archive.org/details/ol_exports?sort=-publicdate) are faster.

```powershell
npm run ingest -- --type authors --file ..\..\data\ol_dump_authors_latest.txt.gz
npm run ingest -- --type works   --file ..\..\data\ol_dump_works_latest.txt.gz --seed ..\..\data\ol_dump_reading-log_latest.txt.gz ..\..\data\ol_dump_ratings_latest.txt.gz
npm run ingest -- --finalise
```

**Order no longer matters.** An authorship link whose author has not been ingested yet is parked in `pending_work_authors`, and `--finalise` resolves whatever has since arrived. Authors-first is still marginally more efficient, but nothing is lost by not doing it — so you can load the books you want to look at without first waiting out 15.4 million author records. (Before that table existed, a work ingested ahead of its author silently lost its authorship.)

**`--seed` is the point.** It keeps only works that somebody has shelved or rated — the accelerator's layer 1 from [`docs/phases.md`](docs/phases.md). That turns a multi-day ingest into an evening, and the popularity signal costs 65 MB instead of parsing the 9.2 GB editions dump.

### 2c. Popularity, and the author aliases

Ranking is materially worse without both of these; neither is optional if you want search to behave.

```powershell
npm run ingest -- --popularity --seed ..\..\data\ol_dump_reading-log_latest.txt.gz ..\..\data\ol_dump_ratings_latest.txt.gz
npm run ingest -- --type authors --file ..\..\data\ol_dump_authors_latest.txt.gz --only-referenced
npm run ingest -- --finalise
```

**`--popularity`** fills `works.log_count`. Without it the popularity term in the ranking contributes nothing and a 1910 monograph on Giovanni Battista Piranesi outranks the Susanna Clarke novel. ~3.2M works scored.

**`--only-referenced`** re-runs the authors pass over just the ~1.66M authors some work actually credits, rather than all 15.4M — 26 minutes instead of hours. It is what populates `authors.alternate_names`, and that is the only reason searching `murakami` finds *Norwegian Wood*, whose author record is named 村上春樹.

`npm run ingest -- --status` shows where every run got to and what is in the catalog. A run interrupted with Ctrl+C is recorded as `INTERRUPTED` and resumes from its checkpoint when you re-run the identical command — **without** `--restart`, which throws the checkpoint away.

Editions add ISBNs, page counts and formats. They're a separate 9.2 GB pass and the app works without them, so leave it until you want them:

```powershell
npm run ingest -- --type editions --file ..\..\data\ol_dump_editions_latest.txt.gz
npm run ingest -- --finalise
```

Useful flags: `--limit 5000` for a trial run, `--no-raw` to skip raw-payload retention, `--status` for where every run got to, `--restart` to ignore the checkpoint (rarely what you want — it starts from line 1).

**It is resumable.** Ctrl+C is safe — it finishes the current batch, writes a checkpoint and stops. Re-run the identical command to continue. The checkpoint is a line count, not a byte offset, because you cannot seek into the middle of a gzip member; resuming re-decompresses from the start and skips without parsing, which is far cheaper than the work it skips.

### 2c-bis. A small dev database — `flyleaf_dev`

The full catalog is ~30 GB. On an 8 GB machine its hot indexes can't stay in memory, so everything is slow and latency numbers mean little. For day-to-day work, build a popularity slice of it:

```powershell
cd apps\api
npm run devdb:build                      # flyleaf -> flyleaf_dev: top 200,000 works (a few GB at most)
$env:DATABASE_URL = "postgres://flyleaf:flyleaf@localhost:5432/flyleaf_dev"
```

- **Copies:** the top N works by `log_count`, **plus every work, edition, author and series any user row points at** (reads, reviews, shelves, favourites, mutes, activity, imports, merges), found from the database's own foreign keys. Also the catalog around them (editions, authorship, subjects, series, stats, external ids, provenance), and every user-owned table in full, including bench data. Bench tokens keep working because ids are identical.
- **How:** migrations build the schema, then rows are pulled through `postgres_fdw` inside the same Postgres server, so there are no dump files and no re-ingest. The source is only read. Every foreign key is verified afterwards, and any orphan fails the build.
- **Options:** `--works 100000` for a smaller slice. `--replace` rebuilds an existing `flyleaf_dev` (it never overwrites without this). `--with-raw-payloads` includes raw OL payloads, only needed for reprocessing work. `--target <name>_dev` for another name (it must end in `_dev`).
- **Keep the full `flyleaf` database** for work that must be proven at 3.2M rows: search relevance and planner behaviour, and dedupe scans. Switch with `DATABASE_URL`, and remove the variable to go back to the default (full) database.
- Rebuilding discards changes made in `flyleaf_dev`.

### 2d. Dedupe

After ingesting, run the duplicate detection pipeline:

```powershell
npm run dedupe -- --dry-run --sample 25   # what a pass would do, with 25 random pairs of each kind
npm run dedupe                            # detect, and queue pairs for review; merges nothing
npm run dedupe -- --auto-merge --cap 50   # also merge up to 50 unambiguous pairs
```

Stages 1 (shared ISBN-13) and 2 (normalised title + shared author) auto-merge only **unambiguous** pairs, and only when merging is switched on (`--auto-merge`, or `DEDUPE_AUTO_MERGE=true` for the worker). Unambiguous means:
- the same normalised title and a shared author, and matching subtitles (stage 2);
- an (author, title) group of exactly two works;
- no sign of two volumes: not in one series at different positions, no volume marker (`vol`, `volume`, `#n`, `book n`, `band`, `tome`, a trailing numeral) in any work or edition title, and page counts within 25% when both are known.

Everything else, and every stage 3 (fuzzy) pair, goes to the review queue, with three limits:
- only when either work has user data or 100+ logs;
- stage 3 takes at most 20% of a pass's free slots;
- never past 500 open items.

The rest are kept in `dedupe_candidates`, against the pass that found them. All merges are reversible for 30 days. A monthly `catalog.dedupe` pg-boss cron job runs a pass. Its **200-merge cap is for new duplicates only**.

#### Clearing the existing backlog

The first pass over the full catalog finds far more duplicates than 200 a month can clear, so the backlog is merged by hand, in batches:

```powershell
npm run dedupe -- --backlog --dry-run          # what the next batch would merge, and a sample
npm run dedupe -- --backlog                    # merge one batch (default --limit 5000)
npm run dedupe -- --backlog --limit 1000       # a smaller batch
```

A batch detects stages 1–2 with the same rules as the monthly pass, walking authors 2,000 at a time and stopping once it has `--limit` auto-mergeable pairs (it never holds the whole catalog in one query: the first version was OOM-killed on the full database), and merges them. It queues nothing and runs no stage 3. Each batch writes `apps/api/dedupe-batches/backlog-<time>.md` with **25 random merged pairs** (titles, authors, work ids, merge ids).

1. Run a batch.
2. Read all 25 sampled pairs.
3. **If 2 or more of the 25 are different books, stop.** Don't run another batch until the rules are tightened (`detectStage12` in `src/catalog/dedupe.ts`).
4. Otherwise run the next batch.

Every merge can be undone for 30 days, one at a time, from `/admin/merges` (or with `undoMerge` and the merge id from the sample file). A pair whose merge was undone is never auto-merged again.

### 3. API

```powershell
npm run dev
```

Check it: <http://localhost:3000/healthz> and <http://localhost:3000/readyz>.

```powershell
curl "http://localhost:3000/v1/search?q=piranesi"
```

> **`password authentication failed for user "flyleaf"`?** Another container probably owns host port 5432 — run `docker ps --format "table {{.Names}}\t{{.Ports}}"`. If `flyleaf-pg` shows only `5432/tcp` (not `0.0.0.0:5432->5432`), stop the other container and `docker compose up -d --force-recreate postgres`. Your data lives in the volume and survives the recreate.

#### Prove the whole backend path — `scripts\smoke.ps1`

With the API running, in a second terminal:

```powershell
cd D:\Bookmarked\flyleaf
.\scripts\smoke.ps1
```

36 assertions covering the full loop *and* the decisions that are supposed to be locked:

- guest search and book pages work with **no token**; `/v1/reads` returns 401
- register rejects a short password and a bad username; a duplicate email is **409 with `field: email`**; wrong password is 401
- **posting the same `client_event_id` three times leaves progress unchanged** — the offline idempotency guarantee
- a *new* event id does advance progress
- finishing works with **no rating**; a quarter-star (4.25) is rejected; 4.5 is accepted
- the heart is independent of the rating
- re-reading creates **attempt_no 2** as a new row, not an overwrite
- another user gets **404, not 403**, on your read — and sees none of your data

Run this before every phase closes. It is the cheapest regression check in the project.

> Written with `Invoke-WebRequest`, deliberately. Shelling out to `curl.exe` from PowerShell mangles the quotes inside a JSON `-d` payload — every GET keeps working and every POST silently fails, which looks exactly like a broken API.

### 3b. The worker

Background jobs run in a second process from the **same codebase** — one artifact deployed twice, so a job's code can never be a different version from the API that enqueued it.

```powershell
cd apps\api
npm run worker
```

To prove the queue end to end, from anywhere in the repo:

```powershell
make ping          # or: cd apps\api ; npm run ping
```

The worker logs `job handled` with the job id within a couple of seconds. pg-boss owns its own `pgboss` schema and migrates it itself — a deliberate exception to "drizzle is the source of truth", because those tables are library internals and hand-managing them makes every pg-boss upgrade a migration you have to get right.

The `catalog.dedupe` cron job runs monthly (`0 0 1 * *`), for new duplicates only (see §2d for the backlog).

Counter reconciliation runs nightly (UTC), each job walking its table in key ranges and correcting drift in trigger-maintained counters:
- `shelves.reconcile` 03:00;
- `follows.reconcile` 03:15;
- `reads.reconcile` 03:30;
- `works.reconcile` 03:40 (catalog mean rating, `work_stats`, `works.reader_count`).

Other nightly jobs:
- `storage.cleanup` 03:45 deletes uploads that were never used and export files past their 48 h link;
- `activity.prune` 03:55 drops feed activity older than 180 days;
- `authors.repair` 04:05 fixes `authors.has_works` after an ingest;
- `retention.sweep` 04:20 applies the retention rules (Verification status).

Every job process connects with its own `work_mem` and `statement_timeout` (Audit 15, `JOB_DB_SETTINGS` in `platform/index.ts`), so one job cannot take the database down. To trigger dedupe manually:

```powershell
npm run worker -- --dedupe
```

### 3c. CI — run it before you push

```powershell
node scripts/ci.mjs      # or: make ci
```

Typecheck, 372 tests, build, `npm audit`, the mobile typecheck, spec check (0 OpenAPI drift), and migrations against the real Postgres — about 160 seconds. **This is the same script GitHub Actions runs**; `.github/workflows/ci.yml` builds the environment and calls it rather than restating the steps, so the two cannot drift. The migration step is skipped locally when no database is up and is mandatory in CI (`--strict`).

On a machine short of memory (the 8 GB dev box), cap the API test workers; each one holds its own PGlite databases:

```powershell
$env:FLYLEAF_TEST_WORKERS = 2; node scripts/ci.mjs     # bash: FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs
```

It passes `--maxWorkers=<n>` to vitest; unset, vitest picks one worker per core. For a single run: `npx vitest run --maxWorkers=2` in `apps/api`.

### 3d. Swapping a provider

Every third-party service sits behind a port in `apps/api/src/providers/`, and one factory (`providers/index.ts`, `createProviders()`) picks the adapters from the environment. The API and the worker both call it, so they always agree on where files and mail go. **Swapping a vendor = one adapter file + one env line.** No vendor SDK may be imported outside `src/providers/`; `src/test/providers.test.ts` fails the build if one is.

| Port | Variable | Adapters (default first) | Production needs |
|---|---|---|---|
| Object storage | `STORAGE_DRIVER` | `disk` (dev), `memory` (tests), `s3` | `s3` + `S3_BUCKET`, `S3_REGION`, `S3_ACCESS_KEY_ID`, `S3_SECRET_ACCESS_KEY`; `S3_ENDPOINT` for R2/B2/MinIO; `S3_FORCE_PATH_STYLE=true` for MinIO |
| Email | `EMAIL_DRIVER` | `console` (dev), `memory`, `smtp` | `smtp` + `SMTP_URL` (e.g. `smtps://user:pass@smtp.postmarkapp.com:465`), `EMAIL_FROM` |
| Push | `PUSH_DRIVER` | `memory` (dev), `expo` | `expo`; `EXPO_ACCESS_TOKEN` only if the Expo project enforces it |
| Error reporting | `ERROR_DRIVER` | `noop`, `memory`, `sentry` | nothing (`noop` is allowed); `sentry` + `SENTRY_DSN` (optional `SENTRY_ENVIRONMENT`, `SENTRY_RELEASE`) |
| Catalog source | — | Open Library | nothing: it is the only source we may store (CC0) |

With `NODE_ENV=production` the API and the worker **refuse to start** when a driver is unset (except errors), is a development adapter (`disk`, `memory`, `console`), or is missing a credential. The message names the variable. The check runs before the database connection, so the failure is immediate.

**Uploads never pass through the API.** The client asks for an upload (`POST /v1/uploads`), sends the file straight to storage with the signed target it gets back, and confirms (`POST /v1/uploads/:id/complete`). The API then checks what arrived (size, type, content) and hands the upload id to a consumer (`POST /v1/imports {upload_id, source}`). Export downloads redirect to a 5-minute storage URL.

Local development:

- The default `disk` adapter keeps files in `apps/api/.uploads` and serves HMAC-signed URLs from the API itself (`/v1/storage/object`), so the whole presigned flow runs with no cloud account. For a phone on your LAN, set `STORAGE_PUBLIC_URL=http://<your-LAN-IP>:3000`; the upload URLs must be reachable from the device.
- To run against the MinIO in `docker-compose.yml` instead: `STORAGE_DRIVER=s3 S3_ENDPOINT=http://localhost:9000 S3_FORCE_PATH_STYLE=true S3_REGION=us-east-1 S3_BUCKET=flyleaf S3_ACCESS_KEY_ID=flyleaf S3_SECRET_ACCESS_KEY=flyleaf123` (create the bucket in the console at <http://localhost:9001> first). The storage contract suite runs against this MinIO automatically when it is up.

Adding an adapter, e.g. a Resend HTTP mailer:

1. Write `providers/email/resend.ts` implementing `EmailSender`. The vendor SDK is imported only there.
2. Add it to `createMailer()` in `providers/index.ts`, with its credentials in the `required(...)` list.
3. Add a harness for it to `src/test/email-contract.test.ts`. It must pass the same cases as the others.
4. Set `EMAIL_DRIVER=resend` in the environment.

### 4. Mobile app — a development build, not Expo Go

> **Expo Go will not run this project, and that is not fixable.** Expo Go supports **exactly one SDK version** at a time — whatever the Play Store build on your device happens to be. If it reports "Supported SDK: 54" and the project is SDK 57, the only ways out are to downgrade the project (no) or stop using Expo Go (yes).
>
> A **development build** is the real answer regardless: it is a normal APK containing *your* native modules at *your* versions, it connects to the same Metro dev server, and Phase 1 needs it anyway for `expo-sqlite`, `expo-camera` and Reanimated worklets.

Pick whichever path suits your machine. Both produce the same thing.

#### Path A — cloud build (nothing to install, ~15 min)

EAS requires a git repository and will offer to create one wherever you happen to be standing — the repo root is already one, so run this from `apps/mobile` inside it and take no offer to `git init`.

```powershell
cd apps\mobile
npm ci
npx eas-cli@latest login          # free Expo account
npx eas-cli@latest build --profile development --platform android
```

**The first run reconfigures and stops.** EAS notices the `development` profile declares a channel, installs `expo-updates`, rewires `app.json`, then says *"Command must be re-run to pick up new updates configuration"* and exits non-zero. That is expected, not a failure — commit the changes and run the same command again:

```powershell
git add -A
git commit -m "EAS: configure expo-updates"
npx eas-cli@latest build --profile development --platform android
```

The second run builds.

**Then it queues.** Free-tier builds wait behind paid ones — anywhere from a few minutes to an hour. `Ctrl+C` is safe: it stops the log tail, not the build. Check progress with:

```powershell
npx eas-cli@latest build:list
```

When it finishes you get a QR code and a URL. Install that APK on your phone once. Good use of the wait: run `scripts\smoke.ps1` above and prove the backend before the phone is involved.

#### Path B — local build (no Android Studio needed)

**You do not need Android Studio.** `expo run:android` needs the SDK *underneath* it, not the IDE — roughly 3–4 GB instead of ~10 GB, and nothing to configure.

```powershell
cd D:\Bookmarked\flyleaf
.\scripts\setup-android.ps1
```

That installs JDK 17, the Android command-line tools, platform 36, build-tools, and NDK 27 (needed because Reanimated compiles C++). It sets `ANDROID_HOME` and `PATH` permanently and is safe to re-run.

Then, in a **new** terminal so the environment variables are live:

```powershell
cd apps\mobile
npx expo run:android
```

Phone connected by USB with Developer options and USB debugging on. Check it's visible with `adb devices`.

##### If the Gradle download times out

```
Downloading https://services.gradle.org/distributions/gradle-9.3.1-bin.zip
java.io.IOException: ... failed: timeout (10000ms)
Caused by: java.net.SocketTimeoutException: Connect timed out
```

This is not a broken setup. React Native's generated `gradle-wrapper.properties` ships `networkTimeout=10000`, and ten seconds is not enough to open a TLS connection to `services.gradle.org` on many connections — before the ~130 MB transfer even starts.

```powershell
cd D:\Bookmarked\flyleaf
.\scripts\fix-gradle.ps1
```

Raises the timeout to 120 s, then downloads the distribution itself, verifies its **SHA-256 against the official checksum**, and drops it into the wrapper cache under the exact hashed name the wrapper looks for. `expo run:android` then finds it already cached and never fetches Gradle again.

Re-run it after `expo prebuild --clean` — that regenerates `gradle-wrapper.properties` with the 10-second timeout back in place.

First build is 10–20 minutes (35 on a laptop). After that it's 1–2 minutes, and **you only rebuild when a native dependency changes** — JS and TS stream over Metro.

##### If the build succeeds but the install fails

```
CommandError: Failed to get properties for device (RZCW92KY1TN)
adb.exe: device 'RZCW92KY1TN' not found
```

`adb` had the phone when the build started and lost it during the build — a locked screen or USB power management. The APK is fine; only the install step failed. Don't rebuild:

```powershell
adb devices
adb install -r android\app\build\outputs\apk\debug\app-debug.apk
```

`adb devices` empty means the USB mode is charging-only — set it to **File transfer**. `unauthorized` means the *Allow USB debugging* prompt is waiting on the phone.

Turn on **Stay awake** in Developer options so a long build doesn't drop the device again.

| | Cloud (Path A) | Local (Path B) |
|---|---|---|
| To install | nothing | ~3–4 GB, one time |
| Per build | free-tier queue, 15 min to 75+ | 1–2 min after the first |
| Build limits | free-tier quota | none |
| Works offline | no | yes |

For a six-month project, Path B pays for itself within about a week.

#### Then, every day after

```powershell
npx expo start --dev-client
```

Open the **Flyleaf** app on your phone (not Expo Go) and it connects to Metro. Reloads and hot refresh work exactly as before. You only rebuild the APK when a **native** dependency changes — JavaScript and TypeScript changes stream over as normal.

**No IP editing needed.** The client derives the API host from Expo's own dev-server address, so it follows your laptop when the IP changes. Only set `extra.apiUrl` in `app.json` to point somewhere else.

If the phone loads the bundle but every request fails, allow **port 3000** through Windows Firewall for private networks.

#### Native changes waiting for a rebuild (audit Part 07b)

These change the native app, so a JavaScript reload does not pick them up:

| Change | Why |
|---|---|
| `@react-native-community/netinfo` 12.0.1 (new) | Flush the offline queue the moment the connection returns, and show "Offline" (D-07-2) |
| `expo` 57.0.23 → 57.0.25 | SDK 57 patch release (A-07-022) |
| `expo-updates` 57.0.22 → 57.0.23 | patch (A-07-022) |
| `expo-constants` 57.0.18 → 57.0.19 | patch (A-07-022) |
| `expo-router` 57.0.21 → 57.0.23 | patch (A-07-022) |
| `expo-linking` 57.0.10 → 57.0.11 | patch (A-07-022) |
| `@expo/metro-runtime` 57.0.15 → 57.0.16 | patch (A-07-022) |
| `app.json` › `android.intentFilters`: `https://flyleaf.app/verify-email` and `/reset-password`, `autoVerify` | Android App Links: the emailed links open the app (D-07-1) |
| `app.json` › `ios.associatedDomains`: `applinks:flyleaf.app` | iOS Universal Links, same links (not built here: Android only) |
| `expo-image-picker` ~57.0.20 (new) + `app.json` plugin entry (photo and camera permission strings) | Avatar picker: library or camera (audit 10, A-10-016) |
| `expo-image-manipulator` ~57.0.20 (new) | Avatar resized to 512 px JPEG on the device before upload (PRD §6.7, A-10-016) |

Batched: the owner rebuilds once after Part 14, with every native change listed here.

The intent filter lives in the generated `android/` folder, so it must be regenerated, not just rebuilt. One command, from `apps\mobile` (PowerShell; it deletes and recreates the generated `android\` folder, re-applies the Gradle timeout fix, then builds and installs):

```powershell
npx expo prebuild --platform android --clean; if ($?) { ..\..\scripts\fix-gradle.ps1 }; if ($?) { npx expo run:android }
```

On the cloud path, `npx eas-cli@latest build --profile development --platform android` does the same (EAS runs prebuild itself).

**App Links need the domain.** Android verifies `flyleaf.app` against `https://flyleaf.app/.well-known/assetlinks.json`, which the API serves once `ANDROID_APP_PACKAGE` and `ANDROID_CERT_SHA256` are set (see Endpoints › Email links). Until the domain serves it, the links open the fallback page in the browser, whose **Open in the app** button works everywhere. To try the in-app path on a dev build: Settings → Apps → Flyleaf → Open by default → Add link → `flyleaf.app`, then `adb shell am start -a android.intent.action.VIEW -d "https://flyleaf.app/verify-email?token=<token>"`. The domain in `app.json` is fixed at build time; if production moves, change it there and in `APP_BASE_URL` together.

#### Dependency rule

For anything in `apps/mobile`, use **`npx expo install <pkg>`**, never `npm install <pkg>`. Expo resolves the version its SDK actually bundles; npm resolves whatever is newest, and newest is frequently incompatible. Every version in this `package.json` came from SDK 57's own `bundledNativeModules.json`. Check with `npx expo install --check` and `npx expo-doctor`.

---

## Layout

```
flyleaf/
├── .github/workflows/ci.yml    builds the environment, calls scripts/ci.mjs
├── docker-compose.yml          Postgres 18 (tuned for the ingest) + MinIO
├── Makefile                    up · dev · worker · ping · test · ci
├── openapi.yaml                generated from Fastify route schemas — 0 drift
├── scripts/ci.mjs              the checks — one definition, shared with CI
├── docs/                       PRD, architecture, design, phases, tasks, surprises
├── db/skeleton/books.csv       102 books, for developing without the full ingest
├── packages/api-client/        typed FlyleafClient, generated from route schemas
├── apps/api/                   TypeScript strict — 422 tests
│   ├── drizzle/                14 migrations (0000–0013)
│   └── src/
│       ├── server.ts           Fastify app
│       ├── worker.ts           pg-boss job runner — same codebase
│       ├── app.ts              hook chain + app factory (auth, CORS, errors)
│       ├── migrate.ts          prerequisites, then the drizzle journal
│       ├── ingest.ts           Open Library ingest CLI
│       ├── dedupe.ts           duplicate detection CLI
│       ├── fetch-dumps.ts      resumable dump downloader
│       ├── db/schema.ts        Drizzle schema — the source of truth
│       ├── platform/           config, pool, Cache + RateLimiter interfaces, outbound client
│       ├── providers/          storage, email, push, errors, catalog source: ports + adapters (§3d)
│       ├── uploads/            presigned uploads: policy, intent, complete, cleanup
│       ├── http.ts             error shape, viewer, requireAdmin/requireModerator
│       ├── identity/           argon2id, JWT, refresh tokens, email verification
│       ├── authorization/      canView(), assertCanView() — the access control layer
│       ├── contract/           route schemas, OpenAPI generation, spec:check
│       ├── jobs/               queue names, handlers, transactional enqueue, reconciler
│       ├── catalog/            search, works, ISBN lookup, gap-fill
│       │   ├── isbn.ts         ISBN-10/13 validation + bidirectional conversion
│       │   ├── dedupe.ts       stage 1–4 merge engine, 30-day undo
│       │   └── ingest/         dump reader, normaliser, COPY writer
│       ├── admin/              isolated admin console (auth, catalog, dedupe, audit)
│       │   ├── auth.ts         admin credentials, TOTP, audit logging
│       │   ├── totp.ts         zero-dependency RFC 6238 engine
│       │   ├── routes.ts       login, 2FA, sessions, audit trail (REST + HTML)
│       │   ├── dedupe.ts       merge review, resolve, undo (REST + HTML)
│       │   ├── catalog.ts      maturity override, ingestion status service
│       │   └── catalog-routes.ts  catalog review + ingest dashboard (REST + HTML)
│       ├── reading/            reads, progress events, reviews, velocity
│       ├── reviews/            reviews, Bayesian rating, review ranking + exploration
│       ├── interactions/       likes + comments on reads, rate-limited
│       ├── activity/           feed: fan-out on read, ranking, aggregation, cold start
│       ├── telemetry/          event ingestion, budget calculation, error scrubbing
│       └── test/               19 test suites, every SQL suite runs on PGlite
└── apps/mobile/                Expo SDK 57 (React Native 0.86) — 52 tests
    ├── app/                    expo-router filesystem routing
    │   ├── (tabs)/             Reading tab, Discover search, Profile
    │   ├── work/[id].tsx       Book detail, status picker, rating histogram
    │   ├── work/[id]/editions.tsx Cover-forward edition picker ("The copy I own")
    │   ├── author/[id].tsx     Author bio, works count, bibliography
    │   ├── series/[id].tsx     Series progress bar, up next card, book list
    │   ├── scanner.tsx         Barcode scanner with camera reticle & manual fallback
    │   ├── auth.tsx            Login/Register, verification, guest migration
    │   ├── finish/[id].tsx     Finish flow modal (rating, heart, format, review)
    │   ├── dnf/[id].tsx        Did-Not-Finish flow modal (page, reason, note)
    │   ├── log.tsx             Update progress sheet (slider, quick increments)
    │   ├── diary.tsx           Chronological reading diary
    │   ├── wall.tsx            Visual cover mosaic wall
    │   ├── stats.tsx           Reading velocity and annual statistics
    │   ├── shelf/
    │   │   ├── [id].tsx        Shelf detail screen (ranked numbering, notes, mosaic cover)
    │   │   ├── create.tsx      Create shelf (name, description, privacy, ranked toggle)
    │   │   └── [id]/edit.tsx   Edit shelf (ranked warning, 30-day soft delete)
    │   └── src/
    │       ├── offline/            db.ts, schema.ts, queue.ts, repository.ts (SQLite mirror & FIFO queue)
    │       ├── lib/                api client, guest mode, budgets, velocity, sentry
    │       └── ui/                 tokens, typography, buttons, covers, error boundary
    └── eas.json                development · preview · production profiles
```

---

## Endpoints

### App and admin API (prefixed `/v1`)

Generated from `openapi.yaml` (Audit 15a), so it lists every route the spec has; `openapi.yaml` is the reference for bodies, responses and who may call what. Paths are relative to `/v1` except `/healthz` and `/readyz`.

**Rate limits** (Audit 15a; `apps/api/src/platform/rate-limits.ts` holds every number with its PRD section). Every route except the two probes is under the **Global** tier, 1,000/hour per account and 200/hour per anonymous IP. The *Limits* column is the route's group:
- `auth`: 30/min per IP, 20/min per anonymous IP.
- `auth-account`: 10/min per account.
- `search`: 60/min per account, 20/min per IP.
- `writes`: 120/min per account. Every POST/PUT/PATCH/DELETE without another group gets this one.
- `progress`: 300/min.
- `events`: 120/hour.
- `username-check`: 20/min per IP.

Service-level limits:
- login 10/min per email;
- comments 5/min;
- reviews 10/hour and 30/day;
- follows 50/hour, 200/day, 3 per pair a day, 20 in a new account's first day;
- imports 3/day, exports 2/day, upload intents 10/day;
- username changes 1 per 30 days.

A refusal is `429 rate_limited` with `Retry-After` and `X-RateLimit-*`.

| Method | Path | Limits | What it is |
|---|---|---|---|
| GET | `/healthz` | — | Liveness probe |
| GET | `/readyz` | — | Readiness probe |
| POST | `/auth/register` | auth | Register account |
| POST | `/auth/login` | auth | Sign in |
| POST | `/auth/refresh` | auth | Rotate refresh token |
| POST | `/auth/logout` | auth | Sign out |
| GET | `/auth/username-available` | username-check | Check username availability |
| POST | `/auth/verify-email` | auth | Verify email |
| POST | `/auth/resend-verification` | auth-account | Resend email verification |
| POST | `/auth/forgot-password` | auth | Forgot password |
| POST | `/auth/reset-password` | auth | Reset password |
| GET | `/auth/sessions` | auth-account | List active sessions |
| DELETE | `/auth/sessions/{id}` | auth-account | Revoke session |
| POST | `/auth/logout-all` | auth-account | Revoke all sessions |
| GET | `/me` | — | Get current user |
| POST | `/me/date-of-birth` | auth-account | Confirm date of birth |
| PUT | `/me/content-settings` | writes | Set "Show explicit titles in search" |
| GET | `/me/profile` | — | Get my profile |
| PATCH | `/me/profile` | writes | Update my profile |
| PATCH | `/me/username` | auth-account | Change my username |
| GET | `/users/{id}` | — | Get public profile |
| GET | `/search` | search | Search catalog |
| GET | `/works/{id}` | — | Get book by ID |
| GET | `/authors/{id}` | — | Get author by ID |
| GET | `/series/{id}` | — | Get series by ID |
| GET | `/editions/isbn/{isbn}` | — | Get edition by ISBN |
| GET | `/me/stats` | — | Get my reading stats |
| GET | `/users/{id}/stats` | — | Get user reading stats |
| GET | `/reads` | — | List my reads |
| POST | `/reads` | writes | Log or update read attempt |
| GET | `/reads/{id}` | — | Get read attempt |
| DELETE | `/reads/{id}` | writes | Delete a read attempt |
| GET | `/users/{id}/reads` | — | List a user's reads, newest update first, cursor-paginated |
| POST | `/reads/{id}/progress` | progress | Record reading progress |
| POST | `/reads/{id}/finish` | writes | Finish reading attempt |
| POST | `/reads/{id}/dnf` | writes | Mark read as stopped (DNF) |
| POST | `/reads/{id}/review` | writes | Create or update review for a read |
| GET | `/reviews/{id}` | — | Get review detail by ID |
| PATCH | `/reviews/{id}` | writes | Update existing review |
| DELETE | `/reviews/{id}` | writes | Delete review |
| GET | `/works/{id}/reviews` | — | List reviews for a work with friends-first ranking |
| POST | `/reads/{id}/like` | writes | Like a read (idempotent). Likes target the read, so a finish with no review is likeable. |
| DELETE | `/reads/{id}/like` | writes | Remove your like from a read (idempotent) |
| GET | `/reads/{id}/likes` | — | Readers who liked this read |
| GET | `/reads/{id}/comments` | — | Comment thread on a read, oldest first, cursor-paginated |
| POST | `/reads/{id}/comments` | writes | Comment on a read. Single-level; 5 per minute. |
| DELETE | `/comments/{id}` | writes | Delete your own comment |
| POST | `/admin/auth/login` | auth | Admin login with password and mandatory 2FA |
| GET | `/admin/auth/me` | — | Get current admin session |
| POST | `/admin/auth/2fa/setup` | auth-account | Initialize 2FA setup for admin account |
| POST | `/admin/auth/2fa/verify` | auth-account | Verify and activate 2FA setup |
| GET | `/admin/audit-log` | — | List admin audit log entries |
| GET | `/admin/dedupe/queue` | — | List dedupe review queue |
| GET | `/admin/dedupe/preview/{survivorId}/{loserId}` | — | Preview merge impact |
| POST | `/admin/dedupe/queue/{id}/resolve` | writes | Resolve dedupe candidate |
| POST | `/admin/dedupe/report` | writes | Report duplicate work (Stage 4) |
| GET | `/admin/merges` | — | List recent merges |
| POST | `/admin/merges/{id}/undo` | writes | Undo work merge |
| GET | `/admin/catalog/works` | — | List catalog works for maturity review |
| GET | `/admin/catalog/works/{id}` | — | Get work detail for maturity review |
| POST | `/admin/catalog/works/{id}/maturity` | writes | Override work maturity classification |
| GET | `/admin/ingest/status` | — | Get ingestion status and system telemetry |
| POST | `/events` | events | Ingest client telemetry events (SL-80) |
| GET | `/admin/telemetry/budgets` | — | PRD §4.4 Interaction Budgets p75 Performance (SL-81) |
| POST | `/shelves` | writes | Create a new shelf |
| GET | `/shelves/mine` | — | List current user shelves |
| GET | `/shelves/saved` | — | List shelves saved by viewer |
| GET | `/shelves/deleted` | — | List my recently deleted shelves |
| POST | `/shelves/{id}/restore` | writes | Restore a deleted shelf |
| GET | `/shelves/browse` | — | Browse and discover public shelves |
| GET | `/shelves/{id}` | — | Get shelf by ID |
| PATCH | `/shelves/{id}` | writes | Update shelf details |
| DELETE | `/shelves/{id}` | writes | Delete a shelf |
| GET | `/shelves/{id}/items` | — | List items in shelf |
| POST | `/shelves/{id}/items` | writes | Add item to shelf |
| DELETE | `/shelves/{id}/items/{workId}` | writes | Remove item from shelf |
| PATCH | `/shelves/{id}/items/{workId}` | writes | Update shelf item note or position |
| PUT | `/shelves/{id}/order` | writes | Reorder shelf items |
| POST | `/shelves/{id}/save` | writes | Save a shelf to library |
| DELETE | `/shelves/{id}/save` | writes | Unsave a shelf from library |
| GET | `/users/{id}/shelves` | — | List user shelves by user ID |
| GET | `/users/{username}/shelves/slug/{slug}` | — | Get shelf by username and slug |
| GET | `/shelves/by-slug/{username}/{slug}` | — | Get shelf by username and slug (alias) |
| POST | `/imports` | writes | Start a background import from an uploaded export file |
| GET | `/imports` | — | List user import jobs |
| GET | `/imports/{id}` | — | Get import job status and progress |
| GET | `/imports/{id}/rows` | — | List import rows with optional state filter |
| POST | `/imports/{id}/rows/{rowNo}/resolve` | writes | Resolve an unmatched import row |
| POST | `/imports/{id}/rows/{rowNo}/skip` | writes | Skip an unmatched import row |
| POST | `/uploads` | writes | Start an upload |
| POST | `/uploads/{id}/complete` | writes | Confirm an upload arrived |
| PUT | `/me/avatar` | writes | Set my avatar |
| DELETE | `/me/avatar` | writes | Remove my avatar |
| GET | `/avatars/uploads/{userId}/{uploadId}` | — | An avatar image |
| POST | `/exports` | writes | Request full reading library export |
| GET | `/exports` | — | List user library exports |
| GET | `/exports/{id}` | — | Get export job status |
| GET | `/exports/{id}/download` | — | Download exported library file |
| GET | `/exports/{id}/link` | — | Get a short-lived download link for my export |
| POST | `/users/{id}/follow` | writes | Follow or request to follow a user |
| DELETE | `/users/{id}/follow` | writes | Unfollow user or cancel pending request |
| GET | `/me/follow-requests` | — | List incoming pending follow requests |
| POST | `/me/follow-requests/{requesterId}/accept` | writes | Accept an incoming pending follow request |
| POST | `/me/follow-requests/{requesterId}/reject` | writes | Reject an incoming pending follow request |
| POST | `/users/{id}/block` | writes | Block a user |
| DELETE | `/users/{id}/block` | writes | Unblock a user |
| GET | `/me/blocks` | — | List users blocked by viewer |
| POST | `/users/{id}/mute` | writes | Mute a user |
| DELETE | `/users/{id}/mute` | writes | Unmute a user |
| POST | `/works/{id}/mute` | writes | Mute a book |
| DELETE | `/works/{id}/mute` | writes | Unmute a book |
| GET | `/me/mutes` | — | List muted users and muted books |
| GET | `/users/{id}/followers` | — | List followers of a user |
| GET | `/users/{id}/following` | — | List users followed by a user |
| GET | `/feed` | — |  |

### Email links and App Links (no prefix)

Server-rendered, for the links in verification and reset emails (`APP_BASE_URL/verify-email?token=…`). A GET never spends the token; only the button or form POST does. Each page also offers **Open in the app** (`flyleaf://…`).

| Method | Path | What it is |
|---|---|---|
| GET, POST | `/verify-email` | "Verify my email" button; the POST verifies |
| GET, POST | `/reset-password` | New password form; the POST resets and signs out every device |
| GET | `/.well-known/assetlinks.json` | Android App Links. 404 unless `ANDROID_APP_PACKAGE` and `ANDROID_CERT_SHA256` (comma-separated `AA:BB:…` SHA-256 of the signing certificates) are set |
| GET | `/.well-known/apple-app-site-association` | iOS Universal Links. 404 unless `IOS_TEAM_ID` and `IOS_BUNDLE_ID` are set |

A malformed value in any of those four stops the API at start-up. To open the pages from a phone in development, set `APP_BASE_URL=http://<your-LAN-IP>:3000` so the emails link to the API.

### Admin HTML console

| Path | What it is |
|---|---|
| `/admin/login` | Login form with 2FA |
| `/admin/merges` | Dedupe review dashboard with side-by-side cards |
| `/admin/audit-log` | Chronological audit trail viewer |
| `/admin/catalog/maturity` | Maturity review and override console |
| `/admin/ingest` | Ingestion status and system telemetry dashboard |

---

## Things that are already correct, and must stay that way

These are not prototype shortcuts. Changing them costs far more later.

| Decision | Where | Why |
|---|---|---|
| **Work / edition split** | `db/schema.ts` | Hardest thing to retrofit. Ratings attach to the work, page counts to the edition |
| **Jobs commit with the data that caused them** | `jobs/sendInTx` | The reason pg-boss is in the stack rather than Redis. A test asserts a rolled-back transaction leaves no job — nothing else would notice if that stopped holding |
| **`field_provenance` cannot name `google_books`** | schema CHECK | Licensing, enforced structurally rather than by remembering |
| **`unclassified` maturity is not a synonym for `general`** | `catalog/ingest/normalise.ts` | A surface that must be safe filters to `general` and accepts a smaller catalog |
| **One row per reading *attempt*** | `reads.attempt_no` | A re-read is a new row, never an overwrite |
| **`progress_events` is append-only** | schema + `reading/index.ts` | Current position is the latest row. Enables pace, streaks, prediction, offline sync |
| **`client_event_id` on every progress write** | `reading/index.ts`, `api.ts` | Replay is safe. The entire offline story in one field |
| **Rating is nullable** | `reads.rating` | Finishing never requires a rating. Also what lets Goodreads' `My Rating = 0` import faithfully |
| **Auth limits live in Postgres** | `PgRateLimiter` | In-process counters are per-instance — two API processes would silently double every limit |
| **`Cache` / `RateLimiter` are interfaces** | `platform/index.ts` | Adding Redis later is one implementation plus a config line, not a refactor |
| **argon2id** | `identity/index.ts` | Never bcrypt, never SHA |
| **Viewer is an argument, not a global** | `catalog/`, `reading/` | `null` is a guest. Retrofitting this means touching every query |
| **404, never 403** | `reading/index.ts`, `authorization/` | A 403 confirms the resource exists |
| **Cover IDs, never URLs** | `works.ol_cover_id` | Size is chosen per surface at render time |
| **Colour only from tokens** | `src/ui/tokens.ts` | A literal in a component is a bug |
| **Admin isolated from app accounts** | `admin/auth.ts` | Separate JWT audience (`flyleaf-admin`), separate credentials table. A stolen app token never authenticates as admin |
| **Admin audit log is non-negotiable** | `admin/auth.ts` | `logAdminAction` records every login, merge, undo, override, and dismissal with actor, target, reason, IP, and payload diff |
| **Merges are reversible for 30 days** | `catalog/dedupe.ts` | `work_merges.moved` stores prior attempt numbers at merge time so undo is possible; after 30 days it is not |
| **Likes and comments target the read** | `interactions/`, `read_likes`, `read_comments` | A finish with no review is the core social event and must be likeable. Also survives the 180-day activity prune |
| **A like is a verb, not a toggle** | `POST`/`DELETE /reads/{id}/like` | The offline queue replays requests; a replayed toggle undoes the user's like |
| **Counters are triggers + a nightly reconciler** | `0018`, `jobs/` | App-side read-modify-write loses increments under concurrency. Triggers on `reads` name their columns, or a like pays for a `work_stats` recompute |
| **Maturity overrides lock provenance** | `admin/catalog.ts` | `field_provenance.is_locked = true` protects a human classification from being overwritten by the next dump re-ingest |

---

## Things that are deliberately wrong

| Shortcut | Replaced by |
|---|---|
| Hand-written API client | Generated from the Fastify route schemas — **done** (`FN-80/81`) |
| No offline queue | SQLite + mutation queue with crash recovery — **done** (`SL-1x`, exit verified) |
| System fonts | Literata serif + Archivo sans-serif tokens — **done** (`SL-02`) |
| 4 screens, no design system | Full mobile experience with tabs, FAB, and design system — **done** (`SL-0x` to `SL-8x`) |
| No barcode scanner | Camera + ISBN lookup + manual fallback — **done** (`SL-44`) |
| No shelves/lists | `shelves` + `shelf_items` + `shelf_saves` schema and counters — **done** (`SH-01`) |
| Shelves UI and CRUD | Create, edit, browse, and reorder shelves — **done** (`SH-02` to `SH-10`, audited in Part 11) |
| No reading goals | Reading goals and annual challenge tracking — `Phase 4` |

Already replaced: container-init schema → drizzle migrations (`FN-01`) · opaque session tokens → JWT + rotating refresh with reuse detection (`FN-63/64`) · 102 books from a CSV → the full Open Library ingest (`FN-2x`) · no rate limiting or request logging → `FN-30` (outbound), one inbound limiter layer (Audit 15, `platform/rate-limits.ts`), `FN-03` · no CI → GitHub Actions (`FN-05`) · Expo Go → a development build · no duplicate detection → stage 1–4 dedupe pipeline (`FN-5x`) · no ISBN lookup → exact edition path + bidirectional conversion (`FN-42`) · no cross-user access control → `canView()` with full test suite (`FN-7x`) · no typed API contract → Fastify route schemas + OpenAPI + typed client (`FN-8x`) · no admin tooling → isolated admin console with 2FA, dedupe review, maturity override, and audit log (`FN-9x`) · mobile prototype → full offline-first mobile app with complete reading lifecycle, reviews, diary, wall, stats, and telemetry budgets (`Phase 1`).

---

## Verification status

Refreshed by the audit (Part 15a, 2026-10-10; laptop figures from Part 15b, 2026-10-11). Every figure below names where it was measured.

| Check | Result |
|---|---|
| CI | `node scripts/ci.mjs` runs 9 steps, the same ones GitHub Actions runs: api-client build, api typecheck, spec check, api tests, api build, `npm audit --audit-level=high`, mobile typecheck, mobile tests, and migrations on a real Postgres 18. Last full run: see `docs/audit/findings/15-cross-cutting.md` › CI result. |
| API tests (`vitest`) | **1,733 tests in 82 files**. Every suite that touches SQL runs against **PGlite** (Postgres in WASM). PGlite timestamps have millisecond resolution, so cursor precision is also checked on a real server (`src/bench/cursor-sweep.ts`). |
| Mobile tests (`node --test`) | **214 tests**: offline queue, auth, guest, reading rules, stats, telemetry budgets, feed cards, shelves, social and interactions |
| Audit | 15 parts, all in `docs/audit/`: findings per part, `SUMMARY.md`, and open questions in `DECISIONS.md` |
| OpenAPI drift | **0**. `spec:check` fails the build on any divergence. |
| Migrations | **42** (`0000_phase0_catalog` … `0041_retention`). They apply cleanly to an empty database in the test suite and to a real Postgres in CI. They are hand-written and idempotent from `0019` on. |
| Rate limits | One layer, PRD §24.4 / §11.7 / §10.6. Exact limits are kept in Postgres, per-request ones in process. Measured cost: `docs/audit/perf/15a-rate-limit-overhead-sandbox.md`. Laptop (`flyleaf_dev`, 3 runs): Global in process within noise of no limits; Global in Postgres 22–25 % fewer requests/s. |
| Performance vs the Part 01 baseline | `docs/audit/perf/comparison.md` (`flyleaf_dev`, 11 Oct): **24 pass, 11 over budget, 1 not measured**. Budgets are indicative only on the 8 GB dev laptop; each over-budget row has its EXPLAIN and a plan. |
| Relevance panel | PGlite corpus **216/217** (floor 0.98). Real catalog **214/214** after Part 02d's popularity weight. |
| Catalog | **3,203,575 works · 15,409,896 authors · 3,791,016 authorship links · 2.18M covers** (`flyleaf`, Phase 0 ingest) |
| Background jobs | pg-boss worker. Monthly: `catalog.dedupe` (sliced stages). Nightly, UTC: `shelves.reconcile` 03:00, `follows.reconcile` 03:15, `reads.reconcile` 03:30, `works.reconcile` 03:40, `storage.cleanup` 03:45, `activity.prune` 03:55, `authors.repair` 04:05, `retention.sweep` 04:20. Weekly: `search.suggestions.refresh` (Sun 04:00), `search.zero.summary` (Mon 04:30). On demand: `imports.process`, `exports.process`. Each batch process connects with its own `work_mem` and `statement_timeout` (`JOB_DB_SETTINGS`). |
| Retention | Raw events 13 months. Zero-result searches 30 days, then a weekly summary only. Soft-deleted shelves, reviews and comments, and deleted accounts, are hard-deleted after 30 days. Import files are deleted after 30 days. Export files are deleted 48 h after the link. |

---

## What to read first

[`docs/surprises.md`](docs/surprises.md). It is the list of things that were not true in the plan, and it has cost more to learn than anything else here. Two entries in particular:

> Two of the bugs that reached the device passed `tsc` strict, 23 unit tests and 36/36 smoke assertions. One produced no runtime error at all. **Green checks are not a device pass.**

> Every expensive bug in Phase 0 was one where **failure and success looked identical from outside** — a COPY stream that died and exited 0, an interrupt that left a dead run marked `running`, a smoke job that logged nothing. The question to ask before calling anything verified: *if this were completely broken, what would I see, and is it different from what I see now?*

Then [`docs/tasks.md`](docs/tasks.md) for what is done, what is next, and what each thing actually cost.
