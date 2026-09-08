# Flyleaf — Phase −1 Walking Skeleton

**Stack:** TypeScript · Node 22 · Fastify 5 · Drizzle · Postgres 18 · Expo SDK 57. Full locked stack in `architecture.md` §0.

One crude path through every layer, working end to end. This is **SK-01 → SK-06** from `tasks.md`.

> **It is ugly on purpose.** No email verification, no refresh-token rotation, no Open Library ingest, no offline queue, no styling beyond the design tokens. What survives this phase is the *shape* — module boundaries, the viewer-in-context pattern, the error envelope, the schema — not this wiring.

---

## What works

```
sign up  →  search 3.2M books →  book detail  →  mark reading
         →  update progress   →  finish       →  rate
         →  see it on a profile
```

Plus **guest mode**: search and book pages work with no account, and the signup prompt appears at the action, naming what you were trying to do.

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

`migrate` creates the extensions and the `flyleaf_unaccent` function first, then runs the drizzle journal in `apps/api/drizzle/`. Both steps are idempotent, so re-running is safe.

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

**Order matters.** Works link to authors by OL key and the merge joins on it rather than inventing placeholder rows, so a work ingested before its author simply loses its authorship.

**`--seed` is the point.** It keeps only works that somebody has shelved or rated — the accelerator's layer 1 from `phases.md`. That turns a multi-day ingest into an evening, and the popularity signal costs 65 MB instead of parsing the 9.2 GB editions dump.

Editions add ISBNs, page counts and formats. They're a separate 9.2 GB pass and the app works without them, so leave it until you want them:

```powershell
npm run ingest -- --type editions --file ..\..\data\ol_dump_editions_latest.txt.gz
npm run ingest -- --finalise
```

Useful flags: `--limit 5000` for a trial run, `--no-raw` to skip raw-payload retention, `--restart` to ignore the checkpoint.

**It is resumable.** Ctrl+C is safe — it finishes the current batch, writes a checkpoint and stops. Re-run the identical command to continue. The checkpoint is a line count, not a byte offset, because you cannot seek into the middle of a gzip member; resuming re-decompresses from the start and skips without parsing, which is far cheaper than the work it skips.

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

### 4. Mobile app — a development build, not Expo Go

> **Expo Go will not run this project, and that is not fixable.** Expo Go supports **exactly one SDK version** at a time — whatever the Play Store build on your device happens to be. If it reports "Supported SDK: 54" and the project is SDK 57, the only ways out are to downgrade the project (no) or stop using Expo Go (yes).
>
> A **development build** is the real answer regardless: it is a normal APK containing *your* native modules at *your* versions, it connects to the same Metro dev server, and Phase 1 needs it anyway for `expo-sqlite`, `expo-camera` and Reanimated worklets.

Pick whichever path suits your machine. Both produce the same thing.

#### Path A — cloud build (nothing to install, ~15 min)

**First, initialise git at the repo root** — not inside `apps/mobile`. EAS requires a git repo and will offer to create one wherever you happen to be standing; the wrong answer leaves your API and docs outside version control.

```powershell
cd D:\Bookmarked\flyleaf
git init
git add -A
git commit -m "Phase -1 walking skeleton"
```

Then:

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
├── docker-compose.yml
├── db/skeleton/
│   ├── 001_skeleton.sql        six tables, by hand
│   └── books.csv               102 books
├── apps/api/                   TypeScript — typechecks clean, 17 tests pass
│   ├── src/server.ts           Fastify app
│   ├── src/seed.ts             CSV loader
│   └── src/
│       ├── db/schema.ts        Drizzle schema
│       ├── platform/           config, pool, Cache + RateLimiter interfaces
│       ├── http.ts             error shape, viewer, conventions
│       ├── identity/           argon2id, sessions  (+ tests)
│       ├── catalog/            search, works, editions
│       └── reading/            reads, progress events
└── apps/mobile/                Expo SDK 57
    ├── app/                    4 screens, expo-router
    ├── eas.json                development · preview · production profiles
    ├── babel.config.js         Reanimated worklets plugin
    └── src/{lib,ui}/           api client, session, design tokens
```

---

## Endpoints

| Method | Path | Guest? |
|---|---|---|
| GET | `/healthz`, `/readyz` | yes |
| POST | `/v1/auth/register`, `/v1/auth/login` | — |
| GET | `/v1/me` | no |
| GET | `/v1/search?q=` | **yes** |
| GET | `/v1/works/{id}` | **yes** |
| GET | `/v1/reads?status=` | no |
| POST | `/v1/reads` | no |
| POST | `/v1/reads/{id}/progress` | no |

---

## Things that are already correct, and must stay that way

These are not prototype shortcuts. Changing them costs far more later.

| Decision | Where | Why |
|---|---|---|
| **Work / edition split** | `001_skeleton.sql` | Hardest thing to retrofit. Ratings attach to the work, page counts to the edition |
| **One row per reading *attempt*** | `reads.attempt_no` | A re-read is a new row, never an overwrite |
| **`progress_events` is append-only** | schema + `reading/index.ts` | Current position is the latest row. Enables pace, streaks, prediction, offline sync |
| **`client_event_id` on every progress write** | `reading/index.ts`, `api.ts` | Replay is safe. The entire offline story in one field |
| **Rating is nullable** | `reads.rating` | Finishing never requires a rating. Also what lets Goodreads' `My Rating = 0` import faithfully |
| **Auth limits live in Postgres** | `PgRateLimiter` | In-process counters are per-instance — two API processes would silently double every limit |
| **`Cache` / `RateLimiter` are interfaces** | `platform/index.ts` | Adding Redis later is one implementation plus a config line, not a refactor |
| **argon2id** | `identity/index.ts` | Never bcrypt, never SHA |
| **Viewer is an argument, not a global** | `catalog/`, `reading/` | `null` is a guest. Retrofitting this means touching every query |
| **404, never 403** | `reading/index.ts` | A 403 confirms the resource exists |
| **Cover IDs, never URLs** | `works.ol_cover_id` | Size is chosen per surface at render time |
| **Colour only from tokens** | `src/ui/tokens.ts` | A literal in a component is a bug |

---

## Things that are deliberately wrong

| Shortcut | Replaced by |
|---|---|
| Opaque session tokens in a table | JWT + rotating refresh with family reuse detection — `FN-63/64` |
| Schema applied by container init | drizzle-kit migrations — `FN-01` |
| 102 books from a CSV | Streaming `COPY` ingest of Open Library dumps — `FN-2x` |
| Hand-written API client | Generated from the Fastify route schemas — `FN-80/81` |
| No offline queue | SQLite + mutation queue — `SL-1x` |
| System fonts | Literata + Archivo — `SL-02` |
| Expo Go as the dev target | A development build — required from the start, see §4 |
| No rate limiting, no CORS, no request logging | `FN-30`, `FN-82` |
| No CI, no branch protection | GitHub Actions — `FN-05` |

---

## Verification status

| Check | Result |
|---|---|
| `tsc --noEmit` (API) | pass — TypeScript **7.0.2** strict, `noUncheckedIndexedAccess` |
| `vitest run` | **157 tests** — identity/platform, schema, search, ingest, outbound. Every suite that touches SQL runs against **PGlite** (Postgres compiled to WASM), so migrations, CHECK constraints, generated columns, GIN and trigram are exercised for real, with no Docker and no services in CI |
| Catalog | **3,203,575 works · 15,409,896 authors · 3,791,016 authorship links · 2.18M covers**, ingested from the Open Library dumps |
| Popularity | **3,203,476 works scored** from the reading-log and ratings dumps. Most-logged: Atomic Habits, 64,006 |
| Search latency | **47–68 ms warm** on the full catalog (was 40 s). Cold, after a restart, 430–660 ms |
| Client typecheck | pass — verified against real React 19 types |
| Mobile dependency resolution | pass — lockfile resolves 624 packages, no peer conflicts |
| `scripts\smoke.ps1` | **36/36** against a real Postgres |
| End-to-end on a device | **pass** — Android 14, dev build of SDK 57, 3 Sep 2026 |
| 20-second finish budget | **pass** — under 15 seconds, unstyled |
| Surprises list | written — `surprises.md` |
| Second person walks it unaided | **SK-09 — still open** |

---

## What to do next — SK-09, the last open item

**Have one other person complete the path unaided.** Hand them the phone, say nothing, and watch. Where they hesitate is the finding.

Everything else in Phase −1 is closed. The four questions are answered in `phases.md`, and the full account is in **`surprises.md`** — including the entry that matters most:

> Two of the bugs that reached the device passed `tsc` strict, 23 unit tests and 36/36 smoke assertions. One produced no runtime error at all. Green checks are not a device pass.
