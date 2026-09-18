// First-party telemetry and PRD §4.4 interaction budget analytics (SL-80, SL-81, Architecture §3.7, PRD §28.1).
//
// Ingests high-frequency user telemetry directly to PostgreSQL with zero third-party
// PII transmission, and continuously monitors the 5 interaction budgets via p75 SQL aggregates.

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { sql } from 'drizzle-orm';
import { z } from 'zod';
import type { Db } from '../platform/index.js';
import { events } from '../db/schema.js';
import { verifyAccessToken } from '../identity/index.js';
import { requireModerator } from '../http.js';
import {
  postEventsBatchBodySchema,
  postEventsResponseSchema,
  budgetMetricsResponseSchema,
  errorResponseSchema,
} from '../contract/schemas.js';

export interface TelemetryEventInput {
  name: string;
  session_id?: string | null;
  platform?: string | null;
  app_version?: string | null;
  properties?: Record<string, any>;
  at?: string | null;
  userId?: string | null;
}

const eventItemZod = z.object({
  name: z.string().min(1).max(100),
  session_id: z.string().uuid().nullish(),
  platform: z.string().max(50).nullish(),
  app_version: z.string().max(50).nullish(),
  properties: z.record(z.string(), z.any()).default({}),
  at: z.string().datetime().nullish(),
});

const postEventsBatchZod = z.object({
  events: z.array(eventItemZod).min(1).max(100),
});

/**
 * Persists an array of telemetry events to Postgres.
 */
export async function recordEvents(
  db: Db,
  eventsList: TelemetryEventInput[],
  authenticatedUserId?: string | null,
): Promise<number> {
  if (eventsList.length === 0) return 0;

  const rows = eventsList.map((item) => ({
    name: item.name,
    userId: authenticatedUserId || item.userId || null,
    sessionId: item.session_id || null,
    platform: item.platform || null,
    appVersion: item.app_version || null,
    properties: item.properties || {},
    at: item.at ? new Date(item.at) : new Date(),
  }));

  await db.insert(events).values(rows);
  return rows.length;
}

export interface BudgetMetrics {
  progress_updated: {
    p75_duration_ms: number | null;
    budget_ms: number;
    sample_count: number;
    passing: boolean;
  };
  book_logged: {
    p75_tap_count: number | null;
    budget_taps: number;
    sample_count: number;
    passing: boolean;
  };
  finish_completed: {
    p75_duration_seconds: number | null;
    budget_seconds: number;
    sample_count: number;
    passing: boolean;
  };
  log_sheet_completed: {
    p75_duration_ms: number | null;
    budget_ms: number;
    sample_count: number;
    passing: boolean;
  };
  finish_flow_abandoned: {
    abandonment_rate: number;
    abandoned_count: number;
    completed_count: number;
    budget_max_rate: number;
    passing: boolean;
  };
}

/**
 * Computes PRD §4.4 interaction budgets using PostgreSQL percentile_cont(0.75).
 */
export async function getBudgetMetrics(db: Db): Promise<BudgetMetrics> {
  // 1. Progress Updated (p75 duration < 5s / 5000ms)
  const progressRes = await db.execute<{ p75: string | number | null; count: string | number }>(sql`
    SELECT
      percentile_cont(0.75) WITHIN GROUP (ORDER BY (properties->>'duration_ms')::numeric) AS p75,
      count(*)::int AS count
    FROM events
    WHERE name = 'progress_updated' AND properties->>'duration_ms' IS NOT NULL;
  `);
  const progressP75 = progressRes[0]?.p75 != null ? Number(progressRes[0].p75) : null;
  const progressCount = Number(progressRes[0]?.count ?? 0);

  // 2. Book Logged (p75 taps <= 2)
  const bookLoggedRes = await db.execute<{ p75: string | number | null; count: string | number }>(sql`
    SELECT
      percentile_cont(0.75) WITHIN GROUP (ORDER BY (properties->>'tap_count')::numeric) AS p75,
      count(*)::int AS count
    FROM events
    WHERE name = 'book_logged' AND properties->>'tap_count' IS NOT NULL;
  `);
  const bookLoggedP75 = bookLoggedRes[0]?.p75 != null ? Number(bookLoggedRes[0].p75) : null;
  const bookLoggedCount = Number(bookLoggedRes[0]?.count ?? 0);

  // 3. Finish Completed (p75 duration < 20s)
  const finishRes = await db.execute<{ p75: string | number | null; count: string | number }>(sql`
    SELECT
      percentile_cont(0.75) WITHIN GROUP (ORDER BY (properties->>'duration_seconds')::numeric) AS p75,
      count(*)::int AS count
    FROM events
    WHERE name = 'finish_completed' AND properties->>'duration_seconds' IS NOT NULL;
  `);
  const finishP75 = finishRes[0]?.p75 != null ? Number(finishRes[0].p75) : null;
  const finishCount = Number(finishRes[0]?.count ?? 0);

  // 4. Log Sheet Completed (p75 duration < 15s / 15000ms)
  const logSheetRes = await db.execute<{ p75: string | number | null; count: string | number }>(sql`
    SELECT
      percentile_cont(0.75) WITHIN GROUP (ORDER BY (properties->>'duration_ms')::numeric) AS p75,
      count(*)::int AS count
    FROM events
    WHERE name = 'log_sheet_completed' AND properties->>'duration_ms' IS NOT NULL;
  `);
  const logSheetP75 = logSheetRes[0]?.p75 != null ? Number(logSheetRes[0].p75) : null;
  const logSheetCount = Number(logSheetRes[0]?.count ?? 0);

  // 5. Abandonment rate in finish flow (< 8% / 0.08)
  const abandonmentRes = await db.execute<{ abandoned: string | number; completed: string | number }>(sql`
    SELECT
      count(*) FILTER (WHERE name = 'finish_flow_abandoned')::int AS abandoned,
      count(*) FILTER (WHERE name = 'finish_completed')::int AS completed
    FROM events
    WHERE name IN ('finish_flow_abandoned', 'finish_completed');
  `);
  const abandonedCount = Number(abandonmentRes[0]?.abandoned ?? 0);
  const completedCount = Number(abandonmentRes[0]?.completed ?? 0);
  const totalFinishFlow = abandonedCount + completedCount;
  const abandonmentRate = totalFinishFlow > 0 ? abandonedCount / totalFinishFlow : 0;

  return {
    progress_updated: {
      p75_duration_ms: progressP75,
      budget_ms: 5000,
      sample_count: progressCount,
      passing: progressP75 === null || progressP75 < 5000,
    },
    book_logged: {
      p75_tap_count: bookLoggedP75,
      budget_taps: 2,
      sample_count: bookLoggedCount,
      passing: bookLoggedP75 === null || bookLoggedP75 <= 2,
    },
    finish_completed: {
      p75_duration_seconds: finishP75,
      budget_seconds: 20,
      sample_count: finishCount,
      passing: finishP75 === null || finishP75 < 20,
    },
    log_sheet_completed: {
      p75_duration_ms: logSheetP75,
      budget_ms: 15000,
      sample_count: logSheetCount,
      passing: logSheetP75 === null || logSheetP75 < 15000,
    },
    finish_flow_abandoned: {
      abandonment_rate: Math.round(abandonmentRate * 10000) / 10000,
      abandoned_count: abandonedCount,
      completed_count: completedCount,
      budget_max_rate: 0.08,
      passing: abandonmentRate < 0.08,
    },
  };
}

/**
 * Fastify routes plugin for telemetry ingestion and budget metrics.
 */
export function telemetryRoutes(db: Db) {
  return async function (fastify: FastifyInstance) {
    // POST /v1/events - Ingest single or batch telemetry events
    fastify.post(
      '/events',
      {
        schema: {
          tags: ['Telemetry'],
          summary: 'Ingest client telemetry events (SL-80)',
          description:
            'Accepts a batch of up to 100 client events. User ID is attached automatically if authenticated.',
          body: postEventsBatchBodySchema,
          response: {
            202: postEventsResponseSchema,
            400: errorResponseSchema,
          },
        },
      },
      async (req: FastifyRequest, reply: FastifyReply) => {
        const parsed = postEventsBatchZod.safeParse(req.body);
        if (!parsed.success) {
          return reply.status(400).send({
            error: {
              code: 'invalid_events_payload',
              message: parsed.error.issues[0]?.message || 'Invalid events batch',
            },
          });
        }

        // Extract optional authenticated user
        let authenticatedUserId: string | null = null;
        const authHeader = req.headers.authorization;
        if (authHeader?.startsWith('Bearer ')) {
          try {
            const token = authHeader.slice(7);
            const verified = await verifyAccessToken(token);
            if (verified) {
              authenticatedUserId = verified.sub;
            }
          } catch {
            // Unauthenticated/anonymous telemetry allowed
          }
        }

        const accepted = await recordEvents(db, parsed.data.events, authenticatedUserId);
        return reply.status(202).send({ accepted });
      },
    );

    // GET /v1/admin/telemetry/budgets - Query PRD §4.4 interaction budget metrics
    fastify.get(
      '/admin/telemetry/budgets',
      {
        schema: {
          tags: ['Admin', 'Telemetry'],
          summary: 'PRD §4.4 Interaction Budgets p75 Performance (SL-81)',
          description:
            'Returns p75 durations, tap counts, and abandonment rates evaluated against non-negotiable budgets.',
          response: {
            200: budgetMetricsResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (req: FastifyRequest, reply: FastifyReply) => {
        // Enforce moderator or admin authentication
        requireModerator(req);
        const metrics = await getBudgetMetrics(db);
        return reply.status(200).send(metrics);
      },
    );
  };
}
