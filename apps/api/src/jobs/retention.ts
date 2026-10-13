// Retention (Audit 15, §4): every soft delete and every log has an end.
//
// One daily job, `retention.sweep`, runs each step below in batches (each its
// own short statement under the worker's work_mem and statement_timeout), and
// one weekly job writes the zero-result summary (D-10-3). The numbers come
// from PRD §23.5 unless a step says otherwise; DECISIONS.md records the
// choices the PRD left open (D-15-5 … D-15-7).

import { createHmac, randomBytes } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import type { ObjectStorage } from '../providers/storage/index.js';
import { CARD_COVER_RETENTION_DAYS, coverKey } from '../cards/images.js';

/** PRD §23.5 "Deleted reviews: soft-deleted 30 days, then purged"; shelves §15.6; accounts §23.5. */
export const SOFT_DELETE_DAYS = 30;
/** D-10-1: raw events are kept 13 months. */
export const EVENT_RETENTION_MONTHS = 13;
/** D-10-1 corrected (PRD §23.5 "Search query logs: 30 days"): a flat 30 days. */
export const ZERO_RESULT_RETENTION_DAYS = 30;
/** D-10-3: a query's text is kept in the weekly summary only with this many distinct searchers. */
export const SUMMARY_MIN_SEARCHERS = 5;
/**
 * Owner decision on SO-3x (12 Oct 2026): notifications are kept 180 days, like
 * activity (PRD §23.5 names no number for them). Counted from `updated_at`, so
 * a like group still gaining likes is not cut off from its own first like.
 */
export const NOTIFICATION_RETENTION_DAYS = 180;
/** Columns of an import file line kept after its row is committed (D-15-5). */
const IMPORT_ROW_KEEP = '(title|author|isbn)';

const BATCH = 5_000;

export interface RetentionResult {
  rateLimits: number;
  /** The rolling store's events past the longest rolling window (0043). */
  rateLimitEvents: number;
  /** Notifications past NOTIFICATION_RETENTION_DAYS (actors cascade). */
  notifications: number;
  events: number;
  zeroResults: number;
  shelves: number;
  reviews: number;
  comments: number;
  accounts: number;
  accountObjects: number;
  orphanMutes: number;
  importRowsTrimmed: number;
  avatarObjects: number;
  /** Share-card cover copies unused for 180 days (owner decision on Phase 5 B). */
  cardCovers: number;
  workedAt: string;
}

/** Deletes `select`'s ids from `table` in batches; returns how many. */
async function deleteInBatches(db: Db, run: (limit: number) => Promise<number>, batch = BATCH): Promise<number> {
  let total = 0;
  for (let i = 0; i < 10_000; i++) {
    const n = await run(batch);
    total += n;
    if (n < batch) break;
  }
  return total;
}

/**
 * Hard-deletes accounts soft-deleted more than 30 days ago (PRD §23.5 "30-day
 * grace, then hard-deleted"). Their stored objects go first: the rows that
 * name them (uploads, imports, exports, the avatar) cascade with the user,
 * the objects do not (A-PV-008). A failed object delete keeps the account for
 * the next run, so nothing is left behind unnamed. Everything else cascades
 * (reads, reviews, shelves, follows, likes, comments, claims); `events`
 * keeps its rows with user_id set to NULL (13 months, then pruned).
 */
async function hardDeleteAccounts(db: Db, storage: ObjectStorage | null): Promise<{ accounts: number; objects: number }> {
  const due = await db.execute<{ id: string }>(sql`
    SELECT id FROM users
    WHERE deleted_at IS NOT NULL AND banned_at IS NULL
      AND deleted_at < now() - make_interval(days => ${SOFT_DELETE_DAYS})
    ORDER BY deleted_at LIMIT 200`);
  let accounts = 0;
  let objects = 0;
  for (const { id } of due) {
    const keys = (await db.execute<{ key: string }>(sql`
      SELECT key FROM uploads WHERE user_id = ${id}::uuid
      UNION SELECT file_key FROM imports WHERE user_id = ${id}::uuid AND file_key IS NOT NULL
      UNION SELECT file_key FROM exports WHERE user_id = ${id}::uuid AND file_key IS NOT NULL
      UNION SELECT avatar_key FROM profiles WHERE user_id = ${id}::uuid AND avatar_key IS NOT NULL`)).map((r) => r.key);
    if (keys.length > 0) {
      if (!storage) continue; // the API process has no business deleting accounts; the worker passes storage
      try {
        for (const key of keys) await storage.delete(key);
      } catch {
        continue; // retried next run, with the rows still naming the objects
      }
      objects += keys.length;
    }
    const deleted = await db.execute(sql`DELETE FROM users WHERE id = ${id}::uuid AND deleted_at IS NOT NULL RETURNING id`);
    accounts += deleted.length;
  }
  return { accounts, objects };
}

/**
 * Avatar objects a replace or remove failed to delete (A-10-016): consumed
 * avatar uploads that are no longer their account's avatar, a day after they
 * were replaced. The object is deleted and the upload marked expired, so a
 * replay of that old upload answers 410 like any expired one.
 */
async function sweepAvatarObjects(db: Db, storage: ObjectStorage | null): Promise<number> {
  if (!storage) return 0;
  const stale = await db.execute<{ id: string; key: string }>(sql`
    SELECT u.id, u.key FROM uploads u
    LEFT JOIN profiles p ON p.user_id = u.user_id
    WHERE u.purpose = 'avatar' AND u.status = 'consumed'
      AND u.consumed_at < now() - interval '1 day'
      AND p.avatar_key IS DISTINCT FROM u.key
    LIMIT 500`);
  let n = 0;
  for (const row of stale) {
    try {
      await storage.delete(row.key);
    } catch {
      continue;
    }
    await db.execute(sql`UPDATE uploads SET status = 'expired' WHERE id = ${row.id}::uuid AND status = 'consumed'`);
    n++;
  }
  return n;
}

/**
 * Cover copies for share cards (0047) that no card has drawn for 180 days
 * (owner decision on Phase 5 B): the object, then its row. A failed object
 * delete keeps the row for the next run; a cover drawn while this runs
 * keeps its row (the delete re-checks the date) and is copied again by the
 * next card that finds the object gone.
 */
async function sweepCardCovers(db: Db, storage: ObjectStorage | null, batch: number): Promise<number> {
  if (!storage) return 0;
  let n = 0;
  for (let round = 0; round < 100; round++) {
    const stale = await db.execute<{ cover_id: number }>(sql`
      SELECT cover_id FROM card_covers
      WHERE last_used_at < now() - make_interval(days => ${CARD_COVER_RETENTION_DAYS})
      ORDER BY last_used_at LIMIT ${Math.min(batch, 1000)}`);
    let deleted = 0;
    for (const { cover_id } of stale) {
      try {
        await storage.delete(coverKey(Number(cover_id)));
      } catch {
        continue;
      }
      deleted += (await db.execute(sql`
        DELETE FROM card_covers WHERE cover_id = ${cover_id}
          AND last_used_at < now() - make_interval(days => ${CARD_COVER_RETENTION_DAYS})
        RETURNING 1`)).length;
    }
    n += deleted;
    if (stale.length < Math.min(batch, 1000) || deleted === 0) break;
  }
  return n;
}

export async function retentionSweep(db: Db, storage: ObjectStorage | null, opts: { batch?: number } = {}): Promise<RetentionResult> {
  const b = opts.batch ?? BATCH;

  // A-04-022: rate-limit buckets whose window ended. Rows from before 0038
  // have no expires_at: 31 days after their window started (longer than any).
  const rateLimits = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    DELETE FROM rate_limits WHERE bucket IN (
      SELECT bucket FROM rate_limits
      WHERE expires_at < now() OR (expires_at IS NULL AND window_start < now() - interval '31 days')
      LIMIT ${limit})
    RETURNING 1`)).length, b);

  // 0043: the rolling store needs a day of events (push:day, the longest
  // rolling window); two are kept.
  const rateLimitEvents = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    DELETE FROM rate_limit_events WHERE ctid IN (
      SELECT ctid FROM rate_limit_events WHERE at < now() - interval '2 days' LIMIT ${limit})
    RETURNING 1`)).length, b);

  // Owner decision on SO-3x: notifications after 180 days, like activity.
  // Their actors go with them (ON DELETE CASCADE); a push ticket names a
  // notification without a key and is gone within a day anyway.
  const notifications = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    DELETE FROM notifications WHERE id IN (
      SELECT id FROM notifications
      WHERE updated_at < now() - make_interval(days => ${NOTIFICATION_RETENTION_DAYS})
      LIMIT ${limit})
    RETURNING 1`)).length, b);

  // D-10-1: zero-result queries after a flat 30 days, every event after 13 months.
  const zeroResults = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    DELETE FROM events WHERE id IN (
      SELECT id FROM events
      WHERE name = 'search_zero_results' AND at < now() - make_interval(days => ${ZERO_RESULT_RETENTION_DAYS})
      LIMIT ${limit})
    RETURNING 1`)).length, b);
  const events = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    DELETE FROM events WHERE id IN (
      SELECT id FROM events WHERE at < now() - make_interval(months => ${EVENT_RETENTION_MONTHS})
      LIMIT ${limit})
    RETURNING 1`)).length, b);

  // A-11-033: shelves past their 30-day recovery. Items, saves and slug
  // claims cascade; their feed cards went when the shelf was deleted.
  const shelves = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    DELETE FROM shelves WHERE id IN (
      SELECT id FROM shelves
      WHERE deleted_at IS NOT NULL AND hidden_at IS NULL AND deleted_at < now() - make_interval(days => ${SOFT_DELETE_DAYS})
      LIMIT ${limit})
    RETURNING 1`)).length, b);

  // PRD §23.5: deleted reviews purged after 30 days (their activity went at delete time).
  // Content a moderator hid (hidden_at, 0044) is also soft-deleted but is never
  // purged here: §27.5 "hidden rather than deleted", and an appeal can restore
  // it. The same holds for comments and shelves, and a banned account (banned_at)
  // is never hard-deleted.
  const reviews = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    DELETE FROM reviews WHERE id IN (
      SELECT id FROM reviews
      WHERE deleted_at IS NOT NULL AND hidden_at IS NULL AND deleted_at < now() - make_interval(days => ${SOFT_DELETE_DAYS})
      LIMIT ${limit})
    RETURNING 1`)).length, b);

  // D-15-6: deleted comments, as reviews (no list shows them; counters count live ones).
  const comments = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    DELETE FROM read_comments WHERE id IN (
      SELECT id FROM read_comments
      WHERE deleted_at IS NOT NULL AND hidden_at IS NULL AND deleted_at < now() - make_interval(days => ${SOFT_DELETE_DAYS})
      LIMIT ${limit})
    RETURNING 1`)).length, b);

  const { accounts, objects: accountObjects } = await hardDeleteAccounts(db, storage);

  // A-13-015: a user mute has no foreign key (the target is polymorphic), so
  // a hard-deleted target leaves the row behind.
  const orphanMutes = (await db.execute(sql`
    DELETE FROM mutes m WHERE m.target_type = 'user'
      AND NOT EXISTS (SELECT 1 FROM users u WHERE u.id = m.target_id)
    RETURNING 1`)).length;

  // D-15-5: once an import's file is gone (30 days after it finished,
  // D-PV-3), a committed row keeps only what identifies the book; its review
  // text, notes, rating and dates now live on the read. Rows still to review
  // (unmatched, skipped) keep the whole line: resolving them needs it.
  const importRowsTrimmed = await deleteInBatches(db, async (limit) => (await db.execute(sql`
    UPDATE import_rows ir
    SET raw = COALESCE((
      SELECT jsonb_object_agg(k, v) FROM jsonb_each(ir.raw) AS e(k, v) WHERE k ~* ${IMPORT_ROW_KEEP}), '{}'::jsonb)
    WHERE (ir.import_id, ir.row_no) IN (
      SELECT r.import_id, r.row_no
      FROM import_rows r JOIN imports i ON i.id = r.import_id
      WHERE i.state IN ('completed', 'failed')
        AND i.finished_at < now() - make_interval(days => ${SOFT_DELETE_DAYS})
        AND r.state IN ('matched', 'resolved')
        AND EXISTS (SELECT 1 FROM jsonb_object_keys(r.raw) AS k WHERE k !~* ${IMPORT_ROW_KEEP})
      LIMIT ${limit})
    RETURNING 1`)).length, b);

  const avatarObjects = await sweepAvatarObjects(db, storage);
  const cardCovers = await sweepCardCovers(db, storage, b);

  return {
    rateLimits, rateLimitEvents, notifications, events, zeroResults, shelves, reviews, comments, accounts, accountObjects,
    orphanMutes, importRowsTrimmed, avatarObjects, cardCovers, workedAt: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------------
// D-10-3: the searcher key and the weekly zero-result summary.

/** Monday of the UTC week holding `at`, as YYYY-MM-DD. */
export function weekOf(at: Date): string {
  const d = new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  const dow = (d.getUTCDay() + 6) % 7; // Monday 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

/** This week's salt, created on first use. Cached per process for the week. */
const saltCache = new Map<string, string>();

async function weekSalt(db: Db, week: string): Promise<string> {
  const hit = saltCache.get(week);
  if (hit) return hit;
  await db.execute(sql`
    INSERT INTO search_week_salts (week, salt) VALUES (${week}::date, ${randomBytes(32).toString('hex')})
    ON CONFLICT (week) DO NOTHING`);
  const [row] = await db.execute<{ salt: string }>(sql`SELECT salt FROM search_week_salts WHERE week = ${week}::date`);
  if (!row) throw new Error('search week salt missing');
  saltCache.clear(); // one week at a time
  saltCache.set(week, row.salt);
  return row.salt;
}

/**
 * hmac(week salt, who) for a zero-result event (D-10-3). `who` is the account
 * id when signed in, else the app's guest session id, else the client IP
 * (D-15-4). Nothing user-identifying is stored: the key is useless without
 * the salt, which is deleted when the week's summary is written.
 */
export async function searcherKey(db: Db, who: string, at = new Date()): Promise<{ week: string; key: string }> {
  const week = weekOf(at);
  const salt = await weekSalt(db, week);
  return { week, key: createHmac('sha256', salt).update(who).digest('hex').slice(0, 32) };
}

export interface ZeroSummaryResult {
  weeks: string[];
  rows: number;
}

/**
 * Writes the summary of every complete week that still has a salt (D-10-3),
 * and deletes that salt in the same transaction. Reads only events inside
 * the 30-day window (older ones are already gone). A query's text is kept
 * when at least SUMMARY_MIN_SEARCHERS distinct searchers searched it that
 * week; the rest of the week is one row with a NULL query.
 */
export async function summariseZeroResults(db: Db, now = new Date()): Promise<ZeroSummaryResult> {
  const current = weekOf(now);
  const weeks = (await db.execute<{ week: string }>(sql`
    SELECT week::text AS week FROM search_week_salts WHERE week < ${current}::date ORDER BY week`)).map((r) => r.week);
  let rows = 0;
  for (const week of weeks) {
    await db.transaction(async (tx) => {
      const ins = await tx.execute(sql`
        WITH ev AS (
          SELECT lower(btrim(properties->>'query')) AS q, properties->>'searcher' AS who
          FROM events
          WHERE name = 'search_zero_results'
            AND at >= ${week}::date AND at < ${week}::date + 7
            AND properties->>'query' IS NOT NULL
        ),
        per_query AS (
          SELECT q, count(*)::int AS searches, count(DISTINCT who)::int AS searchers FROM ev GROUP BY q
        ),
        kept AS (SELECT q FROM per_query WHERE searchers >= ${SUMMARY_MIN_SEARCHERS}),
        rows AS (
          SELECT ${week}::date AS week, q AS query, searches, searchers FROM per_query WHERE q IN (SELECT q FROM kept)
          UNION ALL
          SELECT ${week}::date, NULL, count(*)::int, count(DISTINCT who)::int
          FROM ev WHERE q NOT IN (SELECT q FROM kept)
          HAVING count(*) > 0
        )
        INSERT INTO search_zero_summaries (week, query, searches, distinct_searchers)
        SELECT week, query, searches, searchers FROM rows
        ON CONFLICT (week, query) DO NOTHING
        RETURNING 1`);
      rows += ins.length;
      await tx.execute(sql`DELETE FROM search_week_salts WHERE week = ${week}::date`);
    });
    saltCache.delete(week);
  }
  return { weeks, rows };
}
