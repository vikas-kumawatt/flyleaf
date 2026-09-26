// Audit 07: offline queue properties the SL-13 suite did not cover.
//  - queue rows and local reads belong to one user (A-07-002)
//  - one flush at a time per database, however many repositories exist (A-07-008)
//  - an install from before versioned migrations upgrades in place (A-07-007)
//  - a review written in the finish flow is queued, not dropped (A-07-006)

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { SCHEMA_SQL, type QueuedMutation } from '../schema';
import { LOCAL_SCHEMA_VERSION, migrateOfflineDb } from '../migrations';
import { MutationQueue, type MutationHandler } from '../queue';
import { OfflineRepository } from '../repository';
import { NodeSqliteDriver } from './sqlite-driver';

function recordingHandler(log: string[], delayMs = 0): MutationHandler {
  const wait = () => new Promise((r) => setTimeout(r, delayMs));
  return {
    addProgress: async (readId, page) => {
      await wait();
      log.push(`progress:${readId}:${page}`);
    },
    upsertRead: async (workId, status) => {
      await wait();
      log.push(`upsert:${workId}:${status}`);
      return { id: `server-${workId}` };
    },
    finishRead: async (readId) => {
      await wait();
      log.push(`finish:${readId}`);
    },
    dnfRead: async (readId) => {
      log.push(`dnf:${readId}`);
    },
    saveReview: async (readId, payload) => {
      log.push(`review:${readId}:${payload.body}`);
    },
    setLiked: async (readId, liked) => {
      log.push(`like:${readId}:${liked}`);
    },
    setFollowing: async (userId, following) => {
      log.push(`follow:${userId}:${following}`);
    },
  };
}

/** Wait out the background flush a repository write starts, then flush what is left. */
async function drain(repo: OfflineRepository) {
  for (let i = 0; i < 50 && (await repo.getUnsyncedCount()) > 0; i++) {
    await repo.getQueue().flush(true);
    await new Promise((r) => setTimeout(r, 5));
  }
}

async function insertRead(db: NodeSqliteDriver, id: string, userId: string, workId: string) {
  await db.run(
    `INSERT INTO reads (id, user_id, work_id, status, visibility, created_at, updated_at)
     VALUES (?, ?, ?, 'reading', 'private', '2026-01-01', '2026-01-01')`,
    [id, userId, workId],
  );
}

describe('offline queue: users, concurrency, migrations (audit 07)', () => {
  let db: NodeSqliteDriver;

  beforeEach(async () => {
    db = new NodeSqliteDriver(new DatabaseSync(':memory:'));
    await migrateOfflineDb(db);
  });

  afterEach(async () => {
    await db.close();
  });

  test("user B never replays or sees user A's writes; A's replay when A is back", async () => {
    const log: string[] = [];
    await insertRead(db, 'read-a', 'user-a', 'work-1');
    const a = new MutationQueue(db, 'user-a', recordingHandler(log));
    await a.enqueue('progress_event', 'read-a', 'add_progress', { page: 12 });

    // A signs out; B signs in on the same phone.
    const bRepo = new OfflineRepository(db, 'user-b', recordingHandler(log));
    await bRepo.getQueue().flush(true);
    assert.deepEqual(log, []);
    assert.equal(await bRepo.getUnsyncedCount(), 0);
    assert.deepEqual(await bRepo.getLocalReads(), [], "A's private read is not listed for B");
    assert.equal((await bRepo.getQueue().getDeadLetters()).length, 0);

    // B cannot discard or retry A's rows.
    const [row] = await db.getAll<QueuedMutation>(`SELECT * FROM mutation_queue`);
    await db.run(`UPDATE mutation_queue SET status = 'dead_letter'`);
    await bRepo.getQueue().dismissDeadLetter(row!.id);
    await bRepo.getQueue().retryDeadLetter(row!.id);
    const still = await db.getFirst<QueuedMutation>(`SELECT * FROM mutation_queue WHERE id = ?`, [row!.id]);
    assert.equal(still?.status, 'dead_letter');
    await db.run(`UPDATE mutation_queue SET status = 'pending'`);

    // A signs back in.
    await a.flush(true);
    assert.deepEqual(log, ['progress:read-a:12']);
  });

  test('two repositories flushing at once send each mutation exactly once', async () => {
    const log: string[] = [];
    const handler = recordingHandler(log, 5);
    const first = new OfflineRepository(db, 'user-a', handler);
    const second = new OfflineRepository(db, 'user-a', handler);
    for (const page of [1, 2, 3]) {
      await first.getQueue().enqueue('progress_event', 'read-x', 'add_progress', { page });
    }
    await Promise.all([first.getQueue().flush(true), second.getQueue().flush(true)]);
    await first.getQueue().flush(true);
    assert.deepEqual(log, ['progress:read-x:1', 'progress:read-x:2', 'progress:read-x:3']);
  });

  test('a finish with review text queues the review after the finish, on the same read', async () => {
    const log: string[] = [];
    const repo = new OfflineRepository(db, 'user-a', recordingHandler(log));
    await insertRead(db, 'read-f', 'user-a', 'work-f');
    await repo.finishRead('read-f', { rating: 4, review: '  Loved the ending.  ', visibility: 'followers' });
    await drain(repo);
    assert.deepEqual(log, ['finish:read-f', 'review:read-f:Loved the ending.']);
  });
});

describe('local schema migration from an install before versioning (A-07-007)', () => {
  test('upgrades in place: owners, read-keyed upserts, and unowned rows set aside', async () => {
    const db = new NodeSqliteDriver(new DatabaseSync(':memory:'));
    // The pre-audit app: SCHEMA_SQL only, user_version 0, upsert keyed by work id.
    await db.exec(SCHEMA_SQL);
    await insertRead(db, 'read-1', 'user-a', 'work-1');
    const insert = (id: string, entity: string, action: string, payload: object) =>
      db.run(
        `INSERT INTO mutation_queue (id, entity_type, entity_id, action, payload, client_event_id, status, created_at, updated_at)
         VALUES (?, 'read', ?, ?, ?, ?, 'pending', '2026-01-01', '2026-01-01')`,
        [id, entity, action, JSON.stringify(payload), `ce-${id}`],
      );
    await insert('q-upsert', 'work-1', 'upsert_read', { status: 'reading' });
    await insert('q-progress', 'read-1', 'add_progress', { page: 5 });
    await insert('q-orphan', 'read-gone', 'add_progress', { page: 9 });

    await migrateOfflineDb(db);
    await migrateOfflineDb(db); // a second start is a no-op

    const version = await db.getFirst<{ user_version: number }>('PRAGMA user_version');
    assert.equal(version?.user_version, LOCAL_SCHEMA_VERSION);

    const rows = new Map(
      (await db.getAll<QueuedMutation>(`SELECT * FROM mutation_queue`)).map((r) => [r.id, r]),
    );
    const upsert = rows.get('q-upsert')!;
    assert.equal(upsert.entity_id, 'read-1');
    assert.equal(JSON.parse(upsert.payload).work_id, 'work-1');
    assert.equal(upsert.user_id, 'user-a');
    assert.equal(rows.get('q-progress')!.user_id, 'user-a');
    const orphan = rows.get('q-orphan')!;
    assert.equal(orphan.user_id, null);
    assert.equal(orphan.status, 'dead_letter');
    assert.equal(orphan.error_code, 'owner_unknown');

    // The migrated rows replay for their owner, in order.
    const log: string[] = [];
    await new MutationQueue(db, 'user-a', recordingHandler(log)).flush(true);
    assert.deepEqual(log, ['upsert:work-1:reading', 'progress:server-work-1:5']);
    await db.close();
  });
});
