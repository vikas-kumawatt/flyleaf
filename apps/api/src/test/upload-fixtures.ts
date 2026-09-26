// The presigned upload flow (PV-02), driven through the real routes the way a
// client drives it: intent, direct PUT to the signed target, complete. The
// app must be built with a disk or memory storage, whose signed route plays
// the provider.

import crypto from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import type { Db } from '../platform/index.js';
import { imports } from '../db/schema.js';
import type { ObjectStorage } from '../providers/storage/index.js';

type Headers = Record<string, string>;

/** The signed target's URL as an inject() path. */
export function targetPath(url: string): string {
  const u = new URL(url);
  return `${u.pathname}${u.search}`;
}

export async function startUpload(
  app: FastifyInstance,
  auth: Headers,
  body: Buffer | string,
  opts: { contentType?: string; filename?: string; size?: number } = {},
) {
  const bytes = Buffer.isBuffer(body) ? body : Buffer.from(body);
  const res = await app.inject({
    method: 'POST',
    url: '/v1/uploads',
    headers: auth,
    payload: {
      purpose: 'import',
      content_type: opts.contentType ?? 'text/csv',
      size: opts.size ?? bytes.length,
      ...(opts.filename ? { filename: opts.filename } : {}),
    },
  });
  return { res, bytes };
}

export async function sendToTarget(
  app: FastifyInstance,
  target: { url: string; method: string; headers: Headers },
  bytes: Buffer,
): Promise<LightMyRequestResponse> {
  return app.inject({
    method: target.method as 'PUT',
    url: targetPath(target.url),
    headers: target.headers,
    payload: bytes,
  });
}

export function completeUpload(app: FastifyInstance, auth: Headers, id: string) {
  return app.inject({ method: 'POST', url: `/v1/uploads/${id}/complete`, headers: auth });
}

/** Intent, PUT, complete. Returns the completed upload's id; throws on any non-2xx. */
export async function uploadFile(
  app: FastifyInstance,
  auth: Headers,
  body: Buffer | string,
  opts: { contentType?: string; filename?: string } = {},
): Promise<string> {
  const { res, bytes } = await startUpload(app, auth, body, opts);
  if (res.statusCode !== 201) throw new Error(`POST /v1/uploads: ${res.statusCode} ${res.body}`);
  const { id, target } = res.json();
  const put = await sendToTarget(app, target, bytes);
  if (put.statusCode !== 200) throw new Error(`PUT target: ${put.statusCode} ${put.body}`);
  const done = await completeUpload(app, auth, id);
  if (done.statusCode !== 200) throw new Error(`complete: ${done.statusCode} ${done.body}`);
  return id;
}

/** Upload `csv` and start an import from it. Returns the POST /v1/imports response. */
export async function importCsv(
  app: FastifyInstance,
  auth: Headers,
  csv: Buffer | string,
  opts: { source?: string; filename?: string; force?: boolean } = {},
): Promise<LightMyRequestResponse> {
  const uploadId = await uploadFile(app, auth, csv, { filename: opts.filename });
  return app.inject({
    method: 'POST',
    url: '/v1/imports',
    headers: auth,
    payload: { upload_id: uploadId, source: opts.source ?? 'goodreads', ...(opts.force ? { force: true } : {}) },
  });
}

/**
 * For processor tests that start below the HTTP layer: the object in storage
 * and a queued import row pointing at it, hashed as /complete would.
 */
export async function seedImport(
  db: Db,
  storage: ObjectStorage,
  userId: string,
  csv: Buffer | string,
  opts: { source?: string; filename?: string } = {},
): Promise<string> {
  const bytes = Buffer.isBuffer(csv) ? csv : Buffer.from(csv);
  const key = `uploads/${userId}/${crypto.randomUUID()}`;
  await storage.put(key, bytes, 'text/csv');
  const [row] = await db
    .insert(imports)
    .values({
      userId,
      source: opts.source ?? 'goodreads',
      state: 'queued',
      fileKey: key,
      filename: opts.filename ?? 'export.csv',
      fileSizeBytes: bytes.length,
      contentHash: crypto.createHash('sha256').update(bytes).digest('hex'),
    })
    .returning();
  return row!.id;
}
