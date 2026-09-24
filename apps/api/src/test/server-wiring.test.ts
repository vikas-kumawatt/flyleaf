// L-03 regression: the API built exactly as server.ts builds it must hand
// imports and exports to the job queue. Every other import/export test
// injects its own queue, which is how this shipped broken.

import crypto from 'node:crypto';
import { describe, it, expect } from 'vitest';
import type { PgBoss } from 'pg-boss';
import { buildApp } from '../app.js';
import { QUEUES } from '../jobs/index.js';
import { serverDependencies } from '../server-wiring.js';
import { MemoryFileStorage } from '../imports/storage.js';
import { freshDrizzle } from './pg.js';
import { makeUser } from './interaction-fixtures.js';

function multipart(fields: Record<string, string>, csv: string) {
  const b = '----L03' + crypto.randomBytes(6).toString('hex');
  const parts = [
    ...Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`),
    `--${b}\r\nContent-Disposition: form-data; name="file"; filename="library.csv"\r\nContent-Type: text/csv\r\n\r\n${csv}\r\n`,
    `--${b}--\r\n`,
  ];
  return { headers: { 'content-type': `multipart/form-data; boundary=${b}` }, payload: Buffer.from(parts.join('')) };
}

describe('L-03: the production wiring enqueues imports and exports', () => {
  it('passes a queue, storage and mailer into the app', async () => {
    const { db } = await freshDrizzle();
    const sent: { queue: string; data: unknown }[] = [];
    const boss = { send: async (queue: string, data: unknown) => (sent.push({ queue, data }), 'job-1') } as unknown as PgBoss;

    const deps = serverDependencies(db, boss);
    expect(deps.boss).toBe(boss);
    expect(deps.storage).toBeDefined();
    expect(deps.mailer).toBeDefined();

    // Swap only the disk for memory; everything else is the real wiring.
    const app = await buildApp({ ...deps, storage: new MemoryFileStorage() });
    const alice = await makeUser(db, 'alice_l03');

    const csv = 'Title,Author,ISBN,My Rating,Exclusive Shelf\nPiranesi,Susanna Clarke,,5,read\n';
    const up = multipart({ source: 'goodreads' }, csv);
    const imp = await app.inject({ method: 'POST', url: '/v1/imports', headers: { ...up.headers, ...alice.auth }, payload: up.payload });
    expect(imp.statusCode).toBeLessThan(300);

    const exp = await app.inject({ method: 'POST', url: '/v1/exports', headers: alice.auth, payload: { format: 'csv' } });
    expect(exp.statusCode).toBeLessThan(300);

    expect(sent.map((j) => j.queue)).toEqual([QUEUES.processImport, QUEUES.processExport]);
    await app.close();
  });
});
