// Per-request SQL statement counter (audit Part 01). Dev-only.
//
// Enabled by BENCH_COUNT_QUERIES=1. When unset, makeDb() passes no `debug`
// option and buildApp() registers no hooks, so production pays nothing and
// behaves identically.
//
// How it counts: postgres.js calls `debug` once for every statement it sends,
// including BEGIN/COMMIT and SEARCH_SQL's `$client.unsafe` (which a Drizzle
// logger would miss). The request is identified with AsyncLocalStorage, entered
// in the first onRequest hook so the auth hook's queries are counted too.
//
// LIMITATION: postgres.js fires `debug` when a statement is DISPATCHED to a
// connection, not when it is created. A statement that queued behind a busy
// pool is dispatched from another query's completion callback and is counted
// against whichever request that was. Counts are therefore exact only when
// one request is in flight at a time. The bench runner measures them in a
// separate sequential pass for exactly this reason; do not read them from a
// concurrent load run.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';

export const queryCountingEnabled = process.env.BENCH_COUNT_QUERIES === '1';

export const QUERY_COUNT_HEADER = 'x-bench-query-count';

const store = new AsyncLocalStorage<{ n: number }>();

/** postgres.js `debug` option. */
export function countQuery(): void {
  const s = store.getStore();
  if (s) s.n++;
}

export function registerQueryCounter(app: FastifyInstance): void {
  // Callback style, not async: `done` has to run INSIDE store.run() so that
  // every later hook, the handler and their promise continuations inherit
  // the store.
  app.addHook('onRequest', (_req, _reply, done) => {
    store.run({ n: 0 }, done);
  });
  app.addHook('onSend', async (_req, reply, payload) => {
    const s = store.getStore();
    if (s) reply.header(QUERY_COUNT_HEADER, String(s.n));
    return payload;
  });
  app.addHook('onResponse', async (req) => {
    const s = store.getStore();
    if (s) req.log.info({ queries: s.n, route: req.routeOptions?.url }, 'bench query count');
  });
}
