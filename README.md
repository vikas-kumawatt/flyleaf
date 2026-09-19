# Flyleaf

A reading tracker. Log what you read, rate it in half-stars, see it on a profile.

**Stack:** TypeScript · Node 22 · Fastify 5 · Drizzle · Postgres 18 · pg-boss · Expo SDK 57 · React Native 0.86 · expo-sqlite. Full locked stack in [`docs/architecture.md`](docs/architecture.md) §0.

**Where it is:** Phase 0 (Foundation), **Phase 1 (Solo loop)**, and **Phase 2 (Shelves & lists)** are **100% complete**. All exit criteria met: 3.2M books findable, 15.4M authors indexed, relevance panel at 99.5%, cross-user authorization suite green, two books tracked end-to-end on phone, finish budget p75 < 20s, offline verified with SQLite mutation queue and crash/restart recovery, a11y pass on core flows, shelves and ranked lists with per-entry notes, reordering, starter suggestions, reference saves, discovery browse ranking, 404 obscure privacy matrix, canonical vanity web sharing (`https://flyleaf.app/u/{username}/shelves/{slug}`), visual share card preview, 532 API tests + 83 mobile tests passing, migrations clean on real Postgres, 0 OpenAPI contract drift. Currently in **Phase 3 (Import & export)** — `IM-01` (`imports` and `import_rows` migrations), `IM-02` (upload endpoint returning job ID immediately with pg-boss queueing), and `IM-03` (declarative column mapping engine, RFC 4180 parser, transformer library, header detector, and Goodreads config) complete. Live state is always [`docs/tasks.md`](docs/tasks.md).

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

> **Phase 0, Phase 1, and Phase 2 are done.** The foundation (auth, catalog, search, dedupe, admin console, typed API contract, CI), the full native mobile experience (offline-first SQLite, typography and design system, barcode scanner, reading lifecycle, reviews, diary, wall, stats, and telemetry budgets), and curated shelves & lists (`SH-01` through `SH-10`) are complete and verified. Currently executing **Phase 3 — Import & export** (`IM-01`, `IM-02`, and `IM-03` complete).

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
- Background `mutation_queue` with strict per-entity FIFO sequencing, exponential backoff, dead-letter recovery, and idempotent 409 conflict handling.
- Survived process death and database close/reopen across disk restart with zero data loss.

**Guest mode:**
- Search, scanner, and book pages work with no account.
- Local Want to Read shelf (up to 20 books) with zero data loss — migrated automatically upon account creation.
- Contextual signup prompt appears at the action with clear rationale naming what you were trying to do.

**Auth:** JWT + rotating refresh tokens with reuse detection (entire family revoked on replay), email verification, password reset, session list with per-device revoke, and a 10-character minimum with common-password rejection. argon2id, never bcrypt.

**Authorization:** `canView()` enforces public/followers/private/blocked/guest on every read path. Cross-user access returns 404, never 403.

**Admin console:** Isolated from app accounts (separate JWT audience), mandatory RFC 6238 TOTP, role-based (admin/moderator), server-rendered HTML dashboard. Dedupe review, maturity override, ingestion status, and a non-negotiable audit log on every action.

**Telemetry & Budgets:** Built-in instrumentation for PRD §4.4 interaction budgets (finish p75 < 20s, progress p75 < 5s, book shelved <= 2 taps, log sheet p75 < 15s, abandonment < 8%) and Sentry integration with sensitive context redaction.

**Shelves & Lists (SH-01 through SH-10):** `shelves`, `shelf_items`, and `shelf_saves` tables with check constraints, denormalized counters (`item_count`, `save_count`, 4-cover mosaic), nightly reconciliation worker job, per-user unique slugs with auto-disambiguation, strict 3-tier privacy (public, followers, private) returning 404 on access denial, 30-day soft delete, mobile create/edit screens with ranked warning, shelf detail screen with ranked numbering (#1..#N), per-entry notes (up to 280 chars), 4-cover mosaic cards, interactive Add-to-Shelf sheet (`GET /v1/shelves/mine`, `DELETE /v1/shelves/:id/items/:workId`, `PATCH /v1/shelves/:id/items/:workId`) integrated into book pages, search cards, and long-press gestures, comprehensive reordering (`PUT /v1/shelves/:id/order`) with pan drag handles, step arrows, and accessible "move to position" numeric dialog (PRD §6.36, §46.2), responsive My Shelves 2-column grid with 4-cover mosaic cards, multi-criteria sorting (recent, alphabetical, book count), grid/list toggle, 1-tap starter suggestions on empty states ("Favourites of 2026", "Comfort reads", "Recommended to me") (PRD §6.33), shelf saving (`POST /v1/shelves/:id/save`, `DELETE /v1/shelves/:id/save`, `GET /v1/shelves/saved`) with reference semantics (stays live and dynamically in sync as curator adds or reorders books), forbidden own-shelf saving, mobile "Save Shelf" / "Saved to Library" button with optimistic rollback, dedicated Saved tab in the Shelves screen with curator attribution and 2-column mosaic rendering (PRD §6.34, §15.6), public shelf browsing (`GET /v1/shelves/browse`) powered by PRD §15.5 multi-signal composite ranking (`shelf_score = 0.30 * log(1 + saves) + 0.20 * log(1 + views) + 0.20 * social_proximity + 0.15 * curation_quality + 0.15 * freshness`), guest access, ILIKE search, mobile Curated / Discover Lists integration with 2-column mosaic cards and Featured/Popular/Recent sort pills, and comprehensive shelf privacy (`SH-09`) enforcing strict 3-tier privacy (`public`, `followers`, `private`), private account hierarchy (`profiles.isPrivate = true` masks all shelves with 404 and excludes from browse), 404 obscure masking (never 403), user shelves endpoint `GET /v1/users/:id/shelves`, and dynamic saved shelves filtering upon privacy change.

**Import & Export (IM-01, IM-02, IM-03):**
- Schema & migrations for `imports` and `import_rows` (`0014_imports.sql`) with check constraints across 6 sources (`goodreads`, `storygraph`, `librarything`, `calibre`, `openlibrary`, `openreads`) and states (`queued`, `processing`, `completed`, `failed`), non-negative counter checks, cascade deletions, and index on `(user_id, content_hash)` for duplicate import detection (IM-11).
- Multipart file upload route `POST /v1/imports` accepting export CSVs up to 10MB (PRD §6.8), computing SHA-256 `content_hash`, persisting files via storage abstraction (`DiskFileStorage` / `MemoryFileStorage`), enqueuing background tasks to pg-boss `imports.process`, and immediately returning `{ id, job_id, state: 'queued', source, ... }` per PRD AC-9.
- Status inspection `GET /v1/imports/:id` with strict 404 cross-user privacy barrier, and import history listing `GET /v1/imports`.
- Fully typed `@flyleaf/api-client` methods (`uploadImport`, `getImport`, `listImports`) supporting standard web `Blob`, `File`, and `Uint8Array`.
- Declarative column mapping engine (`IM-03`) with zero source coupling: pure RFC 4180 CSV parser handling multiline quotes and BOM, reusable field transformers (Goodreads ISBN `=".."` cleansing, half-star rating normalisation with `0` → `null`, status mapping, flexible date parser with local calendar preservation, shelf parsing, format mapping), signature-based header auto-detection (`detectSourceFromHeaders`), and full Goodreads reference configuration.

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

### 2d. Dedupe

After ingesting, run the duplicate detection pipeline:

```powershell
npm run dedupe -- --dry-run      # preview what it would merge
npm run dedupe                   # execute merges
```

Stage 1 (ISBN13 exact match) and Stage 2 (normalised title + shared author) auto-merge. Stage 3 (trigram similarity) enqueues candidates for admin review. All merges are reversible for 30 days. A monthly `catalog.dedupe` pg-boss cron job runs this automatically.

### 3. API

```powershell
npm run dev
```

Check it: <http://localhost:3000/healthz> and <http://localhost:3000/readyz>.

```powershell
curl "http://localhost:3000/v1/search?q=piranesi"
```

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

The `catalog.dedupe` cron job runs monthly (`0 0 1 * *`). To trigger it manually:

```powershell
npm run worker -- --dedupe
```

### 3c. CI — run it before you push

```powershell
node scripts/ci.mjs      # or: make ci
```

Typecheck, 372 tests, build, `npm audit`, the mobile typecheck, spec check (0 OpenAPI drift), and migrations against the real Postgres — about 160 seconds. **This is the same script GitHub Actions runs**; `.github/workflows/ci.yml` builds the environment and calls it rather than restating the steps, so the two cannot drift. The migration step is skipped locally when no database is up and is mandatory in CI (`--strict`).

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
│       ├── platform/           config, pool, Cache + RateLimiter interfaces
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
│       ├── telemetry/          event ingestion, budget calculation, Sentry hook
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

### App API (prefixed `/v1`)

| Method | Path | Guest? |
|---|---|---|
| GET | `/healthz`, `/readyz` | yes |
| POST | `/auth/register` | — |
| POST | `/auth/login` | — |
| POST | `/auth/refresh` | — |
| POST | `/auth/logout` | — |
| POST | `/auth/verify-email` | — |
| POST | `/auth/resend-verification` | no |
| POST | `/auth/forgot-password` | — |
| POST | `/auth/reset-password` | — |
| GET | `/auth/sessions` | no |
| DELETE | `/auth/sessions/{id}` | no |
| POST | `/auth/logout-all` | no |
| GET | `/me` | no |
| GET | `/users/{id}` | **yes** |
| GET | `/search?q=` | **yes** |
| GET | `/works/{id}` | **yes** |
| GET | `/editions/isbn/{isbn}` | **yes** |
| GET | `/reads?status=` | no |
| GET | `/reads/{id}` | no |
| GET | `/users/{id}/reads` | **yes** |
| POST | `/reads` | no |
| POST | `/reads/{id}/progress` | no |
| POST | `/reads/{id}/finish` | no |
| POST | `/reads/{id}/dnf` | no |
| POST | `/reads/{id}/reviews` | no |
| GET | `/works/{id}/reviews` | **yes** |
| GET | `/users/{id}/reviews` | **yes** |
| POST | `/events` | **yes** |
| GET | `/admin/telemetry/budgets` | moderator+ |
| POST | `/shelves` | no |
| GET | `/shelves/{id}` | **yes** |
| PATCH | `/shelves/{id}` | no |
| DELETE | `/shelves/{id}` | no |
| GET | `/shelves/{id}/items` | **yes** |
| POST | `/shelves/{id}/items` | no |

### Admin API (prefixed `/admin`)

| Method | Path | Role |
|---|---|---|
| POST | `/auth/login` | — |
| GET | `/auth/me` | moderator+ |
| POST | `/auth/2fa/setup` | admin |
| POST | `/auth/2fa/verify` | admin |
| GET | `/audit-log` | moderator+ |
| GET | `/dedupe/queue` | moderator+ |
| GET | `/dedupe/preview/{survivorId}/{loserId}` | moderator+ |
| POST | `/dedupe/queue/{id}/resolve` | admin |
| POST | `/dedupe/report` | moderator+ |
| GET | `/merges` | moderator+ |
| POST | `/merges/{id}/undo` | admin |
| GET | `/catalog/works` | moderator+ |
| GET | `/catalog/works/{id}` | moderator+ |
| POST | `/catalog/works/{id}/maturity` | admin |
| GET | `/ingest/status` | moderator+ |

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
| Shelves UI and CRUD | Create, edit, browse, and reorder shelves — in progress (`SH-02` to `SH-10`) |
| No reading goals | Reading goals and annual challenge tracking — `Phase 4` |

Already replaced: container-init schema → drizzle migrations (`FN-01`) · opaque session tokens → JWT + rotating refresh with reuse detection (`FN-63/64`) · 102 books from a CSV → the full Open Library ingest (`FN-2x`) · no rate limiting or request logging → `FN-30`, `FN-03` · no CI → GitHub Actions (`FN-05`) · Expo Go → a development build · no duplicate detection → stage 1–4 dedupe pipeline (`FN-5x`) · no ISBN lookup → exact edition path + bidirectional conversion (`FN-42`) · no cross-user access control → `canView()` with full test suite (`FN-7x`) · no typed API contract → Fastify route schemas + OpenAPI + typed client (`FN-8x`) · no admin tooling → isolated admin console with 2FA, dedupe review, maturity override, and audit log (`FN-9x`) · mobile prototype → full offline-first mobile app with complete reading lifecycle, reviews, diary, wall, stats, and telemetry budgets (`Phase 1`).

---

## Verification status

| Check | Result |
|---|---|
| CI | **green** on every push — GitHub Actions / `node scripts/ci.mjs`, ~225 s |
| `tsc --noEmit` (API) | pass — TypeScript strict, `noUncheckedIndexedAccess` |
| `tsc --noEmit` (Mobile) | pass — TypeScript strict, 0 errors |
| `vitest run` (API) | **532 tests** across **24 test suites** — identity (47), schema (29), search (33), ingest (65), outbound (27), jobs (10), relevance (10), dedupe (38), ISBN (18), authorization (43), contract (8), hooks (17), admin (22), admin-catalog (7), reading (10), reviews (12), profile-stats (8), telemetry (7), shelves-migration (11), shelves (36), shelves-privacy (20), imports-migration (12), imports (16), import-mapping (27). Every suite that touches SQL runs against **PGlite** (Postgres compiled to WASM) |
| Mobile test runner | **83 tests** across **20 test suites** — offline queue (7), auth validation (10), guest mode & migration (7), reading velocity (5), profile & stats (9), telemetry budgets (5), Phase 1 exit criteria (4), shelf validation, sorting, sharing & starter helpers (36) |
| OpenAPI drift | **0** — `spec:check` runs in CI and fails the build on any divergence |
| Relevance panel | **216/217 (99.5%)** over a 2,071-work slice of the real catalog. Exact titles must rank **#1**; prefixes, authors and typos must make the top 5. Floor set at 0.98 |
| Cross-user suite | **43 tests green** — 404 not 403, canView covers public/followers/private/blocked/guest, viewer enforcement on every repository method |
| Catalog | **3,203,575 works · 15,409,896 authors · 3,791,016 authorship links · 2.18M covers** |
| Author aliases | **1,661,072 credited authors** re-ingested with `alternate_names`, which is what makes `murakami` → 村上春樹 work |
| Popularity | **3,203,476 works scored**. Most-logged: Atomic Habits, 64,006 |
| Search latency | **47–85 ms warm** on the full catalog (was 40 s). Cold, after a restart, 430–815 ms |
| ISBN lookup | **18 tests** — ISBN-10/13 validation, bidirectional conversion, exact edition resolution, search prioritization |
| Dedupe pipeline | **38 tests** — stage 1–4 detection, merge with collision handling, 30-day undo, preview, admin queue |
| Background jobs | pg-boss worker; `smoke.ping` + `catalog.dedupe` monthly cron + `shelves.reconcile` nightly job + `imports.process`; transactional enqueue test |
| Admin console | **29 tests** (22 admin + 7 admin-catalog) — 2FA, token isolation, role enforcement, audit recording, maturity override, ingestion dashboard |
| Mobile offline mirror | **pass** — SQLite mirror, optimistic writes, per-entity FIFO queue, exponential backoff, dead-letter queue, 409 conflict handling |
| Phase 1 Exit Criteria | **100% verified** — two books tracked end-to-end on phone, finish budget p75 < 20s (measured ~11.2s), offline verified across simulated crash/restart, a11y pass on core flows |
| Migrations | **15 migrations** (`0000_phase0_catalog` through `0014_imports`) apply cleanly on an empty database and run in CI against real Postgres 18 |

---

## What to read first

[`docs/surprises.md`](docs/surprises.md). It is the list of things that were not true in the plan, and it has cost more to learn than anything else here. Two entries in particular:

> Two of the bugs that reached the device passed `tsc` strict, 23 unit tests and 36/36 smoke assertions. One produced no runtime error at all. **Green checks are not a device pass.**

> Every expensive bug in Phase 0 was one where **failure and success looked identical from outside** — a COPY stream that died and exited 0, an interrupt that left a dead run marked `running`, a smoke job that logged nothing. The question to ask before calling anything verified: *if this were completely broken, what would I see, and is it different from what I see now?*

Then [`docs/tasks.md`](docs/tasks.md) for what is done, what is next, and what each thing actually cost.
