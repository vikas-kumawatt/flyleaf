// Background job tests (FN-04).
//
// These run pg-boss against PGlite -- the same real-Postgres-no-Docker engine
// every other suite here uses. pg-boss 12 ships a PGlite adapter and a
// `pglite` backend profile, so the job path is exercised for real: its schema
// is created, a job is inserted, a worker claims it, the handler runs, and the
// result is stored. No mock queue, and no "assert the handler is a function".
//
// The second suite is the one that matters most. architecture.md §9 says
// pg-boss is in the stack *because* jobs commit with the data that created
// them. That is a claim about rollback, and nothing else in the codebase would
// notice if it stopped being true.

import { afterEach, describe, expect, it } from 'vitest';
import { PgBoss, fromPglite } from 'pg-boss';
import type { PGlite } from '@electric-sql/pglite';
import {
  JOBS_SCHEMA, QUEUES, makeBoss, pingHandler, registerQueues, sendInTx, type JobLog,
} from '../jobs/index.js';
import { freshDb, freshDrizzle } from './pg.js';

const bosses: PgBoss[] = [];
const clients: PGlite[] = [];

/** Records what handlers logged, so a test can assert they said anything at all. */
function recordingLog() {
  const lines: { obj: object; msg: string }[] = [];
  return { lines, info: (obj: object, msg: string) => void lines.push({ obj, msg }) };
}

/** A boss on its own database. Torn down after each test. */
async function bossOn(client: PGlite, opts: { work?: boolean; log?: JobLog } = {}) {
  clients.push(client);
  const boss = makeBoss({ db: fromPglite(client), backend: 'pglite' });
  bosses.push(boss);
  // Surfacing these beats a test that times out with no explanation.
  boss.on('error', (err) => console.error('pg-boss error:', err));
  await boss.start();
  if (opts.work) await registerQueues(boss, opts.log ?? { info: () => {} });
  else for (const name of Object.values(QUEUES)) await boss.createQueue(name);
  return boss;
}

afterEach(async () => {
  for (const boss of bosses.splice(0)) await boss.stop({ graceful: false }).catch(() => {});
  for (const client of clients.splice(0)) await client.close().catch(() => {});
});

/** Poll until the job leaves `created`/`active`, or give up. */
async function settled(boss: PgBoss, id: string, ms = 20_000) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const job = await boss.getJobById(QUEUES.smokePing, id);
    if (job && job.state !== 'created' && job.state !== 'active') return job;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`job ${id} never settled`);
}

describe('the handler itself', () => {
  it('answers the last job in the batch', async () => {
    // pg-boss hands over an ARRAY even when the batch size is one.
    const result = await pingHandler([
      { id: '1', name: QUEUES.smokePing, data: { note: 'first' } },
      { id: '2', name: QUEUES.smokePing, data: { note: 'second' } },
    ] as never);
    expect(result).toMatchObject({ pong: true, note: 'second' });
  });

  it('does not require a note', async () => {
    const result = await pingHandler([{ id: '1', name: QUEUES.smokePing, data: {} }] as never);
    expect(result.note).toBe('ping');
  });
});

describe('a job goes all the way round', () => {
  it('is enqueued, claimed, handled, and its result stored', async () => {
    const log = recordingLog();
    const boss = await bossOn(await freshDb(), { work: true, log });

    const id = await boss.send(QUEUES.smokePing, { note: 'hello' });
    expect(id).toBeTruthy();

    const job = await settled(boss, id!);
    expect(job.state).toBe('completed');
    // The stored output is the handler's return value. This is the assertion
    // that would fail if the handler never actually ran and something else
    // marked the job done.
    expect(job.output).toMatchObject({ pong: true, note: 'hello' });

    // And it must SAY so. The first version of this handler was silent, which
    // made a working queue and a dead worker look the same in a terminal --
    // which is the entire job of a smoke job.
    expect(log.lines).toContainEqual(
      expect.objectContaining({ obj: expect.objectContaining({ note: 'hello' }) }),
    );
  }, 60_000);

  it('creates its own schema rather than touching ours', async () => {
    const client = await freshDb();
    await bossOn(client);
    const { rows } = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = $1`,
      [JOBS_SCHEMA],
    );
    expect(rows[0]!.n).toBeGreaterThan(0);

    // `works` is ours and must be exactly where the migrations put it.
    const ours = await client.query<{ schema: string }>(
      `SELECT table_schema AS schema FROM information_schema.tables WHERE table_name = 'works'`,
    );
    expect(ours.rows.map((r) => r.schema)).toEqual(['public']);
  }, 60_000);
});

/**
 * Wake up `send` before opening a transaction.
 *
 * The first `send` to a queue resolves that queue's metadata on the boss's
 * OWN connection. PGlite has exactly one connection, and a drizzle
 * transaction holds it — so the lookup queues behind the transaction while
 * the transaction waits on the lookup, and the test hangs until vitest kills
 * it. One prior send populates the cache and the deadlock is gone.
 *
 * This is an artifact of a single-connection engine and NOT something
 * production has to do: with a pool, that lookup simply takes another
 * connection. It is worth a helper and this comment rather than a bare
 * `await boss.send(...)` that a later reader would delete as pointless.
 */
async function warmSendCache(boss: PgBoss) {
  await boss.send(QUEUES.smokePing, { note: 'warm-up' });
}

// The reason for the dependency, asserted.
describe('jobs commit with the data that created them', () => {
  it('keeps the job when the transaction commits', async () => {
    const { db, client } = await freshDrizzle();
    const boss = await bossOn(client);
    await warmSendCache(boss);

    let id: string | null = null;
    await db.transaction(async (tx) => {
      id = await sendInTx(boss, tx as never, QUEUES.smokePing, { note: 'committed' });
    });

    expect(id).toBeTruthy();
    expect(await boss.getJobById(QUEUES.smokePing, id!)).not.toBeNull();
  }, 60_000);

  it('loses the job when the transaction rolls back', async () => {
    const { db, client } = await freshDrizzle();
    const boss = await bossOn(client);
    await warmSendCache(boss);

    let id: string | null = null;
    await expect(
      db.transaction(async (tx) => {
        id = await sendInTx(boss, tx as never, QUEUES.smokePing, { note: 'doomed' });
        // Whatever the caller was really doing failed after enqueueing.
        throw new Error('rolled back on purpose');
      }),
    ).rejects.toThrow('rolled back on purpose');

    expect(id).toBeTruthy();
    // If this ever returns a job, enqueue is no longer transactional and the
    // stated reason for choosing pg-boss over Redis has quietly evaporated.
    expect(await boss.getJobById(QUEUES.smokePing, id!)).toBeNull();
  }, 60_000);
});
