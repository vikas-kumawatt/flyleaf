// The app's side of moderation (SO-40, SO-42): reporting, the reporter's
// statuses, and the owner's notices and appeal. PRD §24.2 `POST /reports`.

import type { FastifyPluginAsync } from 'fastify';
import { ApiError, requireViewer } from '../http.js';
import type { Db } from '../platform/index.js';
import { errorResponseSchema } from '../contract/schemas.js';
import type { Notifier } from '../notify/index.js';
import { APPEAL_MAX_LENGTH, ModerationService, REPORT_REASONS, RULES, SUBJECT_TYPES, type ReportInput } from './index.js';

const uuid = { type: 'string', format: 'uuid' } as const;

export const reportSchema = {
  type: 'object',
  properties: {
    id: uuid,
    subject_type: { type: 'string', enum: [...SUBJECT_TYPES] },
    subject_id: uuid,
    reason: { type: 'string', enum: [...REPORT_REASONS] },
    status: { type: 'string', enum: ['open', 'reviewed'], description: 'PRD §27.6: never the outcome for someone else' },
    created_at: { type: 'string', format: 'date-time' },
    reviewed_at: { type: ['string', 'null'], format: 'date-time' },
  },
  required: ['id', 'subject_type', 'subject_id', 'reason', 'status', 'created_at', 'reviewed_at'],
} as const;

export const noticeSchema = {
  type: 'object',
  properties: {
    id: uuid,
    subject_type: { type: 'string', enum: [...SUBJECT_TYPES] },
    subject_id: uuid,
    rule: { type: 'string', enum: [...RULES] },
    rule_label: { type: 'string' },
    summary: { type: 'string' },
    consequences: { type: 'array', items: { type: 'string' } },
    created_at: { type: 'string', format: 'date-time' },
    reversed: { type: 'boolean' },
    can_appeal: { type: 'boolean' },
    appeal: {
      type: ['object', 'null'],
      properties: {
        state: { type: 'string', enum: ['pending', 'upheld', 'overturned'], description: 'upheld: the decision stands' },
        body: { type: 'string' },
        appealed_at: { type: 'string', format: 'date-time' },
        resolved_at: { type: ['string', 'null'], format: 'date-time' },
      },
      required: ['state', 'body', 'appealed_at', 'resolved_at'],
    },
  },
  required: ['id', 'subject_type', 'subject_id', 'rule', 'rule_label', 'summary', 'consequences', 'created_at', 'reversed', 'can_appeal', 'appeal'],
} as const;

const reportBodySchema = {
  type: 'object',
  properties: {
    subject_type: { type: 'string', enum: [...SUBJECT_TYPES] },
    subject_id: uuid,
    reason: { type: 'string', enum: [...REPORT_REASONS], description: 'PRD §6.44' },
    detail: { type: ['string', 'null'], maxLength: 1000 },
  },
  required: ['subject_type', 'subject_id', 'reason'],
  additionalProperties: false,
} as const;

const idParams = { type: 'object', properties: { id: uuid }, required: ['id'] } as const;
const pageQuery = {
  type: 'object',
  properties: { limit: { type: 'integer', minimum: 1, maximum: 100, default: 30 }, offset: { type: 'integer', minimum: 0, default: 0 } },
} as const;

export interface ModerationPluginOptions {
  db: Db;
  notifier?: Notifier;
}

export const moderationPlugin: FastifyPluginAsync<ModerationPluginOptions> = async (app, opts) => {
  const service = new ModerationService(opts.db, opts.notifier);

  app.post<{ Body: ReportInput }>(
    '/reports',
    {
      schema: {
        tags: ['moderation'],
        summary: 'Report a review, comment, profile, shelf or book (PRD §6.44, §27.2 layer 2)',
        description: 'Anything the caller may not see is a 404. A second report of the same open subject returns the first (200).',
        body: reportBodySchema,
        response: {
          201: { type: 'object', properties: { report: reportSchema }, required: ['report'] },
          200: { type: 'object', properties: { report: reportSchema }, required: ['report'] },
          400: errorResponseSchema,
          401: errorResponseSchema,
          404: errorResponseSchema,
          422: errorResponseSchema,
          429: errorResponseSchema,
        },
      },
    },
    async (req, reply) => {
      const { report, created } = await service.report(requireViewer(req), req.body);
      return reply.code(created ? 201 : 200).send({ report });
    },
  );

  app.get<{ Querystring: { limit?: number; offset?: number } }>(
    '/me/reports',
    {
      schema: {
        tags: ['moderation'],
        summary: 'Your reports and whether each has been reviewed (PRD §27.6)',
        querystring: pageQuery,
        response: {
          200: { type: 'object', properties: { reports: { type: 'array', items: reportSchema } }, required: ['reports'] },
          401: errorResponseSchema,
        },
      },
    },
    async (req) => service.myReports(requireViewer(req), req.query),
  );

  app.get(
    '/me/moderation',
    {
      schema: {
        tags: ['moderation'],
        summary: 'Moderation decisions about your content: the rule applied and your appeal (PRD §27.6)',
        response: {
          200: { type: 'object', properties: { notices: { type: 'array', items: noticeSchema } }, required: ['notices'] },
          401: errorResponseSchema,
        },
      },
    },
    async (req) => service.myNotices(requireViewer(req)),
  );

  app.get<{ Params: { id: string } }>(
    '/me/moderation/:id',
    {
      schema: {
        tags: ['moderation'],
        summary: 'One moderation decision about your content',
        params: idParams,
        response: { 200: noticeSchema, 401: errorResponseSchema, 404: errorResponseSchema },
      },
    },
    async (req) => service.myNotice(requireViewer(req), req.params.id),
  );

  app.post<{ Params: { id: string }; Body: { body: string } }>(
    '/me/moderation/:id/appeal',
    {
      schema: {
        tags: ['moderation'],
        summary: 'Appeal a decision, once (PRD §27.6). A person reviews it.',
        params: idParams,
        body: {
          type: 'object',
          properties: { body: { type: 'string', minLength: 1, maxLength: APPEAL_MAX_LENGTH } },
          required: ['body'],
          additionalProperties: false,
        },
        response: { 200: noticeSchema, 400: errorResponseSchema, 401: errorResponseSchema, 404: errorResponseSchema, 409: errorResponseSchema, 422: errorResponseSchema },
      },
    },
    async (req) => {
      if (typeof req.body?.body !== 'string') throw ApiError.badRequest('empty_body', 'Tell us why the decision is wrong.', 'body');
      return service.appeal(requireViewer(req), req.params.id, req.body.body);
    },
  );
};
