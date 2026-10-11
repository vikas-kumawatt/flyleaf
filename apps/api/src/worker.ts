// The worker process (FN-04). architecture.md §2: `node dist/worker.js`.
//
// SAME CODEBASE as the API, deliberately. One artifact deployed twice means
// the worker cannot be running a different version of a job's code than the
// API that enqueued it — version skew in a queue is the kind of bug that
// shows up as data corruption weeks later.
//
//   npm run worker         development (tsx watch)
//   node dist/worker.js    production
//   npm run ping           enqueue one smoke.ping and exit
//
// `ping` is its own script rather than `worker -- --ping`, because `worker`
// runs under `tsx watch` and watch mode does not exit when main() returns --
// so the one-shot sat there holding the terminal open after doing its job.

import { pino } from 'pino';
import { config, makeDb, waitForDb, closeDb, JOB_DB_SETTINGS } from './platform/index.js';
import { makeBoss, registerQueues, QUEUES } from './jobs/index.js';
import { createProviders } from './providers/index.js';

const log = pino({
  level: config.logLevel,
  ...(config.env === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
    : {}),
});

async function main() {
  // Before the database, like server.ts: fail fast on provider config (PV-08).
  const providers = createProviders();

  // In `docker compose up` this process wins the race against Postgres, and
  // pg-boss's own start would fail on the first connection rather than wait.
  // The pool is also what job handlers will use as they arrive; the one that
  // exists today needs no database at all.
  // Every job runs under its own work_mem and statement_timeout (Audit 15,
  // A-03-026): the worker's pool for the nightly jobs, a pool of one for the
  // monthly dedupe pass, whose statements are longer.
  const db = makeDb(config.databaseUrl, { max: 4, settings: JOB_DB_SETTINGS.worker });
  const dedupeDb = makeDb(config.databaseUrl, { max: 1, settings: JOB_DB_SETTINGS.dedupe });
  await waitForDb(db);

  const boss = makeBoss();

  // `--ping` enqueues one job and leaves. A smoke job nobody can trigger is
  // not a smoke test -- this is how you answer "is anything consuming?" from
  // a terminal, which is otherwise surprisingly hard. It creates the queue
  // first so it also works before a worker has ever run.
  if (process.argv.includes('--ping')) {
    await boss.start();
    await boss.createQueue(QUEUES.smokePing);
    const id = await boss.send(QUEUES.smokePing, { note: `manual ${new Date().toISOString()}` });
    // ASCII only. A Windows console renders this line in the OEM code page,
    // where a UTF-8 em dash arrives as three bytes of mojibake.
    log.info({ id, queue: QUEUES.smokePing }, 'enqueued; a running worker should handle it');
    await boss.stop({ graceful: false });
    await closeDb(db);
    await closeDb(dedupeDb);
    return;
  }

  if (process.argv.includes('--dedupe')) {
    await boss.start();
    await boss.createQueue(QUEUES.catalogDedupe);
    const id = await boss.send(QUEUES.catalogDedupe, {});
    log.info({ id, queue: QUEUES.catalogDedupe }, 'enqueued; a running worker should handle it');
    await boss.stop({ graceful: false });
    await closeDb(db);
    await closeDb(dedupeDb);
    return;
  }

  // pg-boss reports operational trouble through events, not throws. Without
  // a listener on `error` an EventEmitter turns one into an uncaught
  // exception that kills the process; without one on `warning`, a queue
  // quietly backing up says nothing at all.
  boss.on('error', (err) => log.error({ err }, 'pg-boss'));
  boss.on('warning', (warning) => log.warn({ warning }, 'pg-boss'));

  await boss.start();
  await registerQueues(boss, log, { db, dedupeDb, storage: providers.storage, mailer: providers.mailer });

  // Monthly dedupe pass: 1st of every month at midnight (FN-52, Architecture §9).
  // It detects and queues; it merges only if this worker runs with
  // DEDUPE_AUTO_MERGE=true (Audit 03b), at most 200 per run. That cap is for
  // NEW duplicates: the catalog's existing backlog is cleared by hand with
  // `npm run dedupe -- --backlog` batches (Audit 03c, D6; README).
  await boss.schedule(QUEUES.catalogDedupe, '0 0 1 * *', {});

  // Nightly counter reconciliation (Architecture §3.9: "every counter has a
  // reconciliation job"). Staggered so they never contend for the same rows.
  // Shelves and follows had handlers since SH-01/SO-01 but were never
  // scheduled — a reconciler that never runs reconciles nothing.
  await boss.schedule(QUEUES.reconcileShelves, '0 3 * * *');
  await boss.schedule(QUEUES.reconcileFollows, '15 3 * * *');
  await boss.schedule(QUEUES.reconcileReads, '30 3 * * *');
  // Catalog mean rating, work_stats and works.reader_count (audit 08, 0026).
  // After reads.reconcile, so it counts settled reads.
  await boss.schedule(QUEUES.reconcileWorks, '40 3 * * *');
  // Expired uploads and export files leave object storage (PV-02).
  await boss.schedule(QUEUES.storageCleanup, '45 3 * * *');
  // Activity older than 180 days leaves the feed's table (PRD §23.5, audit 14).
  await boss.schedule(QUEUES.pruneActivity, '55 3 * * *');
  // authors.has_works repair (Audit 15): after the reconcilers.
  await boss.schedule(QUEUES.repairAuthors, '5 4 * * *');
  // Retention (Audit 15, PRD §23.5): soft deletes past 30 days, old events,
  // ended rate-limit buckets, deleted accounts and their objects.
  await boss.schedule(QUEUES.retentionSweep, '20 4 * * *');
  // Zero-result summary for the week that just ended (D-10-3): Mondays.
  await boss.schedule(QUEUES.summariseZeroResults, '30 4 * * 1');
  // "Did you mean …?" vocabulary (audit 10): Sundays, after works.reconcile
  // has settled log counts.
  await boss.schedule(QUEUES.refreshSearchSuggestions, '0 4 * * 0');

  log.info({ queues: Object.values(QUEUES), schema: 'pgboss' }, 'worker ready');

  // Shutdown order mirrors server.ts and matters for the same reason: stop
  // taking new work and let in-flight jobs finish BEFORE closing the pool.
  // Closing first fails whatever was running, and a job killed mid-flight is
  // retried — so the cost of getting this backwards is duplicated work, not
  // just an ugly log line.
  //
  // The force timer is unref'd so it never holds the process open by itself.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      log.error('shutdown timed out after 30s, exiting anyway');
      process.exit(1);
    }, 30_000);
    force.unref();

    try {
      // Longer than the API's 10s: a job is allowed to be slow in a way an
      // HTTP request is not, and finishing beats retrying.
      await boss.stop({ graceful: true, timeout: 25_000 });
      await closeDb(db);
      await closeDb(dedupeDb);
      log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((err) => {
  log.error({ err }, 'worker failed to start');
  process.exit(1);
});
