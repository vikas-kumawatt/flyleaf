// SO-01: follows counters, blocks, mutes — schema, triggers, reconciliation
// Architecture §3.6, §3.9, PRD §11

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import { freshDb, rejected } from './pg.js';

let db: PGlite;

const USER_1 = '11111111-1111-1111-1111-111111111111';
const USER_2 = '22222222-2222-2222-2222-222222222222';
const USER_3 = '33333333-3333-3333-3333-333333333333';
const WORK_1 = '44444444-4444-4444-4444-444444444444';

async function profileCounts(userId: string) {
  const { rows } = await db.query<{ follower_count: number; following_count: number }>(`
    SELECT follower_count, following_count FROM profiles WHERE user_id = '${userId}';
  `);
  return rows[0]!;
}

beforeAll(async () => {
  db = await freshDb();
  await db.exec(`
    INSERT INTO users (id, email, password_hash, date_of_birth) VALUES
      ('${USER_1}', 'u1@flyleaf.test', 'hash1', '2000-01-01'),
      ('${USER_2}', 'u2@flyleaf.test', 'hash2', '2000-01-01'),
      ('${USER_3}', 'u3@flyleaf.test', 'hash3', '2000-01-01');

    INSERT INTO profiles (user_id, username) VALUES
      ('${USER_1}', 'user_one'),
      ('${USER_2}', 'user_two'),
      ('${USER_3}', 'user_three');

    INSERT INTO works (id, title) VALUES ('${WORK_1}', 'Test Work');
  `);
}, 60_000);

afterAll(async () => {
  await db?.close();
});

describe('SO-01: blocks and mutes schema', () => {
  it('creates a block and rejects self-block', async () => {
    await db.query(`
      INSERT INTO blocks (blocker_id, blocked_id)
      VALUES ('${USER_1}', '${USER_2}');
    `);

    const fail = await rejected(db, `
      INSERT INTO blocks (blocker_id, blocked_id)
      VALUES ('${USER_1}', '${USER_1}')
    `);
    expect(fail).toBe(true);
  });

  it('creates user and work mutes with target_type constraint', async () => {
    await db.query(`
      INSERT INTO mutes (user_id, target_type, target_id)
      VALUES ('${USER_1}', 'user', '${USER_2}');
    `);
    await db.query(`
      INSERT INTO mutes (user_id, target_type, target_id)
      VALUES ('${USER_1}', 'work', '${WORK_1}');
    `);

    const fail = await rejected(db, `
      INSERT INTO mutes (user_id, target_type, target_id)
      VALUES ('${USER_1}', 'shelf', '${WORK_1}')
    `);
    expect(fail).toBe(true);
  });
});

describe('SO-01: follow counter triggers', () => {
  it('updates follower and following counts for accepted follows only', async () => {
    expect(await profileCounts(USER_1)).toEqual({ follower_count: 0, following_count: 0 });
    expect(await profileCounts(USER_2)).toEqual({ follower_count: 0, following_count: 0 });

    await db.query(`
      INSERT INTO follows (follower_id, followee_id, state)
      VALUES ('${USER_1}', '${USER_2}', 'accepted');
    `);

    expect(await profileCounts(USER_1)).toEqual({ follower_count: 0, following_count: 1 });
    expect(await profileCounts(USER_2)).toEqual({ follower_count: 1, following_count: 0 });

    await db.query(`
      INSERT INTO follows (follower_id, followee_id, state)
      VALUES ('${USER_1}', '${USER_3}', 'pending');
    `);

    expect(await profileCounts(USER_1)).toEqual({ follower_count: 0, following_count: 1 });
    expect(await profileCounts(USER_3)).toEqual({ follower_count: 0, following_count: 0 });

    await db.query(`
      UPDATE follows SET state = 'accepted'
      WHERE follower_id = '${USER_1}' AND followee_id = '${USER_3}';
    `);

    expect(await profileCounts(USER_1)).toEqual({ follower_count: 0, following_count: 2 });
    expect(await profileCounts(USER_3)).toEqual({ follower_count: 1, following_count: 0 });
  });

  it('decrements counts when a follow is removed', async () => {
    await db.query(`
      DELETE FROM follows
      WHERE follower_id = '${USER_1}' AND followee_id = '${USER_2}';
    `);

    expect(await profileCounts(USER_1)).toEqual({ follower_count: 0, following_count: 1 });
    expect(await profileCounts(USER_2)).toEqual({ follower_count: 0, following_count: 0 });
  });
});

describe('SO-01: reconcile_follow_counters', () => {
  it('restores corrupted profile follow counters', async () => {
    await db.query(`
      UPDATE profiles
      SET follower_count = 999, following_count = 888
      WHERE user_id IN ('${USER_1}', '${USER_2}', '${USER_3}');
    `);

    await db.query(`SELECT reconcile_follow_counters();`);

    expect(await profileCounts(USER_1)).toEqual({ follower_count: 0, following_count: 1 });
    expect(await profileCounts(USER_2)).toEqual({ follower_count: 0, following_count: 0 });
    expect(await profileCounts(USER_3)).toEqual({ follower_count: 1, following_count: 0 });
  });
});
