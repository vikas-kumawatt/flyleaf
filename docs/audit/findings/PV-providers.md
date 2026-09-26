# Audit PV — Providers (PV-01 … PV-08)

2026-09-26 · CI **green in 958 s** (`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`, owner's run: all 9 steps; API 61 files, **1,213 passed, 0 skipped**, so MinIO was up; mobile 100; migrations applied on the real Postgres) · tests **1,091 → 1,213 API** at that run, **1,215** after the decision follow-up below (+1 in `uploads.test.ts`, +1 in `storage-contract.test.ts`; those two files, `jobs.test.ts`, typecheck, build and spec check were re-run here at `--maxWorkers=1`, all green; the full suite was not re-run) · mobile 100, unchanged

This was a build, not an audit part, but it touched the import, export, mail and error paths, and found problems in them. They are recorded here in the audit format.

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| PV-01 | Object-storage port, disk/memory/s3, one contract suite, `FileStorage` deleted | ✅ built; the contract suite runs 10 cases × memory, disk, s3 (mocked client), and s3 against the local MinIO | D-PV-1 |
| PV-02 | Presigned uploads, `uploads` table, complete, consumers, cleanup, multipart removed | ✅ built | A-PV-002, -004, -005, -006, D-PV-2, D-PV-3 |
| PV-03 | api-client `uploadFile`, mobile import switched, export via presigned URL, uploads cleared on logout | ✅ built; the client is tested against the real app | — |
| PV-04 | Email port + a real adapter | ✅ SMTP (nodemailer) | A-PV-001 |
| PV-05 | Push port, Expo + memory | ✅ send only (tickets); receipts left to SO-30 | — |
| PV-06 | Error-reporting port, Sentry as an adapter, noop default | ✅ built | A-PV-003, -009 |
| PV-07 | Catalog-source port for Open Library | ✅ built; lookups have no production caller yet | — |
| PV-08 | Factory, fail-fast in production, API + worker use it, vendor-import rule, docs | ✅ built; ⚠️ the rule is a test, not ESLint | A-PV-001, D-PV-4 |

## Findings

### A-PV-001 · P1 · The worker ignored the configured storage and mailer
- **Where:** `apps/api/src/worker.ts:71` (before), `jobs/index.ts` `registerQueues(boss, log, db)` → `processImportJobHandler(jobs, db)` / `processExportJobHandler(jobs, db)`
- **Evidence:** the handlers fell back to `new DiskFileStorage()` and `new ConsoleEmailSender()` whenever no storage or mailer was passed, and the worker never passed either. Every export-ready email in production would have gone to the worker's stdout. Imports only worked because API and worker happened to share a working directory.
- **Spec:** PRD §6.8 (export link emailed), L-03 (the same class of wiring bug on the API side)
- **Fix:** `registerQueues(boss, log, deps: WorkerDeps)` with `storage` and `mailer` required. `worker.ts` builds them with `createProviders()`, the factory the API uses. The handlers no longer have defaults.
- **Test:** enforced by the type checker (`WorkerDeps` is required). `jobs.test.ts` passes memory adapters. Seen failing before the fix: **no**. There was no seam to test; the fix removes the defaults rather than adding a check.

### A-PV-002 · P2 · An unparseable Content-Type was a 500
- **Where:** `apps/api/src/app.ts`, error handler
- **Evidence:** `POST /v1/imports` with `content-type: multipart/form-data` after multipart was removed → `500 internal`. The same held before PV for any type Fastify had no parser for (`text/plain`, `application/xml`); multipart only escaped because its parser was registered. `FST_ERR_CTP_INVALID_MEDIA_TYPE` was unmapped.
- **Fix:** mapped to `415 unsupported_media_type`.
- **Test:** `imports.test.ts` › "refuses a multipart upload to /v1/imports: the API takes no file bytes". Seen failing before the fix: **yes** (500).

### A-PV-003 · P1 · Server-side Sentry never reported anything
- **Where:** `apps/api/src/telemetry/sentry.ts` (before)
- **Evidence:** `captureApiException` sent only when `enabled`, which only `initSentry()` set, and nothing called `initSentry()` (`grep -rn initSentry src` → the test file only). SL-82 is marked done; with `SENTRY_DSN` set in production, every 500 was silently dropped. The existing test ("gracefully handles missing SENTRY_DSN") passed because doing nothing is the behaviour it asserted.
- **Spec:** SL-82, architecture §11 Observability
- **Fix:** the `ErrorReporter` port. The factory builds the `sentry` adapter from `ERROR_DRIVER=sentry` + `SENTRY_DSN` (the DSN is validated at startup), and `serverDependencies()` passes it to the error handler. Scrubbing (`sanitizeContext`) runs before any adapter.
- **Test:** `telemetry.test.ts` › "a 500 reaches the configured reporter with a scrubbed context…", and `providers.test.ts` › "a complete production configuration builds the real adapters". Seen failing before the fix: **no** (the old code had no injection point to test against).

### A-PV-004 · P2 · A failed import enqueue left the import queued forever
- **Where:** `imports/index.ts` `create()` (before): `boss.send(...)` after the insert, outside any transaction, inside an empty `catch`
- **Evidence:** the code comment claimed "the record remains queued and will be picked up by reconciler/retry"; there is no import reconciler (`QUEUES` has none).
- **Fix:** lock the upload, insert the import, mark the upload consumed and enqueue via `sendInTx`, all in one transaction. A failed enqueue returns 500, leaves no import, and the upload can be used again.
- **Test:** `uploads.test.ts` › "consume and enqueue are one transaction…". Seen failing before the fix: **no** (it is written against the new API).

### A-PV-005 · P2 · Export files were never deleted
- **Where:** `exports/` (before): the file outlived its 48 h link indefinitely
- **Evidence:** nothing deleted `exports/<user>/<id>.*`. A full copy of a user's reading history, reviews included, stayed on disk after the link expired.
- **Spec:** PRD §6.8 ("valid for 48 hours"), §26 privacy
- **Fix:** the daily `storage.cleanup` job deletes the object and clears `file_key` once `expires_at` passes. It also removes uploads never consumed within their 1 h life.
- **Test:** `uploads.test.ts` › "deletes expired, unconsumed uploads and expired export files; leaves the rest".

### A-PV-006 · P2 · A presigned PUT outlives `complete` (design risk, mitigated)
- **Where:** the PV-02 flow itself
- **Evidence:** the target is valid for 15 min. A client can `complete` (passing the content checks) and then PUT different bytes of the same length and type.
- **Fix:** the import worker re-hashes the file and fails the import if it no longer matches the SHA-256 recorded at `complete`.
- **Test:** `uploads.test.ts` › "the worker refuses a file replaced after it was checked". Seen failing with the check removed: **yes**.

### A-PV-007 · P2 · RL · Uploads have no rate limit
- **Where:** `POST /v1/uploads`, `POST /v1/uploads/:id/complete`
- **Evidence:** a user can create unlimited 10 MB upload intents. Storage cost is bounded only by the 1 h cleanup. The PRD's "Import 3/day" (§24.4) is not enforced on `POST /v1/imports` either (as before PV).
- **Fix:** `DEFERRED → Part 15` (one limiter layer, per the method).

### A-PV-008 · P2 · Stored files outlive their owner and their purpose
- **Where:** `uploads` rows cascade with the user; the objects (`uploads/<user>/…`) do not. Consumed import files (`imports.file_key`) are kept forever.
- **Fix (D-PV-3, decided):** the daily `storage.cleanup` deletes an import's file `IMPORT_FILE_RETENTION_DAYS` (30) after the import finished (completed or failed) and clears `imports.file_key`. It never touches a running import. There is no import-undo window, so "the later of 30 days and the undo window" is 30 days; the constant's comment says to take the later one if an undo window is added. Replaying the upload after that returns 409 `upload_consumed`.
- **Deleted accounts:** `DEFERRED → Part 15` retention sweep. Account deletion does not exist (no `DELETE /me`); Part 15 already lists "imports' uploaded files" under retention. At deletion, the objects under `uploads/<user>/` and `exports/<user>/` must go too, since the rows cascade and the objects do not.
- **Test:** `uploads.test.ts` › "deletes an import's file 30 days after the import finished, not before, and never while it runs (D-PV-3)": 31 days completed and 31 days failed are deleted; 29 days and still-processing are kept.

### A-PV-009 · P3 · The Sentry call had no timeout
- **Where:** `telemetry/sentry.ts` (before): a fire-and-forget `fetch` with no signal
- **Fix:** 5 s `AbortSignal.timeout` in the adapter; failures return null.
- **Test:** `error-reporter-contract.test.ts` › "an unreachable or failing Sentry returns null instead of throwing".

## Performance

Not measured on the real database. The new request paths are primary-key or indexed lookups:

| Endpoint | Queries | Notes |
|---|---|---|
| `POST /v1/uploads` | 1 insert | presigning is local computation (no provider call) |
| `POST /v1/uploads/:id/complete` | 1 select (PK) + 1 update | plus one `head` and one streamed read (≤ 10 MB) against storage: a network cost proportional to the file, once per upload |
| `POST /v1/imports` | select … FOR UPDATE (PK) + duplicate lookup (`imports_user_hash_idx`) + insert + update + job insert, one transaction | the replay path adds one lookup on `imports` by (user_id, file_key) through `imports_user_idx`, per user |
| `GET /v1/exports/:id/download` | 1 select (PK) | plus one `head` against storage; the file is no longer streamed through the API |
| `storage.cleanup` | partial index `uploads_cleanup_idx` on live rows only; batches of 500 | exports: `(file_key IS NOT NULL AND expires_at < now())` has no index; the table is small (one row per export request) |

## Behaviour changes

- `POST /v1/imports` takes JSON `{upload_id, source, force?}`. Multipart → **415**. Missing or unknown `source` → **422** (was 400 `missing_source` / `invalid_source`). New codes: 404 (not your upload), 409 `upload_not_complete`, 410 `upload_expired`, 409 `duplicate_import` (as before; the upload stays reusable). A replay with the same upload → **200** with the same import.
- The 10 MB limit is a **413 `file_too_large` at `POST /v1/uploads`**, before any byte is sent. An empty file is a 422 there (was 400 `empty_file`). A wrong type is a **415 `unsupported_content_type`**. A binary file labelled CSV is a **422 `upload_invalid_content`** at complete (it used to be accepted and failed later in the worker).
- New routes: `POST /v1/uploads` and `POST /v1/uploads/:id/complete`. `PUT|GET /v1/storage/object` exists only with the disk or memory adapter, and is hidden from the spec.
- `GET /v1/exports/:id/download` → **302** to a 5-minute storage URL, with `cache-control: no-store` and `referrer-policy: no-referrer` (was a 200 with the file).
- Any request body type with no parser → **415** (was 500).
- Uploads never consumed are deleted after 1 h; export files after their 48 h link; an import's uploaded file 30 days after the import finished (D-PV-3).
- **Deployment:** production must now set `STORAGE_DRIVER=s3` (+ S3 credentials), `EMAIL_DRIVER=smtp` (+ `SMTP_URL`, `EMAIL_FROM`) and `PUSH_DRIVER=expo`, or the API and worker exit at start. `SENTRY_DSN` alone does nothing (it never did); set `ERROR_DRIVER=sentry`.
- api-client: `uploadImport` and `UploadImportOptions` removed. New: `createUpload`, `completeUpload`, `uploadFile`, `createImport`, `cancelPendingUploads`, and `ClientConfig.uploadFetch`.
- Mobile: the import screen shows upload progress. "Import anyway" reuses the upload. Logout cancels uploads in flight.

## Decisions (made by the owner, 2026-09-26)

- **D-PV-1 · Presigned PUT (exact length) vs POST policy: keep PUT.** `createUpload({…, contentLength, …})` binds the exact declared length and type; the policy maximum is checked before signing. The `{url, method, headers, fields?}` shape still allows a POST adapter. (That R2 lacks POST Object is my belief, not verified here.)
- **D-PV-2 · Keep the read in `complete`, hashing while streaming: it already did.** `UploadService.#scan` feeds each chunk to SHA-256 as it arrives, keeps at most the first 8 KB for the sniff, and stops one chunk past the declared size. It never holds the object. The s3 adapter returns the SDK's response stream. **The disk adapter did not stream:** its `getStream` read the whole file into memory, then wrapped it. It now returns an `fs.ReadStream` (test: "disk specifics › getStream streams the file (several chunks)…"). The memory adapter is in memory by definition. The import *worker* still reads the whole file (≤ 10 MB): the CSV parser takes a string.
- **D-PV-3 · Consumed import files: deleted 30 days after the import finishes, or at the end of the import-undo window if later; a deleted account's files at deletion time.** Implemented, except account deletion, which → Part 15 (see A-PV-008).
- **D-PV-4 · Keep the vendor-import rule as a test.** `src/test/providers.test.ts`.

**MinIO in CI.** The `s3 (MinIO)` contract block is skipped when nothing listens on `localhost:9000`, as on GitHub's runners. It says so: a `[storage-contract] s3 (MinIO) SKIPPED …` warning, and each skipped test is named `s3 (MinIO) -- SKIPPED: not reachable at localhost:9000 > …`. The mocked-client s3 block has no skip condition and always runs. Checked here by stopping `flyleaf-minio`: 31 passed, 10 skipped (the MinIO block only). MinIO was restarted afterwards.

## Deferred (with reason and owner part)

- Upload and import rate limits → **Part 15** (A-PV-007, `RL`).
- Objects of deleted users → **Part 15** retention sweep (account deletion is not built) (A-PV-008).
- Expo push **receipts** (the second, delayed call that reports delivery) → **SO-30**, which owns the device-token table they update.
- `CatalogSource.lookupIsbn/Work/Author` have no production caller yet (built for the declared scope, contract-tested only).
- Parts 07 and 12 should audit the new upload path (the PENDING.md run order says so).
