// Audit 15 (§4, A-14-020): every cursor-paged endpoint, walked on a REAL
// Postgres with rows whose timestamps share a millisecond. PGlite's clock has
// only milliseconds, so the test suite cannot see a cursor that drops
// microseconds (A-14-020 found one in the comment thread). Each case seeds
// its own rows, walks the endpoint through the real app (buildApp, inject)
// at a small page size, and checks every row is served exactly once.
// Everything seeded is removed at the end (users cascade; works deleted).
//
//   DATABASE_URL=… npx tsx src/bench/cursor-sweep.ts

import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { closeDb, makeDb, PgRateLimiter } from '../platform/index.js';

const db = makeDb(undefined, { max: 4, quiet: true });
const users: string[] = [];
const works: string[] = [];
const BASE = '2026-10-01T12:00:00.123'; // one millisecond, many microseconds
const at = (us: number) => `${BASE}${String(us).padStart(3, '0')}Z`;

async function user(tag: string) {
  const id = randomUUID();
  await db.execute(sql`INSERT INTO users (id, email, password_hash, date_of_birth, email_verified_at, created_at)
    VALUES (${id}, ${`cursor-sweep-${id}@bench.flyleaf.invalid`}, 'unused', '1990-01-01', now(), now() - interval '30 days')`);
  await db.execute(sql`INSERT INTO profiles (user_id, username) VALUES (${id}, ${`cs_${tag}_${id.slice(0, 6)}`})`);
  users.push(id);
  return { id, auth: { authorization: `Bearer ${await signAccessToken(id)}` } };
}
async function work(title: string) {
  const [w] = await db.execute<{ id: string }>(sql`INSERT INTO works (title) VALUES (${title}) RETURNING id`);
  works.push(w!.id);
  return w!.id;
}

const results: string[] = [];
function report(name: string, expected: string[], served: string[]) {
  const dup = served.length - new Set(served).size;
  const missing = expected.filter((id) => !served.includes(id)).length;
  const ok = dup === 0 && missing === 0;
  results.push(`| ${name} | ${expected.length} | ${served.length} | ${dup} | ${missing} | ${ok ? 'OK' : 'WRONG'} |`);
}

const app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), reading: new ReadingService(db) });
await app.ready();

async function walk(url: (cursor: string | null) => string, headers: Record<string, string>, ids: (body: any) => string[], next: (body: any) => string | null) {
  const served: string[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ method: 'GET', url: url(cursor), headers });
    if (res.statusCode !== 200) throw new Error(`${url(cursor)}: ${res.statusCode} ${res.body}`);
    const body = res.json();
    served.push(...ids(body));
    cursor = next(body);
    if (!cursor) return served;
  }
  throw new Error('never ended');
}

try {
  // 1. A comment thread: 9 comments, three of them on the same microsecond.
  {
    const owner = await user('c');
    const w = await work('Cursor sweep: comments');
    const [r] = await db.execute<{ id: string }>(sql`
      INSERT INTO reads (user_id, work_id, status, attempt_no, visibility, finished_at, started_at)
      VALUES (${owner.id}, ${w}, 'finished', 1, 'public', CURRENT_DATE, CURRENT_DATE) RETURNING id`);
    const ids: string[] = [];
    for (const us of [101, 102, 103, 104, 104, 104, 105, 106, 107]) {
      const [c] = await db.execute<{ id: string }>(sql`
        INSERT INTO read_comments (read_id, user_id, body, created_at) VALUES (${r!.id}, ${owner.id}, ${`c${us}`}, ${at(us)}::timestamptz) RETURNING id`);
      ids.push(c!.id);
    }
    const served = await walk((c) => `/v1/reads/${r!.id}/comments?limit=2${c ? `&cursor=${encodeURIComponent(c)}` : ''}`, owner.auth,
      (b) => b.comments.map((x: any) => x.id), (b) => b.next_cursor);
    report('GET /v1/reads/:id/comments (limit 2)', ids, served);
  }

  // 2. Another user's reads, paged by updated_at: 9 reads in one millisecond.
  {
    const owner = await user('r');
    const viewer = await user('rv');
    const ids: string[] = [];
    for (const us of [201, 202, 203, 204, 204, 204, 205, 206, 207]) {
      const w = await work(`Cursor sweep: read ${us}`);
      const [r] = await db.execute<{ id: string }>(sql`
        INSERT INTO reads (user_id, work_id, status, attempt_no, visibility, finished_at, started_at, updated_at)
        VALUES (${owner.id}, ${w}, 'finished', 1, 'public', CURRENT_DATE, CURRENT_DATE, ${at(us)}::timestamptz) RETURNING id`);
      ids.push(r!.id);
    }
    const served = await walk((c) => `/v1/users/${owner.id}/reads?limit=2${c ? `&cursor=${encodeURIComponent(c)}` : ''}`, viewer.auth,
      (b) => b.data.map((x: any) => x.id), (b) => b.next_cursor);
    report('GET /v1/users/:id/reads (limit 2)', ids, served);
  }

  // 3. The friends feed: 24 cards from 6 followees, in pairs and triples
  //    sharing a microsecond, inside one millisecond.
  {
    const viewer = await user('f');
    const actors = [];
    for (let i = 0; i < 6; i++) {
      const a = await user(`fa${i}`);
      actors.push(a);
      await db.execute(sql`INSERT INTO follows (follower_id, followee_id, state) VALUES (${viewer.id}, ${a.id}, 'accepted')`);
    }
    const ids: string[] = [];
    const recent = new Date(Date.now() - 3_600_000).toISOString().slice(0, 23); // inside the 180-day horizon
    for (let i = 0; i < 24; i++) {
      const w = await work(`Cursor sweep: feed ${i}`);
      const [a] = await db.execute<{ id: string }>(sql`
        INSERT INTO activity (actor_id, verb, work_id, object_type, object_id, metadata, visibility, created_at)
        VALUES (${actors[i % 6]!.id}, ${i % 2 ? 'reviewed' : 'finished'}, ${w}, 'read', ${randomUUID()}, '{}', 'public',
                ${`${recent}${String(300 + Math.floor(i / 3)).padStart(3, '0')}Z`}::timestamptz) RETURNING id`);
      ids.push(a!.id);
    }
    const idsOf = (x: any) => (Array.isArray(x.metadata?.activity_ids) ? x.metadata.activity_ids : [x.id]);
    const friends = await walk((c) => `/v1/feed?tab=friends&limit=4${c ? `&cursor=${encodeURIComponent(c)}` : ''}`, viewer.auth,
      (b) => b.items.flatMap(idsOf), (b) => (b.has_more ? b.next_cursor : null));
    report('GET /v1/feed?tab=friends (limit 4)', ids, friends);

    // 4. Popular (D-14-1): the same cards are public reviews and finishes,
    //    with equal scores in each tie group, keyset-paged on (score, created_at, id).
    const guest = await walk((c) => `/v1/feed?tab=popular&limit=3${c ? `&cursor=${encodeURIComponent(c)}` : ''}`, {},
      (b) => b.items.flatMap(idsOf).filter((id: string) => ids.includes(id)), (b) => (b.has_more ? b.next_cursor : null));
    report('GET /v1/feed?tab=popular, guest (limit 3)', ids, guest);
  }
} finally {
  await app.close();
  for (const id of users) await db.execute(sql`DELETE FROM users WHERE id = ${id}`);
  for (const id of works) await db.execute(sql`DELETE FROM works WHERE id = ${id}`);
  await closeDb(db);
}

console.log('| Endpoint | Rows | Served | Repeated | Missing | Result |');
console.log('|---|---|---|---|---|---|');
for (const r of results) console.log(r);
