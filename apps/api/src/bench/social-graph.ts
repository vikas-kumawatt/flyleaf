// Social graph bench (audit Part 13). Synthetic data, never the dev catalog.
//
//   npx tsx src/bench/social-graph.ts --seed     add sgbench_* users and follows
//   npx tsx src/bench/social-graph.ts --lists    followers pages at offsets 0/1000/1900
//   npx tsx src/bench/social-graph.ts --timing   404 timing: blocked profile vs random id
//   npx tsx src/bench/social-graph.ts --race     concurrent follows: counter drift, deadlocks
//   npx tsx src/bench/social-graph.ts --clean    remove everything --seed added
//
// DATABASE_URL picks the database. Run with BENCH_COUNT_QUERIES=1 to get
// statement counts per request. Requests go through buildApp() with inject(),
// so the numbers include routing, auth, validation and serialization but no
// socket; they are for before/after ratios on one machine, not budgets.
//
// Seed shape: one public "celebrity" with 2,000 accepted followers (in
// batches that share a created_at, so ordering needs its tie-break), one
// viewer who follows 300 of them, blocked 20 and is blocked by 10 others,
// plus 5,000 background users following 20 random others each (~100k rows),
// so follows is not a toy table.

import { performance } from 'node:perf_hooks';
import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { makeDb, closeDb, PgRateLimiter } from '../platform/index.js';
import { buildApp } from '../app.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { QUERY_COUNT_HEADER } from './query-counter.js';
import { SocialService } from '../social/index.js';

const PREFIX = 'sgbench_';
const DOMAIN = '@sgbench.test';
const CELEB_FOLLOWERS = 2000;
const BACKGROUND = 5000;
const has = (f: string) => process.argv.includes(`--${f}`);

const db = makeDb(undefined, { max: 60, quiet: true });

async function ids() {
  const rows = await db.execute<{ id: string; username: string }>(sql`
    SELECT u.id, p.username FROM users u JOIN profiles p ON p.user_id = u.id
    WHERE u.email LIKE ${'%' + DOMAIN}`);
  const by = new Map(rows.map((r) => [r.username, r.id]));
  const need = (n: string) => {
    const id = by.get(PREFIX + n);
    if (!id) throw new Error(`run --seed first (missing ${PREFIX}${n})`);
    return id;
  };
  return { celeb: need('celeb'), viewer: need('viewer'), blocker: need('blocker_0') };
}

async function seed() {
  const t0 = performance.now();
  const users: { id: string; name: string }[] = [];
  const add = (name: string) => {
    const u = { id: randomUUID(), name: PREFIX + name };
    users.push(u);
    return u.id;
  };
  const celeb = add('celeb');
  const viewer = add('viewer');
  const fans = Array.from({ length: CELEB_FOLLOWERS }, (_, i) => add(`fan_${i}`));
  const blockers = Array.from({ length: 10 }, (_, i) => add(`blocker_${i}`));
  const bg = Array.from({ length: BACKGROUND }, (_, i) => add(`bg_${i}`));

  for (let i = 0; i < users.length; i += 1000) {
    const part = users.slice(i, i + 1000);
    await db.execute(sql`
      INSERT INTO users (id, email, password_hash, date_of_birth, email_verified_at)
      SELECT x.id, x.name || ${DOMAIN}, 'bench', '1990-01-01', now()
      FROM jsonb_to_recordset(${JSON.stringify(part)}::jsonb) AS x(id uuid, name text)`);
    await db.execute(sql`
      INSERT INTO profiles (user_id, username)
      SELECT x.id, x.name FROM jsonb_to_recordset(${JSON.stringify(part)}::jsonb) AS x(id uuid, name text)`);
  }

  const edges: { f: string; t: string; at: string; s: string }[] = [];
  const base = Date.parse('2026-01-01T00:00:00Z');
  // Followers of the celebrity, ten at a time sharing one created_at.
  fans.forEach((f, i) => edges.push({ f, t: celeb, at: new Date(base + Math.floor(i / 10) * 60_000).toISOString(), s: 'accepted' }));
  blockers.forEach((f, i) => edges.push({ f, t: celeb, at: new Date(base + i).toISOString(), s: 'accepted' }));
  fans.slice(0, 300).forEach((t, i) => edges.push({ f: viewer, t, at: new Date(base + i * 1000).toISOString(), s: 'accepted' }));
  fans.slice(300, 400).forEach((f, i) => edges.push({ f, t: viewer, at: new Date(base + i * 1000).toISOString(), s: 'accepted' }));
  const seen = new Set(edges.map((e) => e.f + e.t));
  let rnd = 42;
  const next = () => ((rnd = (rnd * 1103515245 + 12345) % 2147483648), rnd);
  for (const f of bg) {
    for (let k = 0; k < 20; k++) {
      const pool = next() % 2 === 0 ? bg : fans;
      const t = pool[next() % pool.length]!;
      if (t === f || seen.has(f + t)) continue;
      seen.add(f + t);
      edges.push({ f, t, at: new Date(base + (next() % 86_400_000)).toISOString(), s: 'accepted' });
    }
  }

  // Bulk: the counter trigger is per row; reconcile afterwards, as bench:seed does.
  await db.execute(sql`ALTER TABLE follows DISABLE TRIGGER follows_counter_trigger`);
  try {
    for (let i = 0; i < edges.length; i += 5000) {
      const part = edges.slice(i, i + 5000);
      await db.execute(sql`
        INSERT INTO follows (follower_id, followee_id, state, created_at)
        SELECT x.f, x.t, x.s, x.at FROM jsonb_to_recordset(${JSON.stringify(part)}::jsonb) AS x(f uuid, t uuid, at timestamptz, s text)
        ON CONFLICT DO NOTHING`);
    }
  } finally {
    await db.execute(sql`ALTER TABLE follows ENABLE TRIGGER follows_counter_trigger`);
  }
  await db.execute(sql`SELECT reconcile_follow_counters()`);

  const blocks = [
    ...fans.slice(1000, 1020).map((b) => ({ a: viewer, b })),
    ...blockers.map((a) => ({ a, b: viewer })),
  ];
  await db.execute(sql`
    INSERT INTO blocks (blocker_id, blocked_id)
    SELECT x.a, x.b FROM jsonb_to_recordset(${JSON.stringify(blocks)}::jsonb) AS x(a uuid, b uuid)`);
  await db.execute(sql`ANALYZE users; ANALYZE profiles; ANALYZE follows; ANALYZE blocks`);
  console.log(`seeded ${users.length} users, ${edges.length} follows, ${blocks.length} blocks in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
}

async function clean() {
  const r = await db.execute(sql`DELETE FROM users WHERE email LIKE ${'%' + DOMAIN}`);
  await db.execute(sql`SELECT reconcile_follow_counters()`);
  console.log(`removed ${(r as unknown as { count: number }).count ?? '?'} users`);
}

function pct(xs: number[], p: number) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]!;
}

async function app() {
  const identity = new IdentityService(db, new PgRateLimiter(db));
  return buildApp({ db, identity });
}

async function lists() {
  const { celeb, viewer } = await ids();
  const a = await app();
  const token = await signAccessToken(viewer);
  for (const offset of [0, 1000, 1900]) {
    const url = `/v1/users/${celeb}/followers?limit=50&offset=${offset}`;
    const go = () => a.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
    for (let i = 0; i < 5; i++) await go();
    const times: number[] = [];
    let queries = '?';
    let body: any;
    for (let i = 0; i < 40; i++) {
      const t = performance.now();
      const res = await go();
      times.push(performance.now() - t);
      queries = String(res.headers[QUERY_COUNT_HEADER] ?? '?');
      body = res.json();
    }
    console.log(`followers offset=${offset}: p50 ${pct(times, 50).toFixed(1)} ms · p95 ${pct(times, 95).toFixed(1)} ms · ${queries} statements · ${body.users.length} rows · total ${body.total}`);
  }
  await a.close();
}

async function timing() {
  const { blocker, viewer } = await ids();
  const a = await app();
  const token = await signAccessToken(viewer);
  const paths = {
    blocked: [`/v1/users/${blocker}`, `/v1/users/${blocker}/followers`],
    random: [() => `/v1/users/${randomUUID()}`, () => `/v1/users/${randomUUID()}/followers`],
  };
  for (const [i, name] of ['profile', 'followers'].entries()) {
    const t: Record<string, number[]> = { blocked: [], random: [] };
    const q: Record<string, string> = {};
    let bodies: Record<string, string> = {};
    for (let k = 0; k < 520; k++) {
      for (const kind of ['blocked', 'random'] as const) {
        const url = kind === 'blocked' ? paths.blocked[i]! : paths.random[i]!();
        const s = performance.now();
        const res = await a.inject({ method: 'GET', url, headers: { authorization: `Bearer ${token}` } });
        const ms = performance.now() - s;
        if (k >= 20) t[kind]!.push(ms);
        q[kind] = String(res.headers[QUERY_COUNT_HEADER] ?? '?');
        bodies[kind] = `${res.statusCode} ${res.body}`;
      }
    }
    const d = pct(t.blocked!, 50) - pct(t.random!, 50);
    console.log(`${name}: blocked p50 ${pct(t.blocked!, 50).toFixed(2)} ms (${q.blocked} statements) · random p50 ${pct(t.random!, 50).toFixed(2)} ms (${q.random} statements) · Δp50 ${d.toFixed(2)} ms · bodies identical: ${bodies.blocked === bodies.random}`);
  }
  await a.close();
}

async function race() {
  const n = 50;
  const users = Array.from({ length: n + 1 }, (_, i) => ({ id: randomUUID(), name: `${PREFIX}race_${i}_${Date.now()}` }));
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, date_of_birth)
    SELECT x.id, x.name || ${DOMAIN}, 'bench', '1990-01-01' FROM jsonb_to_recordset(${JSON.stringify(users)}::jsonb) AS x(id uuid, name text)`);
  await db.execute(sql`
    INSERT INTO profiles (user_id, username)
    SELECT x.id, x.name FROM jsonb_to_recordset(${JSON.stringify(users)}::jsonb) AS x(id uuid, name text)`);
  const [target, ...rest] = users.map((u) => u.id);
  const hold = async (f: string, t: string) =>
    db.transaction(async (tx) => {
      await tx.execute(sql`INSERT INTO follows (follower_id, followee_id, state) VALUES (${f}::uuid, ${t}::uuid, 'accepted')`);
      await tx.execute(sql`SELECT pg_sleep(0.05)`);
    });
  const r1 = await Promise.allSettled(rest.map((f) => hold(f, target!)));
  const [c] = await db.execute<{ counter: number; truth: number }>(sql`
    SELECT p.follower_count AS counter,
      (SELECT count(*)::int FROM follows WHERE followee_id = p.user_id AND state = 'accepted') AS truth
    FROM profiles p WHERE p.user_id = ${target}::uuid`);
  console.log(`${n} concurrent follows of one user: ${r1.filter((r) => r.status === 'rejected').length} errors · counter ${c!.counter} · truth ${c!.truth}`);
  let deadlocks = 0;
  let other = 0;
  for (let k = 0; k + 1 < rest.length; k += 2) {
    const [x, y] = [rest[k]!, rest[k + 1]!];
    for (const r of await Promise.allSettled([hold(x, y), hold(y, x)])) {
      if (r.status === 'rejected') {
        const m = String((r.reason as Error)?.cause ?? r.reason);
        if (/deadlock/i.test(m)) deadlocks++;
        else other++;
      }
    }
  }
  const [d] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM profiles p WHERE p.user_id = ANY(${'{' + users.map((u) => u.id).join(',') + '}'}::uuid[]) AND (
      p.follower_count <> (SELECT count(*) FROM follows f WHERE f.followee_id = p.user_id AND f.state = 'accepted') OR
      p.following_count <> (SELECT count(*) FROM follows f WHERE f.follower_id = p.user_id AND f.state = 'accepted'))`);
  console.log(`${Math.floor(n / 2)} pairs following each other at once: ${deadlocks} deadlocks · ${other} other errors · ${d!.n} of ${users.length} profiles drifted`);
  await db.execute(sql`DELETE FROM users WHERE id = ANY(${'{' + users.map((u) => u.id).join(',') + '}'}::uuid[])`);

  // A follow racing a block of the same pair (A-13-006): b follows a while a
  // blocks b. A follow that commits after the block severed the pair is a
  // follow between blocked users.
  const pairs = 100;
  const people = Array.from({ length: pairs * 2 }, (_, i) => ({ id: randomUUID(), name: `${PREFIX}fb_${i}_${Date.now()}` }));
  await db.execute(sql`
    INSERT INTO users (id, email, password_hash, date_of_birth, email_verified_at)
    SELECT x.id, x.name || ${DOMAIN}, 'bench', '1990-01-01', now() FROM jsonb_to_recordset(${JSON.stringify(people)}::jsonb) AS x(id uuid, name text)`);
  await db.execute(sql`
    INSERT INTO profiles (user_id, username)
    SELECT x.id, x.name FROM jsonb_to_recordset(${JSON.stringify(people)}::jsonb) AS x(id uuid, name text)`);
  const social = new SocialService(db);
  const outcomes = await Promise.allSettled(
    Array.from({ length: pairs }, (_, k) => {
      const [a, b] = [people[2 * k]!.id, people[2 * k + 1]!.id];
      return Promise.allSettled([social.followUser(b, a), social.blockUser(a, b)]);
    }),
  );
  const ids = '{' + people.map((u) => u.id).join(',') + '}';
  const [left] = await db.execute<{ n: number }>(sql`
    SELECT count(*)::int AS n FROM follows f JOIN blocks b ON b.blocker_id = f.followee_id AND b.blocked_id = f.follower_id
    WHERE f.follower_id = ANY(${ids}::uuid[])`);
  console.log(`${pairs} follow-vs-block races: ${outcomes.length} done · ${left!.n} follows left between blocked users`);
  await db.execute(sql`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`);
}

try {
  if (has('clean')) await clean();
  if (has('seed')) await seed();
  if (has('lists')) await lists();
  if (has('timing')) await timing();
  if (has('race')) await race();
} finally {
  await closeDb(db);
}
