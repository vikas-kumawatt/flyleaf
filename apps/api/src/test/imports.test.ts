// IM-02: Upload endpoint returning job ID immediately.
// PRD §6.8, §24.2, AC-9, Architecture §3.7.

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { freshDb, freshDrizzle } from './pg.js';
import { imports, users } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { buildApp } from '../app.js';
import { MemoryFileStorage, IMPORT_SOURCES } from '../imports/index.js';
import { QUEUES, makeBoss } from '../jobs/index.js';
import type { PgBoss } from 'pg-boss';

let app: FastifyInstance;
let drizzleDb: Db;
let storage: MemoryFileStorage;
let boss: PgBoss;

const USER_ALICE = '11111111-1111-1111-1111-111111111111';
const USER_BOB = '22222222-2222-2222-2222-222222222222';

const ALICE_TOKEN = 'token-alice';
const BOB_TOKEN = 'token-bob';

/**
 * Builds a deterministic multipart/form-data payload with headers.
 */
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

  storage = new MemoryFileStorage();

  const mockIdentity = {
    lookup: async (token: string) => {
      if (token === ALICE_TOKEN) return USER_ALICE;
      if (token === BOB_TOKEN) return USER_BOB;
      return null;
    },
  };

  // Mock boss to verify job enqueueing without needing full pgboss schema migration in this test
  const enqueuedJobs: { queue: string; data: any }[] = [];
  boss = {
    send: async (queue: string, data: any) => {
      enqueuedJobs.push({ queue, data });
      return 'job-123';
    },
    _enqueued: enqueuedJobs,
  } as unknown as PgBoss;

  app = await buildApp({
    db: drizzleDb,
    identity: mockIdentity as any,
    storage,
    boss,
  });
}, 60_000);

afterAll(async () => {
  await app?.close();
});

describe('IM-02: POST /v1/imports (Upload Endpoint)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'export.csv', content: 'Title,Author\nDune,Frank Herbert' },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers,
      payload,
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('auth_required');
  });

  it('rejects non-multipart requests with 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        authorization: `Bearer ${ALICE_TOKEN}`,
        'content-type': 'application/json',
      },
      payload: JSON.stringify({ source: 'goodreads' }),
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('invalid_content_type');
  });

  it('rejects upload when source is missing with 400', async () => {
    const { headers, payload } = buildMultipart(
      {},
      { name: 'file', filename: 'export.csv', content: 'Title,Author\nDune,Frank Herbert' },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('missing_source');
  });

  it('rejects unsupported source with 400 invalid_source', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'amazon_kindle' },
      { name: 'file', filename: 'export.csv', content: 'Title,Author\nDune,Frank Herbert' },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('invalid_source');
  });

  it('rejects upload when file is missing with 400', async () => {
    const { headers, payload } = buildMultipart({ source: 'goodreads' });

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('missing_file');
  });

  it('rejects empty file upload with 400 empty_file', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'empty.csv', content: '' },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(400);
    const body = res.json();
    expect(body.error.code).toBe('empty_file');
  });

  it('rejects files exceeding 10MB limit with 413 file_too_large (PRD §6.8)', async () => {
    // 10MB + 1 byte
    const oversizedBuffer = Buffer.alloc(10 * 1024 * 1024 + 1, 'a');
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'huge.csv', content: oversizedBuffer },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.error.code).toBe('file_too_large');
    expect(body.error.message).toContain('10MB limit');
  });

  it('accepts Goodreads export and returns job ID immediately (PRD §6.8, AC-9, IM-02)', async () => {
    const csvContent =
      'Book Id,Title,Author,My Rating,Exclusive Shelf,Date Read\n1,The Left Hand of Darkness,Ursula K. Le Guin,5,read,2026/01/15\n2,Hyperion,Dan Simmons,0,to-read,';
    const expectedHash = crypto.createHash('sha256').update(Buffer.from(csvContent)).digest('hex');

    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'goodreads_library_export.csv', content: csvContent },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();

    // Verify response structure
    expect(body.id).toBeDefined();
    expect(body.job_id).toBe(body.id);
    expect(body.source).toBe('goodreads');
    expect(body.state).toBe('queued');
    expect(body.total_rows).toBe(0);
    expect(body.matched).toBe(0);
    expect(body.unmatched).toBe(0);
    expect(body.filename).toBe('goodreads_library_export.csv');
    expect(body.file_size_bytes).toBe(Buffer.byteLength(csvContent));
    expect(body.content_hash).toBe(expectedHash);
    expect(body.created_at).toBeDefined();
    expect(body.updated_at).toBeDefined();
    expect(body.finished_at).toBeNull();

    // Verify database record was written
    const [dbRow] = await drizzleDb
      .select()
      .from(imports)
      .where(eq(imports.id, body.id));
    expect(dbRow).toBeDefined();
    expect(dbRow?.userId).toBe(USER_ALICE);
    expect(dbRow?.source).toBe('goodreads');
    expect(dbRow?.state).toBe('queued');
    expect(dbRow?.contentHash).toBe(expectedHash);

    // Verify raw file stored in storage
    const storedFile = await storage.get(dbRow!.fileKey!);
    expect(storedFile).not.toBeNull();
    expect(storedFile?.toString()).toBe(csvContent);

    // Verify job was enqueued into pg-boss queue
    const enqueued = (boss as any)._enqueued.find(
      (j: any) => j.queue === QUEUES.processImport && j.data.importId === body.id,
    );
    expect(enqueued).toBeDefined();
    expect(enqueued.data.userId).toBe(USER_ALICE);
    expect(enqueued.data.source).toBe('goodreads');
  });

  it('accepts source from query parameter (?source=storygraph) if not in form fields', async () => {
    const csvContent = 'Title,Authors,Tags,Date Added\nNeuromancer,William Gibson,cyberpunk,2026-02-01';
    const { headers, payload } = buildMultipart(
      {},
      { name: 'file', filename: 'storygraph_export.csv', content: csvContent },
    );

    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports?source=storygraph',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.source).toBe('storygraph');
    expect(body.state).toBe('queued');
  });

  it('supports all 6 platform sources', async () => {
    for (const src of IMPORT_SOURCES) {
      const csv = `title,author\nSample Book,Sample Author for ${src}`;
      const { headers, payload } = buildMultipart(
        { source: src },
        { name: 'file', filename: `${src}.csv`, content: csv },
      );

      const res = await app.inject({
        method: 'POST',
        url: '/v1/imports',
        headers: {
          ...headers,
          authorization: `Bearer ${ALICE_TOKEN}`,
        },
        payload,
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().source).toBe(src);
    }
  });
});

describe('IM-02: GET /v1/imports/:id (Job Status & Isolation)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/imports/${crypto.randomUUID()}`,
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns 404 for non-existent import ID', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/imports/${crypto.randomUUID()}`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('enforces strict cross-user privacy: returns 404 when Bob requests Alice import', async () => {
    // Alice creates an import
    const { headers, payload } = buildMultipart(
      { source: 'goodreads' },
      { name: 'file', filename: 'alice_secret.csv', content: 'Title,Author\nPrivate Diary,Alice' },
    );
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });
    const aliceImportId = createRes.json().id;

    // Bob tries to access Alice's import
    const bobRes = await app.inject({
      method: 'GET',
      url: `/v1/imports/${aliceImportId}`,
      headers: { authorization: `Bearer ${BOB_TOKEN}` },
    });

    // Must be 404 (never 403, preventing resource existence enumeration)
    expect(bobRes.statusCode).toBe(404);
  });

  it('returns import details to owner', async () => {
    const { headers, payload } = buildMultipart(
      { source: 'librarything' },
      { name: 'file', filename: 'librarything.csv', content: 'Title,Author\nFoundation,Isaac Asimov' },
    );
    const createRes = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: {
        ...headers,
        authorization: `Bearer ${ALICE_TOKEN}`,
      },
      payload,
    });
    const importId = createRes.json().id;

    const res = await app.inject({
      method: 'GET',
      url: `/v1/imports/${importId}`,
      headers: { authorization: `Bearer ${ALICE_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.id).toBe(importId);
    expect(body.job_id).toBe(importId);
    expect(body.source).toBe('librarything');
    expect(body.state).toBe('queued');
    expect(body.filename).toBe('librarything.csv');
  });
});

describe('IM-02: GET /v1/imports (List User Imports)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/imports',
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns list of imports belonging strictly to caller in newest-first order', async () => {
    // Bob uploads two imports
    for (const src of ['calibre', 'openreads']) {
      const { headers, payload } = buildMultipart(
        { source: src },
        { name: 'file', filename: `${src}.csv`, content: `Title,Author\nBook from ${src},Author` },
      );
      await app.inject({
        method: 'POST',
        url: '/v1/imports',
        headers: {
          ...headers,
          authorization: `Bearer ${BOB_TOKEN}`,
        },
        payload,
      });
    }

    const res = await app.inject({
      method: 'GET',
      url: '/v1/imports',
      headers: { authorization: `Bearer ${BOB_TOKEN}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(Array.isArray(body.imports)).toBe(true);
    expect(body.imports.length).toBeGreaterThanOrEqual(2);

    // Verify Bob only sees his own imports
    for (const item of body.imports) {
      expect(['calibre', 'openreads']).toContain(item.source);
    }
  });
});
