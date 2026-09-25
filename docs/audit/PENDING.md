# Pending work outside the numbered audit parts

Written 25 Sep 2026, while Part 04 was running. Nothing in this file is done yet. Delete each item when it lands.

## Run order

| When | Item | Why then |
|---|---|---|
| After Part 06, **before Part 07** | **PV-0x providers** (below) | Parts 07 and 12 must audit the new presigned upload path, not patch the multipart one that PV-02 deletes |
| After PV-0x | Parts 07 … 08 as normal | |
| **After Part 08** | **Part 03c** (`03c-dedupe-followup.md`) | Part 08 adds the `reads.work_id` index; the 03c dry run scans `reads` for impact and the stage-3 probe set |
| Then | Parts 09 … 15 | 15 stays last |

## PV-0x — Providers (swappable third-party services)

Goal: any third-party service (object storage, email, push, error reporting, catalog source) is swapped by writing **one adapter file and changing one config line**. No vendor SDK is imported outside `apps/api/src/providers/`. **Uploads go from the client directly to the provider via presigned URLs; the API never receives file bytes, and `@fastify/multipart` is removed.**

What exists today (checked 25 Sep): `FileStorage` in `imports/storage.ts` (put/get/delete/has, Disk + Memory), used by imports and exports; imports arrive as `multipart/form-data` through `@fastify/multipart` (`imports/index.ts`, `api-client uploadImport`); `EmailSender` in `platform/mail.ts` (Console + Memory only); Sentry called directly from `telemetry/sentry.ts`; Open Library calls through `platform/outbound.ts`; no push yet (SO-30).

Paste this block into `docs/tasks.md` as a new section after `FN-9x` (Admin) when the PV session starts:

```markdown
### Providers — `PV-0x` · 5d
- [ ] **PV-01** ⚠️ **Object-storage port.** `ObjectStorage` in `src/providers/storage/`: `createUpload({key, contentType, maxBytes, expiresIn})` → `{url, method, headers, fields?}` (covers S3 PUT, S3 POST policy and Cloudinary-style signed form posts), `createDownloadUrl(key, {expiresIn, filename})`, `head(key)` → `{size, contentType, etag} | null`, `getStream(key)`, `put(key, body, contentType)` (server-generated files only), `delete(key)`. Adapters: `disk` (dev: HMAC-signed local URLs served by a small route, so the presigned flow is exercised locally), `memory` (tests), `s3` (any S3-compatible: AWS, R2, B2, MinIO). One shared contract test suite runs against every adapter. `FileStorage` is deleted — 1.5d
- [ ] **PV-02** ⚠️ **Presigned upload flow.** `uploads` table (id, user_id, purpose, key, content_type, max_bytes, status `pending|uploaded|consumed|expired`, expires_at). `POST /v1/uploads` {purpose, content_type, size} → upload id + presigned target, limits per purpose from one policy table (PRD numbers with section refs). Client uploads directly. `POST /v1/uploads/:id/complete` → server `head()`s the object, checks owner, size, declared type and magic bytes (ranged read), marks `uploaded`. Consumers take `upload_id` (imports first), mark it `consumed` in the same transaction as the job enqueue. Exports: worker `put()`s, client downloads via short-lived `createDownloadUrl`. Daily cleanup job deletes expired/unconsumed uploads and their objects. Remove `@fastify/multipart` and the multipart route. Idempotent `complete`; another user's upload id → 404 — 1.5d
- [ ] **PV-03** api-client + mobile: `uploadFile(purpose, file, {onProgress})` does intent → direct upload → complete, with retry of the upload step only; import screen switched; export download uses the presigned URL; pending uploads cleared per user on logout — 0.5d
- [ ] **PV-04** Email port: `EmailSender` moves to `src/providers/email/`, adds one real adapter (SMTP via nodemailer, or Resend/SES/Postmark) selected by `EMAIL_DRIVER`; templates stay in app code — 0.25d
- [ ] **PV-05** Push port: `PushSender` interface + Expo push adapter + memory adapter, so SO-30 builds on it — 0.25d
- [ ] **PV-06** Error-reporting port: `ErrorReporter` interface; Sentry becomes one adapter; `noop` default; PII scrubbing (`sanitizeContext`) stays outside the adapter — 0.25d
- [ ] **PV-07** Catalog-source port: Open Library access behind `CatalogSource` (lookup by ISBN / work / author, cover URL); `OutboundClient` rate limit + breaker stay shared — 0.25d
- [ ] **PV-08** Wiring + guard rails: one `providers/index.ts` factory reads `STORAGE_DRIVER`, `EMAIL_DRIVER`, `PUSH_DRIVER`, `ERROR_DRIVER` and fails fast on missing credentials in production; `serverDependencies()` and the worker both use it; ESLint `no-restricted-imports` forbids vendor SDKs (`@aws-sdk/*`, `@sentry/*`, `nodemailer`, `expo-server-sdk`, …) outside `src/providers/`; README gets a "Swapping a provider" section; architecture.md updated — 0.5d
```

Session prompt (fresh window, `flyleaf_dev` is fine):

```
Read docs/audit/00-method.md and docs/audit/PENDING.md in full. Implement the PV-0x block from PENDING.md: first paste it into docs/tasks.md after the FN-9x section, then build PV-01 to PV-08 in order, ticking each off. Follow the repo's existing patterns (injected dependencies via serverDependencies, PGlite tests, hand-written idempotent migrations registered in the journal, OpenAPI regenerated with 0 drift). Hard rules: the API never receives upload bytes; @fastify/multipart is removed; no vendor SDK imported outside apps/api/src/providers/; every adapter passes the same contract test suite; production refuses to start with a dev adapter or missing credentials. Do not add a real cloud account or credentials; the s3 adapter is tested against the contract suite with a mocked client (and MinIO only if it is already available). Update README, architecture.md, tasks.md and phases.md, then remove the PV-0x section from PENDING.md. Work autonomously; only stop to ask me if something is destructive or a decision blocks all progress. Finish with node scripts/ci.mjs green and a summary in the 00-method.md format.
```

## Part 03c — dedupe follow-up (D5, D6, D7)

Prompt file: `03c-dedupe-followup.md`. Run after Part 08, on the **full** database:

```powershell
$env:DATABASE_URL = "postgres://flyleaf:flyleaf@localhost:5432/flyleaf"
```

Then in a fresh window:

```
Read docs/audit/00-method.md and docs/audit/03c-dedupe-followup.md in full, then carry out audit Part 03c end to end. Work autonomously; only stop to ask me if something is destructive. Finish with the summary described in 00-method.md.
```
