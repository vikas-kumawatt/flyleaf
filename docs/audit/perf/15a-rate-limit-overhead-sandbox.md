# Rate-limit layer overhead — sandbox, synthetic (Audit 15a)

2026-10-10. Cloud sandbox (Linux), PostgreSQL 18.3 (embedded-postgres package) on localhost:5432, an **empty** `flyleaf` database after `npm run migrate` (no catalog, no bench data). Not the laptop, not `flyleaf_dev`: **only the ratios mean anything**. Rerun on the laptop: see `docs/audit/15b-laptop.md`.

Command: `npx tsx src/bench/rate-limit-overhead.ts --duration 10` (10 connections, 50 signed-in accounts, `GET /v1/reads/:random` → 404 after one indexed lookup, a 3 s warm-up per configuration, configurations back to back).

- **off**: no limits on this route (a test app's default).
- **all-on**: every limit on, as `server-wiring.ts` builds it: Global (and Writes, Search, Progress, Events) counted in process.
- **pg-global**: every limit on, but Global counted in Postgres with `PgRateLimiter` (one `INSERT … ON CONFLICT` per request): the alternative the brief asks to weigh.

## One check, sequential

| Store | Run 1 p50 / p95 / p99 ms | Run 2 | Run 3 |
|---|---|---|---|
| `PgRateLimiter.hit` (n = 2,000) | 1.472 / 1.997 / 3.995 | 1.695 / 2.202 / 3.476 | 1.670 / 2.296 / 3.071 |
| `MemoryRateLimiter.hit` (n = 20,000) | 0.0006 / 0.0009 / 0.0013 | 0.0011 / 0.0023 / 0.0059 | 0.0004 / 0.0009 / 0.0015 |

## End to end (autocannon)

| Config | Run 1 req/s · p50/p90/p99 ms | Run 2 | Run 3 | `rate_limits` increments per run |
|---|---|---|---|---|
| off | 1,014 · 8 / 13 / 20 | 835 · 11 / 16 / 26 | 1,034 · 8 / 13 / 18 | 0 |
| all-on (production) | 1,059 · 8 / 12 / 16 | 931 · 10 / 15 / 20 | 975 · 9 / 14 / 19 | 0 |
| pg-global | 658 · 15 / 19 / 24 | 697 · 14 / 18 / 24 | 764 · 12 / 17 / 23 | ≈ 7,000 (one per request) |

Run 1 counted new rows rather than increments (0 for every config, because the warm-up had created the buckets); runs 2 and 3 count increments.

## Reading

- **In process, the Global tier costs nothing measurable**: `all-on` is within run-to-run noise of `off` (−6 % to +11 % req/s across the three runs; the noise between two `off` runs alone is 19 %).
- **In Postgres it costs about a third of this route's throughput**: `pg-global` serves 26–35 % fewer requests per second than `off` in the same run, p50 +4 to +7 ms, and writes one row update per request (≈ 7,000 in 10 s, each a WAL record). One check alone is ~1.5–1.7 ms p50 against ~1 µs in process.
- Hence the design: exact limits (auth, comments, follows, reviews, imports, exports, uploads, username) in Postgres, where volume is low and correctness across instances matters; per-request limits (Global, Search, Writes, Progress, Events) in process, correct while there is one API instance (architecture §4.1: a second instance is the Redis trigger).

## Laptop, `flyleaf_dev` (Audit 15b, 2026-10-11)

Same command (`npx tsx src/bench/rate-limit-overhead.ts --duration 10`), three runs back to back on the 8 GB laptop, `flyleaf_dev` (3,002 users), Postgres under its 3 GiB limit. Raw output: `perf/15b/rate-limit-overhead.txt`.

| Store | Run 1 p50 / p95 / p99 ms | Run 2 | Run 3 |
|---|---|---|---|
| `PgRateLimiter.hit` (n = 2,000) | 5.173 / 5.815 / 6.482 | 5.130 / 5.754 / 6.633 | 5.116 / 5.715 / 6.506 |
| `MemoryRateLimiter.hit` (n = 20,000) | 0.0013 / 0.0023 / 0.0029 | 0.0009 / 0.0016 / 0.0026 | 0.0009 / 0.0016 / 0.0018 |

| Config | Run 1 req/s · p50/p90/p99 ms | Run 2 | Run 3 | `rate_limits` increments per run |
|---|---|---|---|---|
| off | 609 · 15 / 19 / 23 | 604 · 15 / 19 / 27 | 626 · 15 / 19 / 23 | 0 |
| all-on (production) | 650 · 14 / 17 / 20 | 657 · 14 / 17 / 21 | 671 · 14 / 17 / 20 | 0 |
| pg-global | 468 · 21 / 24 / 28 | 475 · 20 / 23 / 28 | 470 · 20 / 24 / 28 | 4,690 / 4,766 / 4,709 |

**Reading: the laptop confirms 15a.** `all-on` is within noise of `off`; it is even 7–8 % faster in all three runs, which is configuration order and warm-up, not a gain. `pg-global` serves **22–25 % fewer requests per second** than `off` in the same run (the sandbox said 26–35 %: a quarter here rather than a third), p50 +5 to +6 ms, one row increment per request. One `PgRateLimiter.hit` is 5.1 ms p50 here against 1.5–1.7 ms in the sandbox. D-15-1 (per-request limits in process, exact ones in Postgres) stands.
