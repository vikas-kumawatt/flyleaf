// Phase -1 walking skeleton API. Six endpoints, one process, one database.
// Deliberately crude — see phases.md, Phase -1.

import { config, makeDb, waitForDb, closeDb, MemoryCache, PgRateLimiter, ConsoleEmailSender } from './platform/index.js';
import { IdentityService } from './identity/index.js';
import { CatalogService } from './catalog/index.js';
import { GapFillService } from './catalog/gapfill.js';
import { ReadingService } from './reading/index.js';
import { buildApp } from './app.js';

async function main() {
  const db = makeDb();
  await waitForDb(db);

  // Auth limits go through Postgres because they must be exact and correct
  // across instances. General caching is in-process because for a single
  // instance that is strictly faster than a network hop to Redis.
  const limiter = new PgRateLimiter(db);
  const cache = new MemoryCache(1000);
  const mailer = new ConsoleEmailSender();

  const identity = new IdentityService(db, limiter, mailer);
  // Gap-fill turns a search miss into a permanent catalog entry (FN-32).
  // Layer 2 of the accelerator: it exists whether or not the dumps have been
  // ingested, because no ingest is ever complete.
  const catalog = new CatalogService(db, cache, new GapFillService(db));
  const reading = new ReadingService(db);

  const app = await buildApp({
    db,
    identity,
    catalog,
    reading,
    limiter,
    trustProxy: true,
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
        req: (req) => ({ method: req.method, url: req.url, id: req.id }),
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
