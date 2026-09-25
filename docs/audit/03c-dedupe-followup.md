# Audit Part 03c — Dedupe follow-up: D5, D6, D7

**Read `docs/audit/00-method.md`, `docs/audit/03-dedupe.md` and `docs/audit/findings/03-dedupe.md` first.** Run this after Part 08 (it adds the `reads.work_id` index this part's impact queries need) against the **full** database. Keep `DEDUPE_AUTO_MERGE` off throughout and do **not** merge anything on the real database.

These are the answers to the decisions Part 03b raised.

## D5 — series volumes that share a title

A stage 1–2 pair auto-merges only if its author + normalised-title group has **exactly two works** AND none of these hold:
- both works are in the same series at **different positions** (`series_entries`);
- any edition title or subtitle carries a **volume marker** (`vol`, `volume`, `#n`, `book n`, `band`, `tome`, a trailing arabic or roman numeral);
- both page counts are known and differ by **more than 25%**.

Everything else goes to review. **Do not** use publication year as a signal: textbook editions ("Computer system architecture" 1976 / 1993) are legitimate merges. Each rule gets a test that fails when the rule is removed; mutation-check them.

## D6 — clearing the backlog

Add or extend a CLI command that merges in batches: `--limit` (default 5000), `--dry-run`, and a sample file of 25 random merged pairs per batch (titles, authors, work ids). The monthly job keeps its 200 cap and is documented as being for **new** duplicates only. Document the backlog procedure in README: run a batch, read the samples, stop and tighten the rules if 2 or more of 25 are wrong; every merge is undoable.

## D7 — review-queue volume

Only enqueue a review pair if either work has user data (reads, shelf items, reviews, favourites) or `log_count >= 100`. Stage 3 gets at most 20% of each run's new queue entries. Stop enqueueing when 500 review items are open. Record every other detected pair in a candidates table linked to `dedupe_runs`, so it can be recomputed or promoted later; do not discard them.

## Then

Run the full-catalog dry run again. Report the new auto-merge, review-queue and candidate counts next to Part 03b's (283,908 auto pairs / 185,557 works; 54,500 + 82,192 to review), plus 25 fresh auto-merge samples, flagging any that look like different books. Update `findings/03-dedupe.md`, the FN-50…52 audit lines in `tasks.md`, PRD §40.3, and remove the 03c section from `PENDING.md`.
