// `disk` and `memory` object storage (PV-01): development and tests.
//
// Both hand out HMAC-signed URLs to a small route in this process
// (local-routes.ts) that behaves like a provider's presigned endpoint: the
// signature binds the key, content type, exact length and expiry, and a
// request that differs in any of them is refused. That is what lets the whole
// presigned flow -- intent, direct upload, complete -- run on a laptop and in
// PGlite tests with no cloud account.
//
// That route receives upload bytes, which the API must never do in
// production. providers/index.ts refuses to start with either adapter when
// NODE_ENV=production.

import crypto from 'node:crypto';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import {
  assertValidKey,
  type CreateUploadInput,
  type ObjectInfo,
  type ObjectStorage,
  type UploadTarget,
} from './types.js';

/** Path of the route that plays the provider. */
export const LOCAL_OBJECT_ROUTE = '/v1/storage/object';

interface StoredObject {
  data: Buffer;
  contentType: string | null;
}

export type SignedParams =
  | { op: 'put'; key: string; ct: string; len: number; exp: number }
  | { op: 'get'; key: string; filename: string; exp: number };

export abstract class LocalObjectStorage implements ObjectStorage {
  abstract readonly driver: 'disk' | 'memory';
  readonly #secret: Buffer;
  readonly #publicUrl: string;

  /**
   * @param publicUrl origin the client can reach this API on, e.g.
   *   http://192.168.1.20:3000 for a phone on the LAN.
   * @param secret HMAC key. Random per process when omitted, which is fine:
   *   the URLs live minutes, and a restart only invalidates unused ones.
   */
  constructor(opts: { publicUrl: string; secret?: string }) {
    this.#publicUrl = opts.publicUrl.replace(/\/+$/, '');
    this.#secret = opts.secret ? Buffer.from(opts.secret, 'utf8') : crypto.randomBytes(32);
  }

  protected abstract read(key: string): Promise<StoredObject | null>;
  protected abstract write(key: string, obj: StoredObject): Promise<void>;
  protected abstract remove(key: string): Promise<void>;

  #sign(p: SignedParams): string {
    const material =
      p.op === 'put'
        ? ['put', p.key, p.ct, String(p.len), String(p.exp)]
        : ['get', p.key, p.filename, String(p.exp)];
    return crypto.createHmac('sha256', this.#secret).update(material.join('\n')).digest('base64url');
  }

  #url(p: SignedParams): string {
    const q = new URLSearchParams(
      p.op === 'put'
        ? { op: 'put', key: p.key, ct: p.ct, len: String(p.len), exp: String(p.exp) }
        : { op: 'get', key: p.key, filename: p.filename, exp: String(p.exp) },
    );
    q.set('sig', this.#sign(p));
    return `${this.#publicUrl}${LOCAL_OBJECT_ROUTE}?${q.toString()}`;
  }

  /** The route's check: signature first (constant time), then expiry. */
  verify(p: SignedParams, sig: string): 'ok' | 'bad_signature' | 'expired' {
    const expected = Buffer.from(this.#sign(p));
    const given = Buffer.from(sig);
    if (expected.length !== given.length || !crypto.timingSafeEqual(expected, given)) {
      return 'bad_signature';
    }
    return Date.now() > p.exp * 1000 ? 'expired' : 'ok';
  }

  async createUpload(input: CreateUploadInput): Promise<UploadTarget> {
    assertValidKey(input.key);
    const exp = Math.floor(Date.now() / 1000) + input.expiresIn;
    return {
      url: this.#url({ op: 'put', key: input.key, ct: input.contentType, len: input.contentLength, exp }),
      method: 'PUT',
      headers: { 'content-type': input.contentType },
    };
  }

  async createDownloadUrl(key: string, opts: { expiresIn: number; filename?: string }): Promise<string> {
    assertValidKey(key);
    const exp = Math.floor(Date.now() / 1000) + opts.expiresIn;
    return this.#url({ op: 'get', key, filename: opts.filename ?? '', exp });
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertValidKey(key);
    const obj = await this.read(key);
    if (!obj) return null;
    return {
      size: obj.data.length,
      contentType: obj.contentType,
      etag: crypto.createHash('md5').update(obj.data).digest('hex'),
    };
  }

  async getStream(key: string): Promise<Readable | null> {
    assertValidKey(key);
    const obj = await this.read(key);
    return obj ? Readable.from([obj.data]) : null;
  }

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    assertValidKey(key);
    await this.write(key, { data: Buffer.isBuffer(body) ? body : Buffer.from(body), contentType });
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    await this.remove(key);
  }

  /** For the route only: the object and its stored type. */
  async readForDownload(key: string): Promise<StoredObject | null> {
    assertValidKey(key);
    return this.read(key);
  }
}

/** Tests. Objects live in a Map and vanish with the process. */
export class MemoryObjectStorage extends LocalObjectStorage {
  readonly driver = 'memory' as const;
  readonly #objects = new Map<string, StoredObject>();

  constructor(opts: { publicUrl?: string; secret?: string } = {}) {
    super({ publicUrl: opts.publicUrl ?? 'http://localhost', secret: opts.secret });
  }

  protected async read(key: string) {
    return this.#objects.get(key) ?? null;
  }
  protected async write(key: string, obj: StoredObject) {
    this.#objects.set(key, obj);
  }
  protected async remove(key: string) {
    this.#objects.delete(key);
  }

  /** Test helper: every key currently stored. */
  keys(): string[] {
    return [...this.#objects.keys()];
  }
}

/**
 * Development. Files under `baseDir` (default apps/api/.uploads), with the
 * content type in a `.meta.json` sidecar so head() can report it.
 */
export class DiskObjectStorage extends LocalObjectStorage {
  readonly driver = 'disk' as const;
  readonly #baseDir: string;

  constructor(opts: { publicUrl: string; secret?: string; baseDir?: string }) {
    super(opts);
    this.#baseDir = path.resolve(opts.baseDir ?? path.resolve(process.cwd(), '.uploads'));
  }

  /** assertValidKey already refused `..`; this is the belt to that brace. */
  #path(key: string): string {
    const full = path.resolve(this.#baseDir, key);
    if (!full.startsWith(this.#baseDir + path.sep)) throw new Error(`Key escapes storage: ${key}`);
    return full;
  }

  protected async read(key: string): Promise<StoredObject | null> {
    const file = this.#path(key);
    try {
      const data = await fs.readFile(file);
      let contentType: string | null = null;
      try {
        contentType = JSON.parse(await fs.readFile(`${file}.meta.json`, 'utf8')).contentType ?? null;
      } catch {
        // No sidecar: an object written before PV-01. Its type is unknown.
      }
      return { data, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  protected async write(key: string, obj: StoredObject): Promise<void> {
    const file = this.#path(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, obj.data);
    await fs.writeFile(`${file}.meta.json`, JSON.stringify({ contentType: obj.contentType }));
  }

  /** A file stream, not a buffered read: complete() hashes in constant memory. */
  override async getStream(key: string): Promise<Readable | null> {
    assertValidKey(key);
    const file = this.#path(key);
    try {
      await fs.access(file);
    } catch {
      return null;
    }
    return createReadStream(file);
  }

  protected async remove(key: string): Promise<void> {
    const file = this.#path(key);
    await fs.rm(file, { force: true });
    await fs.rm(`${file}.meta.json`, { force: true });
  }
}
