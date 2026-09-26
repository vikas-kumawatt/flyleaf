// Local SQLite migrations (PRD §34.5: "Local database migrations run before the
// first render"). `PRAGMA user_version` records how many steps have run.
// Append new steps; never edit one that has shipped.

import type { OfflineDatabase } from './db';
import { SCHEMA_SQL } from './schema';

const STEPS: ((db: OfflineDatabase) => Promise<void>)[] = [
  // 1 · SL-10 schema. IF NOT EXISTS, so installs from before versioning pass through.
  (db) => db.exec(SCHEMA_SQL),

  // 2 · Audit 07: queue rows belong to a user (A-07-002), keep their error code
  // for the sync-issues screen (A-07-001), and reads created offline remember
  // the server id they were given (A-07-005).
  async (db) => {
    await db.exec(`
      ALTER TABLE mutation_queue ADD COLUMN user_id TEXT;
      ALTER TABLE mutation_queue ADD COLUMN error_code TEXT;
      CREATE INDEX IF NOT EXISTS idx_queue_user_status ON mutation_queue(user_id, status, next_retry_at);
      CREATE TABLE IF NOT EXISTS read_aliases (
        local_id TEXT PRIMARY KEY,
        server_id TEXT NOT NULL
      );
    `);
    // upsert_read used to be keyed by work id. It now carries the work id in
    // its payload and is keyed by the local read, so it shares a FIFO with
    // that read's progress and finish.
    await db.run(
      `UPDATE mutation_queue
          SET payload = json_set(payload, '$.work_id', entity_id)
        WHERE action = 'upsert_read' AND json_extract(payload, '$.work_id') IS NULL`,
    );
    await db.run(
      `UPDATE mutation_queue
          SET entity_id = COALESCE((
                SELECT r.id FROM reads r
                 WHERE r.work_id = mutation_queue.entity_id
                 ORDER BY r.attempt_no DESC LIMIT 1), entity_id)
        WHERE action = 'upsert_read'`,
    );
    // Owner: the user of the read the row is about, when exactly one matches.
    await db.run(
      `UPDATE mutation_queue
          SET user_id = (
                SELECT CASE WHEN COUNT(DISTINCT r.user_id) = 1 THEN MAX(r.user_id) END
                  FROM reads r
                 WHERE r.id = mutation_queue.entity_id)
        WHERE user_id IS NULL`,
    );
    // Rows nobody can be shown to be the owner of are never replayed under
    // whoever signs in next; they wait on the sync-issues screen to be discarded.
    await db.run(
      `UPDATE mutation_queue
          SET status = 'dead_letter', error_code = 'owner_unknown',
              last_error = 'Saved by an earlier version of the app for an account we cannot identify.'
        WHERE user_id IS NULL`,
    );
  },
];

export const LOCAL_SCHEMA_VERSION = STEPS.length;

export async function migrateOfflineDb(db: OfflineDatabase): Promise<void> {
  const row = await db.getFirst<{ user_version: number }>('PRAGMA user_version');
  const from = row?.user_version ?? 0;
  for (let v = from; v < STEPS.length; v++) {
    await db.transaction(async (tx) => {
      await STEPS[v]!(tx);
      await tx.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}
