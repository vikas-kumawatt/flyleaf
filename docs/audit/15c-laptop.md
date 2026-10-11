# Audit 15c — the laptop checklist

15c built migration `0042` (A-15-027, A-15-029, A-15-032) and `shm_size: 512m` (A-15-028) and proved them in a cloud sandbox on synthetic data (`findings/15-cross-cutting.md` › 15c). This checklist applies them to the real databases. **No bench runs, no seeding.** About 20 minutes.

Bash (Git Bash or WSL), in `apps/api`. There is no host `psql` on the laptop (A-15-031), so SQL goes through the container. Save every output under `docs/audit/perf/15c/`.

```bash
cd apps/api
DEV=postgres://flyleaf:flyleaf@localhost:5432/flyleaf_dev
FULL=postgres://flyleaf:flyleaf@localhost:5432/flyleaf
PSQL() { docker exec -i flyleaf-pg psql -U flyleaf -d "$1" "${@:2}"; }   # PSQL <db> [args]; a script on stdin
P=../../docs/audit/perf/15c
```

## 0. Preflight

- [ ] Merge the 15c PR, then `git checkout main && git pull`.
- [ ] `npm ci` in `apps/api`.
- [ ] Stop the API and the worker if they are running (the recreate in step 3 drops their connections).
- [ ] `docker ps` shows `flyleaf-pg` on `0.0.0.0:5432`.
- [ ] Both databases are at 42:
  ```bash
  for D in flyleaf_dev flyleaf; do PSQL $D -Atc "select current_database(), count(*) from drizzle.__drizzle_migrations"; done
  ```

## 1. Apply 0042 to both databases

```bash
time DATABASE_URL=$DEV  npm run migrate    # expect: migrations applied
time DATABASE_URL=$FULL npm run migrate    # expect: migrations applied
```

`0042` replaces one function. `activity_object_idx` is built `CONCURRENTLY` after the journal (`migrate.ts`, ONLINE_SQL), so activity writes are not blocked. `flyleaf_dev` has ~142k activity rows, so expect seconds. The sandbox built 1.14M rows in 3.5 s.

- [ ] The index is valid on both:
  ```bash
  for D in flyleaf_dev flyleaf; do PSQL $D -Atc "select current_database(), i.indisvalid, pg_size_pretty(pg_relation_size(c.oid)) from pg_index i join pg_class c on c.oid = i.indexrelid where c.relname = 'activity_object_idx'"; done
  ```
  Expect `t` twice. If it shows `f` (an interrupted build), run `npm run migrate` again: it drops the invalid index and rebuilds it.
- [ ] Write both times into `findings/15-cross-cutting.md` › 15c › Laptop.

## 2. EXPLAIN on `flyleaf` (plans only, no ANALYZE)

Both scripts run `EXPLAIN` without `ANALYZE` inside `BEGIN … ROLLBACK`, so nothing is executed.

```bash
PSQL flyleaf -v opts='(COSTS)' -v offset=0 < $P/explain-repair-range.sql > $P/laptop-explain-repair-full.txt
PSQL flyleaf -v opts='(COSTS)'             < $P/explain-activity.sql     > $P/laptop-explain-activity-full.txt
```

- [ ] **Repair, first range** (`laptop-explain-repair-full.txt`). It prints four plans:
  - **"before (0040): the set arm":** expect the plan 15b saw: a hash join over seq scans of `work_authors` and `works`. Any plan is fine to record. This is the old statement, shown for comparison.
  - **"after (0042): the set arm":**
    - expect `InitPlan` → `Index Scan` or `Bitmap Index Scan` on `work_authors_author_idx` with both range bounds, and `SubPlan` → `works_pkey`;
    - then `authors_pkey` with `id = ANY (…)`;
    - no `Seq Scan`, no `Hash Join`.
  - **"after (0042): the clear arm":** expect `authors_pkey` on the range and an anti-join probing `work_authors_author_idx` and `works_pkey`, with **no `authors_credited_trgm_idx`**.
  - If an "after" plan differs, stop and send me the file.
- [ ] **Activity** (`laptop-explain-activity-full.txt`). It prints `activity_rows`, then three plans:
  - expect `Index Scan using activity_object_idx` on each;
  - if `activity_rows` is only a few hundred, a `Seq Scan` is the planner's correct choice for a tiny table. Note the count, and it is not a failure.

## 3. Recreate `flyleaf-pg` for `shm_size`

```bash
cd ../.. && docker compose up -d postgres && cd apps/api   # recreates: the compose config changed; the pgdata volume keeps the data
```

- [ ] Wait for `docker ps` to show it healthy.
- [ ] Check the new settings:
  ```bash
  docker inspect -f '{{.HostConfig.ShmSize}} {{.HostConfig.Memory}}' flyleaf-pg   # 536870912 3221225472
  docker exec flyleaf-pg df -h /dev/shm                                          # 512M
  PSQL flyleaf -Atc "show max_connections" -c "show shared_buffers"              # 100, 512MB
  ```

## 4. Confirm 43/43

```bash
for D in flyleaf_dev flyleaf; do PSQL $D -Atc "select current_database(), count(*) from drizzle.__drizzle_migrations"; done
```

- [ ] `flyleaf_dev|43` and `flyleaf|43`.
- [ ] Record the results of steps 1–4 in `findings/15-cross-cutting.md` › 15c › Laptop, and commit the `perf/15c/laptop-*.txt` files.

**Not in this session:** the `review:post` bench on `flyleaf_dev` and an `authors.repair` run on `flyleaf`. The repair needs a machine with ≥ 16 GB, as in 15b.
