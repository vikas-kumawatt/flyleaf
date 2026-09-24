// Audit bench query counter (Part 01): dev-only, must be inert unless enabled.

import { describe, expect, it } from 'vitest';
import Fastify from 'fastify';

import { buildApp } from '../app.js';
import { countQuery, queryCountingEnabled, QUERY_COUNT_HEADER, registerQueryCounter } from '../bench/query-counter.js';

describe('bench query counter', () => {
  it('is off, and buildApp adds no header, when BENCH_COUNT_QUERIES is unset', async () => {
    expect(process.env.BENCH_COUNT_QUERIES).toBeUndefined();
    expect(queryCountingEnabled).toBe(false);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.statusCode).toBe(200);
    expect(res.headers[QUERY_COUNT_HEADER]).toBeUndefined();
    await app.close();
  });

  it('counts per request, across awaits, without leaking between concurrent requests', async () => {
    const app = Fastify();
    registerQueryCounter(app);
    // An auth-style hook that "queries" before the handler, as registerCoreHooks' does.
    app.addHook('onRequest', async () => { countQuery(); });
    app.get('/n/:n', async (req) => {
      const n = Number((req.params as { n: string }).n);
      for (let i = 0; i < n; i++) {
        // Yield between statements so the concurrent requests interleave.
        await new Promise((r) => setTimeout(r, 1 + ((i * 7) % 5)));
        countQuery();
      }
      return { ok: true };
    });

    const counts = [0, 3, 7, 12, 1, 5];
    const responses = await Promise.all(counts.map((n) => app.inject({ method: 'GET', url: `/n/${n}` })));
    expect(responses.map((r) => r.headers[QUERY_COUNT_HEADER])).toEqual(counts.map((n) => String(n + 1)));

    // Outside a request there is no store, so nothing is counted anywhere.
    expect(() => countQuery()).not.toThrow();
    await app.close();
  });
});
