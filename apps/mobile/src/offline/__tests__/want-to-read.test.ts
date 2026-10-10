// Audit 14 / D-11-1: the feed's want-to-read swipe through the offline queue.
//  - writes `want` only when this device knows no read of the book
//  - sends if_absent, so the server never overwrites a read it has
//  - the server's 409 already_in_library drops the local copy, not a sync issue
//  - Undo deletes only the read the swipe created
//  - offline: queued, and says so

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { FlyleafApiError } from '@flyleaf/api-client';

import { migrateOfflineDb } from '../migrations';
import type { MutationHandler } from '../queue';
import { OfflineRepository } from '../repository';
import { NodeSqliteDriver } from './sqlite-driver';

const USER = 'user-a';

interface Server {
  offline: boolean;
  /** Answer the next upsert with a 503 (the queue backs off and retries). */
  fail503?: boolean;
  /** work_id → server read id the server already has */
  reads: Map<string, string>;
  calls: string[];
}

function handler(server: Server): MutationHandler {
  const unexpected = (name: string) => async () => {
    throw new Error(`unexpected ${name}`);
  };
  return {
    addProgress: unexpected('addProgress'),
    upsertRead: async (workId, status, _rating, _hearted, extra) => {
      if (server.offline) throw new TypeError('Network request failed');
      if (server.fail503) {
        server.fail503 = false;
        server.calls.push('upsert:503');
        throw new FlyleafApiError('unavailable', 'Try again.', undefined, 503);
      }
      server.calls.push(`upsert:${workId}:${status}:${extra?.if_absent === true}`);
      if (extra?.if_absent && server.reads.has(workId)) {
        throw new FlyleafApiError('already_in_library', 'This book is already in your library.', undefined, 409);
      }
      const id = `srv-${workId}`;
      server.reads.set(workId, id);
      return { id, work_id: workId, status };
    },
    finishRead: unexpected('finishRead'),
    dnfRead: unexpected('dnfRead'),
    saveReview: unexpected('saveReview'),
    setLiked: unexpected('setLiked'),
    setFollowing: unexpected('setFollowing'),
    deleteRead: async (readId) => {
      if (server.offline) throw new TypeError('Network request failed');
      server.calls.push(`delete:${readId}`);
      const entry = [...server.reads.entries()].find(([, id]) => id === readId);
      if (!entry) throw new FlyleafApiError('not_found', 'No such read.', undefined, 404);
      server.reads.delete(entry[0]);
    },
  };
}

const tick = () => new Promise((r) => setTimeout(r, 5));

describe('want-to-read swipe (D-11-1)', () => {
  let db: NodeSqliteDriver;
  let server: Server;
  let repo: OfflineRepository;

  beforeEach(async () => {
    db = new NodeSqliteDriver(new DatabaseSync(':memory:'));
    await migrateOfflineDb(db);
    server = { offline: false, reads: new Map(), calls: [] };
    repo = new OfflineRepository(db, USER, handler(server));
  });

  afterEach(async () => {
    await db.close();
  });

  /** Until nothing is waiting: a write's own background flush can be running when the test asks. */
  async function settle() {
    for (let i = 0; i < 20; i++) {
      await tick();
      await repo.getQueue().flush(true);
      const left = await db.getAll(`SELECT id FROM mutation_queue WHERE status IN ('pending', 'processing')`);
      if (left.length === 0) return;
    }
  }

  test('no read anywhere: added, with if_absent, and Undo deletes exactly that read', async () => {
    const out = await repo.wantToRead('w1', { title: 'Piranesi' });
    assert.deepEqual(out, { kind: 'added', readId: 'srv-w1' });
    assert.deepEqual(server.calls, ['upsert:w1:want:true']);
    const [local] = await repo.getLocalReads('want');
    assert.equal(local?.id, 'srv-w1');

    await repo.deleteRead(out.kind === 'added' ? out.readId : '');
    await settle();
    assert.deepEqual(server.calls, ['upsert:w1:want:true', 'delete:srv-w1']);
    assert.equal(server.reads.size, 0);
  });

  test('a read this device knows (any status): already in your library, nothing sent', async () => {
    await repo.saveReadStatus('w2', 'reading');
    await settle();
    server.calls.length = 0;
    assert.deepEqual(await repo.wantToRead('w2'), { kind: 'already' });
    assert.deepEqual(server.calls, []);
    const reads = await repo.getLocalReads();
    assert.deepEqual(reads.map((r) => r.status), ['reading']);
  });

  test('a read only the server has: 409 drops the local copy, no sync issue, and Undo is not offered', async () => {
    server.reads.set('w3', 'srv-existing');
    assert.deepEqual(await repo.wantToRead('w3'), { kind: 'already' });
    assert.deepEqual(await repo.getLocalReads(), []);
    assert.equal((await db.getAll(`SELECT * FROM mutation_queue`)).length, 0);
    assert.equal(server.reads.get('w3'), 'srv-existing');
  });

  test('offline: queued (and Undo before sync leaves nothing on the server)', async () => {
    server.offline = true;
    const out = await repo.wantToRead('w4');
    assert.equal(out.kind, 'queued');
    await repo.deleteRead(out.kind === 'queued' ? out.readId : '');
    server.offline = false;
    await settle();
    assert.equal(server.reads.size, 0);
    assert.deepEqual(await repo.getLocalReads(), []);
  });

  test('offline, then the server turns out to have a read: the replay changes nothing there', async () => {
    server.offline = true;
    assert.equal((await repo.wantToRead('w5')).kind, 'queued');
    server.reads.set('w5', 'srv-other-device');
    server.offline = false;
    await settle();
    assert.equal(server.reads.get('w5'), 'srv-other-device');
    assert.deepEqual(await repo.getLocalReads(), []);
    assert.equal((await db.getAll(`SELECT * FROM mutation_queue WHERE status = 'dead_letter'`)).length, 0);
  });

  test('a create backing off holds back the Undo queued after it (queue order per read)', async () => {
    server.fail503 = true;
    const out = await repo.wantToRead('w6');
    assert.equal(out.kind, 'queued');
    await repo.deleteRead(out.kind === 'queued' ? out.readId : '');
    // An unforced flush while the create waits out its back-off sends nothing for this read.
    await tick();
    await repo.getQueue().flush(false);
    assert.deepEqual(server.calls, ['upsert:503']);
    await settle();
    assert.deepEqual(server.calls, ['upsert:503', 'upsert:w6:want:true', 'delete:srv-w6']);
    assert.equal(server.reads.size, 0);
  });
});
