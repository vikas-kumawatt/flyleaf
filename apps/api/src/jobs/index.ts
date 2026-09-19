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
export type { PgBoss } from 'pg-boss';
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

import type { Db } from '../platform/index.js';
import { runDedupe, type DedupeReport } from '../catalog/dedupe.js';
import { processImport } from '../imports/processor.js';
import { DiskFileStorage, type FileStorage } from '../imports/storage.js';

/**
 * Every queue, named once.
 */
export const QUEUES = {
  /**
   * Proves the whole path: enqueued, claimed by a worker, handled, result
   * stored. It is also the ops probe -- send one and see whether anything is
   * consuming, which is otherwise surprisingly hard to answer.
   */
  smokePing: 'smoke.ping',
  /**
   * Monthly dedupe pass (FN-52, Architecture §9).
   * Stages 1–2 auto-merge, Stage 3 queued for review.
   */
  catalogDedupe: 'catalog.dedupe',
  /**
   * Nightly shelves reconciliation (Architecture §3.9, SH-01).
   * Reconciles item_count, save_count, and cover_work_ids.
   */
  reconcileShelves: 'shelves.reconcile',
  /**
   * Reading library import processing job (PRD §6.8, §24.2, IM-02, IM-08).
   * Parses uploaded CSV, matches against catalog, and populates user reads.
   */
  processImport: 'imports.process',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type PingRequest = { note?: string };
export type PingResult = { pong: true; note: string; workedAt: string };

export type ReconcileShelvesResult = { reconciled: true; workedAt: string };

export type DedupeJobRequest = {
  limit?: number;
  dryRun?: boolean;
};

export type DedupeJobResult = DedupeReport;

export type ProcessImportJobRequest = {
  importId: string;
  userId: string;
  source: string;
};

export type ProcessImportJobResult = {
  importId: string;
  processed: boolean;
  totalRows?: number;
  matched?: number;
  unmatched?: number;
  workedAt: string;
};

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
 * Dedupe background job handler (FN-52).
 */
export async function dedupeJobHandler(
  jobs: Job<DedupeJobRequest>[],
  db: Db,
): Promise<DedupeJobResult> {
  const data = jobs.at(-1)?.data ?? {};
  return runDedupe(db, {
    limit: data.limit,
    dryRun: data.dryRun,
  });
}

/**
 * Shelves reconciliation background job handler (Architecture §3.9, SH-01).
 * Reconciles item_count, save_count, and cover_work_ids via SQL procedure.
 */
export async function reconcileShelvesJobHandler(
  _jobs: Job<void>[],
  db: Db,
): Promise<ReconcileShelvesResult> {
  await db.execute(sql`SELECT reconcile_shelf_counters();`);
  return { reconciled: true, workedAt: new Date().toISOString() };
}

/**
 * Import processing background job handler (PRD §6.8, §24.2, IM-02, IM-08).
 * Full chunked resumable processor is expanded in IM-08.
 */
export async function processImportJobHandler(
  jobs: Job<ProcessImportJobRequest>[],
  db: Db,
  storage?: FileStorage,
): Promise<ProcessImportJobResult> {
  const job = jobs.at(-1);
  const importId = job?.data?.importId ?? '';
  if (!importId) {
    return {
      importId: '',
      processed: false,
      workedAt: new Date().toISOString(),
    };
  }

  const fileStorage = storage ?? new DiskFileStorage();
  const res = await processImport(db, fileStorage, importId);

  return {
    importId,
    processed: res.state === 'completed',
    totalRows: res.totalRows,
    matched: res.matched,
    unmatched: res.unmatched,
    workedAt: new Date().toISOString(),
  };
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
export async function registerQueues(boss: PgBoss, log: JobLog, db?: Db): Promise<void> {
  for (const name of Object.values(QUEUES)) await boss.createQueue(name);

  await boss.work<PingRequest, PingResult>(QUEUES.smokePing, async (jobs) => {
    const result = await pingHandler(jobs);
    log.info({ queue: QUEUES.smokePing, ids: jobs.map((j) => j.id), note: result.note },
             'job handled');
    return result;
  });

  if (db) {
    await boss.work<DedupeJobRequest, DedupeJobResult>(QUEUES.catalogDedupe, async (jobs) => {
      const result = await dedupeJobHandler(jobs, db);
      log.info(
        {
          queue: QUEUES.catalogDedupe,
          ids: jobs.map((j) => j.id),
          stage1: result.stage1,
          stage2: result.stage2,
          stage3Queued: result.stage3Queued,
          merged: result.merged,
          skipped: result.skipped,
        },
        'job handled',
      );
      return result;
    });

    await boss.work<void, ReconcileShelvesResult>(QUEUES.reconcileShelves, async (jobs) => {
      const result = await reconcileShelvesJobHandler(jobs, db);
      log.info(
        {
          queue: QUEUES.reconcileShelves,
          ids: jobs.map((j) => j.id),
          reconciled: result.reconciled,
        },
        'job handled',
      );
      return result;
    });

    await boss.work<ProcessImportJobRequest, ProcessImportJobResult>(
      QUEUES.processImport,
      async (jobs) => {
        const result = await processImportJobHandler(jobs, db);
        log.info(
          {
            queue: QUEUES.processImport,
            ids: jobs.map((j) => j.id),
            importId: result.importId,
            totalRows: result.totalRows,
            matched: result.matched,
            unmatched: result.unmatched,
          },
          'job handled',
        );
        return result;
      },
    );
  }
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
