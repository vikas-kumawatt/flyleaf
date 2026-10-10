// Audit 10: profile edits (SL-72/73) and GET /users/:id/reads pagination
// (A-08-027, the Diary and Wall of another user).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { follows, profiles } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { follow, makeRead, makeUser, makeWork, type TestUser } from './interaction-fixtures.js';

let db: Db;
let client: { close: () => Promise<void> };
let app: FastifyInstance;

beforeAll(async () => {
  ({ db, client } = await freshDrizzle());
  app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await client.close();
});

const patch = (u: TestUser, payload: object) =>
  app.inject({ method: 'PATCH', url: '/v1/me/profile', headers: u.auth, payload });

describe('GET /users/:id/reads is cursor-paginated (A-08-027)', () => {
  let owner: TestUser;
  let viewer: TestUser;
  const ids: string[] = [];

  beforeAll(async () => {
    owner = await makeUser(db, 'paged_owner');
    viewer = await makeUser(db, 'paged_viewer');
    for (let i = 0; i < 7; i++) {
      ids.push(await makeRead(db, owner.id, await makeWork(db, `Paged ${i}`)));
    }
    // Three reads inside the same millisecond, apart by microseconds: a
    // cursor that went through a JS Date would drop some of them.
    await db.execute(sql`UPDATE reads SET updated_at = '2026-01-01 10:00:00.123001+00' WHERE id = ${ids[0]}`);
    await db.execute(sql`UPDATE reads SET updated_at = '2026-01-01 10:00:00.123002+00' WHERE id = ${ids[1]}`);
    await db.execute(sql`UPDATE reads SET updated_at = '2026-01-01 10:00:00.123003+00' WHERE id = ${ids[2]}`);
    // And a private one the viewer must never page into.
    await makeRead(db, owner.id, await makeWork(db, 'Hidden'), { visibility: 'private' });
  });

  const page = (query: string, who: TestUser | null = viewer) =>
    app.inject({ method: 'GET', url: `/v1/users/${owner.id}/reads?${query}`, headers: who ? who.auth : {} });

  it('walks every visible read exactly once, in the unpaginated order, at every page size', async () => {
    const all = await page('limit=100');
    expect(all.statusCode).toBe(200);
    const expected = all.json().data.map((r: any) => r.id);
    expect(expected).toHaveLength(7);
    expect(all.json().next_cursor).toBeNull();
    for (const size of [1, 2, 3]) {
      const seen: string[] = [];
      let cursor: string | null = null;
      do {
        const res = await page(`limit=${size}${cursor ? `&cursor=${cursor}` : ''}`);
        expect(res.statusCode).toBe(200);
        const body = res.json();
        expect(body.data.length).toBeLessThanOrEqual(size);
        seen.push(...body.data.map((r: any) => r.id));
        cursor = body.next_cursor;
      } while (cursor);
      expect(seen).toEqual(expected);
    }
  });

  it('defaults to 50 and refuses a limit over 100 or a forged cursor', async () => {
    expect((await page('')).json().data).toHaveLength(7);
    expect((await page('limit=101')).statusCode).toBe(422);
    const bad = await page('cursor=bm90LWEtY3Vyc29y');
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe('invalid_cursor');
  });

  it('reads one page from the database (limit + 1 rows), not every read and a slice', async () => {
    const seen: number[] = [];
    const spy = new Proxy(db, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop !== 'execute') return value;
        return async (...args: unknown[]) => {
          const rows = await (value as (...a: unknown[]) => Promise<unknown[]>).apply(target, args);
          seen.push(rows.length);
          return rows;
        };
      },
    });
    const page = await new ReadingService(spy as Db).listPage(viewer.id, owner.id, undefined, { limit: 2 });
    expect(page.data).toHaveLength(2);
    expect(page.next_cursor).not.toBeNull();
    expect(Math.max(...seen)).toBe(3);
  });

  it('a guest pages the same public reads; the private one never appears', async () => {
    const res = await page('limit=100', null);
    expect(res.json().data).toHaveLength(7);
    expect(res.json().data.every((r: any) => r.visibility === 'public')).toBe(true);
  });
});

describe('PATCH /me/profile (SL-72, PRD §6.38)', () => {
  it('counts the 160-character bio in characters, as the database does, not UTF-16 units', async () => {
    const u = await makeUser(db, 'emoji_bio');
    const bio = '📚'.repeat(160);
    const ok = await patch(u, { bio });
    expect(ok.statusCode).toBe(200);
    expect(ok.json().bio).toBe(bio);
    const tooLong = await patch(u, { bio: '📚'.repeat(161) });
    expect(tooLong.statusCode).toBe(422);
  });

  it('trims the display name and bio; whitespace only is no value', async () => {
    const u = await makeUser(db, 'trim_me');
    const res = await patch(u, { displayName: '  Ada  ', bio: '\n  reads a lot \t' });
    expect(res.json()).toMatchObject({ displayName: 'Ada', bio: 'reads a lot' });
    const blank = await patch(u, { displayName: '   ', bio: ' \n ' });
    expect(blank.json()).toMatchObject({ displayName: null, bio: null });
  });

  it('only the listed fields are writable: counters, username and explicit content are not', async () => {
    const u = await makeUser(db, 'no_smuggling');
    const res = await patch(u, {
      followerCount: 9999, follower_count: 9999, username: 'hijacked', showExplicit: true, show_explicit: true, isPrivate: false,
    });
    expect(res.statusCode).toBe(200);
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, u.id));
    expect(p).toMatchObject({ username: 'no_smuggling', followerCount: 0, showExplicit: false });
  });

  it('going public accepts pending requests and the follower count follows (§11, trigger-maintained)', async () => {
    const priv = await makeUser(db, 'was_private', { isPrivate: true });
    const fan = await makeUser(db, 'pending_fan');
    const friend = await makeUser(db, 'old_friend');
    await follow(db, friend.id, priv.id);
    await db.insert(follows).values({ followerId: fan.id, followeeId: priv.id, state: 'pending' });
    const res = await patch(priv, { isPrivate: false });
    expect(res.statusCode).toBe(200);
    expect(res.json().followerCount).toBe(2);
    const [row] = await db.select().from(follows).where(eq(follows.followerId, fan.id));
    expect(row!.state).toBe('accepted');
  });

  it('favourites: at most four, duplicates collapse, an unknown work is refused and nothing is written', async () => {
    const u = await makeUser(db, 'favs');
    const w = await Promise.all([1, 2, 3, 4, 5].map((i) => makeWork(db, `Fav ${i}`)));
    await patch(u, { favouriteWorkIds: [w[0], w[1]] });
    const dup = await patch(u, { favouriteWorkIds: [w[2], w[2], w[3]] });
    expect(dup.json().favourite_work_ids).toEqual([w[2], w[3]]);
    expect((await patch(u, { favouriteWorkIds: w })).statusCode).toBe(422);
    const unknown = await patch(u, { favouriteWorkIds: [w[0], '00000000-0000-4000-8000-000000000000'], bio: 'changed?' });
    expect(unknown.statusCode).toBe(422);
    const [p] = await db.select().from(profiles).where(eq(profiles.userId, u.id));
    expect(p!.favouriteWorkIds).toEqual([w[2], w[3]]);
    expect(p!.bio).toBeNull();
  });
});

