// SO-30: pushes go through the job queue, never the request path, and the job
// commits or rolls back with the notification (architecture §9). pg-boss on
// PGlite, as jobs.test.ts runs it.

import { afterEach, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';
import { fromPglite, type PgBoss } from 'pg-boss';
import type { PGlite } from '@electric-sql/pglite';
import { QUEUES, makeBoss, registerQueues } from '../jobs/index.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { Notifier, bossNotifyQueue } from '../notify/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';
import { MemoryPushSender } from '../providers/push/index.js';
import { users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, unlimited } from './interaction-fixtures.js';

const bosses: PgBoss[] = [];
const clients: PGlite[] = [];
afterEach(async () => {
  for (const b of bosses.splice(0)) await b.stop({ graceful: false }).catch(() => {});
  for (const c of clients.splice(0)) await c.close().catch(() => {});
});

async function bossOn(client: PGlite, deps?: { db: Db; push: MemoryPushSender }) {
  clients.push(client);
  const boss = makeBoss({ db: fromPglite(client), backend: 'pglite' });
  bosses.push(boss);
  boss.on('error', (err) => console.error('pg-boss error:', err));
  await boss.start();
  if (deps) {
    await registerQueues(boss, { info: () => {} }, {
      db: deps.db, storage: new MemoryObjectStorage(), mailer: new MemoryEmailSender(), push: deps.push,
    });
  } else {
    for (const name of Object.values(QUEUES)) await boss.createQueue(name);
  }
  return boss;
}

/** PGlite has one connection: resolve the queue's metadata before a transaction holds it (see jobs.test.ts). */
async function warm(boss: PgBoss) {
  await boss.send(QUEUES.notifySend, { notificationId: '00000000-0000-0000-0000-000000000000' });
}

async function notifyJobs(db: Db) {
  return db.execute<{ data: { notificationId: string; mode?: string }; start_after: string }>(sql`
    SELECT data, start_after FROM pgboss.job
    WHERE name = ${QUEUES.notifySend} AND data->>'notificationId' <> '00000000-0000-0000-0000-000000000000'`);
}

describe('notify.send rides the transaction of the write', () => {
  it('a like through the API queues its push in pg-boss, an hour out, and sends nothing itself', async () => {
    const { db, client } = await freshDrizzle();
    const boss = await bossOn(client);
    await warm(boss);
    const app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)), limiter: unlimited, boss });
    await app.ready();
    const alice = await makeUser(db, 'alice');
    const bob = await makeUser(db, 'bob');
    const readId = await makeRead(db, alice.id, await makeWork(db, 'Dune'), { status: 'finished' });

    const before = Date.now();
    expect((await app.inject({ method: 'POST', url: `/v1/reads/${readId}/like`, headers: bob.auth })).statusCode).toBe(200);
    const jobs = await notifyJobs(db);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.data.mode).toBe('digest');
    expect(new Date(jobs[0]!.start_after).getTime() - before).toBeGreaterThan(59 * 60 * 1000);
    await app.close();
  }, 60_000);

  it('a rolled-back write leaves no notification and no job', async () => {
    const { db, client } = await freshDrizzle();
    const boss = await bossOn(client);
    await warm(boss);
    const alice = await makeUser(db, 'alice');
    const bob = await makeUser(db, 'bob');
    await db.execute(sql`INSERT INTO follows (follower_id, followee_id) VALUES (${bob.id}::uuid, ${alice.id}::uuid)`);
    const notifier = new Notifier(bossNotifyQueue(boss));
    await expect(db.transaction(async (tx) => {
      await notifier.follow(tx as unknown as Db, bob.id, alice.id, 'accepted');
      throw new Error('the follow failed after the notification');
    })).rejects.toThrow('the follow failed');
    expect(await db.execute(sql`SELECT 1 FROM notifications`)).toHaveLength(0);
    expect(await notifyJobs(db)).toHaveLength(0);

    await db.transaction(async (tx) => notifier.follow(tx as unknown as Db, bob.id, alice.id, 'accepted'));
    expect(await notifyJobs(db)).toHaveLength(1);
  }, 60_000);

  it('the worker claims notify.send and delivers through the push port', async () => {
    const { db, client } = await freshDrizzle();
    const push = new MemoryPushSender();
    const boss = await bossOn(client, { db, push });
    const alice = await makeUser(db, 'alice');
    const bob = await makeUser(db, 'bob');
    await db.update(users).set({ createdAt: new Date(Date.now() - 7 * 86_400_000) });
    await db.execute(sql`INSERT INTO push_tokens (token, user_id, platform) VALUES ('ExponentPushToken[a]', ${alice.id}::uuid, 'android')`);
    await db.execute(sql`INSERT INTO follows (follower_id, followee_id) VALUES (${bob.id}::uuid, ${alice.id}::uuid)`);
    // Quiet hours off, so the test does not depend on the time it runs.
    await db.execute(sql`INSERT INTO notification_preferences (user_id, quiet_enabled) VALUES (${alice.id}::uuid, false)`);
    await new Notifier(bossNotifyQueue(boss)).follow(db, bob.id, alice.id, 'accepted');

    const deadline = Date.now() + 30_000;
    while (push.sent.length === 0 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100));
    expect(push.sent.map((m) => m.body)).toEqual(['bob followed you']);
    const [row] = await db.execute<{ push_state: string }>(sql`SELECT push_state FROM notifications`);
    expect(row!.push_state).toBe('sent');
  }, 60_000);
});
