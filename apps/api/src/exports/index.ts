// Export endpoints and service (PRD §6.8, §24.2, §34.4, §1290, §3424, §3608, §5320, IM-10).
//
// Handles requests to export user reading data (CSV or JSON), creates export records,
// executes data gathering and RFC 4180 / JSON formatting, stores files, sends email with
// secure download links, and serves authenticated or tokenized file downloads.

import crypto from 'node:crypto';
import type { FastifyPluginAsync } from 'fastify';
import { eq, desc, and } from 'drizzle-orm';
import type { PgBoss } from 'pg-boss';

import type { Db, EmailSender } from '../platform/index.js';
import { ConsoleEmailSender } from '../platform/index.js';
import { exports as exportsTable, users, type Export } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { QUEUES } from '../jobs/index.js';
import {
  errorResponseSchema,
  idParamSchema,
  createExportBodySchema,
  exportResponseSchema,
  exportListResponseSchema,
  downloadExportQuerySchema,
} from '../contract/schemas.js';
import { type FileStorage, DiskFileStorage } from '../imports/storage.js';
import {
  generateExportData,
  formatAsCsv,
  formatAsJson,
} from './generator.js';

export * from './generator.js';

export const EXPORT_FORMATS = ['csv', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export interface ExportResponseItem {
  id: string;
  user_id: string;
  format: string;
  state: string;
  file_size_bytes: number | null;
  download_url: string | null;
  expires_at: string | null;
  error: string | null;
  created_at: string;
  finished_at: string | null;
}

export function toExportResponse(row: Export, baseUrl = 'https://flyleaf.app'): ExportResponseItem {
  const downloadUrl =
    row.state === 'completed' && row.downloadToken
      ? `${baseUrl}/v1/exports/${row.id}/download?token=${row.downloadToken}`
      : null;

  return {
    id: row.id,
    user_id: row.userId,
    format: row.format,
    state: row.state,
    file_size_bytes: row.fileSizeBytes,
    download_url: downloadUrl,
    expires_at: row.expiresAt ? row.expiresAt.toISOString() : null,
    error: row.error,
    created_at: row.createdAt.toISOString(),
    finished_at: row.finishedAt ? row.finishedAt.toISOString() : null,
  };
}

export interface CreateExportInput {
  format?: string;
}

export class ExportService {
  constructor(
    private db: Db,
    private storage: FileStorage,
    private mailer: EmailSender = new ConsoleEmailSender(),
    private boss?: PgBoss,
    private baseUrl = 'https://flyleaf.app',
  ) {}

  async create(userId: string, input: CreateExportInput): Promise<ExportResponseItem> {
    const rawFormat = (input.format || 'csv').trim().toLowerCase();
    if (!EXPORT_FORMATS.includes(rawFormat as ExportFormat)) {
      throw ApiError.badRequest(
        'invalid_format',
        `Unsupported export format '${input.format}'. Supported formats: ${EXPORT_FORMATS.join(', ')}.`,
        'format',
      );
    }

    const format = rawFormat as ExportFormat;
    const downloadToken = crypto.randomBytes(32).toString('base64url');
    const expiresAt = new Date(Date.now() + 48 * 60 * 60 * 1000); // 48 hours validity

    const [row] = await this.db
      .insert(exportsTable)
      .values({
        userId,
        format,
        state: 'queued',
        downloadToken,
        expiresAt,
      })
      .returning();

    if (!row) {
      throw new ApiError(500, 'export_create_failed', 'Failed to create export record.');
    }

    // Enqueue background processing job via pg-boss if configured
    if (this.boss) {
      try {
        await this.boss.send(QUEUES.processExport, {
          exportId: row.id,
          userId,
          format,
        });
      } catch {
        // Fallback: if boss queueing fails, proceed
      }
    }

    return toExportResponse(row, this.baseUrl);
  }

  async processExport(exportId: string): Promise<ExportResponseItem> {
    const [exportRow] = await this.db
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, exportId))
      .limit(1);

    if (!exportRow) {
      throw new Error(`Export ${exportId} not found.`);
    }

    if (exportRow.state === 'completed') {
      return toExportResponse(exportRow, this.baseUrl);
    }

    try {
      // 1. Mark processing
      await this.db
        .update(exportsTable)
        .set({ state: 'processing', updatedAt: new Date() })
        .where(eq(exportsTable.id, exportId));

      // 2. Fetch user's email
      const [userRow] = await this.db
        .select({ email: users.email })
        .from(users)
        .where(eq(users.id, exportRow.userId))
        .limit(1);

      if (!userRow) {
        throw new Error(`User not found for export ${exportId}`);
      }

      // 3. Generate export payload
      const exportData = await generateExportData(this.db, exportRow.userId);

      let fileContent: string;
      let mimeType: string;
      let extension: string;

      if (exportRow.format === 'json') {
        fileContent = formatAsJson(exportData);
        mimeType = 'application/json';
        extension = 'json';
      } else {
        fileContent = formatAsCsv(exportData);
        mimeType = 'text/csv';
        extension = 'csv';
      }

      const fileBuffer = Buffer.from(fileContent, 'utf-8');
      const fileKey = `exports/${exportRow.userId}/${exportId}.${extension}`;

      // 4. Save to storage
      await this.storage.put(fileKey, fileBuffer, mimeType);

      // 5. Update export record
      const [updated] = await this.db
        .update(exportsTable)
        .set({
          state: 'completed',
          fileKey,
          fileSizeBytes: fileBuffer.length,
          finishedAt: new Date(),
          updatedAt: new Date(),
        })
        .where(eq(exportsTable.id, exportId))
        .returning();

      // 6. Send email notification with download link (PRD §1290, §3424)
      const downloadUrl = `${this.baseUrl}/v1/exports/${exportId}/download?token=${exportRow.downloadToken}`;

      await this.mailer.send({
        to: userRow.email,
        subject: 'Your Flyleaf data export is ready',
        text: `Your Flyleaf library data export (${exportRow.format.toUpperCase()}) is ready for download.\n\nDownload link:\n${downloadUrl}\n\nThis link is secure and valid for 48 hours.\n\nThank you for using Flyleaf!`,
      });

      return toExportResponse(updated!, this.baseUrl);
    } catch (err: any) {
      const errorMessage = err.message || 'Export processing failed';
      const [failedRow] = await this.db
        .update(exportsTable)
        .set({
          state: 'failed',
          error: errorMessage,
          updatedAt: new Date(),
        })
        .where(eq(exportsTable.id, exportId))
        .returning();

      return toExportResponse(failedRow!, this.baseUrl);
    }
  }

  async get(userId: string, exportId: string): Promise<ExportResponseItem> {
    const [row] = await this.db
      .select()
      .from(exportsTable)
      .where(and(eq(exportsTable.id, exportId), eq(exportsTable.userId, userId)))
      .limit(1);

    if (!row) {
      throw ApiError.notFound('Export not found.');
    }

    return toExportResponse(row, this.baseUrl);
  }

  async list(userId: string, limit = 20): Promise<ExportResponseItem[]> {
    const rows = await this.db
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.userId, userId))
      .orderBy(desc(exportsTable.createdAt))
      .limit(Math.min(50, Math.max(1, limit)));

    return rows.map((r) => toExportResponse(r, this.baseUrl));
  }

  async download(
    exportId: string,
    token?: string,
    viewerId?: string,
  ): Promise<{ buffer: Buffer; filename: string; mimeType: string }> {
    const [row] = await this.db
      .select()
      .from(exportsTable)
      .where(eq(exportsTable.id, exportId))
      .limit(1);

    if (!row) {
      throw ApiError.notFound('Export not found.');
    }

    // Access authorization: either viewer owns the export OR valid token provided
    const isOwner = viewerId && row.userId === viewerId;
    const isValidToken = token && row.downloadToken === token;

    if (!isOwner && !isValidToken) {
      throw ApiError.notFound('Export not found.');
    }

    // Check expiration
    if (row.expiresAt && new Date() > row.expiresAt) {
      throw ApiError.badRequest('export_expired', 'This export download link has expired. Please request a new export.');
    }

    if (row.state !== 'completed' || !row.fileKey) {
      throw ApiError.badRequest('export_not_ready', 'Export is still processing or has failed.');
    }

    const fileBuffer = await this.storage.get(row.fileKey);
    if (!fileBuffer) {
      throw ApiError.notFound('Export file not found in storage.');
    }

    const mimeType = row.format === 'json' ? 'application/json' : 'text/csv';
    const filename = `flyleaf_export_${row.userId.slice(0, 8)}.${row.format}`;

    return {
      buffer: fileBuffer,
      filename,
      mimeType,
    };
  }
}

export interface ExportsPluginOptions {
  db: Db;
  storage?: FileStorage;
  mailer?: EmailSender;
  boss?: PgBoss;
}

/**
 * Fastify plugin registering export endpoints.
 */
export const exportsPlugin: FastifyPluginAsync<ExportsPluginOptions> = async (fastify, opts) => {
  const storage = opts.storage ?? new DiskFileStorage();
  const mailer = opts.mailer ?? new ConsoleEmailSender();
  const service = new ExportService(opts.db, storage, mailer, opts.boss);

  // POST /v1/exports (PRD §3424, IM-10)
  fastify.post(
    '/exports',
    {
      schema: {
        tags: ['Exports'],
        summary: 'Request full reading library export',
        description:
          'Requests an asynchronous data export (CSV or JSON). Generates file and emails secure download link (PRD §1290, §3424, IM-10).',
        body: createExportBodySchema,
        response: {
          201: exportResponseSchema,
          400: errorResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const body = (request.body as CreateExportInput) || {};
      const result = await service.create(viewer, body);

      return reply.status(201).send(result);
    },
  );

  // GET /v1/exports
  fastify.get(
    '/exports',
    {
      schema: {
        tags: ['Exports'],
        summary: 'List user library exports',
        description: 'Lists previous and active data exports for the authenticated viewer.',
        response: {
          200: exportListResponseSchema,
          401: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const result = await service.list(viewer);
      return reply.send({ exports: result });
    },
  );

  // GET /v1/exports/:id
  fastify.get(
    '/exports/:id',
    {
      schema: {
        tags: ['Exports'],
        summary: 'Get export job status',
        description: 'Retrieves the status, file size, and download link for an export job.',
        params: idParamSchema,
        response: {
          200: exportResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const viewer = requireViewer(request);
      const { id } = request.params as { id: string };
      const result = await service.get(viewer, id);
      return reply.send(result);
    },
  );

  // GET /v1/exports/:id/download (Emailed link or direct download)
  fastify.get(
    '/exports/:id/download',
    {
      schema: {
        tags: ['Exports'],
        summary: 'Download exported library file',
        description:
          'Downloads the generated export file (CSV/JSON) using a secure emailed token or Bearer authentication.',
        params: idParamSchema,
        querystring: downloadExportQuerySchema,
        response: {
          400: errorResponseSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params as { id: string };
      const { token } = (request.query as { token?: string }) || {};
      const viewerId = request.viewer ?? undefined;

      const file = await service.download(id, token, viewerId);

      return reply
        .header('Content-Type', file.mimeType)
        .header('Content-Disposition', `attachment; filename="${file.filename}"`)
        .send(file.buffer);
    },
  );
};
