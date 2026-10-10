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
  budgetQuerySchema,
  errorResponseSchema,
} from '../contract/schemas.js';

export interface TelemetryEventInput {
  name: string;
  session_id?: string | null;
  platform?: string | null;
  app_version?: string | null;
  properties?: Record<string, unknown>;
  at?: string | null;
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
 * The names this endpoint stores: PRD §28.2's taxonomy, the §4.4 budget
 * events, and the shelf events the app already sends. Anything else is
 * dropped: the endpoint is anonymous, so an open name set is an open table
 * (audit 10).
 */
export const EVENT_NAMES: ReadonlySet<string> = new Set([
  // Acquisition
  'app_installed', 'app_opened', 'welcome_viewed', 'welcome_skipped', 'signup_started', 'account_created',
  'signup_failed', 'login_succeeded', 'login_failed', 'deep_link_opened',
  // Activation
  'username_set', 'avatar_set', 'import_started', 'import_completed', 'genres_selected', 'favourites_set',
  'follow_suggestions_shown', 'onboarding_completed', 'first_book_logged', 'first_rating_created',
  'first_review_created',
  // Reading
  'book_added', 'book_started', 'progress_updated', 'book_finished', 'book_hearted', 'book_unhearted',
  'book_dnf', 'book_paused', 'book_resumed', 'reread_started', 'goal_set', 'goal_reached',
  // Engagement (and the per-screen events of PRD §6)
  'feed_viewed', 'feed_card_impression', 'feed_card_tapped', 'book_viewed', 'review_viewed', 'read_liked',
  'review_shared', 'comment_created', 'quote_saved', 'quote_shared', 'search_performed', 'search_zero_results',
  'discover_row_impression', 'discover_book_tapped', 'stats_viewed', 'stat_card_shared', 'session_ended',
  'diary_viewed', 'diary_filtered', 'diary_year_changed', 'diary_shared', 'wall_viewed', 'wall_filtered',
  'wall_shared', 'profile_edited', 'favourites_changed',
  // Social
  'user_followed', 'user_unfollowed', 'profile_viewed', 'shelf_created', 'shelf_saved', 'shelf_shared',
  'content_reported', 'user_blocked', 'user_muted',
  // Growth
  'share_card_generated', 'share_completed', 'profile_shared', 'yir_viewed', 'yir_card_shared',
  'invite_sent', 'invite_accepted',
  // Reliability
  'api_error', 'offline_queue_flushed', 'app_crashed', 'screen_load_slow',
  // §4.4 budgets (SL-81)
  'book_logged', 'finish_completed', 'log_sheet_completed', 'finish_flow_abandoned',
  // Shelves (SH-xx), already emitted by the app
  'shelves_viewed', 'shelf_viewed', 'shelf_unsaved', 'shelf_reordered', 'shelf_edited', 'shelf_deleted',
]);

/** Flat properties only: at most 20 keys of 64 characters, scalar values, strings of 200. */
const MAX_PROPERTY_KEYS = 20;
const MAX_KEY_LENGTH = 64;
const MAX_STRING_LENGTH = 200;
/** The client keeps unsent events in memory only (lib/events.ts), so a week is generous. */
const MAX_EVENT_AGE_MS = 7 * 86_400_000;
/** Phone clocks drift; minutes, not hours. */
const MAX_EVENT_SKEW_MS = 5 * 60_000;

/**
 * The measurement each §4.4 budget event must carry, with a sane range. An
 * event without it cannot count toward its budget, so it is refused rather
 * than stored as noise the report has to step around.
 */
const BUDGET_FIELDS: Record<string, { field: string; max: number; integer?: boolean }> = {
  progress_updated: { field: 'duration_ms', max: 3_600_000 },
  book_logged: { field: 'tap_count', max: 50, integer: true },
  finish_completed: { field: 'duration_seconds', max: 3_600 },
  log_sheet_completed: { field: 'duration_ms', max: 3_600_000 },
};

/** Why an event is refused, or null if it is stored. */
export function eventProblem(e: TelemetryEventInput, now = Date.now()): string | null {
  if (!EVENT_NAMES.has(e.name)) return 'unknown_name';
  const props = e.properties ?? {};
  const entries = Object.entries(props);
  if (entries.length > MAX_PROPERTY_KEYS) return 'too_many_properties';
  for (const [k, v] of entries) {
    if (k.length > MAX_KEY_LENGTH) return 'property_name_too_long';
    if (v === null || typeof v === 'boolean') continue;
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return 'property_not_finite';
      continue;
    }
    if (typeof v === 'string') {
      if (v.length > MAX_STRING_LENGTH) return 'property_too_long';
      continue;
    }
    return 'property_not_scalar';
  }
  if (e.at) {
    const at = Date.parse(e.at);
    if (at < now - MAX_EVENT_AGE_MS || at > now + MAX_EVENT_SKEW_MS) return 'timestamp_out_of_range';
  }
  const budget = BUDGET_FIELDS[e.name];
  if (budget) {
    const v = props[budget.field];
    if (typeof v !== 'number' || v < 0 || v > budget.max || (budget.integer && !Number.isInteger(v))) {
      return 'budget_measurement_invalid';
    }
  }
  return null;
}

/**
 * Stores the events that pass eventProblem(). `userId` is the verified
 * token's subject, or null: never anything from the body.
 */
export async function recordEvents(
  db: Db,
  eventsList: TelemetryEventInput[],
  userId: string | null = null,
): Promise<{ accepted: number; rejected: number }> {
  const now = Date.now();
  const rows = eventsList
    .filter((item) => eventProblem(item, now) === null)
    .map((item) => ({
      name: item.name,
      userId,
      sessionId: item.session_id || null,
      platform: item.platform || null,
      appVersion: item.app_version || null,
      properties: item.properties || {},
      at: item.at ? new Date(item.at) : new Date(now),
    }));

  if (rows.length > 0) await db.insert(events).values(rows);
  return { accepted: rows.length, rejected: eventsList.length - rows.length };
}

type Budget<K extends string> = { [P in K]: number | null } & {
  sample_count: number;
  /** null: no samples in the window, so the budget is unknown, not met. */
  passing: boolean | null;
};

export interface BudgetMetrics {
  window_days: number;
  progress_updated: Budget<'p75_duration_ms'> & { budget_ms: number };
  book_logged: Budget<'p75_tap_count'> & { budget_taps: number };
  finish_completed: Budget<'p75_duration_seconds'> & { budget_seconds: number };
  log_sheet_completed: Budget<'p75_duration_ms'> & { budget_ms: number };
  finish_flow_abandoned: {
    abandonment_rate: number | null;
    abandoned_count: number;
    completed_count: number;
    budget_max_rate: number;
    passing: boolean | null;
  };
}

/** Default report window: the §44 metrics are reviewed monthly, and a week is noisy at launch volume. */
export const BUDGET_WINDOW_DAYS = 28;

/**
 * PRD §4.4 budgets over the last `days`, p75 by percentile_cont(0.75).
 *
 * Each budget reads only rows whose measurement is a JSON number. Ingestion
 * refuses anything else now, but a row written before the caps (or by hand)
 * must not turn the report into a cast error: audit 10 found that one
 * anonymous event with "abc" made it answer 422 until the row was deleted.
 * It used to read every event ever stored; events_name_at_idx serves each
 * (name, at >= window) scan.
 */
export async function getBudgetMetrics(db: Db, days = BUDGET_WINDOW_DAYS): Promise<BudgetMetrics> {
  const since = sql`now() - make_interval(days => ${days})`;
  const p75 = async (name: string, field: string) => {
    const [row] = await db.execute<{ p75: string | number | null; count: string | number }>(sql`
      SELECT percentile_cont(0.75) WITHIN GROUP (ORDER BY (properties->>${field})::numeric) AS p75,
             count(*)::int AS count
        FROM events
       WHERE name = ${name} AND at >= ${since}
         AND jsonb_typeof(properties->${field}) = 'number'
    `);
    return { p75: row?.p75 != null ? Number(row.p75) : null, count: Number(row?.count ?? 0) };
  };

  const [progress, logged, finish, sheet, [flow]] = await Promise.all([
    p75('progress_updated', 'duration_ms'),
    p75('book_logged', 'tap_count'),
    p75('finish_completed', 'duration_seconds'),
    p75('log_sheet_completed', 'duration_ms'),
    db.execute<{ abandoned: string | number; completed: string | number }>(sql`
      SELECT count(*) FILTER (WHERE name = 'finish_flow_abandoned')::int AS abandoned,
             count(*) FILTER (WHERE name = 'finish_completed')::int AS completed
        FROM events
       WHERE name IN ('finish_flow_abandoned', 'finish_completed') AND at >= ${since}
    `),
  ]);
  const abandoned = Number(flow?.abandoned ?? 0);
  const completed = Number(flow?.completed ?? 0);
  const rate = abandoned + completed > 0 ? abandoned / (abandoned + completed) : null;
  const judge = (v: number | null, ok: (x: number) => boolean) => (v === null ? null : ok(v));

  return {
    window_days: days,
    progress_updated: {
      p75_duration_ms: progress.p75,
      budget_ms: 5000,
      sample_count: progress.count,
      passing: judge(progress.p75, (x) => x < 5000),
    },
    book_logged: {
      p75_tap_count: logged.p75,
      budget_taps: 2,
      sample_count: logged.count,
      passing: judge(logged.p75, (x) => x <= 2),
    },
    finish_completed: {
      p75_duration_seconds: finish.p75,
      budget_seconds: 20,
      sample_count: finish.count,
      passing: judge(finish.p75, (x) => x < 20),
    },
    log_sheet_completed: {
      p75_duration_ms: sheet.p75,
      budget_ms: 15000,
      sample_count: sheet.count,
      passing: judge(sheet.p75, (x) => x < 15000),
    },
    finish_flow_abandoned: {
      abandonment_rate: rate === null ? null : Math.round(rate * 10000) / 10000,
      abandoned_count: abandoned,
      completed_count: completed,
      budget_max_rate: 0.08,
      passing: judge(rate, (x) => x < 0.08),
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
            'Accepts a batch of up to 100 client events. User ID is attached automatically if authenticated, never taken from the body. ' +
            'Stores only events that pass the caps: a name from the PRD §28.2 taxonomy, at most 20 flat properties (scalars, strings up to 200), ' +
            'a timestamp within the last 7 days, and for §4.4 budget events their measurement as a number in range. The rest are counted in `rejected`.',
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

        const result = await recordEvents(db, parsed.data.events, authenticatedUserId);
        return reply.status(202).send(result);
      },
    );

    // GET /v1/admin/telemetry/budgets - Query PRD §4.4 interaction budget metrics
    fastify.get<{ Querystring: { days?: number } }>(
      '/admin/telemetry/budgets',
      {
        schema: {
          tags: ['Admin', 'Telemetry'],
          summary: 'PRD §4.4 Interaction Budgets p75 Performance (SL-81)',
          description:
            'p75 durations, tap counts and the abandonment rate over the last `days` (default 28), against the §4.4 budgets. ' +
            '`passing` is null when the window has no samples.',
          querystring: budgetQuerySchema,
          response: {
            200: budgetMetricsResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        // Enforce moderator or admin authentication
        requireModerator(req);
        const metrics = await getBudgetMetrics(db, req.query.days ?? BUDGET_WINDOW_DAYS);
        return reply.status(200).send(metrics);
      },
    );
  };
}
