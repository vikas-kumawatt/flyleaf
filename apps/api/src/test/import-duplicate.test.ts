// IM-11: Duplicate-Import Detection by Content Hash Tests (PRD §34.4, §5141, IM-11).

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { users, profiles, imports } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { buildApp } from '../app.js';
import { MemoryFileStorage } from '../imports/storage.js';

let app: FastifyInstance;
let drizzleDb: Db;
let storage: MemoryFileStorage;

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

function buildMultipart(
  fields: Record<string, string>,
  file?: { name: string; filename: string; content: string | Buffer; mimeType?: string },
) {
  const boundary = '----FlyleafBoundary' + crypto.randomBytes(8).toString('hex');
  const crlf = '\r\n';
  const parts: Buffer[] = [];

  for (const [key, value] of Object.entries(fields)) {
    parts.push(
      Buffer.from(
        `--${boundary}${crlf}Content-Disposition: form-data; name="${key}"${crlf}${crlf}${value}${crlf}`,
      ),
    );
  }

  if (file) {
    const header = `--${boundary}${crlf}Content-Disposition: form-data; name="${file.name}"; filename="${file.filename}"${crlf}Content-Type: ${file.mimeType || 'text/csv'}${crlf}${crlf}`;
    parts.push(Buffer.from(header));
    parts.push(Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content));
    parts.push(Buffer.from(crlf));
  }

  parts.push(Buffer.from(`--${boundary}--${crlf}`));

  return {
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
    },
    payload: Buffer.concat(parts),
  };
}

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

  storage = new MemoryFileStorage();

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
  it('1. Uploading an export file succeeds with 201 and persists content_hash', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'goodreads_export.csv', content: SAMPLE_CSV },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        authorization: `Bearer ${ALICE_TOKEN}`,
        ...headers,
      },
      payload,
    });

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
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'goodreads_export.csv', content: SAMPLE_CSV },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        authorization: `Bearer ${ALICE_TOKEN}`,
        ...headers,
      },
      payload,
    });

    expect(res.statusCode).toBe(409);
    const body = res.json();
    expect(body.error.code).toBe('duplicate_import');
    expect(body.error.message).toContain('An identical file has already been imported');
    expect(body.error.message).toContain('Pass force=true to import anyway');
  });

  it('3. Uploading the exact same file for a different user succeeds (per-user scoping)', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'goodreads_export.csv', content: SAMPLE_CSV },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        authorization: `Bearer ${BOB_TOKEN}`,
        ...headers,
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.state).toBe('queued');
  });

  it('4. Uploading the identical file with ?force=true query parameter bypasses duplicate check', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'goodreads_export.csv', content: SAMPLE_CSV },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports?force=true',
      headers: {
        authorization: `Bearer ${ALICE_TOKEN}`,
        ...headers,
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
    expect(body.state).toBe('queued');
  });

  it('5. Uploading the identical file with multipart field force=true bypasses duplicate check', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'goodreads', force: 'true' },
      { name: 'file', filename: 'goodreads_export.csv', content: SAMPLE_CSV },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        authorization: `Bearer ${ALICE_TOKEN}`,
        ...headers,
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
  });

  it('6. Previously failed imports with the same content hash do not block re-upload', async () => {
    // Create a new distinct file payload
    const FAILED_CSV = `Title,Author,ISBN,My Rating,Exclusive Shelf\nFailed Book,Some Author,1234567890,3,read\n`;
    const { headers: h1, payload: p1 } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'failed_test.csv', content: FAILED_CSV },
    );

    const res1 = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        authorization: `Bearer ${ALICE_TOKEN}`,
        ...h1,
      },
      payload: p1,
    });

    expect(res1.statusCode).toBe(201);
    const firstImportId = res1.json().id;

    // Mark this import as failed in the database
    await drizzleDb
      .update(imports)
      .set({ state: 'failed', error: 'Simulated failure' })
      .where(eq(imports.id, firstImportId));

    // Upload the exact same file again without force
    const { headers: h2, payload: p2 } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'failed_test.csv', content: FAILED_CSV },
    );

    const res2 = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        authorization: `Bearer ${ALICE_TOKEN}`,
        ...h2,
      },
      payload: p2,
    });

    // Should succeed because previous attempt was failed
    expect(res2.statusCode).toBe(201);
    const secondImportId = res2.json().id;
    expect(secondImportId).not.toBe(firstImportId);
  });

  it('7. Uploading a different file with a different content hash succeeds without force', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'different.csv', content: DIFFERENT_CSV },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        authorization: `Bearer ${ALICE_TOKEN}`,
        ...headers,
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeDefined();
  });
});
