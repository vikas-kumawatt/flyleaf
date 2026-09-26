// L-03 regression: the API built exactly as server.ts builds it must hand
// imports and exports to the job queue. Every other import/export test
// injects its own queue, which is how this shipped broken.

import { describe, it, expect } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { buildApp } from '../app.js';
import { QUEUES } from '../jobs/index.js';
import { serverDependencies } from '../server-wiring.js';
import { createProviders, MemoryObjectStorage } from '../providers/index.js';
import { freshDrizzle } from './pg.js';
import { makeUser } from './interaction-fixtures.js';
import { importCsv } from './upload-fixtures.js';

describe('L-03: the production wiring enqueues imports and exports', () => {
  it('passes a queue, storage and mailer into the app', async () => {
    const { db } = await freshDrizzle();
    const sent: { queue: string; data: unknown }[] = [];
    const boss = { send: async (queue: string, data: unknown) => (sent.push({ queue, data }), 'job-1') } as unknown as PgBoss;

    // The factory server.ts calls, with memory drivers instead of disk/console.
    const providers = createProviders({ STORAGE_DRIVER: 'memory', EMAIL_DRIVER: 'memory', ERROR_DRIVER: 'memory' });
    const deps = serverDependencies(db, boss, providers);
    expect(deps.boss).toBe(boss);
    expect(deps.storage).toBe(providers.storage);
    expect(deps.storage).toBeInstanceOf(MemoryObjectStorage);
    expect(deps.mailer).toBe(providers.mailer);
    expect(deps.errorReporter).toBe(providers.errors);

    const app = await buildApp(deps);
    const alice = await makeUser(db, 'alice_l03');

    const csv = 'Title,Author,ISBN,My Rating,Exclusive Shelf\nPiranesi,Susanna Clarke,,5,read\n';
    const imp = await importCsv(app, alice.auth, csv);
    expect(imp.statusCode).toBeLessThan(300);

    const exp = await app.inject({ method: 'POST', url: '/v1/exports', headers: alice.auth, payload: { format: 'csv' } });
    expect(exp.statusCode).toBeLessThan(300);

    expect(sent.map((j) => j.queue)).toEqual([QUEUES.processImport, QUEUES.processExport]);
    await app.close();
  });
});
