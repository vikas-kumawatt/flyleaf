# Flyleaf — Phase −1 Walking Skeleton

**Stack:** TypeScript · Node 22 · Fastify 5 · Drizzle · Postgres 17 · Expo SDK 57. Full locked stack in `architecture.md` §0.

One crude path through every layer, working end to end. This is **SK-01 → SK-06** from `tasks.md`.

> **It is ugly on purpose.** No email verification, no refresh-token rotation, no Open Library ingest, no offline queue, no styling beyond the design tokens. What survives this phase is the *shape* — module boundaries, the viewer-in-context pattern, the error envelope, the schema — not this wiring.

---

## What works

```
sign up  →  search 100 books  →  book detail  →  mark reading
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

The schema in `db/skeleton/001_skeleton.sql` runs automatically on first boot.
To start over: `docker compose down -v` then `docker compose up -d`.

### 2. Seed the catalog

```powershell
cd apps\api
npm install
npm run seed -- ..\..\db\skeleton\books.csv
```

Expect `seed complete — inserted=102 skipped=0`.

### 3. API

```powershell
npm run dev
```

Check it: <http://localhost:3000/healthz> and <http://localhost:3000/readyz>.

```powershell
curl "http://localhost:3000/v1/search?q=piranesi"
```

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

The second run builds. You get a QR code and a URL; install that APK on your phone once.

#### Path B — local build (one big install, then unlimited and faster)

Needs **Android Studio** and **JDK 17** (both free, ~10 GB total).

```powershell
cd D:\Bookmarked\flyleaf\apps\mobile
npm ci
npx expo run:android              # phone connected over USB with debugging enabled
```

Long-term this is the better path — no build quotas, no upload wait.

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
| `vitest run` | pass — **17 tests**: argon2id round-trip and salting, password and username rules, cache TTL and eviction |
| Client typecheck | pass — verified against real React 19 types |
| Mobile dependency resolution | pass — lockfile resolves 624 packages, no peer conflicts |
| End-to-end on a device | **SK-07 — yours to run** |

---

## What to do next (SK-07 → SK-09)

1. **Run the whole path on your own phone.** Not an emulator.
2. **Write the surprises list.** Anything that felt wrong, slow, or awkward. That list is the real output of this phase.
3. **Have one other person complete it unaided**, without you explaining anything.

Then answer the four questions in `phases.md`:

- Does the Expo → Node → Postgres round trip actually work on a physical device?
- Is the work/edition split workable in a real UI, or does it force an edition picker into every flow?
- Does an append-only progress stream feel right, or over-engineered for what the screen needs?
- Is the 20-second finish budget achievable, or a fantasy?

Anything the skeleton reveals is cheap to change now. The same discovery in Phase 3 is a rewrite.
