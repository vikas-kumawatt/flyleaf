# Pending work outside the numbered audit parts

Written 25 Sep 2026, while Part 04 was running. Nothing in this file is done yet. Delete each item when it lands.

## Run order

| When | Item | Why then |
|---|---|---|
| Done 27 Sep | Part 08 (findings/08-catalog-reading.md; migrations 0026 + 0027 on both databases; `reads_work_idx` built) — was: Part 08 as normal (Part 07 done 26 Sep and hands Part 08 several items: see `findings/07-mobile-foundation.md` › Deferred. Part 12 still audits the presigned upload path; see `findings/PV-providers.md`) | |
| Done 30 Sep | Part 09 (findings/09-reviews.md; no migration; CI green, 734 s) | |
| **Next** | **Part 09b** (`docs/audit/09b-reviews-followup.md`): latest rating per user in the aggregates, ten half-star histogram buckets, the friends-sort guest cache and capped exact candidates, and why three `flyleaf_dev` works had no stats row | Decided by the owner 30 Sep; before Part 10 because it changes the rating aggregates Part 10's stats read |
| Then | Parts 10 … 15 | 15 stays last |
| Post-audit | **Sample the D5 "groups of more than two" pairs and decide on a rule** (Part 03c: 170,221 pairs held for group size, e.g. *Pandemonium* ×4, *A return to love* ×5; some are true duplicates). Draw ~25 groups, judge them, and write a rule only if it holds on the sample | Needs the review of real groups first; see `findings/03-dedupe.md` › Part 03c |
| Post-audit, after Part 15 and before launch, **with LA-05** | **Copy author names onto `works` (A-02d-002, approved 29 Sep).** A `works` column holding every credited author's name and aliases, with a trigram index, both built concurrently; a batched backfill of the 3.2M rows (no long lock); kept in sync by a trigger on `work_authors` and on author name/alias changes; correct under author and work merges; repaired by a nightly reconcile job like the other counters. Then `by_author` and the ranking's author term read `works` only, and the column joins `works_popularity_idx`'s INCLUDE list. **Acceptance:** the 02d latency set on `flyleaf`, p95 < 300 ms for `war`, `smith`, `king`, `lo`, `har`, `the` after each of 3 ANALYZE rounds (`npm run bench:search-latency`), relevance panel unchanged (`npm run bench:relevance`) | Same rollout shape as LA-05 (a batched online backfill on the full catalog); see `findings/02d-search-real-catalog.md` › A-02d-002 |
| Post-audit, after Part 15 and before launch | **Merge the 94,086-pair dedupe backlog in batches** per README §2d (`npm run dedupe -- --backlog`, 5,000 a batch), reading each batch's 25-pair sample; stop and tighten the rules if 2 or more of 25 are wrong. Every merge is undoable for 30 days | After Part 15 (A-03-026: per-job memory and timeouts), so a batch cannot take the server down |
