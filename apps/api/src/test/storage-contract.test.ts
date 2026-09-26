// PV-01: one contract, every object-storage adapter.
//
// Each adapter runs the SAME cases through a harness that plays the client:
// it sends bytes to the presigned target and fetches download URLs the way a
// phone would. An adapter that passes is interchangeable with the others.
//
//   memory, disk   the in-process signed route (local-routes.ts)
//   s3 (mocked)    the real SDK presigner and adapter code, with S3's API
//                  replaced by an in-memory fake that VERIFIES each presigned
//                  URL by re-signing it with the SDK -- so a wrong type,
//                  length, key or an expired URL is refused as S3 would
//   s3 (MinIO)     a real S3 server, when flyleaf-minio is reachable
//
// Tests may import the vendor SDK; product code outside src/providers/ may
// not (provider-boundary.test.ts).

import { ReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { GetObjectCommand, PutObjectCommand, type S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { registerCoreHooks } from '../app.js';
import {
  DiskObjectStorage,
  MemoryObjectStorage,
  S3ObjectStorage,
  localStorageRoutes,
  readAll,
  type LocalObjectStorage,
  type ObjectStorage,
  type UploadTarget,
} from '../providers/storage/index.js';

type Sent = { status: number };
type Fetched = { status: number; headers: Record<string, string>; body: Buffer };

interface Harness {
  storage: ObjectStorage;
  /** Send `body` to the target as a client would; `contentType` overrides the target's. */
  send(target: UploadTarget, body: Buffer, contentType?: string): Promise<Sent>;
  fetch(url: string): Promise<Fetched>;
  close(): Promise<void>;
}

// ------------------------------------------------------------------ local

async function localHarness(storage: LocalObjectStorage): Promise<Harness> {
  const app: FastifyInstance = Fastify();
  registerCoreHooks(app);
  await app.register(localStorageRoutes(storage));
  await app.ready();
  const pathOf = (url: string) => {
    const u = new URL(url);
    return `${u.pathname}${u.search}`;
  };
  return {
    storage,
    async send(target, body, contentType) {
      const res = await app.inject({
        method: target.method,
        url: pathOf(target.url),
        headers: { ...target.headers, ...(contentType ? { 'content-type': contentType } : {}) },
        payload: body,
      });
      return { status: res.statusCode };
    },
    async fetch(url) {
      const res = await app.inject({ method: 'GET', url: pathOf(url) });
      return {
        status: res.statusCode,
        headers: res.headers as Record<string, string>,
        body: res.rawPayload,
      };
    },
    close: () => app.close(),
  };
}

// ------------------------------------------------------------------ s3, mocked

const S3_CONFIG = {
  bucket: 'contract',
  region: 'us-east-1',
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
  endpoint: 'http://s3.mock.invalid',
  forcePathStyle: true,
};

/** SigV4 X-Amz-Date (20260926T120000Z) → Date. */
function amzDate(value: string): Date {
  const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value);
  if (!m) throw new Error(`bad X-Amz-Date ${value}`);
  return new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!));
}

function mockedS3Harness(): Harness {
  const client = S3ObjectStorage.clientFor(S3_CONFIG);
  const objects = new Map<string, { data: Buffer; contentType: string | null }>();
  const notFound = () =>
    Object.assign(new Error('NotFound'), { name: 'NotFound', $metadata: { httpStatusCode: 404 } });

  // S3's API, in memory. Only what the adapter sends.
  (client as { send: unknown }).send = async (command: { constructor: { name: string }; input: any }) => {
    const { Key, Body, ContentType } = command.input;
    switch (command.constructor.name) {
      case 'PutObjectCommand':
        objects.set(Key, { data: Buffer.from(Body), contentType: ContentType ?? null });
        return {};
      case 'HeadObjectCommand': {
        const o = objects.get(Key);
        if (!o) throw notFound();
        return { ContentLength: o.data.length, ContentType: o.contentType ?? undefined, ETag: '"etag"' };
      }
      case 'GetObjectCommand': {
        const o = objects.get(Key);
        if (!o) throw Object.assign(notFound(), { name: 'NoSuchKey' });
        return { Body: Readable.from([o.data]) };
      }
      case 'DeleteObjectCommand':
        objects.delete(Key);
        return {};
      default:
        throw new Error(`fake S3: unexpected ${command.constructor.name}`);
    }
  };

  /**
   * What S3 does with a presigned request: recompute the signature from
   * what actually arrived, compare, then check expiry.
   */
  async function verify(
    url: string,
    command: (bucket: string, key: string, q: URLSearchParams) => PutObjectCommand | GetObjectCommand,
    signableHeaders?: Set<string>,
  ): Promise<{ ok: boolean; key: string }> {
    const u = new URL(url);
    const [, bucket, ...rest] = u.pathname.split('/');
    const key = decodeURIComponent(rest.join('/'));
    const q = u.searchParams;
    const signingDate = amzDate(q.get('X-Amz-Date') ?? '');
    const expiresIn = Number(q.get('X-Amz-Expires'));
    const again = new URL(
      await getSignedUrl(client as S3Client, command(bucket!, key, q), { expiresIn, signingDate, signableHeaders }),
    );
    const signatureOk = again.searchParams.get('X-Amz-Signature') === q.get('X-Amz-Signature');
    const fresh = Date.now() <= signingDate.getTime() + expiresIn * 1000;
    return { ok: signatureOk && fresh, key };
  }

  return {
    storage: new S3ObjectStorage(S3_CONFIG, client as S3Client),
    async send(target, body, contentType) {
      const type = contentType ?? target.headers['content-type']!;
      const { ok, key } = await verify(
        target.url,
        (Bucket, Key) => new PutObjectCommand({ Bucket, Key, ContentType: type, ContentLength: body.length }),
        new Set(['content-type', 'content-length']),
      );
      if (!ok) return { status: 403 };
      objects.set(key, { data: body, contentType: type });
      return { status: 200 };
    },
    async fetch(url) {
      const { ok, key } = await verify(url, (Bucket, Key, q) =>
        new GetObjectCommand({
          Bucket,
          Key,
          ResponseContentDisposition: q.get('response-content-disposition') ?? undefined,
          ResponseCacheControl: q.get('response-cache-control') ?? undefined,
        }),
      );
      const o = objects.get(key);
      if (!ok) return { status: 403, headers: {}, body: Buffer.alloc(0) };
      if (!o) return { status: 404, headers: {}, body: Buffer.alloc(0) };
      const disposition = new URL(url).searchParams.get('response-content-disposition');
      const headers: Record<string, string> = disposition ? { 'content-disposition': disposition } : {};
      return { status: 200, headers, body: o.data };
    },
    close: async () => {},
  };
}

// ------------------------------------------------------------------ s3, MinIO

const MINIO = { host: 'localhost', port: 9000 };

async function minioReachable(): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(MINIO);
    const done = (ok: boolean) => (socket.destroy(), resolve(ok));
    socket.setTimeout(1_000);
    socket.on('connect', () => done(true));
    socket.on('timeout', () => done(false));
    socket.on('error', () => done(false));
  });
}

async function minioHarness(): Promise<Harness> {
  const storage = new S3ObjectStorage({
    bucket: 'flyleaf-contract-test',
    region: 'us-east-1',
    accessKeyId: process.env.MINIO_ACCESS_KEY ?? 'flyleaf',
    secretAccessKey: process.env.MINIO_SECRET_KEY ?? 'flyleaf123',
    endpoint: `http://${MINIO.host}:${MINIO.port}`,
    forcePathStyle: true,
  });
  await storage.ensureBucket();
  return {
    storage,
    async send(target, body, contentType) {
      const res = await fetch(target.url, {
        method: target.method,
        headers: { ...target.headers, ...(contentType ? { 'content-type': contentType } : {}) },
        body,
      });
      await res.arrayBuffer();
      return { status: res.status };
    },
    async fetch(url) {
      const res = await fetch(url);
      return {
        status: res.status,
        headers: Object.fromEntries(res.headers.entries()),
        body: Buffer.from(await res.arrayBuffer()),
      };
    },
    close: async () => {},
  };
}

// ------------------------------------------------------------------ the contract

const hasMinio = await minioReachable();
// GitHub CI has no MinIO: say so instead of skipping in silence. The mocked
// client suite above it always runs.
if (!hasMinio) {
  console.warn(
    `[storage-contract] s3 (MinIO) SKIPPED: nothing listening on ${MINIO.host}:${MINIO.port}. ` +
      'Start it with `docker compose up -d minio` to run the s3 contract against a real S3 server.',
  );
}
let diskDir = '';

const ADAPTERS: { name: string; skip?: boolean; make: () => Promise<Harness> }[] = [
  { name: 'memory', make: () => localHarness(new MemoryObjectStorage()) },
  {
    name: 'disk',
    make: async () => {
      diskDir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-disk-'));
      return localHarness(new DiskObjectStorage({ publicUrl: 'http://localhost:3000', baseDir: diskDir }));
    },
  },
  { name: 's3 (mocked client)', make: async () => mockedS3Harness() },
  {
    name: hasMinio ? 's3 (MinIO)' : `s3 (MinIO) -- SKIPPED: not reachable at ${MINIO.host}:${MINIO.port}`,
    skip: !hasMinio,
    make: minioHarness,
  },
];

afterAll(async () => {
  if (diskDir) await fs.rm(diskDir, { recursive: true, force: true });
});

const CSV = Buffer.from('Title,Author\nPiranesi,Susanna Clarke\n');

for (const adapter of ADAPTERS) {
  describe.skipIf(adapter.skip)(`ObjectStorage contract: ${adapter.name}`, () => {
    let h: Harness;
    let n = 0;
    const key = () => `contract/${Date.now()}-${n++}.csv`;

    beforeAll(async () => {
      h = await adapter.make();
    }, 30_000);
    afterAll(async () => h?.close());

    it('put, head, getStream and delete round-trip', async () => {
      const k = key();
      await h.storage.put(k, CSV, 'text/csv');

      const info = await h.storage.head(k);
      expect(info).toMatchObject({ size: CSV.length, contentType: 'text/csv' });
      expect(info!.etag).toBeTruthy();

      const stream = await h.storage.getStream(k);
      expect(await readAll(stream!)).toEqual(CSV);

      await h.storage.delete(k);
      expect(await h.storage.head(k)).toBeNull();
      expect(await h.storage.getStream(k)).toBeNull();
    });

    it('a missing object is null, and deleting it is not an error', async () => {
      const k = key();
      expect(await h.storage.head(k)).toBeNull();
      expect(await h.storage.getStream(k)).toBeNull();
      await expect(h.storage.delete(k)).resolves.toBeUndefined();
    });

    it('refuses keys that could leave its namespace', async () => {
      for (const bad of ['../etc/passwd', '/abs', 'a//b', 'a/../b', 'a/./b', '', 'sp ace', 'a\\b']) {
        await expect(h.storage.put(bad, CSV, 'text/csv'), bad).rejects.toThrow(/Invalid object key/);
        await expect(
          h.storage.createUpload({ key: bad, contentType: 'text/csv', contentLength: 1, expiresIn: 60 }),
          bad,
        ).rejects.toThrow(/Invalid object key/);
      }
    });

    it('accepts a direct upload that matches the signed target', async () => {
      const k = key();
      const target = await h.storage.createUpload({
        key: k,
        contentType: 'text/csv',
        contentLength: CSV.length,
        expiresIn: 60,
      });
      expect(target.method).toBe('PUT');
      expect(target.headers['content-type']).toBe('text/csv');

      expect((await h.send(target, CSV)).status).toBe(200);
      expect(await h.storage.head(k)).toMatchObject({ size: CSV.length, contentType: 'text/csv' });
    });

    it('refuses an upload with a different content type', async () => {
      const k = key();
      const target = await h.storage.createUpload({ key: k, contentType: 'text/csv', contentLength: CSV.length, expiresIn: 60 });
      expect((await h.send(target, CSV, 'application/octet-stream')).status).toBe(403);
      expect(await h.storage.head(k)).toBeNull();
    });

    it('refuses an upload longer or shorter than declared', async () => {
      const k = key();
      const target = await h.storage.createUpload({ key: k, contentType: 'text/csv', contentLength: CSV.length, expiresIn: 60 });
      expect((await h.send(target, Buffer.concat([CSV, Buffer.from('x')]))).status).toBe(403);
      expect((await h.send(target, CSV.subarray(1))).status).toBe(403);
      expect(await h.storage.head(k)).toBeNull();
    });

    it('refuses a target whose URL was edited to another key', async () => {
      const k = key();
      const target = await h.storage.createUpload({ key: k, contentType: 'text/csv', contentLength: CSV.length, expiresIn: 60 });
      const other = k.replace('contract/', 'contract/evil-');
      const tampered = { ...target, url: target.url.replace(encodeURIComponent(k), encodeURIComponent(other)).replace(k, other) };
      expect(tampered.url).not.toBe(target.url);
      expect((await h.send(tampered, CSV)).status).toBe(403);
      expect(await h.storage.head(other)).toBeNull();
    });

    it('refuses an expired upload target', async () => {
      const k = key();
      const target = await h.storage.createUpload({ key: k, contentType: 'text/csv', contentLength: CSV.length, expiresIn: 1 });
      await new Promise((r) => setTimeout(r, 2_100));
      expect((await h.send(target, CSV)).status).toBe(403);
      expect(await h.storage.head(k)).toBeNull();
    });

    it('serves a download URL with the requested filename', async () => {
      const k = key();
      await h.storage.put(k, CSV, 'text/csv');
      const url = await h.storage.createDownloadUrl(k, { expiresIn: 60, filename: 'flyleaf_export.csv' });
      const res = await h.fetch(url);
      expect(res.status).toBe(200);
      expect(res.body).toEqual(CSV);
      expect(res.headers['content-disposition']).toBe('attachment; filename="flyleaf_export.csv"');
    });

    it('refuses an expired download URL', async () => {
      const k = key();
      await h.storage.put(k, CSV, 'text/csv');
      const url = await h.storage.createDownloadUrl(k, { expiresIn: 1 });
      await new Promise((r) => setTimeout(r, 2_100));
      expect((await h.fetch(url)).status).toBe(403);
    });
  });
}

describe('disk specifics', () => {
  it('getStream streams the file (several chunks), it does not buffer it: complete() hashes in constant memory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'flyleaf-disk-stream-'));
    try {
      const storage = new DiskObjectStorage({ publicUrl: 'http://localhost:3000', baseDir: dir });
      const big = Buffer.alloc(300 * 1024, 'a');
      await storage.put('stream/big.csv', big, 'text/csv');
      const stream = await storage.getStream('stream/big.csv');
      expect(stream).toBeInstanceOf(ReadStream);
      let chunks = 0;
      let bytes = 0;
      for await (const chunk of stream!) {
        chunks++;
        bytes += (chunk as Buffer).length;
      }
      expect(chunks).toBeGreaterThan(1);
      expect(bytes).toBe(big.length);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
