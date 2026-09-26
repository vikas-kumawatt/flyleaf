// Audit 04: does argon2 on the login path stall unrelated requests, and what
// does the auth hook cost per request?
//
//   DATABASE_URL=postgres://flyleaf:flyleaf@localhost:5432/flyleaf_dev npx tsx src/bench/auth-load.ts
//
// Logins use emails that have no account (`audit04-…@bench.invalid`), which
// since A-04-006 spend one argon2 verify exactly like a wrong password. The
// only rows written are their `rate_limits` buckets, deleted at the end.

import { monitorEventLoopDelay } from 'node:perf_hooks';
import { sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService, signAccessToken, verifyAccessToken } from '../identity/index.js';
import { signAdminToken, verifyAdminToken } from '../admin/auth.js';
import { closeDb, makeDb, MemoryCache, PgRateLimiter } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';

const CONCURRENT_LOGINS = 20;
const SAMPLES = 200;

const pct = (xs: number[], p: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
};
const fmt = (xs: number[]) => `p50 ${pct(xs, 50).toFixed(1)} · p95 ${pct(xs, 95).toFixed(1)} · max ${Math.max(...xs).toFixed(1)} ms`;

const db = makeDb();
const app = await buildApp({
  db,
  identity: new IdentityService(db, new PgRateLimiter(db), new MemoryEmailSender()),
  catalog: new CatalogService(db, new MemoryCache(1000)),
});
const base = await app.listen({ port: 0, host: '127.0.0.1' });

const [work] = await db.execute<{ id: string }>(sql`
  SELECT work_id AS id FROM reads GROUP BY work_id ORDER BY count(*) DESC LIMIT 1`);
const workUrl = `${base}/v1/works/${work!.id}`;

async function sampleWorks(): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < SAMPLES; i++) {
    const t = performance.now();
    const res = await fetch(workUrl);
    await res.arrayBuffer();
    if (res.status !== 200) throw new Error(`GET work → ${res.status}`);
    out.push(performance.now() - t);
  }
  return out;
}

// Warm-up: plans, cache, connections.
for (let i = 0; i < 20; i++) await (await fetch(workUrl)).arrayBuffer();

const loop = monitorEventLoopDelay({ resolution: 1 });
loop.enable();
const idle = await sampleWorks();
const idleLoopP99 = loop.percentile(99) / 1e6;
loop.reset();

let stop = false;
let logins = 0;
let seq = 0;
const loginTimes: number[] = [];
const workers = Array.from({ length: CONCURRENT_LOGINS }, async (_, w) => {
  while (!stop) {
    const t = performance.now();
    const res = await fetch(`${base}/v1/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: `audit04-${w}-${seq++}@bench.invalid`, password: 'wrong-password-123' }),
    });
    await res.arrayBuffer();
    if (res.status !== 401) throw new Error(`login → ${res.status}`);
    loginTimes.push(performance.now() - t);
    logins++;
  }
});
const loadStart = performance.now();
const loaded = await sampleWorks();
const loadSeconds = (performance.now() - loadStart) / 1000;
stop = true;
await Promise.all(workers);
const loadedLoopP99 = loop.percentile(99) / 1e6;
loop.disable();

// Auth hook: the two JWT verifies it runs on every bearer request.
const uid = '11111111-1111-1111-1111-111111111111';
const appToken = await signAccessToken(uid);
const adminToken = await signAdminToken({ id: uid, email: 'a@example.com', role: 'admin' });
const N = 20_000;
const time = async (f: () => Promise<unknown>) => {
  for (let i = 0; i < 1000; i++) await f();
  const t = performance.now();
  for (let i = 0; i < N; i++) await f();
  return ((performance.now() - t) / N) * 1000;
};
const appVerifyUs = await time(() => verifyAccessToken(appToken));
const adminOnAppUs = await time(() => verifyAdminToken(appToken));
const adminVerifyUs = await time(() => verifyAdminToken(adminToken));

await db.execute(sql`DELETE FROM rate_limits WHERE bucket LIKE 'login:audit04-%@bench.invalid'`);
await app.close();
await closeDb(db);

console.log(`database: ${new URL(process.env.DATABASE_URL ?? 'postgres://x/flyleaf').pathname.slice(1)}`);
console.log(`GET /v1/works/:id, idle            ${fmt(idle)} · event-loop p99 ${idleLoopP99.toFixed(1)} ms`);
console.log(`GET /v1/works/:id, ${CONCURRENT_LOGINS} logins    ${fmt(loaded)} · event-loop p99 ${loadedLoopP99.toFixed(1)} ms`);
console.log(`POST /v1/auth/login under load    ${fmt(loginTimes)} · ${(logins / loadSeconds).toFixed(1)} logins/s`);
console.log(`auth hook: app verify ${appVerifyUs.toFixed(1)} µs · admin verify of an app token ${adminOnAppUs.toFixed(1)} µs · admin verify ${adminVerifyUs.toFixed(1)} µs`);
