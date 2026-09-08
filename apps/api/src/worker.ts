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
import { config, makeDb, waitForDb, closeDb } from './platform/index.js';
import { makeBoss, registerQueues, QUEUES } from './jobs/index.js';

const log = pino({
  level: config.logLevel,
  ...(config.env === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
    : {}),
});

async function main() {
  // In `docker compose up` this process wins the race against Postgres, and
  // pg-boss's own start would fail on the first connection rather than wait.
  // The pool is also what job handlers will use as they arrive; the one that
  // exists today needs no database at all.
  const db = makeDb(config.databaseUrl, { max: 4 });
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
    return;
  }

  // pg-boss reports operational trouble through events, not throws. Without
  // a listener on `error` an EventEmitter turns one into an uncaught
  // exception that kills the process; without one on `warning`, a queue
  // quietly backing up says nothing at all.
  boss.on('error', (err) => log.error({ err }, 'pg-boss'));
  boss.on('warning', (warning) => log.warn({ warning }, 'pg-boss'));

  await boss.start();
  await registerQueues(boss, log);

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
