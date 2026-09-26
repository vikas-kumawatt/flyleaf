// `s3` object storage (PV-01): AWS S3, Cloudflare R2, Backblaze B2, MinIO --
// anything that speaks the S3 API and SigV4 presigned URLs.
//
// Uploads are presigned PUTs, not POST policies: R2 does not implement POST
// Object, and a PUT can bind the exact length and type, which is all the
// upload flow needs (the policy maximum is checked before signing).

import { Readable } from 'node:stream';
import {
  CreateBucketCommand,
  DeleteObjectCommand,
  HeadBucketCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  assertValidKey,
  attachmentDisposition,
  type CreateUploadInput,
  type ObjectInfo,
  type ObjectStorage,
  type UploadTarget,
} from './types.js';

export interface S3StorageConfig {
  bucket: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
  /** Omit for AWS. R2: https://<account>.r2.cloudflarestorage.com; MinIO: http://localhost:9000. */
  endpoint?: string;
  /** MinIO needs path-style (http://host/bucket/key); R2 and AWS take either. */
  forcePathStyle?: boolean;
}

/** Content-Type and Content-Length are signed, so the provider refuses anything else. */
const SIGNED_UPLOAD_HEADERS = new Set(['content-type', 'content-length']);

function isNotFound(err: unknown): boolean {
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return e?.name === 'NotFound' || e?.name === 'NoSuchKey' || e?.$metadata?.httpStatusCode === 404;
}

export class S3ObjectStorage implements ObjectStorage {
  readonly driver = 's3' as const;
  readonly #bucket: string;

  /**
   * `client` is injectable so the contract suite can run this adapter against
   * an in-memory fake of S3's API with no network (presigning is local
   * computation and uses the real SDK either way).
   */
  constructor(config: S3StorageConfig, readonly client: S3Client = S3ObjectStorage.clientFor(config)) {
    this.#bucket = config.bucket;
  }

  static clientFor(config: S3StorageConfig): S3Client {
    return new S3Client({
      region: config.region,
      endpoint: config.endpoint,
      forcePathStyle: config.forcePathStyle,
      credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    });
  }

  /** Development (MinIO) and tests: create the bucket if it is not there. */
  async ensureBucket(): Promise<void> {
    try {
      await this.client.send(new HeadBucketCommand({ Bucket: this.#bucket }));
    } catch (err) {
      if (!isNotFound(err)) throw err;
      await this.client.send(new CreateBucketCommand({ Bucket: this.#bucket }));
    }
  }

  async createUpload(input: CreateUploadInput): Promise<UploadTarget> {
    assertValidKey(input.key);
    const url = await getSignedUrl(
      this.client,
      new PutObjectCommand({
        Bucket: this.#bucket,
        Key: input.key,
        ContentType: input.contentType,
        ContentLength: input.contentLength,
      }),
      { expiresIn: input.expiresIn, signableHeaders: SIGNED_UPLOAD_HEADERS },
    );
    return { url, method: 'PUT', headers: { 'content-type': input.contentType } };
  }

  async createDownloadUrl(key: string, opts: { expiresIn: number; filename?: string }): Promise<string> {
    assertValidKey(key);
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.#bucket,
        Key: key,
        ResponseContentDisposition: opts.filename ? attachmentDisposition(opts.filename) : undefined,
        ResponseCacheControl: 'private, no-store',
      }),
      { expiresIn: opts.expiresIn },
    );
  }

  async head(key: string): Promise<ObjectInfo | null> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new HeadObjectCommand({ Bucket: this.#bucket, Key: key }));
      return {
        size: Number(res.ContentLength ?? 0),
        contentType: res.ContentType ?? null,
        etag: res.ETag ? res.ETag.replace(/"/g, '') : null,
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async getStream(key: string): Promise<Readable | null> {
    assertValidKey(key);
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.#bucket, Key: key }));
      const body = res.Body;
      if (!body) return null;
      // In Node the SDK returns an IncomingMessage (a Readable).
      return body instanceof Readable ? body : Readable.from(body as AsyncIterable<Uint8Array>);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async put(key: string, body: Buffer | string, contentType: string): Promise<void> {
    assertValidKey(key);
    await this.client.send(
      new PutObjectCommand({ Bucket: this.#bucket, Key: key, Body: body, ContentType: contentType }),
    );
  }

  async delete(key: string): Promise<void> {
    assertValidKey(key);
    // S3 DeleteObject succeeds for a missing key; the contract requires that.
    await this.client.send(new DeleteObjectCommand({ Bucket: this.#bucket, Key: key }));
  }
}
