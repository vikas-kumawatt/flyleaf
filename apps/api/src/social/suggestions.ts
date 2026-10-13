// Onboarding follow suggestions (SO-52; PRD §6.11, §4.1 "Follow suggestions:
// 12–15 users matched on genre and favourite overlap", §11.6 P0 row).
//
// Ranking, in PRD §6.11's order: genre overlap → favourite-book overlap →
// active reviewers → (seeded editorial accounts: none exist yet, see
// tasks.md SO-52) → most-followed, as the fallback that keeps the list from
// being empty for a reader who skipped everything (§4.1 anti-pattern note).
//
// Who is never suggested, whatever their score:
//   - the viewer, anyone they already follow or asked to follow;
//   - anyone in a block with the viewer, either way (§11.4: the block must
//     never be confirmable, so a blocked account is simply absent);
//   - anyone the viewer muted (§11.5; muting is silent, so nothing about the
//     mute is visible to the muted account either);
//   - private accounts (§26.1: a suggestion would show a header and invite a
//     request the reader cannot see behind, and "Follow all" must follow, not
//     request), deleted and banned accounts (a ban is a soft delete),
//     unverified accounts (their reviews are hidden, D-05-3) and accounts
//     under a posting suspension (§27.3).
// Overlap is computed from PUBLIC reads and public favourites only: a
// private or followers-only read must never be the reason someone is shown.
//
// Cost: the candidates are a bounded pool (co-readers of the viewer's books,
// recent reviewers, most-followed public accounts), not every account; each
// is scored with index probes on its own reads. The reviewer and most-followed
// parts are the same for every viewer and need a scan of recent reviews and
// of profiles, so they are computed once and cached for POOL_TTL_SECONDS
// (every exclusion is still applied per viewer, on live rows).

import { sql } from 'drizzle-orm';
import type { Cache, Db } from '../platform/index.js';
import { avatarUrl } from '../uploads/index.js';

export const SUGGESTION_DEFAULT = 15;
export const SUGGESTION_MAX = 30;
/** The viewer's top genres that count for overlap. */
const MY_GENRES = 10;
/** Pool sizes: co-readers, recent reviewers, most followed. */
const POOL_CO_READERS = 1000;
const POOL_REVIEWERS = 200;
const POOL_POPULAR = 100;
/** "Active reviewers": live public reviews in this many days. */
export const ACTIVE_REVIEWER_DAYS = 90;
/** How long the viewer-independent part of the pool is reused. */
const POOL_TTL_SECONDS = 600;
const POOL_KEY = 'follow-suggestions:pool';

export type SuggestionReason = 'favourites' | 'genres' | 'reviewer' | 'popular';

export interface FollowSuggestion {
  id: string;
  username: string;
  display_name: string | null;
  avatar_url: string | null;
  follower_count: number;
  /** Up to four of their favourites (never an explicit book), for the card's covers. */
  favourites: { id: string; title: string; cover_id: number | null }[];
  reason: SuggestionReason;
}

type Row = Record<string, unknown>;

export class FollowSuggestions {
  constructor(private readonly db: Db, private readonly cache?: Cache) {}

  /** Recent reviewers and most-followed public accounts: the same for every viewer. */
  async #sharedPool(): Promise<string[]> {
    const cached = await this.cache?.get<string[]>(POOL_KEY);
    if (cached) return cached;
    const rows = await this.db.execute<{ user_id: string }>(sql`
      (SELECT rv.user_id FROM reviews rv
        WHERE rv.deleted_at IS NULL AND rv.visibility = 'public'
          AND rv.published_at > now() - make_interval(days => ${ACTIVE_REVIEWER_DAYS})
        GROUP BY rv.user_id ORDER BY count(*) DESC, rv.user_id LIMIT ${POOL_REVIEWERS})
      UNION
      (SELECT p.user_id FROM profiles p WHERE NOT p.is_private
        ORDER BY p.follower_count DESC, p.user_id LIMIT ${POOL_POPULAR})`);
    const ids = rows.map((r) => r.user_id);
    await this.cache?.set(POOL_KEY, ids, POOL_TTL_SECONDS);
    return ids;
  }

  async forViewer(viewer: string, limit = SUGGESTION_DEFAULT): Promise<FollowSuggestion[]> {
    const n = Math.min(Math.max(Math.trunc(limit) || SUGGESTION_DEFAULT, 1), SUGGESTION_MAX);
    const shared = await this.#sharedPool();
    const sharedIds = shared.length ? sql.join(shared.map((id) => sql`${id}::uuid`), sql`, `) : sql`NULL::uuid`;
    const rows = await this.db.execute<Row>(sql`
      WITH my_favs AS (
        SELECT unnest(favourite_work_ids) AS work_id FROM profiles WHERE user_id = ${viewer}::uuid
      ),
      my_works AS (
        SELECT work_id FROM reads WHERE user_id = ${viewer}::uuid
        UNION SELECT work_id FROM my_favs
      ),
      my_genres AS (
        SELECT ws.subject_id FROM my_works mw
        JOIN work_subjects ws ON ws.work_id = mw.work_id
        JOIN subjects s ON s.id = ws.subject_id AND s.kind = 'genre'
        GROUP BY ws.subject_id ORDER BY count(*) DESC, ws.subject_id LIMIT ${MY_GENRES}
      ),
      pool AS (
        (SELECT r.user_id FROM reads r
          WHERE r.work_id IN (SELECT work_id FROM my_works) AND r.visibility = 'public' AND r.user_id <> ${viewer}::uuid
          LIMIT ${POOL_CO_READERS})
        UNION
        SELECT unnest(ARRAY[${sharedIds}]::uuid[])
      ),
      eligible AS (
        SELECT u.id, p.username, p.display_name, p.avatar_key, p.follower_count, p.favourite_work_ids
        FROM pool
        JOIN users u ON u.id = pool.user_id
        JOIN profiles p ON p.user_id = u.id
        WHERE u.id <> ${viewer}::uuid
          AND u.deleted_at IS NULL
          AND u.email_verified_at IS NOT NULL
          AND (u.suspended_until IS NULL OR u.suspended_until <= now())
          AND NOT p.is_private
          AND NOT EXISTS (SELECT 1 FROM follows f WHERE f.follower_id = ${viewer}::uuid AND f.followee_id = u.id)
          AND NOT EXISTS (
            SELECT 1 FROM blocks b
            WHERE (b.blocker_id = ${viewer}::uuid AND b.blocked_id = u.id)
               OR (b.blocker_id = u.id AND b.blocked_id = ${viewer}::uuid))
          AND NOT EXISTS (
            SELECT 1 FROM mutes m WHERE m.user_id = ${viewer}::uuid AND m.target_type = 'user' AND m.target_id = u.id)
      ),
      scored AS (
        SELECT e.*,
          (SELECT count(DISTINCT ws.subject_id) FROM reads r
            JOIN work_subjects ws ON ws.work_id = r.work_id
            WHERE r.user_id = e.id AND r.visibility = 'public'
              AND ws.subject_id IN (SELECT subject_id FROM my_genres))::int AS genre_overlap,
          (SELECT count(*) FROM my_favs mf
            WHERE mf.work_id = ANY (e.favourite_work_ids)
               OR EXISTS (SELECT 1 FROM reads r
                 WHERE r.user_id = e.id AND r.work_id = mf.work_id AND r.visibility = 'public'))::int AS favourite_overlap,
          (SELECT count(*) FROM reviews rv JOIN reads r ON r.id = rv.read_id
            WHERE rv.user_id = e.id AND rv.deleted_at IS NULL
              AND rv.visibility = 'public' AND r.visibility = 'public'
              AND rv.published_at > now() - make_interval(days => ${ACTIVE_REVIEWER_DAYS}))::int AS recent_reviews
        FROM eligible e
      )
      SELECT * FROM scored
      ORDER BY genre_overlap DESC, favourite_overlap DESC, recent_reviews DESC, follower_count DESC, id
      LIMIT ${n}`);
    if (rows.length === 0) return [];

    // Their favourites for the cards' covers: one query for every card.
    const favIds = [...new Set(rows.flatMap((r) => uuidArray(r.favourite_work_ids).slice(0, 4)))];
    const works = favIds.length === 0
      ? []
      : await this.db.execute<{ id: string; title: string; cover_id: number | null }>(sql`
          SELECT id, title, ol_cover_id AS cover_id FROM works
          WHERE id IN (${sql.join(favIds.map((id) => sql`${id}::uuid`), sql`, `)})
            AND merged_into_id IS NULL AND maturity <> 'explicit'`);
    const byId = new Map(works.map((w) => [w.id, w]));

    return rows.map((r) => {
      const genre = Number(r.genre_overlap);
      const fav = Number(r.favourite_overlap);
      const reviews = Number(r.recent_reviews);
      return {
        id: String(r.id),
        username: String(r.username),
        display_name: (r.display_name as string | null) ?? null,
        avatar_url: avatarUrl(r.avatar_key as string | null),
        follower_count: Number(r.follower_count),
        favourites: uuidArray(r.favourite_work_ids).slice(0, 4).flatMap((id) => {
          const w = byId.get(id);
          return w ? [{ id: w.id, title: w.title, cover_id: w.cover_id ?? null }] : [];
        }),
        reason: fav > 0 ? 'favourites' : genre > 0 ? 'genres' : reviews > 0 ? 'reviewer' : 'popular',
      };
    });
  }
}

function uuidArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean);
}
