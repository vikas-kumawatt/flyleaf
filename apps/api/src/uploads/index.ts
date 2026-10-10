// Presigned uploads (PV-02). The API never receives upload bytes.
//
//   1. POST /v1/uploads {purpose, content_type, size}   -> row + signed target
//   2. the client sends the file straight to object storage
//   3. POST /v1/uploads/:id/complete                    -> the API looks at what
//      arrived: size, type, magic bytes, SHA-256 -> status 'uploaded'
//   4. a consumer (POST /v1/imports {upload_id}) marks it 'consumed' in the
//      same transaction as its job enqueue
//
// Step 3 reads the object once as a stream (at most the policy maximum,
// 10 MB): that is how the type is checked by content rather than by name
// (PRD §42 #11) and how import duplicate detection (PRD §34.4) gets a hash
// without the bytes ever passing through a request to the API.
//
// A presigned PUT stays valid until it expires, so the object could be
// replaced after step 3. Consumers must re-check the hash when they read the
// file (the import worker does).

import crypto from 'node:crypto';
import path from 'node:path';
import type { FastifyPluginAsync } from 'fastify';
import { and, eq, inArray, isNotNull, isNull, lt, sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { exports as exportsTable, imports, profiles, uploads, users, type Upload } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { loadRelationship } from '../authorization/index.js';
import type { ObjectStorage, UploadTarget } from '../providers/storage/index.js';
import {
  createUploadBodySchema,
  setAvatarBodySchema,
  avatarResponseSchema,
  avatarParamsSchema,
  errorResponseSchema,
  idParamSchema,
  uploadResponseSchema,
} from '../contract/schemas.js';

export type UploadPurpose = 'import' | 'avatar';

export interface UploadPolicy {
  maxBytes: number;
  contentTypes: readonly string[];
  /** How complete() judges the first bytes. */
  sniff: 'text' | 'image';
  /** The 413 message. */
  tooLarge: string;
}

/**
 * Every upload limit, in one place.
 *
 * import: PRD §6.8 ("File too large (>10MB) -> explain and offer to split")
 * and §42 #11 ("magic-byte type validation, not extension ... 10MB cap").
 * `application/vnd.ms-excel` is what Windows browsers and some pickers call a
 * .csv; the sniff below, not the label, decides whether it is text.
 */
export const UPLOAD_POLICIES: Record<UploadPurpose, UploadPolicy> = {
  import: {
    maxBytes: 10 * 1024 * 1024,
    contentTypes: ['text/csv', 'text/plain', 'application/csv', 'application/vnd.ms-excel'],
    sniff: 'text',
    tooLarge: 'File exceeds the 10MB limit. Please split your export into smaller files.',
  },
  // PRD §6.7 (audit 10, A-07-032): the client resizes before sending (a
  // 512 px JPEG is ~100 KB), so 2 MB only has to cover a client that cannot.
  // The magic bytes must match the declared type (PRD §42 #11).
  avatar: {
    maxBytes: 2 * 1024 * 1024,
    contentTypes: ['image/jpeg', 'image/png', 'image/webp'],
    sniff: 'image',
    tooLarge: 'The photo is over 2MB. Choose a smaller one.',
  },
};

/** How long the signed target accepts the bytes. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;
/** How long the upload may wait to be completed and consumed before cleanup takes it. */
export const UPLOAD_TTL_SECONDS = 60 * 60;
/** Bytes complete() sniffs. */
const SNIFF_BYTES = 8 * 1024;

/** `Text/CSV; charset=utf-8` -> `text/csv`. The signed type is always this form. */
export function normalizeContentType(value: string | null | undefined): string {
  return (value ?? '').split(';')[0]!.trim().toLowerCase();
}

const BINARY_SIGNATURES: number[][] = [
  [0x50, 0x4b, 0x03, 0x04], // zip, xlsx, docx
  [0xd0, 0xcf, 0x11, 0xe0], // OLE: xls, doc
  [0x25, 0x50, 0x44, 0x46], // %PDF
  [0x1f, 0x8b], // gzip
  [0x37, 0x7a, 0xbc, 0xaf], // 7z
  [0x52, 0x61, 0x72, 0x21], // Rar!
  [0x4d, 0x5a], // MZ: Windows executable
  [0x7f, 0x45, 0x4c, 0x46], // ELF
  [0x89, 0x50, 0x4e, 0x47], // PNG
  [0xff, 0xd8, 0xff], // JPEG
  [0x47, 0x49, 0x46, 0x38], // GIF8
];

/** The image type the first bytes say, or null. Only the types an avatar may be. */
export function imageTypeOf(head: Buffer): 'image/jpeg' | 'image/png' | 'image/webp' | null {
  const at = (bytes: number[], offset = 0) => bytes.every((b, i) => head[offset + i] === b);
  if (at([0xff, 0xd8, 0xff])) return 'image/jpeg';
  if (at([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png';
  // RIFF....WEBP
  if (at([0x52, 0x49, 0x46, 0x46]) && at([0x57, 0x45, 0x42, 0x50], 8)) return 'image/webp';
  return null;
}

/**
 * Text, judged by content: no known binary signature, and no NUL byte (which
 * no CSV export contains and every binary format does). Encoding is not
 * judged: the parser reads UTF-8 and older Windows exports are not.
 */
export function looksLikeText(head: Buffer): boolean {
  if (head.length === 0) return false;
  if (BINARY_SIGNATURES.some((sig) => sig.every((b, i) => head[i] === b))) return false;
  return !head.includes(0);
}

/** Display name only; never part of a storage key. */
function cleanFilename(name: string | undefined): string | null {
  if (!name) return null;
  const base = path.basename(name.replace(/\\/g, '/')).replace(/[\u0000-\u001f\u007f]/g, '').trim();
  return base ? base.slice(0, 255) : null;
}

export interface UploadResponseItem {
  id: string;
  purpose: string;
  status: string;
  content_type: string;
  size: number;
  max_bytes: number;
  filename: string | null;
  expires_at: string;
  created_at: string;
  completed_at: string | null;
  target?: UploadTarget;
}

export function toUploadResponse(row: Upload, target?: UploadTarget): UploadResponseItem {
  return {
    id: row.id,
    purpose: row.purpose,
    status: row.status,
    content_type: row.contentType,
    size: row.size,
    max_bytes: row.maxBytes,
    filename: row.filename,
    expires_at: row.expiresAt.toISOString(),
    created_at: row.createdAt.toISOString(),
    completed_at: row.completedAt ? row.completedAt.toISOString() : null,
    ...(target ? { target } : {}),
  };
}

const expired = () => new ApiError(410, 'upload_expired', 'This upload has expired. Upload the file again.');

export class UploadService {
  constructor(private db: Db, private storage: ObjectStorage) {}

  async create(
    userId: string,
    input: { purpose: UploadPurpose; contentType: string; size: number; filename?: string },
  ): Promise<UploadResponseItem> {
    const policy = UPLOAD_POLICIES[input.purpose];
    const contentType = normalizeContentType(input.contentType);
    if (!policy.contentTypes.includes(contentType)) {
      throw new ApiError(
        415,
        'unsupported_content_type',
        `Unsupported file type '${contentType}'. Expected one of: ${policy.contentTypes.join(', ')}.`,
        'content_type',
      );
    }
    if (input.size > policy.maxBytes) {
      throw new ApiError(413, 'file_too_large', policy.tooLarge, 'size');
    }

    const id = crypto.randomUUID();
    const [row] = await this.db
      .insert(uploads)
      .values({
        id,
        userId,
        purpose: input.purpose,
        key: `uploads/${userId}/${id}`,
        contentType,
        size: input.size,
        maxBytes: policy.maxBytes,
        filename: cleanFilename(input.filename),
        status: 'pending',
        expiresAt: new Date(Date.now() + UPLOAD_TTL_SECONDS * 1000),
      })
      .returning();

    const target = await this.storage.createUpload({
      key: row!.key,
      contentType,
      contentLength: input.size,
      expiresIn: UPLOAD_URL_TTL_SECONDS,
    });
    return toUploadResponse(row!, target);
  }

  /** Idempotent: an upload already checked is returned as it is. */
  async complete(userId: string, uploadId: string): Promise<UploadResponseItem> {
    const [row] = await this.db
      .select()
      .from(uploads)
      .where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId)))
      .limit(1);
    // Another user's upload is indistinguishable from a missing one.
    if (!row) throw ApiError.notFound('Upload not found.');
    if (row.status === 'uploaded' || row.status === 'consumed') return toUploadResponse(row);
    if (row.status === 'expired' || row.expiresAt <= new Date()) throw expired();

    const info = await this.storage.head(row.key);
    if (!info) {
      throw ApiError.conflict('upload_missing', 'The file has not arrived yet. Send it to the upload target, then complete.');
    }

    const reject = async (code: string, message: string): Promise<never> => {
      // The client may retry with the same target while it is valid.
      await this.storage.delete(row.key);
      throw ApiError.unprocessable(code, message);
    };

    if (info.size !== row.size) {
      await reject('upload_size_mismatch', `The file is ${info.size} bytes; ${row.size} were declared.`);
    }
    if (normalizeContentType(info.contentType) !== row.contentType) {
      await reject('upload_type_mismatch', 'The stored file type does not match the declared type.');
    }

    const scan = await this.#scan(row.key, row.size);
    if (!scan) throw ApiError.conflict('upload_missing', 'The file has not arrived yet. Send it to the upload target, then complete.');
    if (scan.bytes !== row.size) {
      await reject('upload_size_mismatch', `The file is ${scan.bytes} bytes; ${row.size} were declared.`);
    }
    const policy = UPLOAD_POLICIES[row.purpose as UploadPurpose];
    if (policy.sniff === 'text' && !looksLikeText(scan.head)) {
      await reject('upload_invalid_content', 'The file is not a text export. Upload the CSV file your library service produced.');
    }
    if (policy.sniff === 'image' && imageTypeOf(scan.head) !== row.contentType) {
      await reject('upload_invalid_content', 'The file is not the image it was declared as. Choose a JPEG, PNG or WebP photo.');
    }

    const [updated] = await this.db
      .update(uploads)
      .set({ status: 'uploaded', sha256: scan.sha256, completedAt: new Date() })
      .where(and(eq(uploads.id, row.id), eq(uploads.status, 'pending')))
      .returning();
    if (updated) return toUploadResponse(updated);

    // A concurrent complete won the update; report what it wrote.
    const [current] = await this.db.select().from(uploads).where(eq(uploads.id, row.id)).limit(1);
    return toUploadResponse(current!);
  }

  /** One pass: the first bytes, the SHA-256, and the true length (stops just past `limit`). */
  async #scan(key: string, limit: number) {
    const stream = await this.storage.getStream(key);
    if (!stream) return null;
    const hash = crypto.createHash('sha256');
    const head: Buffer[] = [];
    let headBytes = 0;
    let bytes = 0;
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      bytes += chunk.length;
      if (bytes > limit) {
        stream.destroy();
        break;
      }
      hash.update(chunk);
      if (headBytes < SNIFF_BYTES) {
        head.push(chunk.subarray(0, SNIFF_BYTES - headBytes));
        headBytes += Math.min(chunk.length, SNIFF_BYTES - headBytes);
      }
    }
    return { head: Buffer.concat(head), bytes, sha256: hash.digest('hex') };
  }
}

/**
 * For consumers, inside their transaction: the viewer's completed upload of
 * this purpose, row-locked so two consumers cannot both take it. Returns the
 * row as it is; the caller decides what `consumed` means for a replay.
 */
export async function lockUploadForConsumer(
  tx: Db,
  userId: string,
  uploadId: string,
  purpose: UploadPurpose,
): Promise<Upload> {
  const [row] = await tx
    .select()
    .from(uploads)
    .where(and(eq(uploads.id, uploadId), eq(uploads.userId, userId), eq(uploads.purpose, purpose)))
    .for('update')
    .limit(1);
  if (!row) throw ApiError.notFound('Upload not found.');
  if (row.status === 'consumed') return row;
  if (row.status === 'pending') {
    throw ApiError.conflict('upload_not_complete', 'Complete the upload (POST /v1/uploads/:id/complete) first.');
  }
  if (row.status === 'expired' || row.expiresAt <= new Date()) throw expired();
  return row;
}

export async function markUploadConsumed(tx: Db, uploadId: string): Promise<void> {
  await tx
    .update(uploads)
    .set({ status: 'consumed', consumedAt: new Date() })
    .where(eq(uploads.id, uploadId));
}

export type CleanupResult = { uploadsExpired: number; exportFilesDeleted: number; importFilesDeleted: number };

/**
 * An import's uploaded file is kept this long after the import finishes
 * (completed or failed), then deleted (D-PV-3). Review and resolve work from
 * `import_rows.raw`, never the file. There is no import-undo window; if one
 * is added, this must become the later of the two.
 */
export const IMPORT_FILE_RETENTION_DAYS = 30;

/**
 * Daily (worker): uploads never consumed, export files past their download
 * window, and import files IMPORT_FILE_RETENTION_DAYS after the import
 * finished leave storage. Files of a deleted account are not handled here:
 * account deletion does not exist yet (Part 15's retention sweep). An object is deleted BEFORE its row is
 * updated, so a failed delete is retried by the next run rather than
 * orphaned. Nothing consumes an upload past expires_at (lockUploadForConsumer),
 * so there is no race with a consumer.
 */
export async function cleanupStorage(
  db: Db,
  storage: ObjectStorage,
  opts: { batch?: number } = {},
): Promise<CleanupResult> {
  const batch = opts.batch ?? 500;
  const now = new Date();

  const stale = await db
    .select({ id: uploads.id, key: uploads.key })
    .from(uploads)
    .where(and(inArray(uploads.status, ['pending', 'uploaded']), lt(uploads.expiresAt, now)))
    .limit(batch);
  let uploadsExpired = 0;
  for (const u of stale) {
    await storage.delete(u.key);
    const done = await db
      .update(uploads)
      .set({ status: 'expired' })
      .where(and(eq(uploads.id, u.id), inArray(uploads.status, ['pending', 'uploaded'])))
      .returning({ id: uploads.id });
    uploadsExpired += done.length;
  }

  const oldExports = await db
    .select({ id: exportsTable.id, key: exportsTable.fileKey })
    .from(exportsTable)
    .where(and(isNotNull(exportsTable.fileKey), lt(exportsTable.expiresAt, now)))
    .limit(batch);
  for (const e of oldExports) {
    await storage.delete(e.key!);
    await db
      .update(exportsTable)
      .set({ fileKey: null, updatedAt: sql`now()` })
      .where(eq(exportsTable.id, e.id));
  }

  const importCutoff = new Date(now.getTime() - IMPORT_FILE_RETENTION_DAYS * 86_400_000);
  const oldImports = await db
    .select({ id: imports.id, key: imports.fileKey })
    .from(imports)
    .where(
      and(
        inArray(imports.state, ['completed', 'failed']),
        isNotNull(imports.fileKey),
        lt(imports.finishedAt, importCutoff),
      ),
    )
    .limit(batch);
  for (const i of oldImports) {
    await storage.delete(i.key!);
    await db.update(imports).set({ fileKey: null, updatedAt: sql`now()` }).where(eq(imports.id, i.id));
  }

  return { uploadsExpired, exportFilesDeleted: oldExports.length, importFilesDeleted: oldImports.length };
}

/**
 * Where a profile's avatar is served (GET /v1/avatars/<key>), or null. Every
 * response that carries avatar_url builds it here.
 */
export function avatarUrl(key: string | null | undefined): string | null {
  return key ? `/v1/avatars/${key}` : null;
}

/** A served avatar URL is valid for an hour; responses may be cached a little less. */
const AVATAR_URL_TTL_SECONDS = 60 * 60;

/**
 * Avatars (PRD §6.7, audit 10 A-07-032). The upload is an ordinary PV-02
 * upload with purpose 'avatar'; PUT /me/avatar consumes it. The old object is
 * deleted after the switch commits. Best effort: a failed delete leaves an
 * orphan for Part 15's retention sweep (A-PV-008), never a broken avatar.
 */
export class AvatarService {
  constructor(private db: Db, private storage: ObjectStorage) {}

  async set(userId: string, uploadId: string): Promise<{ avatar_url: string | null }> {
    const { key, previous } = await this.db.transaction(async (tx) => {
      const row = await lockUploadForConsumer(tx as unknown as Db, userId, uploadId, 'avatar');
      const [profile] = await tx
        .select({ key: profiles.avatarKey })
        .from(profiles)
        .where(eq(profiles.userId, userId))
        .for('update');
      if (row.status === 'consumed') {
        // A replay of the request that set it is a success; an older
        // avatar's upload cannot come back (its object may be gone).
        if (profile?.key === row.key) return { key: row.key, previous: null };
        throw ApiError.conflict('upload_consumed', 'This upload was already used. Upload the photo again.');
      }
      await tx.update(profiles).set({ avatarKey: row.key }).where(eq(profiles.userId, userId));
      await markUploadConsumed(tx as unknown as Db, row.id);
      return { key: row.key, previous: profile?.key ?? null };
    });
    if (previous && previous !== key) await this.storage.delete(previous).catch(() => {});
    return { avatar_url: avatarUrl(key) };
  }

  async remove(userId: string): Promise<{ avatar_url: null }> {
    const [old] = await this.db
      .select({ key: profiles.avatarKey })
      .from(profiles)
      .where(eq(profiles.userId, userId));
    await this.db.update(profiles).set({ avatarKey: null }).where(eq(profiles.userId, userId));
    if (old?.key) await this.storage.delete(old.key).catch(() => {});
    return { avatar_url: null };
  }

  /**
   * A short-lived URL for a CURRENT avatar of a live account, or null. Only
   * keys that are some profile's avatar_key are served: the key is built
   * from the path, and every other upload (import CSVs) shares its shape.
   * The header rules of PRD §16.3: a private account's avatar does not exist
   * for a guest, and nobody's exists across a block either way.
   */
  async url(viewer: string | null, userId: string, uploadId: string): Promise<string | null> {
    const rel = await loadRelationship(this.db, viewer, userId);
    if (!rel.ownerExists || rel.isBlocked || (rel.isOwnerPrivate && viewer === null)) return null;
    const key = `uploads/${userId}/${uploadId}`;
    const [row] = await this.db
      .select({ key: profiles.avatarKey })
      .from(profiles)
      .innerJoin(users, eq(users.id, profiles.userId))
      .where(and(eq(profiles.userId, userId), eq(profiles.avatarKey, key), isNull(users.deletedAt)));
    if (!row) return null;
    return this.storage.createDownloadUrl(key, { expiresIn: AVATAR_URL_TTL_SECONDS });
  }
}

export interface UploadsPluginOptions {
  db: Db;
  storage: ObjectStorage;
}

export const uploadsPlugin: FastifyPluginAsync<UploadsPluginOptions> = async (fastify, opts) => {
  const service = new UploadService(opts.db, opts.storage);

  fastify.post(
    '/uploads',
    {
      schema: {
        tags: ['Uploads'],
        summary: 'Start an upload',
        description:
          'Returns a short-lived target to send the file to directly; the API never receives the bytes. ' +
          'Limits per purpose: import 10 MB, CSV/text (PRD §6.8, §42 #11). Then POST /v1/uploads/{id}/complete (PV-02).',
        body: createUploadBodySchema,
        response: {
          201: uploadResponseSchema,
          401: errorResponseSchema,
          413: errorResponseSchema,
          415: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const body = request.body as { purpose: UploadPurpose; content_type: string; size: number; filename?: string };
      const result = await service.create(viewer, {
        purpose: body.purpose,
        contentType: body.content_type,
        size: body.size,
        filename: body.filename,
      });
      return reply.status(201).send(result);
    },
  );

  fastify.post(
    '/uploads/:id/complete',
    {
      schema: {
        tags: ['Uploads'],
        summary: 'Confirm an upload arrived',
        description:
          'Checks the stored file against what was declared (size, type, content) and marks it uploaded. ' +
          'Idempotent. 409 upload_missing: the file has not arrived yet (PV-02).',
        params: idParamSchema,
        response: {
          200: uploadResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          410: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      return reply.send(await service.complete(viewer, id));
    },
  );

  const avatars = new AvatarService(opts.db, opts.storage);

  fastify.put(
    '/me/avatar',
    {
      schema: {
        tags: ['Uploads'],
        summary: 'Set my avatar',
        description:
          'Consumes a completed upload with purpose avatar (JPEG/PNG/WebP, 2 MB; PRD §6.7). A replay with the same upload succeeds; ' +
          'an upload already used for an earlier avatar is 409 upload_consumed.',
        body: setAvatarBodySchema,
        response: {
          200: avatarResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          409: errorResponseSchema,
          410: errorResponseSchema,
        },
      },
    },
    async (request) => {
      const viewer = requireViewer(request);
      return avatars.set(viewer, (request.body as { upload_id: string }).upload_id);
    },
  );

  fastify.delete(
    '/me/avatar',
    {
      schema: {
        tags: ['Uploads'],
        summary: 'Remove my avatar',
        description: 'Back to the generated typographic avatar (PRD §6.7).',
        response: { 200: avatarResponseSchema, 401: errorResponseSchema },
      },
    },
    async (request) => avatars.remove(requireViewer(request)),
  );

  fastify.get(
    '/avatars/uploads/:userId/:uploadId',
    {
      schema: {
        tags: ['Uploads'],
        summary: 'An avatar image',
        description:
          'Redirects (302) to a short-lived URL for the image, to whoever may see the profile header (PRD §16.3): ' +
          'anyone for a public account, signed-in users for a private one, nobody across a block. ' +
          'Only current avatars of live accounts; anything else is 404. Send the bearer token for a private account.',
        params: avatarParamsSchema,
        response: { 404: errorResponseSchema },
      },
    },
    async (request, reply) => {
      const { userId, uploadId } = request.params as { userId: string; uploadId: string };
      const url = await avatars.url(request.viewer, userId, uploadId);
      if (!url) throw ApiError.notFound('No such avatar.');
      return reply
        // private: whether it may be served depends on the viewer.
        .header('cache-control', `private, max-age=${AVATAR_URL_TTL_SECONDS - 300}`)
        .redirect(url, 302);
    },
  );
};
