# Pending work outside the numbered audit parts

Written 25 Sep 2026, while Part 04 was running. Nothing in this file is done yet. Delete each item when it lands.

## Run order

| When | Item | Why then |
|---|---|---|
| Done 27 Sep | Part 08 (findings/08-catalog-reading.md; migrations 0026 + 0027 on both databases; `reads_work_idx` built) — was: Part 08 as normal (Part 07 done 26 Sep and hands Part 08 several items: see `findings/07-mobile-foundation.md` › Deferred. Part 12 still audits the presigned upload path; see `findings/PV-providers.md`) | |
| **Next** | **Part 03c** (`03c-dedupe-followup.md`) | Part 08 adds the `reads.work_id` index; the 03c dry run scans `reads` for impact and the stage-3 probe set |
| After 03c | **Part 02d** (`02d-search-real-catalog.md`) | Full DB too; `pir` takes 11–16 s and the panel scores 198/217 on flyleaf (A-08-025). Run it while the full DB is still set up for 03c |
| Then | Parts 09 … 15 | 15 stays last |

## Part 03c — dedupe follow-up (D5, D6, D7)

Prompt file: `03c-dedupe-followup.md`. Run after Part 08, on the **full** database:

```powershell
$env:DATABASE_URL = "postgres://flyleaf:flyleaf@localhost:5432/flyleaf"
```

Then in a fresh window:

```
Read docs/audit/00-method.md and docs/audit/03c-dedupe-followup.md in full, then carry out audit Part 03c end to end. Work autonomously; only stop to ask me if something is destructive. Finish with the summary described in 00-method.md.
```
