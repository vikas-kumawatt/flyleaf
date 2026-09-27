# Pending work outside the numbered audit parts

Written 25 Sep 2026, while Part 04 was running. Nothing in this file is done yet. Delete each item when it lands.

## Run order

| When | Item | Why then |
|---|---|---|
| Done 27 Sep | Part 08 (findings/08-catalog-reading.md; migrations 0026 + 0027 on both databases; `reads_work_idx` built) — was: Part 08 as normal (Part 07 done 26 Sep and hands Part 08 several items: see `findings/07-mobile-foundation.md` › Deferred. Part 12 still audits the presigned upload path; see `findings/PV-providers.md`) | |
| **Next** | **Part 02d** (`02d-search-real-catalog.md`) | Full DB too; `pir` takes 11–16 s and the panel scores 198/217 on flyleaf (A-08-025). Run it while the full DB is still set up for 03c |
| Then | Parts 09 … 15 | 15 stays last |
| Post-audit | **Sample the D5 "groups of more than two" pairs and decide on a rule** (Part 03c: 170,221 pairs held for group size, e.g. *Pandemonium* ×4, *A return to love* ×5; some are true duplicates). Draw ~25 groups, judge them, and write a rule only if it holds on the sample | Needs the review of real groups first; see `findings/03-dedupe.md` › Part 03c |
| Post-audit, after Part 15 and before launch | **Merge the 94,086-pair dedupe backlog in batches** per README §2d (`npm run dedupe -- --backlog`, 5,000 a batch), reading each batch's 25-pair sample; stop and tighten the rules if 2 or more of 25 are wrong. Every merge is undoable for 30 days | After Part 15 (A-03-026: per-job memory and timeouts), so a batch cannot take the server down |
