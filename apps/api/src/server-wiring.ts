// The API server's dependency wiring (L-03).
//
// Lives outside server.ts so a test can build the app EXACTLY as production
// does. Before this, server.ts wired its services inline and never passed a
// job queue, storage or mailer to buildApp(). The imports and exports
// services only enqueue `if (this.boss)`, so every import and export created
// through the real API sat in 'queued' forever. Every test injected its own
// queue, which is why nothing noticed: the tests proved the feature, the
// server never ran it.

import type { PgBoss } from 'pg-boss';
import { MemoryCache, PgRateLimiter, ConsoleEmailSender, type Db } from './platform/index.js';
import { IdentityService } from './identity/index.js';
import { CatalogService } from './catalog/index.js';
import { GapFillService } from './catalog/gapfill.js';
import { ReadingService } from './reading/index.js';
import { DiskFileStorage } from './imports/storage.js';
import type { BuildAppOptions } from './app.js';

export function serverDependencies(db: Db, boss: PgBoss) {
  // Auth limits go through Postgres because they must be exact and correct
  // across instances. General caching is in-process because for a single
  // instance that is strictly faster than a network hop to Redis.
  const limiter = new PgRateLimiter(db);
  const cache = new MemoryCache(1000);
  const mailer = new ConsoleEmailSender();
  // Same default directory the worker's handlers read from (apps/api/.uploads,
  // relative to the working directory both processes are started from).
  const storage = new DiskFileStorage();

  const deps = {
    db,
    boss,
    storage,
    mailer,
    limiter,
    identity: new IdentityService(db, limiter, mailer),
    // Gap-fill turns a search miss into a permanent catalog entry (FN-32).
    catalog: new CatalogService(db, cache, new GapFillService(db)),
    reading: new ReadingService(db),
  } satisfies BuildAppOptions;
  return deps;
}
