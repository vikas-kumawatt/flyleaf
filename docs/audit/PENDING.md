# Pending work outside the numbered audit parts

Written 25 Sep 2026, while Part 04 was running. Nothing in this file is done yet. Delete each item when it lands.

## Run order

| When | Item | Why then |
|---|---|---|
| Next | Part 07b: implement the owner's answers to D-07-1, D-07-2 and D-07-3 (`findings/07-mobile-foundation.md` › Decisions), with one native rebuild that also takes the Expo patch updates (A-07-022) | Decisions made 26 Sep; kept out of Part 07 on purpose |
| Then | Part 08 as normal (Part 07 done 26 Sep and hands Part 08 several items: see `findings/07-mobile-foundation.md` › Deferred. Part 12 still audits the presigned upload path; see `findings/PV-providers.md`) | |
| **After Part 08** | **Part 03c** (`03c-dedupe-followup.md`) | Part 08 adds the `reads.work_id` index; the 03c dry run scans `reads` for impact and the stage-3 probe set |
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
