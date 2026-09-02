// Phase -1 walking skeleton API. Six endpoints, one process, one database.
// Deliberately crude — see phases.md, Phase -1.

import Fastify from 'fastify';
import cors from '@fastify/cors';

import { config, makeDb, waitForDb, MemoryCache, PgRateLimiter } from './platform/index.js';
import { ApiError, sendError } from './http.js';
import { IdentityService, identityRoutes } from './identity/index.js';
import { CatalogService, catalogRoutes } from './catalog/index.js';
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
  const catalog = new CatalogService(db, cache);
  const reading = new ReadingService(db);

  const app = Fastify({
    logger:
      config.env === 'development'
        ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } } }
        : true,
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

  app.get('/healthz', async () => ({ status: 'ok' }));
  app.get('/readyz', async () => {
    await waitForDb(db, 1);
    return { status: 'ready' };
  });

  await app.register(identityRoutes(identity), { prefix: '/v1' });
  await app.register(catalogRoutes(catalog), { prefix: '/v1' });
  await app.register(readingRoutes(reading), { prefix: '/v1' });

  await app.listen({ port: config.port, host: config.host });

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      app.log.info('shutting down');
      void app.close().then(() => process.exit(0));
    });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
