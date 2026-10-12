// SO-30: the notification view's visibility predicate (notify/index.ts,
// viewSql) is hand-written SQL, so it is checked against canView() — the one
// visibility function (FN-71) — over the matrix that matters for a like or a
// comment: the read's visibility × the recipient's account privacy × whether
// the actor is an accepted follower × a block either way. A row is shown
// exactly when canView(actor, recipient's read) is true.

import { describe, it, expect, beforeAll } from 'vitest';
import { sql, eq } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { canView } from '../authorization/index.js';
import { NotificationService, Notifier } from '../notify/index.js';
import { blocks, follows, profiles, reads } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, type TestUser } from './interaction-fixtures.js';

const VIS = ['public', 'followers', 'private'] as const;
const cases = VIS.flatMap((visibility) =>
  [false, true].flatMap((isPrivate) =>
    [false, true].flatMap((isFollower) =>
      (['none', 'recipient', 'actor'] as const).map((blockedBy) => ({ visibility, isPrivate, isFollower, blockedBy })),
    ),
  ),
);

describe('notification visibility matches canView() for every case', () => {
  let db: Db;
  let alice: TestUser;
  let bob: TestUser;
  let readId: string;

  beforeAll(async () => {
    ({ db } = await freshDrizzle());
    alice = await makeUser(db, 'alice');
    bob = await makeUser(db, 'bob');
    readId = await makeRead(db, alice.id, await makeWork(db, 'Earthsea'), { status: 'finished' });
    // Written while everything is open, then each case changes the state.
    await new Notifier().like(db, bob.id, readId);
    await new Notifier().comment(db, bob.id, readId, (await db.execute<{ id: string }>(sql`
      INSERT INTO read_comments (read_id, user_id, body) VALUES (${readId}::uuid, ${bob.id}::uuid, 'x') RETURNING id`))[0]!.id);
  });

  it.each(cases)('read %o', async ({ visibility, isPrivate, isFollower, blockedBy }) => {
    await db.update(reads).set({ visibility }).where(eq(reads.id, readId));
    await db.update(profiles).set({ isPrivate }).where(eq(profiles.userId, alice.id));
    await db.delete(follows);
    if (isFollower) await db.insert(follows).values({ followerId: bob.id, followeeId: alice.id, state: 'accepted' });
    await db.delete(blocks);
    if (blockedBy === 'recipient') await db.insert(blocks).values({ blockerId: alice.id, blockedId: bob.id });
    if (blockedBy === 'actor') await db.insert(blocks).values({ blockerId: bob.id, blockedId: alice.id });

    const expected = canView({
      viewer: bob.id, ownerId: alice.id, visibility, isOwnerPrivate: isPrivate,
      isBlocked: blockedBy !== 'none', isFollower,
    });
    const { items } = await new NotificationService(db).list(alice.id);
    expect(items.map((i) => i.type).sort()).toEqual(expected ? ['comment', 'like'] : []);
  });
});
