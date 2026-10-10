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

import { retentionSweep, summariseZeroResults, type RetentionResult, type ZeroSummaryResult } from './retention.js';
import { walkRanges } from './ranges.js';
import { PgBoss, fromDrizzle, type Db as BossDb, type Job, type ConstructorOptions } from 'pg-boss';
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
import type { EmailSender } from '../providers/email/index.js';
import { runDedupe, type DedupeReport } from '../catalog/dedupe.js';
import { processImport } from '../imports/processor.js';
import type { ObjectStorage } from '../providers/storage/index.js';
import { ExportService } from '../exports/index.js';
import { cleanupStorage, type CleanupResult } from '../uploads/index.js';
import { FEED_HORIZON_DAYS } from '../activity/index.js';

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
   * Nightly follow counter reconciliation (Architecture §3.9, SO-01).
   * Reconciles profiles.follower_count and profiles.following_count.
   */
  reconcileFollows: 'follows.reconcile',
  /**
   * Nightly read interaction counter reconciliation (Architecture §3.9, SO-20).
   * Reconciles reads.like_count and reads.comment_count from read_likes /
   * live read_comments. Writes only rows that drifted.
   */
  reconcileReads: 'reads.reconcile',
  /**
   * Nightly work counter reconciliation (Architecture §3.9, audit 08).
   * Refreshes the catalog mean rating, then repairs work_stats and
   * works.reader_count from reads. Writes only rows that drifted, except
   * weighted ratings, which move with the catalog mean.
   */
  reconcileWorks: 'works.reconcile',
  /**
   * Reading library import processing job (PRD §6.8, §24.2, IM-02, IM-08).
   * Parses uploaded CSV, matches against catalog, and populates user reads.
   */
  processImport: 'imports.process',
  /**
   * Reading library export processing job (PRD §1290, §3424, IM-10).
   * Generates CSV/JSON export and emails download link.
   */
  processExport: 'exports.process',
  /**
   * Daily storage cleanup (PV-02): uploads never consumed, export files
   * past their 48 h download window, and import files 30 days after the
   * import finished are deleted from object storage.
   */
  storageCleanup: 'storage.cleanup',
  /**
   * Weekly rebuild of the "Did you mean …?" vocabulary (audit 10, 0032):
   * titles and authors of works with 20+ logs move slowly.
   */
  refreshSearchSuggestions: 'search.suggestions.refresh',
  /**
   * Daily activity retention (PRD §23.5, audit 14): rows older than 180 days
   * are deleted in small batches. Likes and comments live on reads, so a
   * pruned card loses nothing but the card.
   */
  pruneActivity: 'activity.prune',
  /**
   * Nightly authors.has_works repair (Audit 15, §4): authors an ingest left
   * unflagged (it skips the trigger until --finalise) and authors whose works
   * were all merged away. One range of authors at a time.
   */
  repairAuthors: 'authors.repair',
  /**
   * Daily retention (Audit 15, §4; PRD §23.5): ended rate-limit buckets,
   * events past 13 months and zero-result queries past 30 days, shelves,
   * reviews and comments 30 days after deletion, accounts 30 days after
   * deletion with their stored objects, committed import rows trimmed, stray
   * avatar objects.
   */
  retentionSweep: 'retention.sweep',
  /**
   * Weekly zero-result summary (D-10-3): each complete week's counts, with a
   * query's text only past 5 distinct searchers; the week's salt is deleted
   * in the same transaction.
   */
  summariseZeroResults: 'search.zero.summary',
} as const;

export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export type PingRequest = { note?: string };
export type PingResult = { pong: true; note: string; workedAt: string };

export type ReconcileShelvesResult = { reconciled: true; corrected: number; ranges: number; workedAt: string };

export type ReconcileFollowsResult = { reconciled: true; corrected: number; ranges: number; workedAt: string };

export type ReconcileReadsResult = { reconciled: true; corrected: number; ranges: number; workedAt: string };

export type ReconcileWorksResult = {
  reconciled: true;
  /** work_stats rows rewritten. Includes weighted ratings that moved with the catalog mean. */
  workStats: number;
  /** works whose reader_count had drifted; should be 0 every night. */
  readerCount: number;
  catalogMean: number;
  ranges: number;
  workedAt: string;
};

export type DedupeJobRequest = {
  dryRun?: boolean;
  /** Per-run merge cap; DEFAULT_MERGE_CAP when absent. Only matters with DEDUPE_AUTO_MERGE=true. */
  mergeCap?: number;
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

export type ProcessExportJobRequest = {
  exportId: string;
  userId: string;
  format: 'csv' | 'json';
};

export type ProcessExportJobResult = {
  exportId: string;
  processed: boolean;
  fileSizeBytes?: number;
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
 *
 * Never merges unless the worker's environment says so: DEDUPE_AUTO_MERGE=true
 * (Audit 03b). Off, the monthly pass detects and queues only. The switch is
 * deliberately not in the job payload, so nothing that can enqueue a job can
 * turn merging on.
 *
 * On, it merges at most DEFAULT_MERGE_CAP (200) pairs per run: enough for the
 * duplicates a month's ingest adds, not for the catalog's existing backlog,
 * which is cleared with `npm run dedupe -- --backlog` batches (Audit 03c, D6).
 */
export async function dedupeJobHandler(
  jobs: Job<DedupeJobRequest>[],
  db: Db,
  env: Record<string, string | undefined> = process.env,
): Promise<DedupeJobResult> {
  const data = jobs.at(-1)?.data ?? {};
  return runDedupe(db, {
    dryRun: data.dryRun,
    mergeCap: data.mergeCap,
    autoMerge: env.DEDUPE_AUTO_MERGE === 'true',
  });
}

/** Rows per range for the nightly reconciles (Audit 15, A-03-026). */
export const RECONCILE_BATCH = 5_000;
/** Authors per range for the has_works repair: the table is 15.4M rows on the full catalog. */
export const AUTHOR_REPAIR_BATCH = 20_000;

type RangeOpts = { batch?: number };

/**
 * Shelves reconciliation background job handler (Architecture §3.9, SH-01).
 * Reconciles item_count, save_count and cover_work_ids, one range of shelves
 * at a time (Audit 15). `corrected` is the number of shelves that had
 * drifted (A-11-021: the count is now logged).
 */
export async function reconcileShelvesJobHandler(
  _jobs: Job<void>[],
  db: Db,
  opts: RangeOpts = {},
): Promise<ReconcileShelvesResult> {
  let corrected = 0;
  const ranges = await walkRanges(db, { table: 'shelves', column: 'id' }, opts.batch ?? RECONCILE_BATCH, async (lo, hi) => {
    const [row] = await db.execute<{ n: number }>(sql`SELECT reconcile_shelf_counters(${lo}::uuid, ${hi}::uuid) AS n`);
    corrected += Number(row?.n ?? 0);
  });
  return { reconciled: true, corrected, ranges, workedAt: new Date().toISOString() };
}

/**
 * Follow counter reconciliation background job handler (Architecture §3.9, SO-01).
 * `corrected` is the number of profiles whose counters had drifted (audit 13,
 * A-13-002): 0 on a healthy night. One range of profiles at a time.
 */
export async function reconcileFollowsJobHandler(
  _jobs: Job<void>[],
  db: Db,
  opts: RangeOpts = {},
): Promise<ReconcileFollowsResult> {
  let corrected = 0;
  const ranges = await walkRanges(db, { table: 'profiles', column: 'user_id' }, opts.batch ?? RECONCILE_BATCH, async (lo, hi) => {
    const [row] = await db.execute<{ n: number }>(sql`SELECT reconcile_follow_counters(${lo}::uuid, ${hi}::uuid) AS n`);
    corrected += Number(row?.n ?? 0);
  });
  return { reconciled: true, corrected, ranges, workedAt: new Date().toISOString() };
}

/**
 * Read interaction counter reconciliation (Architecture §3.9, SO-20).
 * `corrected` is the number of reads whose counters had drifted — it should
 * be 0 every night; anything else means a trigger is missing a path.
 */
export async function reconcileReadsJobHandler(
  _jobs: Job<void>[],
  db: Db,
  opts: RangeOpts = {},
): Promise<ReconcileReadsResult> {
  let corrected = 0;
  const ranges = await walkRanges(db, { table: 'reads', column: 'id' }, opts.batch ?? RECONCILE_BATCH, async (lo, hi) => {
    const [row] = await db.execute<{ n: number }>(sql`SELECT reconcile_read_counters(${lo}::uuid, ${hi}::uuid) AS n`);
    corrected += Number(row?.n ?? 0);
  });
  return { reconciled: true, corrected, ranges, workedAt: new Date().toISOString() };
}

/**
 * Work counter reconciliation (Architecture §3.9, audit 08).
 * `readerCount` should be 0 every night: anything else means a path changed
 * reads without the triggers seeing it (or a race the lock does not cover).
 *
 * Two walks over reads.work_id (Audit 15): the catalog mean C summed range
 * by range and written once, then work_stats and reader_count repaired range
 * by range with that C. Same results as reconcile_work_counters(), without
 * aggregating every read in one statement.
 */
export async function reconcileWorksJobHandler(
  _jobs: Job<void>[],
  db: Db,
  opts: RangeOpts = {},
): Promise<ReconcileWorksResult> {
  const batch = opts.batch ?? RECONCILE_BATCH;
  const key = { table: 'reads', column: 'work_id' } as const;
  let ratingSum = 0;
  let ratingCount = 0;
  await walkRanges(db, key, batch, async (lo, hi) => {
    const [row] = await db.execute<{ rating_sum: string; rating_count: string }>(
      sql`SELECT rating_sum::text, rating_count::text FROM catalog_rating_sums(${lo}::uuid, ${hi}::uuid)`);
    ratingSum += Number(row?.rating_sum ?? 0);
    ratingCount += Number(row?.rating_count ?? 0);
  });
  await db.execute(sql`
    INSERT INTO catalog_rating_stats (id, rating_sum, rating_count, refreshed_at)
    VALUES (true, ${ratingSum.toFixed(1)}::numeric, ${ratingCount}, now())
    ON CONFLICT (id) DO UPDATE SET
      rating_sum = EXCLUDED.rating_sum, rating_count = EXCLUDED.rating_count, refreshed_at = EXCLUDED.refreshed_at`);
  const [cRow] = await db.execute<{ c: string }>(sql`SELECT flyleaf_catalog_mean()::text AS c`);
  const c = cRow?.c ?? '3.9';

  let workStats = 0;
  let readerCount = 0;
  const ranges = await walkRanges(db, key, batch, async (lo, hi) => {
    const [row] = await db.execute<{ r: { work_stats: number; reader_count: number } }>(
      sql`SELECT reconcile_work_counters(${lo}::uuid, ${hi}::uuid, ${c}::numeric) AS r`);
    workStats += Number(row?.r.work_stats ?? 0);
    readerCount += Number(row?.r.reader_count ?? 0);
  });
  return {
    reconciled: true,
    workStats,
    readerCount,
    catalogMean: Number(c),
    ranges,
    workedAt: new Date().toISOString(),
  };
}

export type RepairAuthorsResult = { set: number; cleared: number; ranges: number; workedAt: string };

/**
 * Nightly authors.has_works repair (Audit 15, §4; Part 02b/02c). The ingest
 * skips the has_works trigger and relies on `--finalise`: an ingest that dies
 * before it leaves new authors out of author search until this runs. Also
 * clears the flag of authors whose works were all merged away. Should report
 * 0 / 0 on a healthy night. One range of authors at a time.
 */
export async function repairAuthorsJobHandler(
  _jobs: Job<void>[],
  db: Db,
  opts: RangeOpts = {},
): Promise<RepairAuthorsResult> {
  let set = 0;
  let cleared = 0;
  const ranges = await walkRanges(db, { table: 'authors', column: 'id' }, opts.batch ?? AUTHOR_REPAIR_BATCH, async (lo, hi) => {
    const [row] = await db.execute<{ r: { set: number; cleared: number } }>(
      sql`SELECT repair_author_has_works(${lo}::uuid, ${hi}::uuid) AS r`);
    set += Number(row?.r.set ?? 0);
    cleared += Number(row?.r.cleared ?? 0);
  });
  return { set, cleared, ranges, workedAt: new Date().toISOString() };
}

export type PruneActivityResult = { deleted: number; batches: number; workedAt: string };

/**
 * PRD §23.5: `activity` rows are kept 180 days, then pruned. Deletes in
 * batches of `batchSize`, each its own short statement, so the table is never
 * locked for long and the feed keeps reading while it runs. The batch picks
 * through activity_visibility_idx (visibility, created_at), which every row
 * is in. Nothing references an activity id: dedupe's undo log may name
 * pruned ids, and its UPDATE then matches nothing.
 */
export async function pruneActivityJobHandler(
  _jobs: Job<void>[],
  db: Db,
  opts: { batchSize?: number; maxBatches?: number } = {},
): Promise<PruneActivityResult> {
  const batchSize = opts.batchSize ?? 5_000;
  const maxBatches = opts.maxBatches ?? 1_000;
  let deleted = 0;
  let batches = 0;
  while (batches < maxBatches) {
    const rows = await db.execute<{ id: string }>(sql`
      DELETE FROM activity WHERE id IN (
        SELECT id FROM activity
        WHERE visibility IN ('public', 'followers', 'private')
          AND created_at < now() - make_interval(days => ${FEED_HORIZON_DAYS})
        LIMIT ${batchSize})
      RETURNING id`);
    batches++;
    deleted += rows.length;
    if (rows.length < batchSize) break;
  }
  return { deleted, batches, workedAt: new Date().toISOString() };
}

/** Rebuilds search_suggestions (0032); returns the number of terms. */
export async function refreshSearchSuggestionsJobHandler(_jobs: Job<void>[], db: Db): Promise<{ terms: number }> {
  const [row] = await db.execute<{ n: number }>(sql`SELECT refresh_search_suggestions() AS n;`);
  return { terms: Number(row?.n ?? 0) };
}

/**
 * Import processing background job handler (PRD §6.8, §24.2, IM-02, IM-08).
 * Full chunked resumable processor is expanded in IM-08.
 */
export async function processImportJobHandler(
  jobs: Job<ProcessImportJobRequest>[],
  db: Db,
  storage: ObjectStorage,
): Promise<ProcessImportJobResult> {
  const job = jobs.at(-1);
  const importId = job?.data?.importId ?? '';
  if (!job || !importId) {
    return {
      importId: '',
      processed: false,
      workedAt: new Date().toISOString(),
    };
  }

  const res = await processImport(db, storage, importId);

  return {
    importId: job.data.importId,
    processed: res.state === 'completed',
    totalRows: res.totalRows,
    matched: res.matched,
    unmatched: res.unmatched,
    workedAt: new Date().toISOString(),
  };
}

export async function processExportJobHandler(
  jobs: Job<ProcessExportJobRequest>[],
  db: Db,
  storage: ObjectStorage,
  mailer: EmailSender,
): Promise<ProcessExportJobResult> {
  const job = jobs[0];
  if (!job) throw new Error('No job passed to handler');

  const service = new ExportService(db, storage, mailer);

  const res = await service.processExport(job.data.exportId);

  return {
    exportId: job.data.exportId,
    processed: res.state === 'completed',
    fileSizeBytes: res.file_size_bytes ?? undefined,
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
export function makeBoss(
  opts: { db?: BossDb; backend?: 'postgres' | 'pglite'; options?: Partial<ConstructorOptions> } = {},
): PgBoss {
  return new PgBoss({
    ...(opts.db
      ? { db: opts.db, backend: opts.backend ?? 'postgres' }
      : { connectionString: config.databaseUrl }),
    ...opts.options,
    schema: JOBS_SCHEMA,
  });
}

/**
 * A boss for the API process: it ENQUEUES and nothing else.
 *
 * Supervision, maintenance and cron belong to the worker (worker.ts). Two
 * processes both running maintenance is harmless but wasteful; two both
 * running the cron would double-schedule. `supervise: false` and
 * `schedule: false` keep the API a pure producer.
 */
export function makeProducerBoss(): PgBoss {
  return makeBoss({ options: { supervise: false, schedule: false } });
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
/**
 * What the handlers that touch data need. The worker builds it from the same
 * provider factory as the API (providers/index.ts), so both processes read and
 * write the same storage -- the handlers used to default to a local disk and
 * a console mailer of their own.
 */
export interface WorkerDeps {
  db: Db;
  /** The monthly dedupe pass's connection (JOB_DB_SETTINGS.dedupe). Default: `db`. */
  dedupeDb?: Db;
  storage: ObjectStorage;
  mailer: EmailSender;
}

export async function registerQueues(boss: PgBoss, log: JobLog, deps?: WorkerDeps): Promise<void> {
  for (const name of Object.values(QUEUES)) await boss.createQueue(name);

  // The monthly dedupe pass reads the whole catalog: stage 1–2 detection alone
  // took 7.5 minutes on 3.2M works (Audit 03). At the 15-minute default it is
  // expired and retried while the first run is still merging. update, not
  // create, so queues that already exist with the default are fixed too.
  await boss.updateQueue(QUEUES.catalogDedupe, { expireInSeconds: 4 * 60 * 60 });

  await boss.work<PingRequest, PingResult>(QUEUES.smokePing, async (jobs) => {
    const result = await pingHandler(jobs);
    log.info({ queue: QUEUES.smokePing, ids: jobs.map((j) => j.id), note: result.note },
             'job handled');
    return result;
  });

  if (deps) {
    const { db, storage, mailer } = deps;
    await boss.work<DedupeJobRequest, DedupeJobResult>(QUEUES.catalogDedupe, async (jobs) => {
      const result = await dedupeJobHandler(jobs, deps.dedupeDb ?? db);
      log.info(
        {
          queue: QUEUES.catalogDedupe,
          ids: jobs.map((j) => j.id),
          stage1: result.stage1,
          stage2: result.stage2,
          autoMergeable: result.autoMergeable,
          toReview: result.toReview,
          queued: result.queued,
          stage3: result.stage3,
          stage3Queued: result.stage3Queued,
          stage3Since: result.stage3Since,
          autoMerge: result.autoMerge,
          merged: result.merged,
          skipped: result.skipped,
          deferred: result.deferred,
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
          corrected: result.corrected,
          ranges: result.ranges,
        },
        'job handled',
      );
      return result;
    });

    await boss.work<void, ReconcileFollowsResult>(QUEUES.reconcileFollows, async (jobs) => {
      const result = await reconcileFollowsJobHandler(jobs, db);
      log.info(
        {
          queue: QUEUES.reconcileFollows,
          ids: jobs.map((j) => j.id),
          reconciled: result.reconciled,
          corrected: result.corrected,
        },
        'job handled',
      );
      return result;
    });

    await boss.work<void, ReconcileReadsResult>(QUEUES.reconcileReads, async (jobs) => {
      const result = await reconcileReadsJobHandler(jobs, db);
      log.info(
        {
          queue: QUEUES.reconcileReads,
          ids: jobs.map((j) => j.id),
          corrected: result.corrected,
        },
        'job handled',
      );
      return result;
    });

    await boss.work<void, ReconcileWorksResult>(QUEUES.reconcileWorks, async (jobs) => {
      const result = await reconcileWorksJobHandler(jobs, db);
      log.info(
        {
          queue: QUEUES.reconcileWorks,
          ids: jobs.map((j) => j.id),
          workStats: result.workStats,
          readerCount: result.readerCount,
          catalogMean: result.catalogMean,
        },
        'job handled',
      );
      return result;
    });

    await boss.work<void, RepairAuthorsResult>(QUEUES.repairAuthors, async (jobs) => {
      const result = await repairAuthorsJobHandler(jobs, db);
      log.info({ queue: QUEUES.repairAuthors, ids: jobs.map((j) => j.id), set: result.set, cleared: result.cleared, ranges: result.ranges }, 'job handled');
      return result;
    });

    await boss.work<void, RetentionResult>(QUEUES.retentionSweep, async (jobs) => {
      const result = await retentionSweep(db, storage);
      log.info({ queue: QUEUES.retentionSweep, ids: jobs.map((j) => j.id), ...result }, 'job handled');
      return result;
    });

    await boss.work<void, ZeroSummaryResult>(QUEUES.summariseZeroResults, async (jobs) => {
      const result = await summariseZeroResults(db);
      log.info({ queue: QUEUES.summariseZeroResults, ids: jobs.map((j) => j.id), weeks: result.weeks, rows: result.rows }, 'job handled');
      return result;
    });

    await boss.work<void, PruneActivityResult>(QUEUES.pruneActivity, async (jobs) => {
      const result = await pruneActivityJobHandler(jobs, db);
      log.info(
        { queue: QUEUES.pruneActivity, ids: jobs.map((j) => j.id), deleted: result.deleted, batches: result.batches },
        'job handled',
      );
      return result;
    });

    await boss.work<void, { terms: number }>(QUEUES.refreshSearchSuggestions, async (jobs) => {
      const result = await refreshSearchSuggestionsJobHandler(jobs, db);
      log.info({ queue: QUEUES.refreshSearchSuggestions, ids: jobs.map((j) => j.id), terms: result.terms }, 'job handled');
      return result;
    });

    await boss.work<ProcessImportJobRequest, ProcessImportJobResult>(
      QUEUES.processImport,
      async (jobs) => {
        const result = await processImportJobHandler(jobs, db, storage);
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

    await boss.work<ProcessExportJobRequest, ProcessExportJobResult>(
      QUEUES.processExport,
      async (jobs) => {
        const result = await processExportJobHandler(jobs, db, storage, mailer);
        log.info(
          {
            queue: QUEUES.processExport,
            ids: jobs.map((j) => j.id),
            exportId: result.exportId,
            processed: result.processed,
          },
          'job handled',
        );
        return result;
      },
    );

    await boss.work<void, CleanupResult>(QUEUES.storageCleanup, async (jobs) => {
      const result = await cleanupStorage(db, storage);
      log.info(
        {
          queue: QUEUES.storageCleanup,
          ids: jobs.map((j) => j.id),
          uploadsExpired: result.uploadsExpired,
          exportFilesDeleted: result.exportFilesDeleted,
          importFilesDeleted: result.importFilesDeleted,
        },
        'job handled',
      );
      return result;
    });
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
