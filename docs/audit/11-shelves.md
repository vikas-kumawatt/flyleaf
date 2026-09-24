# Audit Part 11 — Shelves and lists (SH-01 … SH-10)

**Read `docs/audit/00-method.md` first.**

Spec: PRD §15 (all; §15.2 model, §15.3 types, §15.5 discovery and ranking, §15.6 constraints), §6.33–6.36, §16.5 public URLs, §26.1–26.2, §29.1 growth loops, §34.3, §43.1. Architecture §3.5 and §3.9.

Code: `apps/api/src/shelves/index.ts` (about 2,000 lines, including the server-rendered OG pages), migration `0013_shelves.sql`, `jobs/index.ts` (`shelves.reconcile`, now scheduled nightly since SO-20); mobile `app/(tabs)/shelves.tsx`, `app/shelf/**`, `app/u/[username]/shelves/[slug].tsx`, `src/ui/{AddToShelfSheet,ShareShelfModal}.tsx`, `src/lib/shelfValidation.ts`. Tests: `shelves.test.ts`, `shelves-privacy.test.ts`, `shelves-migration.test.ts`.

Note: the most recent commit (`55f72e3`) restored a dropped `WHERE` in `ShelvesService.browse` that had let private, deleted and private-account shelves into discovery. **That regression passed CI.** Find out why the tests didn't catch it, and make sure one would now.

## Confirmed leads

1. **Browse ranking's `views` term is hard-coded to 0** (`const viewsScore = 0;`). The claimed PRD §15.5 formula has a `0.20 · log(1+views)` term. No view counter exists, so the formula as implemented is 80% of the spec. Decide: implement view counting (cheap and abuse-resistant: per viewer per day, or sampled) or record it as a spec gap. Either way, fix the tasks.md claim.
2. The SO-15 feed swipe "Want to read" claims `POST /v1/shelves/want-to-read/items`. **No such route exists.** The swipe itself is audited in Part 14. Here, decide how want-to-read relates to shelves (it's a read *status* in PRD §8.2, not a shelf), so Part 14 can wire the swipe to the right endpoint.

## SH-01 — schema and counters

- Triggers keep `item_count`, `save_count` and `cover_work_ids` (the first 4 by position) correct under add, remove, reorder, and a work being merged (Part 03). `reconcile_shelf_counters()` repairs all three. Test drift repair, the way SO-20 tests `reconcile_read_counters()`.
- Constraints: name ≤ 60 (and non-blank after trim?), note ≤ 280, description ≤ 2,000 (DB or API only?), privacy enum, unique `(user_id, slug)`.

## SH-02 — create and edit

- **Slug generation**: unicode names (`Книги 2026`, `本`, emoji-only), names that slugify to empty, reserved slugs (`new`, `edit`, `saved`, `browse`, `mine` would collide with routes), max length. **A concurrent create with the same name** → both compute `slug` → unique violation → 500? Test it with parallel requests and fix it (retry on conflict).
- Renaming: does the slug change? Old share links then break. Check the spec, and if there's no redirect, record it.
- Unranking warning; privacy change effects (saved-by-others, feed activity visibility via `updateActivityVisibility`).
- **Soft delete (30 days)**: is there a job that hard-deletes after 30 days? Is there a restore endpoint? If neither, record it. What do other users who saved it see?

## SH-03 / SH-04 / SH-05 — detail, add-to-shelf, reorder

- Items: pagination for 500+ item shelves (bench "big shelf"). Is it unbounded today? Ranked numbering stays correct across pages.
- Add: an item for a missing/merged work, to a deleted shelf, to another user's shelf (404), a duplicate (409, and the mobile optimistic UI reconciles), and position assignment under concurrent adds (two adds → same position?).
- **Reorder (`PUT /shelves/:id/order`)**: the `work_ids` array must be **exactly** the shelf's current set. Test: a missing id (the item's position becomes?), an extra id not on the shelf, duplicates (claimed 400), an empty array, and 5,000 ids (payload and transaction time). Concurrent reorder + add.
- `GET /v1/shelves/mine?work_id=` membership check cost for a user with 200 shelves.

## SH-06 / SH-07 — my shelves and saves

- Saves are references, so the saver sees updates immediately, **and loses access immediately** when the owner makes the shelf private, blocks them, or deletes it (claimed dynamic privacy).
- **`GET /v1/shelves/saved` runs `canView` per shelf.** Count the queries for a user with 300 saves (N+1?) and measure.
- Saving your own shelf → 400 (claimed). Saving twice is idempotent. Unsaving a shelf you can no longer see → 404 or success? Decide and test.

## SH-08 — browse

- Only public shelves of **public** accounts, not deleted, not from blocked users (either direction) when signed in. Is `mutes` respected? Guests OK.
- **Performance**: the ranking score is computed per row over **all** public shelves, then sorted, with `ILIKE` search on name/description (no trigram index?). With the bench shelves, `EXPLAIN` it and measure. Plan for scale (a precomputed score column refreshed by a job, and a trigram index for search).
- `sort=popular|recent` pagination is stable (a deterministic tie-break).

## SH-09 — privacy on every read path

- Extend the Part 05 matrix to every shelf route: detail, items, by-slug (both aliases), user list, saved list, browse, and the **OG HTML pages** (`/u/:username/shelves/:slug`, `/shelf/:id`). A private shelf's OG page must 404 without leaking the title in any meta tag.
- The private-account hierarchy (claimed). A followers-only shelf for a **pending** follower → 404.

## SH-10 — sharing

- OG pages: every interpolation is escaped (the `escapeHtml` helper escapes `& < > " '`; confirm it's used for **every** field, including `og:image` URLs and cover ids). Check canonical URLs, `al:*` app links, the cache headers, and that a deleted shelf 404s.
- Vanity URL resolution when a username changes (does the old link 404?).
- Mobile share message/URL helpers match the server routes.

## Deliverables

`docs/audit/findings/11-shelves.md`, fixes, tests, perf before/after for browse, big-shelf items and saved, and audit lines under SH-01…10.
