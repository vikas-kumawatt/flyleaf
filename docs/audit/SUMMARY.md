# Audit summary

The audit ran from 25 Sep to 10 Oct 2026, in 15 parts plus the providers build (PV). It re-verified every task from `FN-40` to `SO-15` against the PRD and the code. Each part's findings are in `findings/NN-*.md`. Open questions for you are in `DECISIONS.md`. The laptop half of Part 15 is `15b-laptop.md`.

## Totals

There are **432 finding entries**. Three Part 03 ids appear twice, in Part 03 and its follow-up. Part 01's routed leads (L-xx) are excluded; each was re-filed in the part it went to.

The statuses below were counted per finding from its heading and body. "Fixed" includes fixes made in a later part (for example, every RL finding is fixed by Part 15's limiter). "Open" means deferred with an owner. "Note" covers records, accepted decisions and guards.

| | P0 | P1 | P2 | P3 | RL | Unrated (notes, decisions) | Total |
|---|---|---|---|---|---|---|---|
| Fixed | **23** | 131 | 159 | 48 | 9 | 6 | **376** |
| Open | **0** | 3 | 12 | 18 | 0 | 1 | **34** |
| Note | 0 | 0 | 0 | 12 | 0 | 10 | 22 |

The three open P1s:
- A-02d-002, the author arm. Approved, and scheduled after the audit.
- A-11-024, the shelf view counter (`DECISIONS.md` 3).
- A-12-024, manual column mapping for an unrecognised import file.

| Part | Entries | Fixed | Open | | Part | Entries | Fixed | Open |
|---|---|---|---|---|---|---|---|---|
| 02 Search | 29 | 28 | 1 | | 09 Reviews | 45 | 35 | 4 |
| 02d Real catalog | 7 | 5 | 1 | | 10 Profile, stats, telemetry | 32 | 26 | 4 |
| 03 Dedupe | 31 | 25 | 3 | | 11 Shelves | 34 | 30 | 4 |
| 04 Auth | 26 | 25 | 0 | | 12 Import/export | 30 | 25 | 5 |
| 05 Authorization, contract | 23 | 22 | 1 | | 13 Social graph | 21 | 17 | 2 |
| 06 Admin | 30 | 28 | 2 | | 14 Feed | 23 | 20 | 2 |
| 07 Mobile foundation | 40 | 35 | 4 | | 15 Cross-cutting | 23 | 18 | 0 |
| 08 Catalog, reading | 29 | 28 | 1 | | PV Providers | 9 | 9 | 0 |

**Tests:**
- API: about 740 tests (Part 02) grew to **CI_API_AFTER**.
- Mobile: 100 grew to **CI_MOBILE_AFTER**.
- No test was weakened, skipped or deleted. Assertions that pinned behaviour a fix changed on purpose were updated with a comment naming the finding.

**Migrations:** `0019`–`0041`, all hand-written and idempotent. On the laptop, `0034`–`0041` are still to be applied (15b).

## Top 10 findings by impact

1. **Dedupe merged different books** (A-03-004, -005, -021, P0). Stage 1 and stage 2 merged distinct and unrelated books. The monthly job would have run unattended on 1 Oct. Merges are now reversible for 30 days, and auto-merge is off unless a pair passes the D5 rules.
2. **Private things leaked through the feed** (A-08-006, A-09-001, -002, A-11-001, A-14-004, P0). Reads, reviews and shelves made private stayed visible in the feed. A status change without `visibility` made a private read public. "Followed" cards showed blocked people.
3. **Blocks and private items were confirmable** (A-05-001, -002, -004, -005, A-11-015, A-13-005, P0). Denial bodies differed from a random id's, and writes answered 200 where reads said 404.
4. **One account's offline writes replayed under the next account** (A-07-002, -003, P0). The query cache also survived sign-out.
5. **Production could run on a published JWT secret** (A-04-001, P0). The admin console had stored XSS and a session cookie set by page JavaScript (A-06-001, -002, P0).
6. **A batch job could take the database down** (A-03-026). A dedupe statement was OOM-killed and Postgres dropped every connection. Jobs now have their own memory and time budgets and work in key ranges (A-15-004, -005). Proof on the full catalog: 15b.
7. **Features were never wired in** (L-03, PV-06, A-14-002, A-15-001):
   - imports sat in `queued` forever;
   - Sentry was never on;
   - feed affinity was never passed in;
   - telemetry posted to a route that did not exist.
8. **The interaction budgets were a false green** (A-10-003). The app invented durations and a constant tap count. Budgets are now measured, and `book_logged` counts taps (A-15-010).
9. **The feed lost and repeated cards, and never ended for 1–3 follows** (A-14-001, -003). Popular had no popularity signal. Now every card is served once, and Popular follows D-14-1 (A-15-003).
10. **Almost no rate limits** (L-07 and about 30 RL findings). Four call sites existed. Now one layer covers PRD §24.4, §11.7 and §10.6, with 429 + `Retry-After` and a measured cost (A-15-002).

## Performance, before and after

TBD in 15b: three lines from `perf/comparison.md`, giving the pass/over-budget count and the biggest changes, plus the step-12 dedupe run under the memory limit.

Until then, every after-number in Parts 11–15 is **sandbox, synthetic**:
- the friends feed for `heavy`: p95 494 → 161 ms (Part 14);
- rate-limit overhead: Global in process within noise, Global in Postgres −26–35 % throughput (Part 15).

## Decisions waiting on you (`DECISIONS.md`)

1. Drop the unused `authors_search_trgm_idx` (938 MB) once 15b confirms `idx_scan = 0`.
2. Ratings from new or unverified accounts, imports included: decide with the §9.7 fast-follow (SL-62b).
3. The shelf view counter: keep it as a spec gap for now (recommended), or build it.
4. Same-name author records: decide after 15b's count and sample.
5. Dedupe groups of more than two: sample, then write a rule.

Also: confirm or change **D-15-1 … D-15-7**, the reversible choices Part 15 made (limit stores, two numbers the PRD has no row for, the exposure cap, the guest searcher id, `import_rows` trimming, the comment purge). Add the 13-month event retention to the privacy policy.

## Check by hand on the device

The per-part lists in findings 07, 08, 09, 10, 11 and 12 have the exact steps. Here they are merged; each group says whether it needs the native rebuild (README › Native changes waiting for a rebuild).

**Needs the dev-client rebuild:**
- Offline state bar; queued likes and follows, with coalescing (07 13–18).
- Date-of-birth prompt and emailed links (07 19–20).
- Avatar: library, camera, remove (10 1).

**JS reload is enough:**
- **Sync and accounts** (07 1–3, 9–11): an offline start keeps you signed in. Offline progress says "will sync". An account switch shows none of A's books. Guest-shelf migration. "Couldn't sync" shows a reason and Retry. New in 15a: a 429 holds the write and it syncs later. It is not a "Couldn't sync".
- **Auth screens** (07 4–8): link pages, the unverified banner and prompt, guest gates, the private-profile request, the username check.
- **Reading** (08): one save per slider drag; the book page's empty states and histogram; the explicit interstitial shows once; a finish after midnight is dated today; the want queue's Remove; the scanner's single lookup; author pages; the edition picker.
- **Reviews** (09 1–8): drag-rating with haptics; tap to clear; sheets close on swipe; edit vs new review; the review on an unlogged book; the spoiler page cleared; rating-count rules; a long draft survives a kill.
- **Profile and stats** (10 2–7): another user's Wall; the stats layout and streak; undated Diary entries; "Did you mean"; the content setting; the under-13 refusal.
- **Shelves** (11 1–8): show more past 100; reorder; ranked numbering; restore; the duplicate-add tick; the duplicate-name prompt; saved paging; a private shelf leaves the feed.
- **Import/export** (12 1–5): accented titles; a re-import doesn't duplicate; the banner stops; the CSV opens with formulas shown as text; resolve twice is refused.
- **Feed (15a):**
  - Home › Popular shows only reviews and finishes from the last two weeks, and a reader with many likes ranks above a newer quiet one.
  - Search → book → "Want to read" sends `book_logged` with 2 taps. Check it in the admin budgets at `/v1/admin/telemetry/budgets`.

## Recommended order for what is still open

1. **15b on the laptop**: migrations, the after bench, the full-catalog job and dedupe runs under the memory limit, and the §6 verification (`15b-laptop.md`). Everything else assumes those numbers.
2. **Your decisions** above, especially 1 (frees 938 MB) and 4 (needs 15b's count).
3. **Before launch**, already in `PENDING.md`:
   - the author arm (A-02d-002, with LA-05);
   - the dedupe backlog, in batches, now safe under A-03-026's budgets;
   - the 0019 rollout plan.
4. **Device sweep**: the checklist above. Then the UI items left open:
   - colour literals (A-07-021);
   - the email-exists next step (A-07-031);
   - reviews "load more" (A-09-033);
   - optimistic social state (A-07-040);
   - Diary and Wall gaps (A-10-026, -030).
5. **Post-audit engineering**:
   - manual import column mapping (A-12-024);
   - admin catalog search (A-06-025);
   - `openapi-typescript` client types (A-05-021);
   - a React Native test renderer, to replace the tautological Phase 1 tests (A-07-026);
   - prepared statements (Part 14);
   - registration's mail-after-commit (A-04-024 rest).
6. **With later features**:
   - the §9.7 exclusion (SL-62b);
   - provenance locks (A-06-027, with §6.46 corrections);
   - the TRUNCATE-less API role (A-06-017, with LA-05);
   - Redis for the in-process limits (when a second instance exists).
