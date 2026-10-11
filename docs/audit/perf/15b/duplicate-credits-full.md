# Step 10, A-03-027 duplicate author credits on flyleaf: not measured

2026-10-11, flyleaf under the 3 GiB container limit.

- Attempt 1 (15:10): the count query planned a parallel hash join and failed in Postgres: `could not resize shared memory segment ... to 16777216 bytes: No space left on device` (SQLSTATE 53100). The container's /dev/shm is Docker's default 64 MB (A-15-028).
- Attempt 2 (15:12), the same read-only script with `max_parallel_workers_per_gather=0` for its session: killed by the 300 MB memory guard at 175 MB available after ~50 s. Its server-side statement was then cancelled (read-only; nothing to roll back).

Part 03c's numbers (11,112 works, 12,524 pairs) stand until this runs on a machine with ≥ 16 GB.

## Attempt 1 error

```
D:\Bookmarked\flyleaf\apps\api\node_modules\src\pg-core\session.ts:73
				throw new DrizzleQueryError(queryString, params, e as Error);
				      ^


DrizzleQueryError: Failed query: 
      SELECT count(DISTINCT x.work_id)::int AS works, count(*)::int AS pairs
      FROM work_authors x
      JOIN work_authors y ON y.work_id = x.work_id AND y.author_id > x.author_id
      JOIN authors ax ON ax.id = x.author_id
      JOIN authors ay ON ay.id = y.author_id
      JOIN works w ON w.id = x.work_id AND w.merged_into_id IS NULL
      WHERE lower(btrim(ax.name)) = lower(btrim(ay.name))
params: 
  query: '\n' +
    '      SELECT count(DISTINCT x.work_id)::int AS works, count(*)::int AS pairs\n' +
    '      FROM work_authors x\n' +
    '      JOIN work_authors y ON y.work_id = x.work_id AND y.author_id > x.author_id\n' +
    '      JOIN authors ax ON ax.id = x.author_id\n' +
    '      JOIN authors ay ON ay.id = y.author_id\n' +
    '      JOIN works w ON w.id = x.work_id AND w.merged_into_id IS NULL\n' +
    '      WHERE lower(btrim(ax.name)) = lower(btrim(ay.name))',
  params: [],
  cause: PostgresError: could not resize shared memory segment "/PostgreSQL.1823671390" to 16777216 bytes: No space left on device
    severity_local: 'ERROR',
```
