// notify.yir (ST-09; PRD §19.2 item 8 "Year in Review ready · push + in-app ·
// on · once annually", §6.41 "unlocks 1 December").
//
// Every 30 minutes the job finds readers whose own 1 December has come (in
// the zone their notification preferences hold, as quiet hours use; UTC
// without one), who finished at least one book dated in that year, and who
// have not had this year's notice. Each is claimed in
// `year_in_review_notices` and notified in the same transaction, so two runs
// cannot both notify and a reader is never told twice, whatever their
// preferences say at the time. The Notifier then applies the preferences
// (category `year_in_review`, push and in-app) and queues the push, which
// delivery.ts holds through quiet hours and counts against the 5-a-day cap
// like any other.
//
// Outside the days when some zone is in December (30 November 10:00 UTC, when
// UTC+14 reaches 1 December, to 1 January 12:00 UTC, when UTC−12 leaves
// 31 December) it returns at once.

import { sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import type { Notifier } from './index.js';

export interface YirNoticeResult {
  claimed: number;
}

/** True while some time zone on Earth is in December. */
export function decemberSomewhere(now: Date): boolean {
  const y = now.getUTCFullYear();
  const t = now.getTime();
  const from = Date.UTC(y, 10, 30, 10); // 30 Nov 10:00 UTC = 1 Dec 00:00 at UTC+14
  const to = Date.UTC(y, 0, 1, 12); // 1 Jan 12:00 UTC = 1 Jan 00:00 at UTC−12
  return t >= from || t < to;
}

export async function sendYearInReviewNotices(db: Db, notifier: Notifier, now = new Date(), batch = 500): Promise<YirNoticeResult> {
  if (!decemberSomewhere(now)) return { claimed: 0 };
  const at = now.toISOString();
  let claimed = 0;
  for (let round = 0; round < 1_000; round++) {
    const due = await db.execute<{ user_id: string; year: number }>(sql`
      WITH local AS (
        SELECT u.id, (${at}::timestamptz AT TIME ZONE COALESCE(p.timezone, 'UTC')) AS t
          FROM users u LEFT JOIN notification_preferences p ON p.user_id = u.id
         WHERE u.deleted_at IS NULL
      )
      SELECT l.id AS user_id, extract(year FROM l.t)::int AS year
        FROM local l
       WHERE extract(month FROM l.t) = 12
         AND NOT EXISTS (SELECT 1 FROM year_in_review_notices y WHERE y.user_id = l.id AND y.year = extract(year FROM l.t)::int)
         AND EXISTS (SELECT 1 FROM reads r
               WHERE r.user_id = l.id AND r.status = 'finished'
                 AND r.finished_at >= make_date(extract(year FROM l.t)::int, 1, 1)
                 AND r.finished_at < make_date(extract(year FROM l.t)::int + 1, 1, 1))
       LIMIT ${batch}`);
    for (const d of due) {
      await db.transaction(async (tx) => {
        const t = tx as unknown as Db;
        const [mine] = await t.execute(sql`
          INSERT INTO year_in_review_notices (user_id, year) VALUES (${d.user_id}::uuid, ${d.year})
          ON CONFLICT DO NOTHING RETURNING 1`);
        if (!mine) return;
        await notifier.yearInReview(t, d.user_id, Number(d.year));
        claimed++;
      });
    }
    if (due.length < batch) break;
  }
  return { claimed };
}
