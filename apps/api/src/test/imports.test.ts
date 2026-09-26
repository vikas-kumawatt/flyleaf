// IM-02: Import endpoint returning job ID immediately.
// PRD §6.8, §24.2, AC-9, Architecture §3.7.
//
// PV-02: the file reaches storage directly through a presigned upload; the
// import takes the completed upload's id. The upload flow's own edge cases
// live in uploads.test.ts.

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { imports, uploads, users } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { buildApp } from '../app.js';
import { IMPORT_SOURCES } from '../imports/index.js';
import { MemoryObjectStorage, readAll } from '../providers/storage/index.js';
import { QUEUES } from '../jobs/index.js';
import type { PgBoss } from 'pg-boss';
import { importCsv, startUpload, uploadFile } from './upload-fixtures.js';

let app: FastifyInstance;
let drizzleDb: Db;
let storage: MemoryObjectStorage;
let boss: PgBoss;

const USER_ALICE = '11111111-1111-1111-1111-111111111111';
const USER_BOB = '22222222-2222-2222-2222-222222222222';

const ALICE_TOKEN = 'token-alice';
const BOB_TOKEN = 'token-bob';
const ALICE = { authorization: `Bearer ${ALICE_TOKEN}` };
const BOB = { authorization: `Bearer ${BOB_TOKEN}` };

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

  storage = new MemoryObjectStorage();

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

describe('IM-02: POST /v1/imports (from a completed upload)', () => {
  it('rejects unauthenticated requests with 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      payload: { upload_id: crypto.randomUUID(), source: 'goodreads' },
    });

    expect(res.statusCode).toBe(401);
    const body = res.json();
    expect(body.error.code).toBe('auth_required');
  });

  it('rejects a body without upload_id with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: ALICE,
      payload: { source: 'goodreads' },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.field).toBe('upload_id');
  });

  it('refuses a multipart upload to /v1/imports: the API takes no file bytes', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: { ...ALICE, 'content-type': 'multipart/form-data; boundary=x' },
      payload:
        '--x\r\nContent-Disposition: form-data; name="file"; filename="a.csv"\r\n\r\nTitle\r\n--x--\r\n',
    });

    expect(res.statusCode).toBe(415);
  });

  it('rejects a missing source with 422', async () => {
    const uploadId = await uploadFile(app, ALICE, 'Title,Author\nDune,Frank Herbert');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: ALICE,
      payload: { upload_id: uploadId },
    });

    expect(res.statusCode).toBe(422);
    expect(res.json().error.field).toBe('source');
  });

  it('rejects an unsupported source with 422 and leaves the upload usable', async () => {
    const uploadId = await uploadFile(app, ALICE, 'Title,Author\nDune,Frank Herbert');
    const res = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: ALICE,
      payload: { upload_id: uploadId, source: 'amazon_kindle' },
    });

    expect(res.statusCode).toBe(422);
    const [u] = await drizzleDb.select().from(uploads).where(eq(uploads.id, uploadId));
    expect(u!.status).toBe('uploaded');
  });

  it('rejects an upload whose file never arrived with 409 upload_not_complete', async () => {
    const { res } = await startUpload(app, ALICE, 'Title,Author\nDune,Frank Herbert');
    const imp = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: ALICE,
      payload: { upload_id: res.json().id, source: 'goodreads' },
    });

    expect(imp.statusCode).toBe(409);
    expect(imp.json().error.code).toBe('upload_not_complete');
  });

  it('rejects an empty file at the upload step with 422', async () => {
    const { res } = await startUpload(app, ALICE, '');
    expect(res.statusCode).toBe(422);
    expect(res.json().error.field).toBe('size');
  });

  it('rejects files exceeding 10MB limit with 413 file_too_large before any byte is sent (PRD §6.8)', async () => {
    const { res } = await startUpload(app, ALICE, 'x', { size: 10 * 1024 * 1024 + 1 });

    expect(res.statusCode).toBe(413);
    const body = res.json();
    expect(body.error.code).toBe('file_too_large');
    expect(body.error.message).toContain('10MB limit');
  });

  it('accepts Goodreads export and returns job ID immediately (PRD §6.8, AC-9, IM-02)', async () => {
    const csvContent =
      'Book Id,Title,Author,My Rating,Exclusive Shelf,Date Read\n1,The Left Hand of Darkness,Ursula K. Le Guin,5,read,2026/01/15\n2,Hyperion,Dan Simmons,0,to-read,';
    const expectedHash = crypto.createHash('sha256').update(Buffer.from(csvContent)).digest('hex');

    const res = await importCsv(app, ALICE, csvContent, { filename: 'goodreads_library_export.csv' });

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

    // The file is the uploaded object, under a server-made key
    expect(dbRow!.fileKey).toMatch(new RegExp(`^uploads/${USER_ALICE}/[0-9a-f-]{36}$`));
    const stored = await storage.getStream(dbRow!.fileKey!);
    expect((await readAll(stored!)).toString()).toBe(csvContent);

    // The upload is consumed
    const [u] = await drizzleDb.select().from(uploads).where(eq(uploads.key, dbRow!.fileKey!));
    expect(u!.status).toBe('consumed');
    expect(u!.consumedAt).not.toBeNull();

    // Verify job was enqueued into pg-boss queue
    const enqueued = (boss as any)._enqueued.find(
      (j: any) => j.queue === QUEUES.processImport && j.data.importId === body.id,
    );
    expect(enqueued).toBeDefined();
    expect(enqueued.data.userId).toBe(USER_ALICE);
    expect(enqueued.data.source).toBe('goodreads');
  });

  it('a repeated request with the same upload returns the same import with 200 and enqueues once', async () => {
    const uploadId = await uploadFile(app, ALICE, 'Title,Author\nReplay,Someone');
    const send = () =>
      app.inject({
        method: 'POST',
        url: '/v1/imports',
        headers: ALICE,
        payload: { upload_id: uploadId, source: 'storygraph' },
      });

    const first = await send();
    const second = await send();

    expect(first.statusCode).toBe(201);
    expect(second.statusCode).toBe(200);
    expect(second.json().id).toBe(first.json().id);
    const jobs = (boss as any)._enqueued.filter((j: any) => j.data.importId === first.json().id);
    expect(jobs).toHaveLength(1);
  });

  it("another user's upload id is 404, with the same body as a random one", async () => {
    const aliceUpload = await uploadFile(app, ALICE, 'Title,Author\nMine,Alice');
    const take = (id: string) =>
      app.inject({ method: 'POST', url: '/v1/imports', headers: BOB, payload: { upload_id: id, source: 'goodreads' } });

    const stolen = await take(aliceUpload);
    const random = await take(crypto.randomUUID());

    expect(stolen.statusCode).toBe(404);
    expect(stolen.body).toBe(random.body);
    const [u] = await drizzleDb.select().from(uploads).where(eq(uploads.id, aliceUpload));
    expect(u!.status).toBe('uploaded');
  });

  it('supports all 6 platform sources', async () => {
    for (const src of IMPORT_SOURCES) {
      const csv = `title,author\nSample Book,Sample Author for ${src}`;
      const res = await importCsv(app, ALICE, csv, { source: src, filename: `${src}.csv` });

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
    const createRes = await importCsv(app, ALICE, 'Title,Author\nPrivate Diary,Alice', {
      filename: 'alice_secret.csv',
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
    const createRes = await importCsv(app, ALICE, 'Title,Author\nFoundation,Isaac Asimov', {
      source: 'librarything',
      filename: 'librarything.csv',
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
      await importCsv(app, BOB, `Title,Author\nBook from ${src},Author`, {
        source: src,
        filename: `${src}.csv`,
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
