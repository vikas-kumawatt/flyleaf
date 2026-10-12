# perf/15c

Every file here **except `laptop-*.txt`** was made in the 15c cloud sandbox and is **sandbox, synthetic**. The sandbox ran PostgreSQL 18.3 with:
- a synthetic catalog: 15.4M authors, 1.5M works, 1.8M credits;
- Part 01's bench set;
- 1M synthetic activity rows.

The numbers are good for plan shapes, buffer counts and same-machine ratios only. The write-up is `findings/15-cross-cutting.md` › 15c.

| File | What |
|---|---|
| `explain-repair-range.sql` | Both arms of the `has_works` repair for one 20,000-author range, 0040 vs 0042, as plain statements. The laptop runs it with `opts='(COSTS)'`. |
| `explain-activity.sql` | The activity statements a review save runs. The laptop runs it with `opts='(COSTS)'`. |
| `seed-activity.sql` | Sandbox only: 1M activity rows owned by bench users, removed by `bench:seed -- --clean`. |
| `explain-repair-sandbox.txt` | A-15-027 / A-15-032: three ranges, before and after, `ANALYZE, BUFFERS`. |
| `explain-rejected-join-sandbox.txt` | A-15-027: the join rewrite that was not kept, and why. |
| `plancache-sandbox.txt` | A-15-027: the sixth call of each arm still gets a custom plan. |
| `repair-sweep-sandbox.txt` | A-15-027: `authors.repair` over all 770 ranges, before and after, with the same drift. |
| `explain-activity-{before,after}-sandbox.txt` | A-15-029: the three statements, before and after `activity_object_idx`. |
| `review-post-{before,after}-sandbox-{1,2,3}.{md,json}` | A-15-029: the bench runner's `review:post`, three runs each. |
| `laptop-*.txt` | Written by `15c-laptop.md` on the laptop (2026-10-12): `migrate-{dev,full}`, `index-valid` (both databases), `explain-{repair,activity}-full` (`flyleaf`), `recreate` (steps 3–4). |
