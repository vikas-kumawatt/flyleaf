// PV-02: the presigned upload flow. The API never receives the bytes; it
// signs a target, then judges what arrived in storage.

import crypto from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { exports as exportsTable, imports, uploads } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';
import { cleanupStorage, IMPORT_FILE_RETENTION_DAYS, UPLOAD_POLICIES } from '../uploads/index.js';
import { processImport } from '../imports/processor.js';
import { freshDrizzle } from './pg.js';
import { makeUser, unlimited, type TestUser } from './interaction-fixtures.js';
import { completeUpload, sendToTarget, startUpload, uploadFile } from './upload-fixtures.js';

let db: Db;
let app: FastifyInstance;
let storage: MemoryObjectStorage;
let alice: TestUser;
let bob: TestUser;
const sent: { queue: string; data: any }[] = [];
let failEnqueue = false;

const CSV = 'Title,Author\nPiranesi,Susanna Clarke\n';

beforeAll(async () => {
  ({ db } = await freshDrizzle());
  storage = new MemoryObjectStorage();
  const boss = {
    send: async (queue: string, data: any) => {
      if (failEnqueue) throw new Error('queue down');
      sent.push({ queue, data });
      return 'job-1';
    },
  } as unknown as PgBoss;
  app = await buildApp({ db, identity: new IdentityService(db, unlimited), storage, boss });
  alice = await makeUser(db, 'alice_up');
  bob = await makeUser(db, 'bob_up');
}, 60_000);

afterAll(async () => app?.close());

const uploadRow = async (id: string) => (await db.select().from(uploads).where(eq(uploads.id, id)))[0]!;

describe('POST /v1/uploads', () => {
  it('needs a signed-in user', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      payload: { purpose: 'import', content_type: 'text/csv', size: 10 },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns a pending upload and a signed PUT target, never the storage key', async () => {
    const { res } = await startUpload(app, alice.auth, CSV, { filename: 'goodreads.csv' });
    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body).toMatchObject({
      purpose: 'import',
      status: 'pending',
      content_type: 'text/csv',
      size: Buffer.byteLength(CSV),
      max_bytes: UPLOAD_POLICIES.import.maxBytes,
      filename: 'goodreads.csv',
      completed_at: null,
    });
    expect(body.target.method).toBe('PUT');
    expect(body.target.headers).toEqual({ 'content-type': 'text/csv' });
    expect(body).not.toHaveProperty('key');
    const ttl = new Date(body.expires_at).getTime() - Date.now();
    expect(ttl).toBeGreaterThan(55 * 60_000);
    expect(ttl).toBeLessThanOrEqual(60 * 60_000);
  });

  it('signs the canonical content type', async () => {
    const { res } = await startUpload(app, alice.auth, CSV, { contentType: 'Text/CSV; charset=utf-8' });
    expect(res.statusCode).toBe(201);
    expect(res.json().content_type).toBe('text/csv');
    expect(res.json().target.headers['content-type']).toBe('text/csv');
  });

  it('refuses a type outside the purpose policy with 415', async () => {
    const { res } = await startUpload(app, alice.auth, CSV, { contentType: 'application/pdf' });
    expect(res.statusCode).toBe(415);
    expect(res.json().error.code).toBe('unsupported_content_type');
  });

  it('refuses an unknown purpose with 422', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/uploads',
      headers: alice.auth,
      payload: { purpose: 'avatar', content_type: 'text/csv', size: 10 },
    });
    expect(res.statusCode).toBe(422);
  });

  it('accepts exactly the maximum size and refuses one byte more', async () => {
    const max = UPLOAD_POLICIES.import.maxBytes;
    expect((await startUpload(app, alice.auth, 'x', { size: max })).res.statusCode).toBe(201);
    expect((await startUpload(app, alice.auth, 'x', { size: max + 1 })).res.statusCode).toBe(413);
  });

  it('keeps only the base name of the filename, without control characters', async () => {
    const { res } = await startUpload(app, alice.auth, CSV, { filename: '..\\..\\etc/pass\u0007wd.csv' });
    expect(res.json().filename).toBe('passwd.csv');
  });
});

describe('POST /v1/uploads/:id/complete', () => {
  it('409 until the file has arrived, then uploaded with its hash; repeat calls change nothing', async () => {
    const { res, bytes } = await startUpload(app, alice.auth, CSV);
    const { id, target } = res.json();

    const early = await completeUpload(app, alice.auth, id);
    expect(early.statusCode).toBe(409);
    expect(early.json().error.code).toBe('upload_missing');

    expect((await sendToTarget(app, target, bytes)).statusCode).toBe(200);
    const done = await completeUpload(app, alice.auth, id);
    expect(done.statusCode).toBe(200);
    expect(done.json().status).toBe('uploaded');
    expect(done.json()).not.toHaveProperty('target');

    const row = await uploadRow(id);
    expect(row.sha256).toBe(crypto.createHash('sha256').update(bytes).digest('hex'));

    const again = await completeUpload(app, alice.auth, id);
    expect(again.statusCode).toBe(200);
    expect(again.json().completed_at).toBe(done.json().completed_at);
  });

  it('two racing completes both succeed and agree', async () => {
    const { res, bytes } = await startUpload(app, alice.auth, CSV);
    const { id, target } = res.json();
    await sendToTarget(app, target, bytes);
    const [a, b] = await Promise.all([completeUpload(app, alice.auth, id), completeUpload(app, alice.auth, id)]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect(a.json().completed_at).toBe(b.json().completed_at);
  });

  it("another user's upload is 404 with the body of a random id", async () => {
    const id = await uploadFile(app, alice.auth, CSV);
    const theirs = await completeUpload(app, bob.auth, id);
    const random = await completeUpload(app, bob.auth, crypto.randomUUID());
    expect(theirs.statusCode).toBe(404);
    expect(theirs.body).toBe(random.body);
  });

  it('judges content, not the label: a PDF sent as text/csv is refused and removed', async () => {
    const pdf = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(40, 0x41)]);
    const { res } = await startUpload(app, alice.auth, pdf);
    const { id, target } = res.json();
    await sendToTarget(app, target, pdf);

    const done = await completeUpload(app, alice.auth, id);
    expect(done.statusCode).toBe(422);
    expect(done.json().error.code).toBe('upload_invalid_content');
    expect((await uploadRow(id)).status).toBe('pending');
    expect(await storage.head((await uploadRow(id)).key)).toBeNull();

    // The same target takes a corrected file of the same size.
    const fixed = Buffer.from('A'.repeat(pdf.length));
    expect((await sendToTarget(app, target, fixed)).statusCode).toBe(200);
    expect((await completeUpload(app, alice.auth, id)).statusCode).toBe(200);
  });

  it('refuses a file with NUL bytes (binary) even without a known signature', async () => {
    const bin = Buffer.from('Title,Author\n\u0000\u0001\u0002');
    const { res } = await startUpload(app, alice.auth, bin);
    await sendToTarget(app, res.json().target, bin);
    const done = await completeUpload(app, alice.auth, res.json().id);
    expect(done.statusCode).toBe(422);
    expect(done.json().error.code).toBe('upload_invalid_content');
  });

  it('refuses an object whose size or type differ from what was declared', async () => {
    // A provider that did not bind the length or type: write the object directly.
    const sized = (await startUpload(app, alice.auth, CSV)).res.json();
    await storage.put((await uploadRow(sized.id)).key, CSV + 'extra', 'text/csv');
    const r1 = await completeUpload(app, alice.auth, sized.id);
    expect(r1.statusCode).toBe(422);
    expect(r1.json().error.code).toBe('upload_size_mismatch');

    const typed = (await startUpload(app, alice.auth, CSV)).res.json();
    await storage.put((await uploadRow(typed.id)).key, CSV, 'application/octet-stream');
    const r2 = await completeUpload(app, alice.auth, typed.id);
    expect(r2.statusCode).toBe(422);
    expect(r2.json().error.code).toBe('upload_type_mismatch');
  });

  it('an expired upload is 410 to complete and to consume', async () => {
    const pending = (await startUpload(app, alice.auth, CSV)).res.json();
    const done = await uploadFile(app, alice.auth, CSV);
    await db.update(uploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploads.id, pending.id));
    await db.update(uploads).set({ expiresAt: new Date(Date.now() - 1000) }).where(eq(uploads.id, done));

    expect((await completeUpload(app, alice.auth, pending.id)).statusCode).toBe(410);
    const imp = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: alice.auth,
      payload: { upload_id: done, source: 'goodreads' },
    });
    expect(imp.statusCode).toBe(410);
    expect(imp.json().error.code).toBe('upload_expired');
  });
});

describe('consuming an upload', () => {
  it('consume and enqueue are one transaction: a failed enqueue leaves no import and a reusable upload', async () => {
    const id = await uploadFile(app, alice.auth, 'Title,Author\nAtomic,Writer\n');
    failEnqueue = true;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/imports',
        headers: alice.auth,
        payload: { upload_id: id, source: 'goodreads' },
      });
      expect(res.statusCode).toBe(500);
    } finally {
      failEnqueue = false;
    }
    expect((await uploadRow(id)).status).toBe('uploaded');
    expect(await db.select().from(imports).where(eq(imports.fileKey, (await uploadRow(id)).key))).toHaveLength(0);

    const retry = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: alice.auth,
      payload: { upload_id: id, source: 'goodreads' },
    });
    expect(retry.statusCode).toBe(201);
  });

  it('the worker refuses a file replaced after it was checked (the PUT target is still valid)', async () => {
    const original = 'Title,Author\nOriginal,Writer\n';
    const { res, bytes } = await startUpload(app, alice.auth, original);
    const { id, target } = res.json();
    await sendToTarget(app, target, bytes);
    await completeUpload(app, alice.auth, id);
    const imp = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: alice.auth,
      payload: { upload_id: id, source: 'goodreads' },
    });
    expect(imp.statusCode).toBe(201);

    // Same length, same type: the signature still accepts it.
    const swapped = Buffer.from(original.replace('Original', 'Replaced'));
    expect(swapped.length).toBe(bytes.length);
    expect((await sendToTarget(app, target, swapped)).statusCode).toBe(200);

    await expect(processImport(db, storage, imp.json().id)).rejects.toThrow(/changed after it was checked/);
    const [row] = await db.select().from(imports).where(eq(imports.id, imp.json().id));
    expect(row!.state).toBe('failed');
  });
});

describe('storage cleanup (daily job)', () => {
  it('deletes expired, unconsumed uploads and expired export files; leaves the rest', async () => {
    const stale = await uploadFile(app, alice.auth, CSV);
    const fresh = await uploadFile(app, alice.auth, CSV);
    const consumed = await uploadFile(app, alice.auth, 'Title,Author\nKept,Writer\n');
    const imp = await app.inject({
      method: 'POST',
      url: '/v1/imports',
      headers: alice.auth,
      payload: { upload_id: consumed, source: 'goodreads' },
    });
    expect(imp.statusCode).toBe(201);
    const past = new Date(Date.now() - 1000);
    for (const id of [stale, consumed]) await db.update(uploads).set({ expiresAt: past }).where(eq(uploads.id, id));

    await storage.put('exports/x/old.csv', 'a', 'text/csv');
    await storage.put('exports/x/new.csv', 'b', 'text/csv');
    const [oldExport] = await db
      .insert(exportsTable)
      .values({ userId: alice.id, state: 'completed', fileKey: 'exports/x/old.csv', expiresAt: past })
      .returning();
    const [newExport] = await db
      .insert(exportsTable)
      .values({ userId: alice.id, state: 'completed', fileKey: 'exports/x/new.csv', expiresAt: new Date(Date.now() + 3600_000) })
      .returning();

    const result = await cleanupStorage(db, storage);

    expect(result.uploadsExpired).toBeGreaterThanOrEqual(1);
    expect((await uploadRow(stale)).status).toBe('expired');
    expect(await storage.head((await uploadRow(stale)).key)).toBeNull();
    expect((await uploadRow(fresh)).status).toBe('uploaded');
    expect(await storage.head((await uploadRow(fresh)).key)).not.toBeNull();
    // Consumed: the import owns the file now.
    expect((await uploadRow(consumed)).status).toBe('consumed');
    expect(await storage.head((await uploadRow(consumed)).key)).not.toBeNull();

    expect(await storage.head('exports/x/old.csv')).toBeNull();
    expect((await db.select().from(exportsTable).where(eq(exportsTable.id, oldExport!.id)))[0]!.fileKey).toBeNull();
    expect(await storage.head('exports/x/new.csv')).not.toBeNull();
    expect((await db.select().from(exportsTable).where(eq(exportsTable.id, newExport!.id)))[0]!.fileKey).toBe('exports/x/new.csv');

    // A second run finds nothing left to do.
    const again = await cleanupStorage(db, storage);
    expect(again).toEqual({ uploadsExpired: 0, exportFilesDeleted: 0, importFilesDeleted: 0 });
  });

  it(`deletes an import's file ${IMPORT_FILE_RETENTION_DAYS} days after the import finished, not before, and never while it runs (D-PV-3)`, async () => {
    const day = 86_400_000;
    const make = async (name: string, state: string, finishedDaysAgo: number | null) => {
      const res = await importCsvRow(`Title,Author
${name},Writer
`);
      await db
        .update(imports)
        .set({ state, finishedAt: finishedDaysAgo === null ? null : new Date(Date.now() - finishedDaysAgo * day) })
        .where(eq(imports.id, res.id));
      return res;
    };
    const old = await make('Old', 'completed', IMPORT_FILE_RETENTION_DAYS + 1);
    const oldFailed = await make('OldFailed', 'failed', IMPORT_FILE_RETENTION_DAYS + 1);
    const recent = await make('Recent', 'completed', IMPORT_FILE_RETENTION_DAYS - 1);
    const running = await make('Running', 'processing', null);

    const result = await cleanupStorage(db, storage);

    expect(result.importFilesDeleted).toBe(2);
    for (const gone of [old, oldFailed]) {
      expect(await storage.head(gone.key)).toBeNull();
      expect((await db.select().from(imports).where(eq(imports.id, gone.id)))[0]!.fileKey).toBeNull();
    }
    for (const kept of [recent, running]) {
      expect(await storage.head(kept.key)).not.toBeNull();
      expect((await db.select().from(imports).where(eq(imports.id, kept.id)))[0]!.fileKey).toBe(kept.key);
    }
  });
});

/** Upload + import through the API; the import's id and file key. */
async function importCsvRow(csv: string): Promise<{ id: string; key: string }> {
  const uploadId = await uploadFile(app, alice.auth, csv);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: alice.auth,
    payload: { upload_id: uploadId, source: 'goodreads', force: true },
  });
  if (res.statusCode !== 201) throw new Error(`import: ${res.statusCode} ${res.body}`);
  const [row] = await db.select().from(imports).where(eq(imports.id, res.json().id));
  return { id: row!.id, key: row!.fileKey! };
}
