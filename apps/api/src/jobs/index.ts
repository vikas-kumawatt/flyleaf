// Background jobs (FN-04). architecture.md §9.
//
// pg-boss is in the stack instead of a Redis-backed queue for one reason:
// a job can be enqueued IN THE SAME TRANSACTION as the data that caused it.
// "Row written but job lost" and "job ran but row rolled back" both stop
// being possible, without an outbox table or a reconciler. `sendInTx` below
// is that property; there is a test asserting a rolled-back transaction
// leaves no job, because if that ever stops holding, the reason for the
// dependency is gone and nothing else would tell us.
//
// This module owns the queue names, the handlers, and how a boss is built.
// worker.ts owns the process. Keeping them apart is what lets the tests run
// the real handlers against a real Postgres without starting a process.

import { PgBoss, fromDrizzle, type Db as BossDb, type Job } from 'pg-boss';
import { sql } from 'drizzle-orm';
import { config } from '../platform/index.js';

/**
 * pg-boss owns this schema and migrates it itself.
 *
 * A DECISION, not an oversight: everywhere else in this project drizzle is
 * the source of truth for schema. pg-boss is the exception because its tables
 * are library internals versioned by the library -- hand-managing them would
 * turn every pg-boss upgrade into a migration we have to write and get right,
 * and getting it wrong loses jobs. It lives in its own schema precisely so the
 * two never collide, and `public` stays entirely ours.
 *
 * The cost: the worker's database role needs DDL rights at startup. Acceptable
 * for a single-VM deployment (architecture.md §13). The day the API and the
 * worker have separate roles, start pg-boss once with `migrate: true` during
 * deploy and run it with `migrate: false` thereafter.
 */
export const JOBS_SCHEMA = 'pgboss';

/**
 * Every queue, named once.
 *
 * architecture.md §9 lists thirteen. Exactly one exists today -- adding the
 * other twelve now would be twelve empty handlers to keep compiling.
 */
export const QUEUES = {
  /**
   * Proves the whole path: enqueued, claimed by a worker, handled, result
   * stored. It is also the ops probe -- send one and see whether anything is
   * consuming, which is otherwise surprisingly hard to answer.
   */
  smokePing: 'smoke.ping',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type PingRequest = { note?: string };
export type PingResult = { pong: true; note: string; workedAt: string };

/**
 * The smoke handler.
 *
 * Exported and pure so a test can call it directly, and so the end-to-end
 * test runs THIS function rather than a paraphrase of it.
 *
 * pg-boss hands a handler an ARRAY -- a batch, even when the batch size is
 * one. Writing `job.data` instead of `jobs[0].data` compiles under a loose
 * type and is undefined at runtime.
 */
export async function pingHandler(jobs: Job<PingRequest>[]): Promise<PingResult> {
  const note = jobs.at(-1)?.data?.note ?? 'ping';
  return { pong: true, note, workedAt: new Date().toISOString() };
}

/**
 * Build a boss.
 *
 * `db` overrides the connection: the tests pass a PGlite adapter so the job
 * path is exercised against the real engine with no Docker, the same way
 * every other suite here works.
 */
export function makeBoss(opts: { db?: BossDb; backend?: 'postgres' | 'pglite' } = {}): PgBoss {
  return new PgBoss({
    ...(opts.db
      ? { db: opts.db, backend: opts.backend ?? 'postgres' }
      : { connectionString: config.databaseUrl }),
    schema: JOBS_SCHEMA,
  });
}

/**
 * The bit of a logger a job handler needs. Pino satisfies it; so does a stub.
 * Narrow on purpose -- a handler that could reach the whole logger would
 * eventually reach for `level` or a child logger and stop being testable.
 */
export type JobLog = { info(obj: object, msg: string): void };

/**
 * Declare the queues and attach the handlers.
 *
 * `createQueue` is required before a queue accepts work in pg-boss 10+; a
 * `send` to a queue that was never created is an error rather than an
 * implicit create, which is the right trade — it turns a typo'd queue name
 * into a failure instead of a job nobody will ever consume.
 *
 * The handler is wrapped rather than passed bare so that every job SAYS it
 * ran. The first version did not log, which made `smoke.ping` useless for the
 * one thing it exists for: watching a worker terminal and seeing the job
 * land. A silent handler and a dead worker look identical.
 */
export async function registerQueues(boss: PgBoss, log: JobLog): Promise<void> {
  for (const name of Object.values(QUEUES)) await boss.createQueue(name);

  await boss.work<PingRequest, PingResult>(QUEUES.smokePing, async (jobs) => {
    const result = await pingHandler(jobs);
    log.info({ queue: QUEUES.smokePing, ids: jobs.map((j) => j.id), note: result.note },
             'job handled');
    return result;
  });
}

/**
 * Enqueue inside a caller's transaction.
 *
 * The whole point of pg-boss. `tx` is a drizzle transaction; the job insert
 * rides on that transaction's connection, so it commits with the caller's
 * writes or disappears with them.
 *
 *   await db.transaction(async (tx) => {
 *     const read = await tx.insert(reads).values(...).returning();
 *     await sendInTx(boss, tx, QUEUES.smokePing, { note: read.id });
 *   });
 */
export async function sendInTx(
  boss: PgBoss,
  tx: { execute(query: unknown): Promise<unknown> },
  name: QueueName,
  data: object,
): Promise<string | null> {
  return boss.send(name, data, { db: fromDrizzle(tx as never, sql as never) });
}
