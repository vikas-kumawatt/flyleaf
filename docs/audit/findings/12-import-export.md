# Audit 12 — Import and export (IM-01 … IM-12)

2026-10-10 · CI: **green in 1,135 s**, all 9 steps (sandbox, `FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs`, Postgres 18.3 and MinIO reachable) · Tests: API **1,502 → 1,547** (+43 in the new `import-export-audit.test.ts`, +2 in `authorization-equivalence.test.ts`); mobile **182 → 187** (+2 `export-download.test.ts`, +3 `import-polling.test.ts`). No test was weakened or skipped. Existing assertions that pinned behaviour this part deliberately changed were updated, each with a comment naming the finding (list under "Behaviour changes" › "Tests changed").

**How this part ran.** In a cloud sandbox (Linux), not on the laptop. Overrides from the owner for this run:

- **No `flyleaf` / `flyleaf_dev`.** A local **PostgreSQL 18.3** (the `@embedded-postgres/linux-x64@18.3.0-beta.16` npm package; apt is blocked by the sandbox proxy) on port 5432 with an empty `flyleaf` database. `npm run migrate` ran clean on it, including 0035.
- **MinIO ran for real.** `dl.min.io` is blocked, so the standalone server was built from source through the Go module proxy (`go install github.com/minio/minio@RELEASE.2025-04-22T22-12-26Z`) and run on :9000 with the compose credentials. The **10 S3 contract tests that skip without MinIO ran and passed** (`storage-contract.test.ts` 41/41), so the presigned upload path (PV-0x) was exercised against a real S3 server, not only the memory/disk adapters. The new audit tests run on the **disk** adapter's signed URLs (the brief: not only memory).
- **No 3.2M-work catalog.** Matching cost was judged by statements per row, query plans and a same-machine before/after ratio on a **synthetic catalog of 300,000 works** (50,000 authors, one author each, 240,000 editions with valid ISBN-13s, trigram index as in production) loaded into the sandbox database. **Every latency number below is "not measured on flyleaf — rerun on the laptop"**; only ratios, plan shapes, buffer counts and statement counts are evidence.
- **Migration 0035** applied to PGlite (every test) and the sandbox Postgres only. **Not applied to `flyleaf` or `flyleaf_dev`** (see Deferred).
- Branch `audit/12-import-export` from `main`, committed, pushed, PR to `main`.

**"Seen failing".** The two changed test files were copied onto unmodified `main` (a separate worktree) and run there: **38 of the 43 tests in `import-export-audit.test.ts` fail on `main`**, and the new D-05-3 matrix in `authorization-equivalence.test.ts` fails (7 cells leak). The five that pass on `main` are guards that confirm a claim held, each named in its section: the quoted header after a BOM, "imports write no activity" (IM-07), the `../../` filename, the empty file / `.xlsx`-named-`.csv` refusal, and the disk-adapter processor read. The mobile helpers are new (the behaviour lived inline in components); their findings give the code-reading evidence.

## Items handed to Part 12 by earlier parts

| From | Item | Outcome |
|---|---|---|
| 01 L-03 | Imports/exports created through the real API were never processed | **Holds.** `server-wiring.test.ts` passes; imports enqueue with `sendInTx` in the upload-consuming transaction (PV-02). Exports did **not**: A-12-020 |
| PV-providers | Audit the presigned path: ownership, size/type from `head()` and magic bytes, expiry, `consumed` with the enqueue, streaming, cleanup, disk adapter | Verified (table below). One gap: UTF-16 files were refused at `complete` (A-12-004) |
| 05 D-05-3 | Unverified authors' imported reviews | **Built:** A-12-013 |
| 08 | Export includes `dnf_note` | **Done:** A-12-018 |
| 02 A-02-027 | Does the import matcher use `authors_name_trgm_idx` / `authors_search_trgm_idx`? | **No.** The matcher's author test is equality/`LIKE` on the authors of title candidates, reached through `work_authors` by work id; the plans below use neither author trigram index. Part 15 may drop them as far as imports are concerned |
| README | CSV export formula injection | **Fixed:** A-12-015 |

**Presigned upload path (PV-0x), checked:** another user's upload id → 404 with the random-id body (`uploads.test.ts`); size refused at intent (413 at 10 MB + 1) and re-checked at `complete` against `head()` and the streamed byte count; type judged by magic bytes, not the label (a PDF or an `.xlsx` named `.csv` → 422, deleted); an expired upload 410 to complete and to consume; a pending upload 409 to consume; `consumed` set in the same transaction as the import row and the `sendInTx` job (a double submit returns the same import with 200; a failed enqueue leaves no import and a reusable upload); the worker re-hashes the object and refuses a file replaced after `complete`; cleanup removes expired uploads and their objects, export files past 48 h, and import files 30 days after the import finished. The worker reads through `getStream()` but buffers the (≤ 10 MB) file to hash and decode it; BOMs and encodings now hold on that path (A-12-004).

## Verdict per task

| Task | Claimed | Verified | Findings |
|---|---|---|---|
| IM-01 | imports, import_rows, exports tables | ✅ as described; the export token column was plaintext (A-12-016) | A-12-016 |
| IM-02 | upload → job id, returns immediately | ✅ PV-02 path verified (above); UTF-16 refused | A-12-004 |
| IM-03 | declarative maps, RFC 4180 parser, transformers | ❌ UTF-8 only (Windows-1252 mojibake); an unclosed quote garbled the rest of the file; `2023/02/30` passed and failed the whole import; Date Added/Entry Date read as start dates; the declared source was never checked against the columns, an unrecognised file "completed", a header-only file "completed, 0 books" | A-12-004, -005, -006, -008, -019 |
| IM-04 | six source maps | ❌ checked against the exporters' own code where public: OpenReads and Open Library maps did not fit their real exports (to-read imported as finished; Open Library: every book want-to-read, no ratings); Calibre published the book's blurb as the reader's review; Goodreads spoiler flag ignored | A-12-007, -008, -009, -011, A-12-029 |
| IM-05 | ISBN → title+author → fuzzy, ambiguous never guessed | ❌ the ISBN stage guessed (most popular of two works); a merged work's key missed; `_`/`%` in names were wildcards; exact and fuzzy stages seq-scanned the catalog per row (~70× slower than now on 300k works) | A-12-002, -003, -014 |
| IM-06 | My Rating = 0 → NULL, quarter stars, 10-point | ✅ 0 → NULL everywhere; StoryGraph quarter stars round to half stars; no source uses the 10-point scale (Calibre's catalog already halves its 0–10) | — |
| IM-07 | `source='import'`, no activity | ⚠️ no activity rows (guard test); but every re-import or overlapping export added a second attempt of every book; import shelves filled deleted shelves and ignored the caps | A-12-001, -010 |
| IM-08 | chunked, resumable, progress | ⚠️ resumable and atomic per chunk (a crash between a read and its `import_rows` row is impossible: same transaction); `total_rows` set before matching; but one refused row failed the import, and statements per row were ~5.6 | A-12-006, -014 |
| IM-09 | screen, banner, review queue | ❌ resolving a resolved row to another work added a second read; skipping a matched row left its read and broke the counters; an unknown work 422 (FK) instead of 404; a merged work stored the loser; the banner looped requests after completion and is not on Home | A-12-012, -022, -023 |
| IM-10 | CSV/JSON export, emailed link, round trip | ❌ formula injection; §26.4 data missing (progress, follows, DNF fields, heart, visibility) and deleted content exported; one query per shelf; token stored in the clear and not single-use as claimed; enqueue outside the transaction | A-12-015, -016, -017, -018, -020 |
| IM-11 | duplicate detection by content hash, force, per user | ✅ per user, `force` reuses the upload, failed imports don't block (existing tests); what `force` did was the problem (A-12-001) | A-12-001 |
| IM-12 | real library ≥ 85 % matched, round trip | ⚠️ the "real" fixtures are hand-made (25 + 5 rows) against a hand-seeded catalog, not a real export; the round trip lost start dates and spoiler flags (fixed) | A-12-030 |

## Findings

### A-12-001 · P1 · Re-importing (or importing an overlapping export) doubled the library
- **Where:** `imports/committer.ts` `commitImportRow` (before: `attemptNo = max + 1`, always insert).
- **Evidence:** import a file, then the same file with `force: true` → two reads of every book (attempt 1 and 2, both finished, both rated). A newer Goodreads export (different hash, so no duplicate warning) does the same for every book already imported. A book logged in the app (`reading`) got a second, `finished` attempt from the import. Every finished count, rating and reader stat doubles.
- **Spec:** PRD §6.8 / §34.4 "Duplicate import → detect and offer merge or replace"; §8.1 attempts are re-reads.
- **Fix (decision D-12-1, safest reversible):** **merge**: an imported row for a work the reader already has (any attempt, any source) changes nothing and is recorded `matched` with `failure_reason = 'already_in_library'`. The check and the insert are one statement under the app's per-(user, work) attempt lock (SL-56), so a concurrent app log cannot race it. "Replace" is not built (D-12-1).
- **Test:** *importing the same file again with force creates no second attempt*, *a book already logged in the app is left as the reader logged it*. Seen failing before the fix: yes (2 reads).

### A-12-002 · P1 · The ISBN stage guessed; a merged work's key matched nothing
- **Where:** `imports/matcher.ts` stage 1 (before: `ORDER BY log_count DESC LIMIT 1`), stage 2 (`merged_into_id IS NULL` on the keyed work).
- **Evidence:** an ISBN carried by editions of two different works (a catalog duplicate) matched the more popular one at confidence 1.0; a row whose ISBN-10 and ISBN-13 point at different works did the same. An Open Library work key of a merged (loser) work found nothing and fell through to the title stages.
- **Spec:** AC-9 / PRD §34.4: ambiguous matches go to review, never guessed.
- **Fix:** stage 1 collects every live work carrying any of the row's ISBNs; more than one → `unmatched`, `ambiguous_match`, candidates listed (a title match does not override it). Stage 2 resolves the keyed work through `resolveWorkId` to the survivor. Editions are moved to the survivor by the merge (Part 03), so ISBNs already land on it. **Unmeasured on the real catalog:** how many real rows become ambiguous because two unmerged duplicate works share an ISBN (rerun on the laptop, A-12-014's bench reports matched/unmatched).
- **Test:** *an ISBN carried by editions of two different works is ambiguous…*, *ISBN-10 and ISBN-13 … different works is ambiguous*, *an Open Library work key of a merged work resolves to the survivor*. Seen failing before the fix: yes (all three).

### A-12-003 · P2 · `_` and `%` in an author name were wildcards
- **Where:** exact title+author stage (`ILIKE '%' || author || '%'` both ways, unescaped).
- **Evidence:** author `_` matched "Joanna Baillie": the row was imported as that book with confidence 0.92.
- **Fix:** both directions escape `\ % _` (`ESCAPE '\'`), as Part 11 did for browse.
- **Test:** *LIKE metacharacters in an author are literal*. Seen failing before the fix: yes.

### A-12-004 · P1 · Only UTF-8: Windows-1252 exports were mangled, UTF-16 refused
- **Where:** `processor.ts` (`toString('utf-8')`), `parser.ts`, `uploads/index.ts` `looksLikeText`.
- **Evidence:** a Windows-1252 file: `Les Mis�rables`, `The Handmaid�s Tale` (U+FFFD in titles, so no exact match, and in reviews). Excel's "Unicode text" (UTF-16 with BOM): `/complete` → 422 "not a text export" (its NUL bytes).
- **Fix:** `decodeCsvBytes`: a BOM decides (UTF-8, UTF-16LE/BE); otherwise strict UTF-8, falling back to Windows-1252, decoded by a hand table for 0x80–0x9F because **Node's `TextDecoder('windows-1252')` decodes that range as Latin-1 control characters** (’ – € became invisible C1 codes). The sniff accepts a UTF-16 BOM file when its decoded head has no NUL.
- **Test:** *decodes a Windows-1252 export…*, *decodes UTF-16 with a BOM*, *a UTF-16 file passes /complete*. Seen failing before the fix: yes (all three). Guard: *a UTF-8 BOM before a quoted header* (passed before).

### A-12-005 · P2 · One stray quote garbled the rest of the file
- **Where:** `parser.ts` (before: a `"` anywhere toggled quoting).
- **Evidence:** `"Two,B\nThree,C\nFour,D` parsed as one field to the end of the file. In a Goodreads file (every row has quotes) the parity flipped for every later row.
- **Fix:** a quote opens a quoted field only at the start of a field (RFC 4180); elsewhere it is a character. A quote still open at the end of the input: the row it opened on is taken as one literal line, marked malformed (`import_rows.failure_reason = 'malformed_row'`, never matched), and parsing resumes on the next line. A broken row in the middle can absorb its neighbour (CSV cannot tell), then the parser resynchronises.
- **Test:** *an unclosed quote spoils one row…*, *a broken row in the middle spoils itself and its neighbour, not the rest of the file*, *an unclosed quote on the last row is reported as malformed_row*. Seen failing before the fix: yes.
- **Also checked:** ragged rows (missing cells are empty, extra cells ignored), CRLF/CR/LF, trailing newline. Size is bounded by the 10 MB upload limit; the parser is linear: 50,000 rows (10.8 MB) parse in 1.07 s, a 1 MB single field in 0.13 s (sandbox).

### A-12-006 · P1 · One bad row failed the whole import
- **Where:** `transformers.ts` `isValidDate` (any day ≤ 31) and `parseDate`'s `new Date()` fallback; `processor.ts` (a chunk is one transaction, any error fails the import).
- **Evidence:** `Date Read = 2023/02/30` reached the `date` column, aborted the chunk and marked the import `failed`; every other row was lost. (The `Date()` fallback also rolled `2023/02/30` over to March 2 in some shapes.)
- **Fix:** calendar validation (days in the month, leap years); a numeric date that is not a real day is no date. A chunk the database refuses is redone with each row in its own savepoint; a refused row is recorded `unmatched`, `commit_failed`, and the import continues.
- **Test:** *an impossible calendar date in one row does not fail the import*, *one row the database refuses is recorded and the import goes on* (a one-shot trigger refuses one book). Seen failing before the fix: yes (both: import `failed`).

### A-12-007 · P1 · OpenReads: to-read books imported as finished; reviews, dates and formats ignored
- **Where:** `configs/openreads.ts`, checked against OpenReads' exporter (`lib/core/helpers/backup/csv_export.dart`, fetched for this audit).
- **Evidence:** OpenReads writes `status` = `finished | in_progress | planned | abandoned | unknown`, `my_review`, `book_format`, `readings` (`start|finish|ms;…`), `olid`, tags joined by `|||||`, and `deleted`. The map knew none of `planned`/`in_progress`(as written)/`my_review`/`book_format`/`readings`/`olid`/`deleted`: every planned book became **finished**, reviews and dates were dropped, books in the app's trash were imported.
- **Fix:** all of the above mapped; `deleted=true` rows are recorded `skipped` (`excluded_by_source`); `olid` (an edition key) feeds stage 2.
- **Test:** *OpenReads: planned is want-to-read, my_review is the review, readings give the dates, deleted rows are skipped*. Seen failing before the fix: yes.

### A-12-008 · P1 · Open Library: every book want-to-read and unrated; files never checked against their source
- **Where:** `configs/openlibrary.ts`, checked against Open Library's `ReadingLogExport` (`openlibrary/plugins/upstream/account.py`); `processor.ts`.
- **Evidence (Open Library):** the reading log's columns are `Work ID, Title, Authors, …, Edition ID, …, Bookshelf, My Ratings, …`, with `Bookshelf` = Want to Read / Currently Reading / Already Read / Stopped Reading and authors joined by ` | `. The map read none of `Bookshelf`, `My Ratings`, `Work ID`: every book was imported as **want**, unrated, matched by title only.
- **Evidence (any source):** the processor used the declared source's map without looking at the columns. A StoryGraph file declared as Goodreads imported its to-read books as finished; `foo,bar` "completed" with every row unmatched; a header-only file "completed, 0 books".
- **Fix:** Open Library columns and values mapped. The processor picks the source whose required columns are all present and whose signature columns fit best, the declared one winning ties, and records the source used. No source fits → `failed`: "Unrecognised file: its columns do not match any supported export (found: …)". No rows → `failed`: "no books in it". Goodreads' required columns no longer include `Book Id` (Flyleaf's own export has none; the importer never used it).
- **Test:** *Open Library reading log: Bookshelf, My Ratings and Work ID are read*, *a StoryGraph file declared as Goodreads is read as StoryGraph*, *an unrecognised file fails and names the columns*, *a file with only a header row fails…*. Seen failing before the fix: yes (all four).
- **Not built (PRD §6.8 / §34.4 "show detected columns and offer manual mapping"):** A-12-024.

### A-12-009 · P1 · Calibre: the book's description was published as the reader's review
- **Where:** `configs/calibre.ts`, checked against Calibre's catalog writer (`src/calibre/library/catalogs/csv_xml.py`).
- **Evidence:** Calibre's `comments` is the book's description (publisher blurb). It was mapped to the review, so every Calibre book with a description got a **public review under the reader's name** of someone else's copyrighted text. `pubdate` (publication date) was the finish date and `timestamp` (date added to Calibre) the start date.
- **Fix:** no review, no dates from Calibre (it records neither). Ratings: Calibre writes 0–5 (`rating / 2`), as mapped.
- **Decision needed:** D-12-2 (Calibre's default status).
- **Test:** *Calibre's comments are the book's blurb…*. Seen failing before the fix: yes (and it found the review).

### A-12-010 · P2 · Import shelves: deleted shelves filled, caps ignored, duplicate names
- **Where:** `committer.ts` shelves (before: own `slugifyShelfName`, `SELECT … WHERE slug = …` including deleted shelves, `position = item_count + 1`).
- **Evidence:** a tag matching a soft-deleted shelf's slug added the book to the deleted shelf (invisible, restored later with it). A tag `café` with an existing shelf `Café` (slug `cafe`, Part 11 folds Latin diacritics) created a second shelf `café`. A reader at 200 shelves got a 201st; a shelf could pass 1,000 books.
- **Fix:** an import tag reuses the reader's live shelf with that name (any case) or slug; otherwise a new shelf is created as the shelves API creates one (`generateUniqueSlug`, under `lockUserShelves`, refused at 200: the book is imported, the tag dropped). Items go at the end, never past 1,000, never twice, in one statement. Shelf ids are cached per chunk (a tag repeats on hundreds of rows).
- **Test:** *an import tag reuses the reader's shelf of that name, and never fills a deleted shelf*, *imports never take a reader past 200 shelves*. Seen failing before the fix: yes (both).

### A-12-011 · P2 · Goodreads spoiler flag ignored: spoilers published unmarked
- **Where:** `configs/goodreads.ts`, `committer.ts`.
- **Evidence:** Goodreads' `Spoiler` column (`true` on reviews the reader marked) was not read; imported reviews were shown to everyone without a spoiler gate.
- **Fix:** read into `has_spoilers`; Flyleaf's CSV export writes it back (round trip).
- **Test:** *Goodreads: a review marked Spoiler is imported with the spoiler flag*. Seen failing before the fix: yes.

### A-12-012 · P1 · Review queue: a second read on re-resolve, skip after match, 422 for a missing work
- **Where:** `imports/index.ts` `resolveRow`, `skipRow`.
- **Evidence:** resolving a row already resolved to work A, now to work B → 200 and a second read. Skipping a matched row → `skipped` while its read stayed (counters dropped it). `work_id` of no work → **422** (the FK violation mapped by Part 05) instead of 404. A merged (loser) work id was stored as given. No row lock: two concurrent resolves could both commit.
- **Fix:** the row is locked; the work is resolved to the survivor (unknown → 404 "Work not found"); an `edition_id` must belong to that work (422 `invalid_edition`). Only `unmatched`/`skipped` rows commit; the same work again is a no-op 200; another work 409 `import_row_resolved`. Skip only from `unmatched` (409 otherwise). Resolving a work already in the library records `already_in_library` and adds nothing (A-12-001).
- **Test:** four tests in *IM-09 review queue*. Seen failing before the fix: yes (all four). Ownership (another user's import → 404) is covered by the existing `import-review.test.ts`.

### A-12-013 · P1 (decided D-05-3) · Reviews of unverified authors were public
- **Where:** `authorization/index.ts` (`canView`, `canViewWith`, `loadRelationship`, `canViewSql`), `reviews/index.ts` (`visibleReviews`, `getReview`).
- **Evidence:** an unverified account imported a file with a review; the work's review list and `GET /v1/reviews/:id` showed it to strangers and guests.
- **Fix (as decided in Part 05):** in the visibility layer, not the importer. `canView({ isAuthorUnverified })` → only the author; `loadRelationship` returns `ownerVerified`; `canViewWith(…, { authored: true })` and `canViewSql({ authored: true })` (the owner-alive `EXISTS` also requires `email_verified_at`, or the viewer is the author). The two review read paths pass `authored`. Verifying the email shows the reviews with no data rewrite. Reads, ratings and shelves are not authored content and are unaffected.
- **Leak check:** reviews are reached only through those two paths (`grep "FROM reviews"`); imported reviews never get feed activity (`syncReviewActivity` skips `source = 'import'`), so the feed cannot show them; rating aggregates count ratings (reads), not reviews, and there is no review count. Ratings from unverified accounts still count, as an app-logged rating does (D-04-1 allows logging): with §9.7 (Part 15 hand-over).
- **Test:** *hidden from the work list and the review page until the email is verified*; `authorization-equivalence.test.ts` › *canView ≡ canViewSql ≡ oracle with "author unverified" as a dimension (126 cells)* and *non-authored items ignore verification*. The original 63-cell matrix passes unchanged. Seen failing before the fix: yes (7 cells leak).

### A-12-014 · P1 (perf) · Matching scanned the whole catalog per row
- **Where:** `matcher.ts` stages 3 and 4; stage 1 per row.
- **Evidence (sandbox, 300,000 synthetic works, `pg_trgm.similarity_threshold = 0.45` as production sets it):** the exact title+author stage could not use any index (`lower(title) = … OR regexp(…) = …`); the planner scanned `authors` and `work_authors` instead (**4,813 buffers, 167 ms**, both seq scans). The fuzzy stage (`similarity() > 0.40 OR title ILIKE '%…%'`) seq-scanned every work (**Rows Removed by Filter 299,964; 6,005 buffers; 402 ms**). Both grow with the catalog: ×10 on the real 3.2M catalog. Every unmatched row pays both. End to end, 200 rows: **199.9 s, 5.57 statements/row** on `main`.
- **Fix:** candidates come from the trigram index first: exact stage `title ILIKE <escaped title> OR title %> <normalised title>` (word similarity, same index), then the stage's own exact rule; fuzzy stage `title % <title> AND similarity(…) > 0.40`. The dropped `OR ILIKE '%…%'` arm only ever added candidates scoring under 0.40 on title, which can neither be the match (needs ≥ 0.82 total) nor make one ambiguous (margin < 0.15 needs a runner-up ≥ 0.67); at production's 0.45 threshold the `%` arm also drops 0.40–0.45 candidates, for the same reason without effect. Stage 1 runs once per chunk for all its ISBNs. Commits are one statement per read (lock, existence check, insert), one `import_rows` insert per chunk.
- **After:** exact stage **369 buffers, 9.6 ms** (bitmap index scans on `works_title_trgm_idx`), fuzzy stage **303 buffers, 5.4 ms**; under prepared statements (generic plan) the exact stage reads ~1,100 buffers, still index-bound. End to end, 200 rows: **2.9 s, 2.13 statements/row (68× faster)**; 1,000 rows 12.6 s; 5,000 rows 128 s; 10,000 rows 270 s, 2.09 statements/row. `pg_stat_statements` on the 5,000-row run: the exact stage is 65 % of the time (27.8 ms mean, 2,999 calls). **All sandbox timings: not measured on flyleaf — rerun on the laptop** (`npx tsx src/bench/import-cost.ts --rows 5000 --export`, new in this part).
- **Test:** *matching a chunk of rows with ISBNs does not cost an ISBN query per row*: 40 rows, **208 statements before, 50 after** (bound 60). Seen failing before the fix: yes.
- **Remaining:** at 3.2M works the exact stage's word-similarity arm may return many candidates for one-word titles ("Dune"); measure on the laptop before tuning.

### A-12-015 · P1 · CSV export ran spreadsheet formulas
- **Where:** `exports/generator.ts` `escapeCsvField`.
- **Evidence:** a review `=HYPERLINK("http://evil","click")` (or a shelf name `+…`, `-…`, `@…`) was written as is; Excel/Sheets run it when the reader opens their export.
- **Fix:** a cell starting with `= + - @`, tab or CR is prefixed with `'`. The importer removes exactly that prefix (`unguardCell`, only before those characters, so `'Salem's Lot` is untouched), so the export still round-trips.
- **Test:** *neutralises spreadsheet formulas in every cell*, *the guarded review comes back unchanged through re-import (round trip)*. Seen failing before the fix: yes (both).

### A-12-016 · P2 · Export download token stored in the clear; "single-use" claim false; expiry 400
- **Where:** `exports/index.ts`, `exports.download_token`.
- **Evidence:** the 48-hour bearer link to a reader's whole library was stored in plaintext (any read of the table — a backup, a replica — was every recent export), compared with `===`, returned in every `GET /v1/exports` response, and valid any number of times (tasks.md said single-use). An expired link answered 400.
- **Fix:** migration **0035** adds `download_token_hash` and hashes existing tokens in place (links already emailed keep working). The token is made when the file is ready (the 48 h run from then), emailed, and stored only as its SHA-256; compared in constant time. Responses' `download_url` is now always `null`; the app's Download button calls the new **`GET /v1/exports/:id/link`** (owner's session → a 5-minute storage URL). Expired → **410** `export_expired`. A wrong token is the random-id 404. Not made single-use: a failed or interrupted download would burn the link; the 5-minute storage URL is the short-lived part. tasks.md corrected. Tokens never reach logs (`redactUrl` in `server.ts`, Part 05).
- **Test:** *the download token is not stored in the clear; a wrong token is the random-id 404; an expired link is 410*, *the owner gets a short-lived link from the app without the emailed token*; mobile *isExportDownloadable…*. Seen failing before the fix: yes.

### A-12-017 · P2 · Export ran one query per shelf
- **Where:** `generateExportData` (a `SELECT … shelf_items` per shelf; up to 200).
- **Evidence:** 2 shelves: 6 statements; 12 shelves: 16.
- **Fix:** shelves, all their items, reads, progress, authors and follows in a constant 7 statements. The file is still built in memory: 8,244 reads → 643 KB, +8.6 MB heap, 422 ms on the sandbox (not measured on flyleaf — rerun on the laptop; at the 10,000-read scale the brief asks about, memory is not a concern).
- **Test:** *an export costs the same statements for 2 shelves as for 12*. Seen failing before the fix: yes (`16` vs `6`).

### A-12-018 · P1 · Export missed what §26.4 lists, and exported deleted content
- **Where:** `generateExportData`.
- **Evidence:** PRD §26.4 "Full export: reads, progress, reviews, shelves, follows, profile". Missing: progress updates, follows, `dnf_note`/`dnf_reason`/`abandoned_*` (Part 08), the heart, read visibility, read source. Exported: soft-deleted reviews and soft-deleted shelves (and their names in each book's `Bookshelves`).
- **Fix:** JSON version **1.1** adds per read `progress[]`, `hearted`, `visibility`, `source`, `abandonedAt`, `abandonedPage`, `dnfReason`, `dnfNote`, and a top-level `following[]` (username, state, since: the reader's own follows; who follows them is the other accounts' data and is not exported). Deleted reviews and shelves are left out. CSV adds `Date Started` and `Spoiler` (read back by the importer). Nothing of anyone else's: every query is scoped to the reader's own rows.
- **Test:** *exports everything §26.4 lists and nothing deleted…*. Seen failing before the fix: yes.

### A-12-019 · P2 · Wrong and impossible dates: "date added" as the start, dates on want-to-read, dates in the future
- **Where:** Goodreads `Date Added` and LibraryThing `Entry Date` → `started_at`; Calibre `timestamp`; no date sanity.
- **Evidence:** a want-to-read book got `started_at` = the day it was shelved; a book read in 2024 "started" when it was added in 2015 (stats and the diary read it). A finish date next year was stored.
- **Fix:** no start date from Goodreads (it exports none; Flyleaf's own `Date Started` is read), LibraryThing's start is `Date Started`. After mapping: no dates on `want`, no finish on `reading`/`paused`, none later than tomorrow (UTC), start after finish dropped. Ambiguous `03/04/2025`: every supported exporter writes year-first dates (Goodreads/StoryGraph `YYYY/MM/DD`, the others ISO), so the US reading of a hand-made file is kept (P3, recorded).
- **Test:** *Goodreads' Date Added is when the book was shelved…*, *a date in the future is dropped*. Seen failing before the fix: yes (both).

### A-12-020 · P2 · A failed export enqueue left the export "queued" forever
- **Where:** `ExportService.create` (`boss.send` after the insert, error swallowed) — the bug A-PV-004 fixed for imports.
- **Fix:** insert and `sendInTx` in one transaction; a failed enqueue is a 500 and leaves no row.
- **Test:** *a failed enqueue leaves no export queued forever*. Seen failing before the fix: yes.

### A-12-021 · RL · Import 3/day, export 2/day not enforced
- PRD §24.4. No limit on `POST /v1/imports` or `POST /v1/exports` (nor `POST /v1/uploads`, A-PV-007). → **Part 15** (one limiter layer); the replay of an import by `upload_id` must not count twice.

### A-12-022 · P2 · The import banner looped requests after completion
- **Where:** `src/ui/ImportProgressBanner.tsx` (effect depending on `onComplete`), used with an inline arrow in `app/import/index.tsx`.
- **Evidence (code reading):** on completion `onComplete` → `loadImports()` → the parent re-renders → a new `onComplete` → the effect re-runs → an immediate `GET /imports/:id` → completed → `onComplete` again: `GET /imports/:id`, `GET /imports` and `GET /exports` in a loop for as long as the finished banner stays up.
- **Fix:** the polling lives in `src/lib/importPolling.ts` (one fetch, then every 2 s while queued/processing; stops on completed/failed, `onDone` exactly once; stops on unmount and drops a response in flight); the banner keeps the latest callback in a ref and restarts only for another import.
- **Test:** mobile `import-polling.test.ts` (3). New helper (not seen failing; the loop is by code reading).

### A-12-023 · P2 · The banner is not on Home and does not survive a restart; no ETA
- PRD §6.8: "Progress appears as a dismissible banner on Home"; "5,000-book library → chunked processing, ETA shown". The banner exists only on the import screen, in component state. **→ Part 14** (Home is rebuilt there; plan in `14-feed.md`).

### A-12-024 · P1 (spec gap) · No manual column mapping for an unrecognised file
- PRD §6.8 / §34.4: "show detected columns and let the user map them manually". Not built; the import now fails with the columns it found (A-12-008) instead of "completing" with garbage. **Plan (≈ 1 day, post-audit):** `POST /v1/imports` accepts an optional `mapping` (`{title, author, isbn, status, rating, date_read, review, shelves}` → column names) stored on the import; the processor builds a `SourceColumnConfig` from it; the app shows the failed import's columns (from the error, or a new `GET /v1/uploads/:id/columns` reading the first line) with pickers. **DEFERRED → post-audit** (feature, not a fix).

### A-12-025 · P3 · Ambiguity candidates are computed and thrown away
- The matcher builds `candidates` for ambiguous rows; nothing stores them, so the review screen searches again from the title. Storing them needs an `import_rows` column. Left; noted for the review-screen work.

### A-12-026 · P3 · Imported reads count toward `reader_count`/`log_count` and ratings
- Checked, not changed: `refresh_work_counters` counts readers of any source, one per reader per work (now that re-imports no longer add attempts, A-12-001). PRD §14.3 defines `log_count` as the Open Library baseline plus Flyleaf logs; an imported read is a Flyleaf log. Ratings from imports count in `work_stats` like any rating (§9.7 → Part 15).

### A-12-027 · P3 · Retention of import data
- Verified: the uploaded file is deleted 30 days after the import finishes (D-PV-3, test in `uploads.test.ts`); unconsumed uploads after 1 h; export files after 48 h. `import_rows.raw` keeps every row of the file indefinitely (the review queue needs it). Account deletion: `imports`/`import_rows`/`uploads`/`exports` rows cascade; the objects do not (A-PV-008). **→ Part 15** retention sweep (hand-over written).

### A-12-028 · P3 · Import tags lowercase shelf names
- `parseShelves` lowercases tags, so a new shelf from tag `Sci-Fi` is named `sci-fi`. Unchanged (no drive-by); existing shelves are matched case-insensitively (A-12-010).

### A-12-029 · P3 · Formats that could not be verified
- **Goodreads and StoryGraph:** headers match the repo's sample files (hand-made by the previous author, see A-12-030) and public descriptions; not checked against an export made today. **LibraryThing:** its exporter is not public; the map follows LibraryThing's documented CSV columns (`Primary Author`, `Date Started`, `Date Read`, `Entry Date`, `[ISBN]`); LibraryThing also offers tab-separated export, which is **not supported** (a `.tsv` fails as unrecognised). **Calibre, Open Library, OpenReads:** checked against the exporters' source (above). Owner action: export from each service you use and import it (Deferred).

### A-12-030 · P3 · tasks.md claims corrected
- IM-03 "streaming/block" parser (it buffers), IM-04 OpenReads/Open Library/Calibre claims, IM-05 "ambiguous never guessed" (true only for title stages), IM-07 "re-read attempt numbers", IM-10 "single-use emailed token" and "100 % round-trip fidelity" (start dates and spoiler flags were lost), IM-12 "real library" (the fixtures are hand-made: 25 Goodreads + 5 StoryGraph rows against a hand-seeded catalog). Struck through with corrections.

## Decisions

### D-12-1 · Taken (safest reversible): an import merges into the library, it never adds attempts
- **Options:** (a) **merge**: a book already in the library is left as it is, the row is reported `already_in_library` (built); (b) replace: overwrite the existing read with the file's state; (c) new attempt (the old behaviour: doubles the library on every re-import).
- **Why (a):** it never loses or duplicates what the reader logged, and it is what a reader expects from "import my newer Goodreads export". PRD §6.8 asks to "offer merge or replace"; replace overwrites data the reader may have edited in Flyleaf, so it needs a confirmation UI. **Owner:** confirm (a), and whether "replace" is wanted at all (if so: a `mode: 'replace'` on `POST /v1/imports` that updates the latest attempt's status, dates and rating, never deletes; ≈ half a day).

## Decisions needed

- **D-12-1:** confirm merge; replace wanted? (above)
- **D-12-2 · Calibre's default status.** Calibre has no read state; a book with no read-ish tag imports as **finished**, so a 2,000-ebook library becomes 2,000 finished books (goals, stats). Options: (a) keep finished; (b) **want** unless a tag says read/reading/DNF (recommended: a Calibre library is a collection, not a reading log); (c) ask in the app before importing. Left as is until decided.

## Performance

Sandbox PostgreSQL 18.3, synthetic catalog (header). **Not measured on flyleaf — rerun on the laptop**; plan shapes, buffers and statement counts are the evidence.

| Query / run | Before | After | Notes |
|---|---|---|---|
| Exact title+author, one row | seq scans of `authors` + `work_authors`; 4,813 buffers; 167 ms | bitmap index scans on `works_title_trgm_idx`; 369 buffers; 9.6 ms | generic plan: ~1,100 buffers, index-bound |
| Fuzzy title, one row | seq scan of all works (299,964 removed by filter); 6,005 buffers; 402 ms | bitmap index scan; 303 buffers; 5.4 ms | cost now grows with matching titles, not the catalog |
| ISBN stage, 40-row chunk | 40 queries | 1 query | |
| Import, 200 rows end to end | 199.9 s · 1,113 statements (5.57/row) | 2.9 s · 425 statements (2.13/row) | 68× (same machine, back to back) |
| Import, 5,000 rows | — (≈ 80 min at the measured rate) | 128 s · 2.09/row | exact stage 65 % of time |
| Import, 10,000 rows | — | 270 s · 2.09/row | |
| Export, 8,244 reads | 6 statements + 1 per shelf | 7 statements · 422 ms · 643 KB · +8.6 MB heap | built in memory |
| PGlite, 40 ISBN rows | 208 statements | 50 statements | the test's bound: 60 |

## Behaviour changes

1. An import never adds a second attempt of a book already in the library; such rows are `matched` with `failure_reason = 'already_in_library'` (D-12-1). Matched and committed rows are `resolved` as before.
2. New `import_rows.failure_reason` values: `malformed_row`, `commit_failed`, `already_in_library`, `excluded_by_source` (state `skipped`).
3. Imports read Windows-1252 and UTF-16 files; UTF-16 uploads pass `/complete`.
4. The import source is chosen by the file's columns (the declared one wins ties) and `imports.source` records the one used. An unrecognised file fails naming its columns; a header-only file fails ("no books"). A file with `Title, Author, My Rating, Exclusive Shelf` is Goodreads format without `Book Id`.
5. Matching: an ISBN on two works is ambiguous; a merged work's Open Library key resolves to the survivor; `_`/`%` are literal; fuzzy candidates scoring under 0.40 on title are no longer listed.
6. Source maps: OpenReads (statuses, review, format, dates, `olid`, trash skipped), Open Library (`Bookshelf`, `My Ratings`, `Work ID`, ` | ` authors), Calibre (no review, no dates), LibraryThing (`Date Started`), Goodreads (`Spoiler`; no start from `Date Added`; `Date Started` read). No dates on want-to-read, no finish while reading, none in the future.
7. Import tags reuse the reader's live shelf of that name or slug; never a deleted shelf; at most 200 shelves and 1,000 books per shelf.
8. `POST /v1/imports/:id/rows/:rowNo/resolve`: 404 for an unknown work (was 422), survivor for a merged work, 409 `import_row_resolved` for a row already matched to another work, 422 `invalid_edition`. `…/skip`: 409 for a matched or resolved row.
9. Reviews by unverified authors are visible only to the author (work review list and `GET /v1/reviews/:id`), until they verify (D-05-3).
10. Export: formula cells prefixed with `'`; CSV adds `Date Started` and `Spoiler`, and `Date Added` is the read's creation date; JSON `version` `1.1` with progress, follows and the read fields above; deleted reviews and shelves are not exported.
11. Export download: `download_url` is always `null`; new `GET /v1/exports/:id/link`; an expired link is 410 `export_expired` (was 400); the 48 h run from when the file is ready; the emailed token is hashed at rest (0035). `POST /v1/exports` → 500 and no row when the job cannot be enqueued.
12. App: the Download button uses the new link endpoint; the import banner stops polling once finished.

**Tests changed** (assertions pinning behaviour changed above, each commented in place): `export.test.ts` (no token in the row; `download_url` null; token taken from the email; `version` 1.1), `import-committer.test.ts` (the attempt test now asserts `already_in_library`; two tests clear an earlier test's read first), `import-processor.test.ts` (resume test clears an earlier test's read first), `import-mapping.test.ts` (`Book Id` not required; Goodreads/LibraryThing start dates; Calibre review null ×2).

## Deferred (with reason and owner)

| Item | Why deferred | Owner |
|---|---|---|
| **Apply migration 0035 to `flyleaf` on the laptop** (and to `flyleaf_dev` with the other audit migrations at Part 15) | Sandbox has neither; `flyleaf_dev` stays unchanged until Part 15's comparison. Safe any time on `flyleaf` (adds a nullable column, rewrites only rows with a token) | Laptop / Part 15 |
| **5,000-row import against the real DB** — not measured on flyleaf, rerun on the laptop: `npx tsx src/bench/import-cost.ts --rows 5000` (`DATABASE_URL` → `flyleaf`) | No 3.2M catalog here | Laptop / Part 15 |
| **10,000-read export** — not measured on flyleaf, rerun on the laptop: `… --rows 10000 --export` | Same | Laptop / Part 15 |
| Import your own real exports (Goodreads, StoryGraph, LibraryThing if used) and read the unmatched list (IM-12 exit criterion, A-12-029/030) | Needs your files | Owner |
| Manual column mapping (A-12-024) | Feature, ≈ 1 day | Post-audit |
| Banner on Home, restore after restart, ETA (A-12-023) | Home is rebuilt in Part 14 | Part 14 |
| Import/export/upload rate limits (A-12-021) | One limiter layer | Part 15 |
| Retention of `import_rows`, deleted accounts' objects (A-12-027) | Retention sweep | Part 15 |
| Unverified/new accounts' imported ratings (§9.7) | With SL-62b | Part 15 |
| D-12-1 replace mode, D-12-2 Calibre default | Owner decisions | Owner |

## CI result

`FLYLEAF_TEST_WORKERS=2 node scripts/ci.mjs` in the sandbox, with Postgres 18.3 on 5432 and MinIO on 9000: **green in 1,135 s, exit 0.**

1. api-client · build: ok
2. api · typecheck: ok
3. api · spec check: "openapi.yaml is up to date" (drift 0)
4. api · tests: **76 files, 1,547 tests: 1,547 passed, 0 skipped, 0 failed** (1,105 s). The 10 MinIO S3 contract tests, skipped in Part 11's sandbox run, **ran and passed** here. 1,502 + 45 new = 1,547.
5. api · build: ok
6. api · audit (`--audit-level=high`): ok
7. mobile · typecheck: ok
8. mobile · offline tests: **187/187** (182 + 5)
9. api · migrations on a real Postgres: "migrations applied" (sandbox Postgres 18.3, including 0035)

GitHub Actions runs `--strict` on the PR as well (it has no MinIO, so the 10 S3 tests skip there by design).

## Phone checklist (no native change; a JS reload is enough)

1. Profile › Data & imports › paste a Goodreads export that contains an accented title: the title is right and it matches.
2. Import it again with "Import anyway": no book appears twice in the library; the import's review list shows them as already in the library.
3. While an import runs, leave the screen open after it finishes: the banner stops (no repeated spinner/refresh).
4. Request a CSV export, wait for it, tap Download: the file opens; a formula-looking review shows as text in a spreadsheet.
5. Unmatched list: resolve a book, then try to resolve it again to another book: refused with a message.
