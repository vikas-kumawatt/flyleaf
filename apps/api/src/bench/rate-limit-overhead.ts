// What the rate-limit layer costs per request (Audit 15, §1).
//
//   npx tsx src/bench/rate-limit-overhead.ts [--duration 10] [--connections 10] [--users 50]
//
// Builds the real app (buildApp) in this process against DATABASE_URL, listens
// on a free port, and drives one cheap signed-in route with autocannon in
// three configurations, back to back, after a warm-up of each:
//
//   off         no limits beyond the legacy ones (none on this route)
//   all-on      every limit on, Global and Writes in process (production)
//   pg-global   every limit on, but Global counted in Postgres (the design
//               the brief asks to weigh: one INSERT … ON CONFLICT per request)
//
// The route is GET /v1/reads/:random (404 after one indexed lookup): a request
// whose own cost is small, so the limiter's share is visible. Requests are
// spread over --users signed-in accounts so no limit trips (1,000/hour each).
// Also reports the raw cost of one check on each store, measured alone.
// Writes nothing but `rate_limits` rows under the `bench-rl:` and Global
// buckets of the bench's random user ids, deleted at the end.

import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import autocannon from 'autocannon';
import { sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { closeDb, config, makeDb, PgRateLimiter } from '../platform/index.js';
import { MemoryRateLimiter, RateLimits, type LimitName, type LimitResult } from '../platform/rate-limits.js';

const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? d : Number(process.argv[i + 1]);
};
const DURATION = arg('duration', 10);
const CONNECTIONS = arg('connections', 10);
const USERS = arg('users', 50);

/** Counts Global in Postgres instead of in process: the alternative being measured. */
class PgGlobalLimits extends RateLimits {
  override async check(name: LimitName, key: string): Promise<LimitResult | null> {
    if (name !== 'global:account' && name !== 'global:ip') return super.check(name, key);
    const limit = name === 'global:account' ? 1000 : 200;
    const hit = await (this.exact as PgRateLimiter).hit(`${name}:${key}`, limit, 3600);
    return { ...hit, name, limit };
  }
}

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)] ?? NaN;
};

async function main() {
  const db = makeDb(config.databaseUrl, { max: 10, quiet: true });
  const userIds: string[] = [];
  const [w] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM users`);
  console.log(`database: ${config.databaseUrl.replace(/:[^:@/]+@/, ':***@')} (users: ${w?.n})`);
  for (let i = 0; i < USERS; i++) userIds.push(randomUUID());
  const tokens = await Promise.all(userIds.map((id) => signAccessToken(id)));

  // ---- Raw cost of one check, alone, sequential.
  const pg = new PgRateLimiter(db);
  const mem = new MemoryRateLimiter();
  for (let i = 0; i < 200; i++) await pg.hit(`bench-rl:warm:${i % 20}`, 1e9, 3600);
  const pgTimes: number[] = [];
  for (let i = 0; i < 2000; i++) {
    const t = process.hrtime.bigint();
    await pg.hit(`bench-rl:${userIds[i % USERS]}`, 1e9, 3600);
    pgTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  const memTimes: number[] = [];
  for (let i = 0; i < 20000; i++) {
    const t = process.hrtime.bigint();
    mem.hitSync(`bench-rl:${userIds[i % USERS]}`, 1e9, 3600);
    memTimes.push(Number(process.hrtime.bigint() - t) / 1e6);
  }
  console.log('\nOne check, sequential (ms):');
  console.log(`  PgRateLimiter.hit      p50 ${pct(pgTimes, 50).toFixed(3)}  p95 ${pct(pgTimes, 95).toFixed(3)}  p99 ${pct(pgTimes, 99).toFixed(3)}  (n=2000)`);
  console.log(`  MemoryRateLimiter.hit  p50 ${pct(memTimes, 50).toFixed(4)}  p95 ${pct(memTimes, 95).toFixed(4)}  p99 ${pct(memTimes, 99).toFixed(4)}  (n=20000)`);

  // ---- End to end.
  const configs: Array<[string, () => RateLimits | undefined]> = [
    ['off', () => undefined],
    ['all-on', () => new RateLimits({ exact: new PgRateLimiter(db), enabled: 'all' })],
    ['pg-global', () => new PgGlobalLimits({ exact: new PgRateLimiter(db), enabled: 'all' })],
  ];
  const rows: string[] = [];
  for (const [label, make] of configs) {
    const app = await buildApp({
      db,
      identity: new IdentityService(db, new PgRateLimiter(db)),
      reading: new ReadingService(db),
      rateLimits: make(),
    });
    await app.listen({ port: 0, host: '127.0.0.1' });
    const url = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    let n = 0;
    const run = (duration: number) =>
      autocannon({
        url,
        connections: CONNECTIONS,
        duration,
        requests: [{
          method: 'GET',
          setupRequest: (req: Record<string, unknown>) => ({
            ...req,
            path: `/v1/reads/${randomUUID()}`,
            headers: { authorization: `Bearer ${tokens[n++ % USERS]}` },
          }),
        }],
      });
    await run(3); // warm-up
    const [before] = await db.execute<{ n: number }>(sql`SELECT COALESCE(sum(count), 0)::int AS n FROM rate_limits`);
    const r: any = await run(DURATION);
    const [after] = await db.execute<{ n: number }>(sql`SELECT COALESCE(sum(count), 0)::int AS n FROM rate_limits`);
    const non404 = r.non2xx - (r.statusCodeStats?.['404']?.count ?? 0);
    rows.push(
      `| ${label} | ${r.requests.average.toFixed(0)} | ${r.latency.p50} | ${r.latency.p90} | ${r.latency.p99} | ${non404} | ${Number(after?.n) - Number(before?.n)} |`,
    );
    await app.close();
  }
  console.log(`\nGET /v1/reads/:random signed in, ${CONNECTIONS} connections × ${DURATION} s, ${USERS} accounts:`);
  console.log('| config | req/s | p50 ms | p90 ms | p99 ms | non-404 | rate_limits increments |');
  console.log('|---|---|---|---|---|---|---|');
  for (const row of rows) console.log(row);

  await db.execute(sql`DELETE FROM rate_limits WHERE bucket LIKE 'bench-rl:%' OR bucket = ANY (${`{${userIds.map((u) => `global:account:${u}`).join(',')}}`}::text[])`);
  await closeDb(db);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
