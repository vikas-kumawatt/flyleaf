// IM-11: Duplicate-Import Detection by Content Hash Tests (PRD §34.4, §5141, IM-11).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { users, profiles, imports } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { buildApp } from '../app.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';
import { importCsv, uploadFile } from './upload-fixtures.js';

let app: FastifyInstance;
let drizzleDb: Db;
let storage: MemoryObjectStorage;

const USER_ALICE = '11111111-1111-1111-1111-111111111111';
const USER_BOB = '22222222-2222-2222-2222-222222222222';
const ALICE_TOKEN = 'token-alice';
const BOB_TOKEN = 'token-bob';

const SAMPLE_CSV = `Title,Author,ISBN,My Rating,Exclusive Shelf
Dune,Frank Herbert,0441172717,5,read
Neuromancer,William Gibson,0441569595,4,read
`;

const DIFFERENT_CSV = `Title,Author,ISBN,My Rating,Exclusive Shelf
Foundation,Isaac Asimov,0553293354,5,read
`;

beforeAll(async () => {
  const context = await freshDrizzle();
  drizzleDb = context.db;

  await drizzleDb.insert(users).values([
    {
      id: USER_ALICE,
      email: 'alice@flyleaf.test',
      passwordHash: 'hash1',
      dateOfBirth: '2000-01-01',
    },
    {
      id: USER_BOB,
      email: 'bob@flyleaf.test',
      passwordHash: 'hash2',
      dateOfBirth: '2000-01-01',
    },
  ]);

  await drizzleDb.insert(profiles).values([
    {
      userId: USER_ALICE,
      username: 'alice',
      displayName: 'Alice Reader',
    },
    {
      userId: USER_BOB,
      username: 'bob',
      displayName: 'Bob Reader',
    },
  ]);

  storage = new MemoryObjectStorage();

  const mockIdentity = {
    lookup: async (token: string) => {
      if (token === ALICE_TOKEN) return USER_ALICE;
      if (token === BOB_TOKEN) return USER_BOB;
      return null;
    },
  };

  app = await buildApp({
    db: drizzleDb,
    storage,
    identity: mockIdentity as any,
  });
});

afterAll(async () => {
  await app?.close();
});

describe('IM-11: Duplicate-Import Detection by Content Hash', () => {
  const ALICE = { authorization: `Bearer ${ALICE_TOKEN}` };
  const BOB = { authorization: `Bearer ${BOB_TOKEN}` };

  it('1. Uploading an export file succeeds with 201 and persists content_hash', async () => {
    const res = await importCsv(app, ALICE, SAMPLE_CSV, { filename: 'goodreads_export.csv' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.state).toBe('queued');
    expect(body.content_hash).toBeDefined();
    expect(body.content_hash.length).toBe(64); // SHA-256 hex string

    // Verify record in database
    const [row] = await drizzleDb
      .select()
      .from(imports)
      .where(eq(imports.id, body.id));

    expect(row).toBeDefined();
    expect(row!.contentHash).toBe(body.content_hash);
  });

  it('2. Uploading the exact same file for the same user without force is rejected with 409 duplicate_import', async () => {
    const res = await importCsv(app, ALICE, SAMPLE_CSV, { filename: 'goodreads_export.csv' });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('duplicate_import');
    expect(body.error.message).toContain('An identical file has already been imported');
    expect(body.error.message).toContain('Pass force=true to import anyway');
  });

  it('3. Uploading the exact same file for a different user succeeds (per-user scoping)', async () => {
    const res = await importCsv(app, BOB, SAMPLE_CSV, { filename: 'goodreads_export.csv' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.state).toBe('queued');
  });

  it('4. Uploading the identical file with force=true bypasses duplicate check', async () => {
    const res = await importCsv(app, ALICE, SAMPLE_CSV, { filename: 'goodreads_export.csv', force: true });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.state).toBe('queued');
  });

  it('5. "Import anyway" reuses the refused upload: no second upload needed', async () => {
    const uploadId = await uploadFile(app, ALICE, SAMPLE_CSV, { filename: 'goodreads_export.csv' });
    const take = (force?: boolean) =>
      app.inject({
        method: 'POST',
        url: '/v1/imports',
        headers: ALICE,
        payload: { upload_id: uploadId, source: 'goodreads', ...(force ? { force } : {}) },
      });

    const refused = await take();
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error.code).toBe('duplicate_import');

    const forced = await take(true);
    expect(forced.statusCode).toBe(201);
    expect(forced.json().id).toBeDefined();
  });

  it('6. Previously failed imports with the same content hash do not block re-upload', async () => {
    // Create a new distinct file payload
    const FAILED_CSV = `Title,Author,ISBN,My Rating,Exclusive Shelf\nFailed Book,Some Author,1234567890,3,read\n`;
    const res1 = await importCsv(app, ALICE, FAILED_CSV, { filename: 'failed_test.csv' });

    expect(res1.statusCode).toBe(201);
    const firstImportId = res1.json().id;

    // Mark this import as failed in the database
    await drizzleDb
      .update(imports)
      .set({ state: 'failed', error: 'Simulated failure' })
      .where(eq(imports.id, firstImportId));

    // Upload the exact same file again without force
    const res2 = await importCsv(app, ALICE, FAILED_CSV, { filename: 'failed_test.csv' });

    // Should succeed because previous attempt was failed
    expect(res2.statusCode).toBe(201);
    const secondImportId = res2.json().id;
    expect(secondImportId).not.toBe(firstImportId);
  });

  it('7. Uploading a different file with a different content hash succeeds without force', async () => {
    const res = await importCsv(app, ALICE, DIFFERENT_CSV, { filename: 'different.csv' });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
  });
});
