// Phase -1 walking skeleton API. Six endpoints, one process, one database.
// Deliberately crude — see phases.md, Phase -1.

import { config, makeDb, waitForDb, closeDb } from './platform/index.js';
import { buildApp, redactUrl } from './app.js';
import { makeProducerBoss, QUEUES } from './jobs/index.js';
import { serverDependencies } from './server-wiring.js';
import { createProviders } from './providers/index.js';

async function main() {
  // First: a production process with a dev adapter or missing credentials
  // must exit here, before it waits on the database (PV-08).
  const providers = createProviders();

  const db = makeDb();
  await waitForDb(db);

  // The API enqueues imports and exports; the worker (`npm run worker`)
  // processes them. Without this boss, both features were dead outside the
  // tests (L-03). Queues are created here too, so enqueueing works even
  // before a worker has ever started.
  const boss = makeProducerBoss();
  boss.on('error', (err) => console.error('pg-boss (api):', err));
  await boss.start();
  await boss.createQueue(QUEUES.processImport);
  await boss.createQueue(QUEUES.processExport);

  const app = await buildApp({
    ...serverDependencies(db, boss, providers),
    trustProxy: config.trustProxy,
    logger: {
      level: config.logLevel,
      // Structured JSON in production, human-readable locally. Never both.
      ...(config.env === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : {}),
      // A bearer token in a log line is a credential at rest in a log
      // aggregator. Redact at the logger, not at each call site.
      redact: {
        paths: ['req.headers.authorization', 'req.headers.cookie', 'res.headers["set-cookie"]'],
        remove: true,
      },
      serializers: {
        // The query string can carry an export download token: redacted.
        req: (req) => ({ method: req.method, url: redactUrl(req.url), id: req.id }),
      },
    },
  });

  await app.listen({ port: config.port, host: config.host });

  // Graceful shutdown, in order: stop accepting connections and let in-flight
  // requests finish, THEN close the database pool. Closing the pool first
  // fails every request that was already running.
  //
  // The timer is the important part: a hung request must not hold the process
  // open forever, because an orchestrator will SIGKILL it and you lose the
  // shutdown logs that would have told you what hung. unref() so the timer
  // itself never keeps the process alive.
  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');

    const force = setTimeout(() => {
      app.log.error('shutdown timed out after 10s, exiting anyway');
      process.exit(1);
    }, 10_000);
    force.unref();

    try {
      await app.close();
      // After the HTTP server (no new enqueues), before the pool.
      await boss.stop({ graceful: true, timeout: 5_000 });
      await closeDb(db);
      app.log.info('shutdown complete');
      process.exit(0);
    } catch (err) {
      app.log.error({ err }, 'shutdown failed');
      process.exit(1);
    }
  };

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => void shutdown(signal));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
