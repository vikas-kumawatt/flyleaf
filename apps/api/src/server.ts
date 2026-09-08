// Phase -1 walking skeleton API. Six endpoints, one process, one database.
// Deliberately crude — see phases.md, Phase -1.

import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { sql } from 'drizzle-orm';

import { config, makeDb, waitForDb, closeDb, MemoryCache, PgRateLimiter } from './platform/index.js';
import { ApiError, sendError } from './http.js';
import { IdentityService, identityRoutes } from './identity/index.js';
import { CatalogService, catalogRoutes } from './catalog/index.js';
import { GapFillService } from './catalog/gapfill.js';
import { ReadingService, readingRoutes } from './reading/index.js';

async function main() {
  const db = makeDb();
  await waitForDb(db);

  // Auth limits go through Postgres because they must be exact and correct
  // across instances. General caching is in-process because for a single
  // instance that is strictly faster than a network hop to Redis.
  const limiter = new PgRateLimiter(db);
  const cache = new MemoryCache(1000);

  const identity = new IdentityService(db, limiter);
  // Gap-fill turns a search miss into a permanent catalog entry (FN-32).
  // Layer 2 of the accelerator: it exists whether or not the dumps have been
  // ingested, because no ingest is ever complete.
  const catalog = new CatalogService(db, cache, new GapFillService(db));
  const reading = new ReadingService(db);

  const app = Fastify({
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
    // Trust the proxy's X-Forwarded-For so rate-limit buckets key on the real
    // client rather than on the proxy (FN-30 depends on this being right).
    trustProxy: true,
    genReqId: () => randomUUID(),
    requestIdHeader: 'x-request-id',
    bodyLimit: 1_048_576,
  });

  await app.register(cors, { origin: true });

  // Auth NEVER rejects. It populates a viewer when a token is present and
  // leaves null when it is not — a guest is a legitimate caller (PRD §4.2).
  app.decorateRequest('viewer', null);
  app.addHook('onRequest', async (req) => {
    const header = req.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      req.viewer = await identity.lookup(header.slice(7).trim());
    }
  });

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof ApiError) return sendError(reply, err);
    req.log.error({ err }, 'unhandled');
    return reply
      .status(500)
      .send({ error: { code: 'internal', message: 'Something went wrong.' } });
  });

  app.setNotFoundHandler((_req, reply) =>
    reply.status(404).send({ error: { code: 'not_found', message: 'Not found.' } }),
  );

  // healthz: is this process alive. readyz: can it actually serve traffic.
  // Keeping them distinct matters — a restart loop caused by a readiness
  // probe that only pings the socket is very hard to diagnose.
  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    await waitForDb(db, 1);
    // The database answering is not the same as the schema being there.
    // Before migrations existed this gap showed up as a 500 on the first
    // real request instead of an honest "not ready".
    const [row] = await db.execute<{ ready: boolean }>(sql`
      SELECT to_regclass('public.works') IS NOT NULL
         AND to_regclass('public.reads') IS NOT NULL AS ready
    `);
    if (!row?.ready) {
      throw new ApiError(503, 'migrations_pending', 'Schema not applied. Run: npm run migrate');
    }
    return { status: 'ready' };
  });

  await app.register(identityRoutes(identity), { prefix: '/v1' });
  await app.register(catalogRoutes(catalog), { prefix: '/v1' });
  await app.register(readingRoutes(reading), { prefix: '/v1' });

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
