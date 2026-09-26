// PV-03: the typed client's uploadFile() against the real app.
//
// FlyleafClient is built from packages/api-client (dist, as contract.test.ts
// uses it) with fetch routed into app.inject, and memory storage's signed
// route standing in for the provider. What matters: intent -> direct upload
// -> complete in that order, only the direct upload retried, the bearer token
// never sent to storage, and cancelPendingUploads() stopping an upload.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq } from 'drizzle-orm';
import { FlyleafClient, FlyleafApiError } from '../../../../packages/api-client/dist/index.js';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { imports, uploads } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { MemoryObjectStorage, readAll } from '../providers/storage/index.js';
import { freshDrizzle } from './pg.js';
import { makeUser, unlimited, type TestUser } from './interaction-fixtures.js';

type Call = { method: string; path: string; authorization?: string };

let db: Db;
let app: FastifyInstance;
let storage: MemoryObjectStorage;
let alice: TestUser;

/** fetch -> app.inject, recording every call. */
function injectFetch(calls: Call[]): typeof fetch {
  return (async (input: string | URL | Request, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const headers = Object.fromEntries(new Headers(init.headers).entries());
    calls.push({ method: init.method ?? 'GET', path: url.pathname, authorization: headers.authorization });
    const res = await app.inject({
      method: (init.method ?? 'GET') as 'GET',
      url: `${url.pathname}${url.search}`,
      headers,
      payload: init.body as string | Buffer | undefined,
    });
    return new Response(res.rawPayload.length ? res.rawPayload : null, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  }) as typeof fetch;
}

function client(calls: Call[], uploadFetch?: typeof fetch) {
  return new FlyleafClient({
    baseUrl: 'http://localhost/v1',
    getToken: () => alice.token,
    fetch: injectFetch(calls),
    uploadFetch: uploadFetch ?? injectFetch(calls),
  });
}

beforeAll(async () => {
  ({ db } = await freshDrizzle());
  storage = new MemoryObjectStorage();
  app = await buildApp({ db, identity: new IdentityService(db, unlimited), storage });
  alice = await makeUser(db, 'alice_client');
}, 60_000);

afterAll(async () => app?.close());

const CSV = 'Title,Author,ISBN,My Rating,Exclusive Shelf\nPiranesi,Susanna Clarke,,5,read\n';

describe('FlyleafClient.uploadFile (PV-03)', () => {
  it('intent, direct upload, complete; then an import from it. The token never reaches storage', async () => {
    const calls: Call[] = [];
    const c = client(calls);

    const upload = await c.uploadFile('import', CSV, { contentType: 'text/csv', filename: 'goodreads.csv' });
    expect(upload.status).toBe('uploaded');

    expect(calls.map((x) => `${x.method} ${x.path}`)).toEqual([
      'POST /v1/uploads',
      'PUT /v1/storage/object',
      `POST /v1/uploads/${upload.id}/complete`,
    ]);
    const put = calls.find((x) => x.method === 'PUT')!;
    expect(put.authorization).toBeUndefined();

    const imp = await c.createImport({ upload_id: upload.id, source: 'goodreads' });
    expect(imp.state).toBe('queued');
    expect(imp.filename).toBe('goodreads.csv');
    const [row] = await db.select().from(imports).where(eq(imports.id, imp.id));
    expect((await readAll((await storage.getStream(row!.fileKey!))!)).toString()).toBe(CSV);
  });

  it('counts a multi-byte string by bytes, not characters', async () => {
    const text = 'Title,Author\nLes Misérables,Victor Hugo 📚\n';
    expect(Buffer.byteLength(text)).toBeGreaterThan(text.length);
    const upload = await client([]).uploadFile('import', text, { contentType: 'text/csv' });
    expect(upload.size).toBe(Buffer.byteLength(text));
  });

  it('retries only the direct upload on a 503, then completes', async () => {
    const calls: Call[] = [];
    let puts = 0;
    const flaky: typeof fetch = async (input, init) => {
      puts++;
      if (puts === 1) return new Response('busy', { status: 503 });
      return injectFetch(calls)(input, init);
    };

    const upload = await client(calls, flaky).uploadFile('import', CSV, { contentType: 'text/csv' });

    expect(upload.status).toBe('uploaded');
    expect(puts).toBe(2);
    expect(calls.filter((x) => x.path === '/v1/uploads')).toHaveLength(1);
    expect(calls.filter((x) => x.path.endsWith('/complete'))).toHaveLength(1);
  });

  it('does not retry a refusal (403) and never completes', async () => {
    const calls: Call[] = [];
    let puts = 0;
    const refusing: typeof fetch = async () => {
      puts++;
      return new Response('SignatureDoesNotMatch', { status: 403 });
    };

    const err = await client(calls, refusing)
      .uploadFile('import', CSV, { contentType: 'text/csv' })
      .catch((e: unknown) => e);

    expect(err).toBeInstanceOf(FlyleafApiError);
    expect((err as FlyleafApiError).code).toBe('upload_failed');
    expect(puts).toBe(1);
    expect(calls.some((x) => x.path.endsWith('/complete'))).toBe(false);
  });

  it('surfaces a policy refusal from the intent without sending anything', async () => {
    const calls: Call[] = [];
    const err = await client(calls)
      .uploadFile('import', CSV, { contentType: 'application/pdf' })
      .catch((e: unknown) => e);
    expect((err as FlyleafApiError).status).toBe(415);
    expect(calls.map((x) => x.method)).toEqual(['POST']);
  });

  it('cancelPendingUploads() (logout) stops an upload in flight; nothing is completed', async () => {
    const calls: Call[] = [];
    let started!: () => void;
    const putStarted = new Promise<void>((r) => (started = r));
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        started();
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
      });

    const c = client(calls, hanging);
    const pending = c.uploadFile('import', CSV, { contentType: 'text/csv' }).catch((e: unknown) => e);
    await putStarted;
    c.cancelPendingUploads();

    const err = await pending;
    expect((err as FlyleafApiError).code).toBe('upload_cancelled');
    expect(calls.some((x) => x.path.endsWith('/complete'))).toBe(false);
    const rows = await db.select().from(uploads).where(eq(uploads.userId, alice.id));
    expect(rows.filter((r) => r.status === 'pending').length).toBeGreaterThanOrEqual(1);
  });
});
