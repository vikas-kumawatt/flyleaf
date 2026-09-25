# Audit Part 12 — Import and export (IM-01 … IM-12)

**Read `docs/audit/00-method.md` first.**

Spec: PRD §6.8 (onboarding import), **§34.4 import and data edge cases**, §26.4 data rights, §24.4 (import 3/day, export 2/day), §9.3 (rating optional; `My Rating = 0` → NULL), §41.3 UGC, §42 threat model, AC-9 in §49. Architecture §9 (jobs).

Code: `apps/api/src/imports/*` (parser, detector, transformers, `configs/*`, matcher, committer, processor, storage, index) and `exports/{generator,index}.ts`, migrations `0014_imports.sql` and `0015_exports.sql`, `jobs/index.ts`; mobile `app/import/{index,unmatched}.tsx`, `src/ui/ImportProgressBanner.tsx`. Fixtures in `src/test/fixtures/real-library-*.csv`. Tests: `import*.test.ts`, `export.test.ts`, `imports-migration.test.ts`.

## Confirmed leads

0. **L-03 is already fixed. Verify it, don't redo it.** `server.ts` never passed a job queue to the app, so imports and exports created through the real API were never processed. Fixed on 24 Sep before Part 02: `src/server-wiring.ts` holds the production wiring (producer-only pg-boss, storage, mailer), and `src/test/server-wiring.test.ts` fails without it. It was verified end to end on real Postgres: an uploaded CSV import reached `completed` (1 row matched) and an export produced a CSV once `npm run worker` ran. Confirm it still holds, then audit the rest. Note that imports enqueue with `boss.send` **after** inserting the row, not `sendInTx` in the same transaction, so audit that crash window (see IM-02 below).

1. **CSV formula injection in exports.** `escapeCsvField` quotes commas, quotes and newlines but does nothing about cells starting with `=`, `+`, `-`, `@`, tab or CR. A review or shelf name like `=HYPERLINK("http://evil","click")` executes when the user opens their export in Excel. Neutralise it (prefix `'`), **and** check the round trip: IM-10's re-import must strip the prefix again, or 100% fidelity breaks. **P1.**
2. **Rate limits** (import 3/day, export 2/day) are likely absent. Record as `RL` for Part 15.

## IM-02 — upload

- The 10 MB limit returns a proper 413 envelope (claimed). Test 10 MB + 1 byte, an empty file, a wrong content type, a binary file, and a file with a CSV extension that isn't CSV.
- Stored where (`DiskFileStorage`)? The path is derived from ids, not the filename, so `../../` in the filename can't escape (test it). **Retention**: uploaded files contain a user's whole reading history (PII). Are they deleted after processing, or after N days? Does account deletion (LA-01 later) have a hook to find them? Record it.
- A queued import survives an API restart: the pg-boss job is enqueued **in the same transaction** as the `imports` row (`sendInTx`). Verify, because otherwise a crash between them leaves a forever-"queued" import.

## IM-03 / IM-04 — parsing and source maps

- **Encodings**: Goodreads and LibraryThing exports produced on Windows are often **Windows-1252 / Latin-1**, not UTF-8. Feed a Latin-1 file with `é`, `ü` and `’`: does it mojibake, or is it detected? UTF-16 with BOM (Excel "Unicode text")? CRLF vs LF, a trailing newline, a BOM plus a quoted header.
- Malformed rows: an unclosed quote swallowing the rest of the file (does one bad row kill the import, or is it contained?), ragged rows, extra columns, a 1 MB single field, 50,000 rows.
- Header detection: a file matching two sources, renamed headers, a header in the wrong case, and a file with only headers.
- Each of the six configs: test on one real-format sample per source. The repo has real samples for Goodreads and StoryGraph only. Build small realistic samples for LibraryThing, Calibre, OpenLibrary and OpenReads from their documented export formats, and state which fields you couldn't verify.
- Dates: ambiguous `03/04/2025` (US vs EU; which does each source emit?) and dates in the future.

## IM-05 / IM-06 — matching and ratings

- The **ambiguity rule (AC-9: never guess)** holds in every stage: ISBN matching two editions of **different** works, a source id pointing to a merged work (resolve to the survivor), and exact title+author with two works. Fuzzy margin < 0.15 → unmatched.
- ISBNs in Goodreads' `="…"` form, empty `=""`, and ISBN-10/13 both present but pointing to different works.
- `My Rating = 0` → NULL everywhere (claimed); quarter-star rounding (StoryGraph); 10-point scales.
- **Matching cost**: per-row queries (ISBN, then title, then trigram) for 5,000 rows against 3.2M works. Time a 5,000-row import end to end on the real DB. Is matching batched? A trigram search per row can take minutes. Target and record.

## IM-07 / IM-08 — commit and the job

- `source = 'import'` → no activity rows, no notifications later, and `works.log_count`? (It's a popularity signal: should imports count? Check the spec, and see Part 02.)
- **Resumability and duplicates**: chunk 50, resume from `import_rows`. Crash **between** committing a read and recording its `import_rows` state: does the resume create a second read? Simulate a throw at each step. Reads created for a re-imported file with `force=true` duplicate or merge? (IM-11 says a duplicate is allowed with force. What happens to existing reads for the same work: a new attempt, overwrite, or skip? Check the spec.)
- Import rows mapping to a work the user already has: attempt handling is consistent with SL-56.
- Shelves created from import tags: name collisions with existing shelves, and the slug rules (Part 11).
- Progress reporting: `total_rows` is known before processing starts (for a real progress bar).

## IM-09 — review queue and screens

- Resolve/skip on someone else's import → 404. Resolve twice → idempotent. Resolve to a merged work → survivor.
- Mobile: polling stops when complete or failed and when the screen unmounts (no leaks), and the banner survives app restart.

## IM-10 / IM-11 — export and duplicate detection

- Export content: all of the user's data (reads incl. private, since it's their data; reviews; shelves; progress? ratings; hearts; DNF data; dates), and **nothing of anyone else's**. Check §26.4 for what a data export must include.
- **Download security**: `?token=` is random, hashed at rest?, single-use? (claimed "single-use emailed token"), and expires at 48 h. Another user's export id with your bearer token → 404. The token must never be logged (see Part 10 Sentry redaction).
- Large libraries: is the file built fully in memory? Measure a 10,000-read export. Is the file deleted after expiry (a job)?
- Content hash duplicate detection is per user (claimed). Force override works. Failed imports don't block (claimed).

## Deliverables

`docs/audit/findings/12-import-export.md`, the encoding and malformed-file test fixtures, fixes, the end-to-end import timing, and audit lines under IM-01…12.

## Precondition: PV-0x (presigned uploads)

This part runs **after PV-0x** (see `PENDING.md`). If `@fastify/multipart` is still in `apps/api/package.json`, stop and say so: don't patch the multipart upload path, which PV-02 deletes. Audit the new path instead:
- `POST /v1/uploads` → direct upload → `complete` → import consumes `upload_id`: ownership (another user's upload id → 404), size and declared type enforced at `complete` from the object's real `head()` and magic bytes, not from the client's claim; an expired, already-consumed or never-uploaded id is refused; `consumed` is set in the same transaction as the job enqueue (a double submit makes one import).
- The worker reads the CSV through `ObjectStorage.getStream()`: encodings, BOMs and size limits still hold when the file is streamed, not buffered.
- Exports: the worker `put()`s the file; the client gets a short-lived `createDownloadUrl` only after the ownership check; the link expires; the formula-injection guard still applies.
- The cleanup job removes expired or unconsumed uploads **and** their objects; exports have a retention path.
- Run every import/export test against the `disk` adapter's signed URLs, not only `memory`.

## Decided in Part 05: D-05-3, imported reviews from unverified accounts

Imports let an unverified throwaway account bulk-publish reviews, bypassing D-04-1's gate. Fix it in the visibility layer, not in the importer: a review whose author's email is **unverified** is visible **only to its author**. Put that in `canView` and its SQL twin, so imports, the API and any future path are all covered, and verifying the email makes the reviews appear with no data rewrite. The existing canView/SQL agreement test must still pass over all combinations; add "author unverified" as a dimension. Check that the work's review list, rating aggregates and feed don't leak or count these reviews until verification.
