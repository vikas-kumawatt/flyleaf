// canView() ≡ canViewSql() (FN-71, Audit 05).
//
// List queries filter in SQL; single resources call canView(). If the two
// disagree, a list shows what the detail page 404s (or the reverse). This
// runs both over the same fixture matrix: every viewer state × account kind
// × item visibility, plus the stricter-of-two rule used for reviews.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  VISIBILITIES,
  canViewSql,
  canViewWith,
  loadRelationship,
  mostRestrictive,
  mostRestrictiveSql,
  visibleLevels,
  type Visibility,
} from '../authorization/index.js';
import type { Db } from '../platform/index.js';
import { users, follows, blocks } from '../db/schema.js';
import { eq } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { makeUser, type TestUser } from './interaction-fixtures.js';

const VIEWERS = ['guest', 'stranger', 'pending', 'follower', 'blockedBy', 'blocker', 'owner'] as const;
type Viewer = (typeof VIEWERS)[number];
const ACCOUNTS = ['public', 'private', 'deleted'] as const;
type Account = (typeof ACCOUNTS)[number];

/** Independent oracle, from PRD §26.1–26.2, §11.4, §25.4 (not from canView). */
function oracle(viewer: Viewer, account: Account, vis: Visibility): boolean {
  if (account === 'deleted') return false;
  if (viewer === 'blockedBy' || viewer === 'blocker') return false;
  if (viewer === 'owner') return true;
  if (vis === 'private') return false;
  if (account === 'private' || vis === 'followers') return viewer === 'follower';
  return true;
}

let db: Db;
let close: () => Promise<void>;
const owners = {} as Record<Account, TestUser>;
const viewers = {} as Record<Exclude<Viewer, 'guest' | 'owner'>, TestUser>;

const viewerId = (v: Viewer, a: Account): string | null =>
  v === 'guest' ? null : v === 'owner' ? owners[a].id : viewers[v].id;

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  close = () => fresh.client.close();
  for (const k of ['stranger', 'pending', 'follower', 'blockedBy', 'blocker'] as const) {
    viewers[k] = await makeUser(db, `eq_${k.toLowerCase()}`);
  }
  for (const a of ACCOUNTS) {
    const o = await makeUser(db, `eq_owner_${a}`, { isPrivate: a === 'private' });
    owners[a] = o;
    await db.insert(follows).values([
      { followerId: viewers.pending.id, followeeId: o.id, state: 'pending' },
      { followerId: viewers.follower.id, followeeId: o.id, state: 'accepted' },
      // A block between two accounts that still follow each other (sever is
      // the block service's job): the block must win anyway.
      { followerId: viewers.blockedBy.id, followeeId: o.id, state: 'accepted' },
    ]);
    await db.insert(blocks).values([
      { blockerId: o.id, blockedId: viewers.blockedBy.id },
      { blockerId: viewers.blocker.id, blockedId: o.id },
    ]);
  }
  await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, owners.deleted.id));
});

afterAll(async () => {
  await close?.();
});

describe('canView ≡ canViewSql ≡ PRD oracle', () => {
  it('agree on every viewer × account × visibility (63 cells)', async () => {
    const rows: string[] = [];
    let cells = 0;
    for (const a of ACCOUNTS) {
      for (const v of VIEWERS) {
        const viewer = viewerId(v, a);
        const ownerId = owners[a].id;
        const rel = await loadRelationship(db, viewer, ownerId);
        for (const vis of VISIBILITIES) {
          cells++;
          const ts = canViewWith(viewer, ownerId, rel, vis);
          const [row] = await db.execute<{ ok: boolean }>(sql`
            SELECT ${canViewSql(viewer, {
              ownerId: sql`${ownerId}::uuid`,
              visibility: sql`${vis}::text`,
              ownerIsPrivate: sql`(SELECT p.is_private FROM profiles p WHERE p.user_id = ${ownerId}::uuid)`,
            })} AS ok
          `);
          const inSql = Boolean(row!.ok);
          const want = oracle(v, a, vis);
          if (ts !== want || inSql !== want) rows.push(`${v} → ${a}/${vis}: oracle ${want}, canView ${ts}, sql ${inSql}`);
        }
      }
    }
    expect(cells).toBe(63);
    expect(rows).toEqual([]);
  });

  it('visibleLevels() lists exactly the visibilities canView allows (reads list, Audit 05)', async () => {
    for (const a of ACCOUNTS) {
      for (const v of VIEWERS) {
        const viewer = viewerId(v, a);
        const rel = await loadRelationship(db, viewer, owners[a].id);
        expect(visibleLevels(viewer, owners[a].id, rel)).toEqual(VISIBILITIES.filter((vis) => oracle(v, a, vis)));
      }
    }
  });

  it('a pending follow never counts as following', async () => {
    const rel = await loadRelationship(db, viewers.pending.id, owners.private.id);
    expect(rel.followStatus).toBe('pending');
    expect(canViewWith(viewers.pending.id, owners.private.id, rel, 'public')).toBe(false);
  });
});

describe('mostRestrictive ≡ mostRestrictiveSql (review on a read)', () => {
  it.each(VISIBILITIES.flatMap((a) => VISIBILITIES.map((b) => [a, b] as const)))('%s + %s', async (a, b) => {
    const [row] = await db.execute<{ v: string }>(sql`SELECT ${mostRestrictiveSql(sql`${a}::text`, sql`${b}::text`)} AS v`);
    const rank = { public: 0, followers: 1, private: 2 } as const;
    const want = rank[a] >= rank[b] ? a : b;
    expect(mostRestrictive(a, b)).toBe(want);
    expect(row!.v).toBe(want);
  });
});
