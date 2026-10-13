// Milestone moments (ST-10; PRD §18.2, §18.4, §19.2 item 12, §8.6).
//
//   1st book            full-screen celebration, share prompt
//   10th book           a subtle in-app moment
//   100th, 500th, 1,000th  full celebration with a share card
//   1st review          celebration and encouragement
//   1st follower        a notification with warmth
//   annual goal reached celebration and share card (§8.6: the one moment)
//   longest book yet    an inline note on the finish screen (not stored)
//
// "Each fires once, in-app, and never becomes a push notification" (§18.4):
//   - once: `milestones` has one row per (user, key); a key is never written twice;
//   - in-app: a moment the app shows from GET /me/milestones, and a row in
//     the notification list under the `milestones` category (§19.2 item 12,
//     in-app only: the category has no push channel, so nothing is queued);
//   - no feed card: nothing here writes activity (owner decision on Phase 5 A,
//     item 4: the `goal_reached` verb stays unused).
//
// A milestone is celebrated only by the in-app action that reaches it: the
// finish that is the 10th book, the review that is the first. One passed some
// other way (an import of 300 books, a goal lowered below what is already
// read) is stored as already seen, silently, so it never fires later.
//
// Counts are the owner's own record, private reads included, like their own
// stats (§17.5): books are finished reads (each attempt, as books_count).

import type { FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { requireViewer, ApiError } from '../http.js';
import { errorResponseSchema } from '../contract/schemas.js';
import { Notifier, loadPreferences } from '../notify/index.js';

export const BOOK_MILESTONES = [1, 10, 100, 500, 1000] as const;

/** How the app marks each one (§18.4). */
export type Treatment = 'full' | 'subtle' | 'note';
export function treatmentOf(key: string): Treatment {
  if (key === 'books_10') return 'subtle';
  if (key === 'first_follower') return 'note';
  return 'full';
}

export interface Milestone {
  key: string;
  treatment: Treatment;
  achieved_at: string;
  data: Record<string, unknown>;
}

export class Milestones {
  // Milestones never push (no push channel), so no queue is needed.
  constructor(private readonly notifier: Notifier = new Notifier()) {}

  /** Writes a key once. Returns true when this call wrote it and it is to be celebrated. */
  async #reach(t: Db, userId: string, key: string, celebrate: boolean, data: Record<string, unknown>, actorId: string | null = null): Promise<boolean> {
    const [row] = await t.execute<{ key: string }>(sql`
      INSERT INTO milestones (user_id, key, seen_at, data)
      VALUES (${userId}::uuid, ${key}, ${celebrate ? null : sql`now()`}, ${JSON.stringify(data)}::jsonb)
      ON CONFLICT (user_id, key) DO NOTHING
      RETURNING key`);
    if (!row || !celebrate) return false;
    await this.notifier.milestone(t, userId, key, data, actorId);
    return true;
  }

  /**
   * After a read became finished in the app (ReadingService, in its
   * transaction; imports never come here). Book counts and the goal of the
   * finish's year.
   */
  async afterFinish(t: Db, userId: string, read: { id: string; work_id: string; finished_at: string | null }): Promise<void> {
    const [c] = await t.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM reads WHERE user_id = ${userId}::uuid AND status = 'finished'`);
    const n = Number(c?.n ?? 0);
    for (const at of BOOK_MILESTONES) {
      if (n < at) break;
      await this.#reach(t, userId, `books_${at}`, n === at, { count: at, read_id: read.id, work_id: read.work_id });
    }
    if (!read.finished_at) return;
    const year = Number(read.finished_at.slice(0, 4));
    const [g] = await t.execute<{ target_books: number; n: number }>(sql`
      SELECT g.target_books,
             (SELECT count(*)::int FROM reads r WHERE r.user_id = g.user_id AND r.status = 'finished'
                AND r.finished_at >= make_date(g.year, 1, 1) AND r.finished_at < make_date(g.year + 1, 1, 1)) AS n
        FROM goals g WHERE g.user_id = ${userId}::uuid AND g.year = ${year}`);
    if (!g || Number(g.n) < Number(g.target_books)) return;
    await this.#reach(t, userId, `goal_${year}`, Number(g.n) === Number(g.target_books), {
      year, target_books: Number(g.target_books), read_id: read.id, work_id: read.work_id,
    });
  }

  /** After a new review was written in the app: the first one ever is celebrated. */
  async afterReview(t: Db, userId: string, reviewId: string, workId: string): Promise<void> {
    const [c] = await t.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM reviews WHERE user_id = ${userId}::uuid`);
    await this.#reach(t, userId, 'first_review', Number(c?.n ?? 0) === 1, { review_id: reviewId, work_id: workId });
  }

  /**
   * After a follow took effect (a follow of a public account, or a request
   * accepted). The followee's first follower ever is a warm note in their
   * list, naming the follower; no full-screen moment. An accepted request is
   * the recipient's own act (SO-30: no "new follower" for it either), so it
   * is recorded without the note (`notify: false`).
   */
  async afterFollow(t: Db, followeeId: string, followerId: string, opts: { notify?: boolean } = {}): Promise<void> {
    const [c] = await t.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM follows WHERE followee_id = ${followeeId}::uuid AND state = 'accepted'`);
    const first = Number(c?.n ?? 0) === 1;
    const [row] = await t.execute<{ key: string }>(sql`
      INSERT INTO milestones (user_id, key, seen_at, data)
      VALUES (${followeeId}::uuid, 'first_follower', now(), ${JSON.stringify({ follower_id: followerId })}::jsonb)
      ON CONFLICT (user_id, key) DO NOTHING
      RETURNING key`);
    if (row && first && opts.notify !== false) await this.notifier.milestone(t, followeeId, 'first_follower', { follower_id: followerId }, followerId);
  }

  /**
   * Moments the app has not shown yet, oldest first. None while the reader has
   * the `milestones` category switched off (§19.4: every category can be
   * turned off); they stay recorded and are never shown late.
   */
  async unseen(db: Db, userId: string): Promise<Milestone[]> {
    const prefs = await loadPreferences(db, userId);
    if (prefs.categories.milestones.in_app !== true) return [];
    const rows = await db.execute<{ key: string; achieved_at: string | Date; data: unknown }>(sql`
      SELECT key, achieved_at, data FROM milestones
       WHERE user_id = ${userId}::uuid AND seen_at IS NULL ORDER BY achieved_at, key`);
    return rows.map((r) => ({
      key: r.key,
      treatment: treatmentOf(r.key),
      achieved_at: new Date(r.achieved_at).toISOString(),
      data: (typeof r.data === 'string' ? JSON.parse(r.data) : r.data ?? {}) as Record<string, unknown>,
    }));
  }

  async markSeen(db: Db, userId: string, keys: string[]): Promise<void> {
    if (keys.length === 0) return;
    await db.execute(sql`
      UPDATE milestones SET seen_at = now()
       WHERE user_id = ${userId}::uuid AND seen_at IS NULL
         AND key IN (${sql.join(keys.map((k) => sql`${k}`), sql`, `)})`);
  }

  /**
   * §18.4 "Longest book yet": the read's page count is above every other
   * finished book's of this reader (and there is at least one other with a
   * page count). An inline note, not stored, so it can come again with the
   * next record. Someone else's read, or one not finished, is false.
   */
  async longestYet(db: Db, userId: string, readId: string): Promise<{ longest_yet: boolean; page_count: number | null }> {
    const [r] = await db.execute<{ pages: number | null; prev: number | null }>(sql`
      SELECT flyleaf_page_count(r.edition_id, r.work_id) AS pages,
             (SELECT max(flyleaf_page_count(o.edition_id, o.work_id)) FROM reads o
               WHERE o.user_id = r.user_id AND o.status = 'finished' AND o.id <> r.id AND o.work_id <> r.work_id) AS prev
        FROM reads r WHERE r.id = ${readId}::uuid AND r.user_id = ${userId}::uuid AND r.status = 'finished'`);
    if (!r || r.pages === null) return { longest_yet: false, page_count: r?.pages ?? null };
    return { longest_yet: r.prev !== null && Number(r.pages) > Number(r.prev), page_count: Number(r.pages) };
  }
}

// ---------------------------------------------------------------------------
// Routes: what the app reads to show a moment, and tells us it showed.
// ---------------------------------------------------------------------------

const milestoneSchema = {
  type: 'object',
  properties: {
    key: { type: 'string', description: 'books_1 | books_10 | books_100 | books_500 | books_1000 | first_review | first_follower | goal_YYYY' },
    treatment: { type: 'string', enum: ['full', 'subtle', 'note'], description: 'PRD §18.4: full-screen, a subtle moment, or the list only.' },
    achieved_at: { type: 'string', format: 'date-time' },
    data: { type: 'object', additionalProperties: true },
  },
  required: ['key', 'treatment', 'achieved_at', 'data'],
} as const;

const KEY = /^(books_(1|10|100|500|1000)|first_review|first_follower|goal_\d{4})$/;

export function milestoneRoutes(db: Db) {
  return async (app: FastifyInstance) => {
    const service = new Milestones();
    const tags = ['Reading'];

    app.get<{ Querystring: { read_id?: string } }>('/me/milestones', {
      schema: {
        tags, summary: 'Milestone moments to show',
        description: 'ST-10, PRD §18.4: milestones reached in the app that have not been shown, oldest first (none while the milestones category is off). With read_id (one of your finished reads): whether it is your longest book yet, for the finish screen\'s inline note. In-app only: milestones are never pushed and never in the feed.',
        security: [{ BearerAuth: [] }],
        querystring: { type: 'object', properties: { read_id: { type: 'string', format: 'uuid' } } },
        response: {
          200: {
            type: 'object',
            properties: {
              milestones: { type: 'array', items: milestoneSchema },
              longest_yet: { type: ['boolean', 'null'], description: 'null without read_id.' },
            },
            required: ['milestones', 'longest_yet'],
          },
          401: errorResponseSchema,
          422: errorResponseSchema,
        },
      },
    }, async (req) => {
      const viewer = requireViewer(req);
      const [milestones, longest] = await Promise.all([
        service.unseen(db, viewer),
        req.query.read_id ? service.longestYet(db, viewer, req.query.read_id) : Promise.resolve(null),
      ]);
      return { milestones, longest_yet: longest ? longest.longest_yet : null };
    });

    app.post<{ Body: { keys?: unknown } }>('/me/milestones/seen', {
      schema: {
        tags, summary: 'Mark milestone moments shown',
        description: 'The app showed these moments: they are not shown again. Unknown or already-seen keys change nothing.',
        security: [{ BearerAuth: [] }],
        body: {
          type: 'object',
          properties: { keys: { type: 'array', items: { type: 'string', maxLength: 32 }, maxItems: 20 } },
          required: ['keys'],
        },
        response: { 204: { type: 'null' }, 401: errorResponseSchema, 422: errorResponseSchema },
      },
    }, async (req, reply) => {
      const viewer = requireViewer(req);
      const keys = req.body?.keys;
      if (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string' || !KEY.test(k))) {
        throw ApiError.unprocessable('invalid_milestone', 'keys is a list of milestone keys.', 'keys');
      }
      await service.markSeen(db, viewer, keys as string[]);
      return reply.code(204).send();
    });
  };
}
