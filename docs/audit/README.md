# Implementation audit — FN-40 → SO-15

Sixteen prompts for Claude Code, one per session. Each part reads `00-method.md` (shared rules, severity, output format) and then its own file. Findings go to `findings/`, perf numbers to `perf/`.

## How to run a part

Start a **fresh** Claude Code session in `D:\Bookmarked\flyleaf` for each part, since the context from earlier parts isn't needed and costs quality. Then paste:

```
Read docs/audit/00-method.md and docs/audit/NN-<file>.md in full, then carry out that audit part end to end. Work autonomously; only stop to ask me if you hit something destructive or a DECISION NEEDED that blocks all further progress. Finish with the summary described in 00-method.md.
```

After each part: review the diff and `findings/NN-*.md`, then commit before starting the next part.

## Order and scope

| Part | File | Tasks | Notes |
|---|---|---|---|
| 01 | `01-baseline-and-bench.md` | — | **Required first.** Baseline CI, bench data + runner, route inventory |
| 02 | `02-search.md` | FN-40…43 | incl. FN-42 ISBN |
| 03 | `03-dedupe.md` | FN-50…52 | merges don't repoint tables added after Phase 0 |
| 04 | `04-auth.md` | FN-60…66 | JWT secret fallback, proxy trust |
| 05 | `05-authorization-and-contract.md` | FN-70…72, FN-80…82 | review visibility leaks, spec generator |
| 06 | `06-admin.md` | FN-90…93 | admin cookie not HttpOnly, CSRF, TOTP replay |
| — | `PENDING.md` → PV-0x | PV-01…08 | **Run after 06, before 07.** Providers + presigned uploads; 07 and 12 audit the result |
| 07 | `07-mobile-foundation-offline-auth-guest.md` | SL-00…05, SL-10…14, SL-20…22, SL-30…33 | 409 swallowed, queue not scoped per user |
| 08 | `08-catalog-screens-and-reading-core.md` | SL-40…44, SL-50…57 | status matrix, attempt races, author page |
| 03c | `03c-dedupe-followup.md` | FN-50…52 | **Run after 08** on the full DB: D5–D7 from Part 03b |
| 09 | `09-ratings-and-reviews.md` | SL-60…64 | §9.7 missing, in-memory review list |
| 10 | `10-profile-stats-telemetry.md` | SL-70…74, SL-80…82 | stats privacy, unauthenticated events |
| 11 | `11-shelves.md` | SH-01…10 | slug races, browse cost, views term = 0 |
| 12 | `12-import-export.md` | IM-01…12 | CSV formula injection, encodings |
| 13 | `13-social-graph.md` | SO-01…06 | docs describe the wrong schema, §11.7 limits |
| 14 | `14-feed.md` | SO-10…15 | pagination skips items, home feed is sample data |
| 15 | `15-cross-cutting-and-wrap-up.md` | all | rate limiting once, perf comparison, docs, SUMMARY |

Parts 02–14 can be reordered if you need to, but **05 before 09, 11 and 13** (they reuse its visibility matrix), **PV-0x before 07 and 12**, **03c after 08**, and **15 last**. Everything not yet done outside the numbered parts is listed in `PENDING.md`. Parts 07 and 14 are the largest; if a session runs out of room, tell it to finish its findings file first, then continue the fixes in a new session with "continue audit part NN from `findings/NN-*.md`".

## Leads confirmed while writing these prompts

Each part lists its leads. These were checked in the code on 24 Sep 2026, not guessed:

- `JWT_SECRET` falls back to a hard-coded dev secret in production (Part 04)
- The admin session cookie is set from JS: not HttpOnly, not Secure (Part 06)
- Review PATCH/DELETE return 403; `GET /v1/reviews/:id` ignores blocks and private accounts; the reviews list ignores private accounts (Part 05)
- The offline queue treats every 409 as success, and it's not cleared per user on logout (Part 07)
- `client_event_id` conflicts silently succeed across reads and users (Part 07)
- Dedupe merges don't touch `shelf_items`, `activity`, `mutes`, favourites or `import_rows` (Part 03)
- CSV export has no formula-injection guard (Part 12)
- Feed cursor pagination skips and repeats items; feed affinity is always 1.0; home feed renders sample data; the want-to-read swipe calls nothing; no 180-day prune (Part 14)
- Shelf browse `views` term hard-coded to 0 (Part 11)
- None of the PRD §24.4 rate limits exist outside auth and comments (Part 15)
