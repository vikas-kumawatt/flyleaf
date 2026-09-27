// Audit 08: the offline reading writes agree with the server.
//  - the attempt rule is the server's: a finished or DNF record is never
//    overwritten locally either
//  - changing status keeps the heart
//  - "remove from want to read" deletes the read (it used to pause it), the
//    delete replays after the create it depends on, and a refresh before it
//    syncs does not bring the book back

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';

import { FlyleafApiError } from '@flyleaf/api-client';
import { migrateOfflineDb } from '../migrations';
import type { MutationHandler } from '../queue';
import { OfflineRepository } from '../repository';
import type { Read } from '@/lib/api';
import { NodeSqliteDriver } from './sqlite-driver';

const USER = 'user-1';

function handler(log: string[], overrides: Partial<MutationHandler> = {}): MutationHandler {
  return {
    addProgress: async (readId, page) => { log.push(`progress:${readId}:${page}`); },
    upsertRead: async (workId, status, _r, hearted) => {
      log.push(`upsert:${workId}:${status}:${hearted ?? 'keep'}`);
      return { id: `server-${workId}-${log.length}` };
    },
    finishRead: async (readId) => { log.push(`finish:${readId}`); },
    dnfRead: async (readId) => { log.push(`dnf:${readId}`); },
    saveReview: async (readId) => { log.push(`review:${readId}`); },
    setLiked: async () => {},
    setFollowing: async () => {},
    deleteRead: async (readId) => { log.push(`delete:${readId}`); },
    ...overrides,
  };
}

/** No network: every write waits in the queue, so only the local rule is in play. */
const offline = () => handler([], {
  upsertRead: async () => { throw new TypeError('Network request failed'); },
});

async function drain(repo: OfflineRepository) {
  for (let i = 0; i < 50 && (await repo.getUnsyncedCount()) > 0; i++) {
    await repo.getQueue().flush(true);
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('offline reading writes (audit 08)', () => {
  let db: NodeSqliteDriver;

  beforeEach(async () => {
    db = new NodeSqliteDriver(new DatabaseSync(':memory:'));
    await migrateOfflineDb(db);
  });
  afterEach(async () => { await db.close(); });

  const attempts = () => db.getAll<{ attempt_no: number; status: string }>(
    `SELECT attempt_no, status FROM reads WHERE user_id = ? ORDER BY attempt_no`, [USER]);

  test('finishing a DNF book offline adds an attempt; the DNF stays (PRD §6.18)', async () => {
    const repo = new OfflineRepository(db, USER, offline());
    await repo.saveReadStatus('work-1', 'dnf');
    await repo.saveReadStatus('work-1', 'finished');
    assert.deepEqual((await attempts()).map((r) => [r.attempt_no, r.status]), [[1, 'dnf'], [2, 'finished']]);
  });

  test('stopping a finished book offline adds an attempt; the finish stays', async () => {
    const repo = new OfflineRepository(db, USER, offline());
    await repo.saveReadStatus('work-1', 'finished');
    await repo.saveReadStatus('work-1', 'dnf');
    assert.deepEqual((await attempts()).map((r) => r.status), ['finished', 'dnf']);
  });

  test('changing status keeps the heart, locally and in what is sent', async () => {
    const log: string[] = [];
    const repo = new OfflineRepository(db, USER, handler(log));
    await repo.saveReadStatus('work-1', 'paused', null, true);
    await repo.saveReadStatus('work-1', 'reading');
    const [row] = await db.getAll<{ hearted: number }>(`SELECT hearted FROM reads`);
    assert.equal(row!.hearted, 1);
    await drain(repo);
    assert.ok(log.some((l) => l === 'upsert:work-1:reading:keep'), log.join(' | '));
  });

  test('removing a want-to-read book deletes it, after the create it depends on', async () => {
    const log: string[] = [];
    const repo = new OfflineRepository(db, USER, handler(log));
    await repo.saveReadStatus('work-1', 'want');
    const [local] = await db.getAll<{ id: string }>(`SELECT id FROM reads`);
    await repo.deleteRead(local!.id);

    assert.deepEqual(await repo.getLocalReads(), []);
    await drain(repo);
    assert.equal(log.length, 2);
    assert.match(log[0]!, /^upsert:work-1:want/);
    // The delete went to the SERVER id the create returned, not the local one.
    assert.match(log[1]!, /^delete:server-work-1-/);
  });

  test('a delete the server has already applied (404) is not a sync issue', async () => {
    const repo = new OfflineRepository(db, USER, handler([], {
      deleteRead: async () => { throw new FlyleafApiError('not_found', 'Not found.', undefined, 404); },
    }));
    await db.run(`INSERT INTO reads (id, user_id, work_id, status, visibility, synced, created_at, updated_at)
                  VALUES ('read-9', ?, 'work-9', 'want', 'public', 1, '2026-01-01', '2026-01-01')`, [USER]);
    await repo.deleteRead('read-9');
    await drain(repo);
    assert.equal(await repo.getUnsyncedCount(), 0);
    assert.deepEqual(await repo.getQueue().getDeadLetters(), []);
  });

  test('a refresh before the delete syncs does not bring the book back', async () => {
    const repo = new OfflineRepository(db, USER, handler([], {
      deleteRead: async () => { throw new TypeError('Network request failed'); },
    }));
    await db.run(`INSERT INTO reads (id, user_id, work_id, status, visibility, synced, created_at, updated_at)
                  VALUES ('read-9', ?, 'work-9', 'want', 'public', 1, '2026-01-01', '2026-01-01')`, [USER]);
    await repo.deleteRead('read-9');
    await repo.cacheServerReads([{
      id: 'read-9', user_id: USER, work_id: 'work-9', status: 'want', attempt_no: 1,
      rating: null, hearted: false, visibility: 'public',
    } as Read]);
    assert.deepEqual(await repo.getLocalReads(), []);
  });
});
