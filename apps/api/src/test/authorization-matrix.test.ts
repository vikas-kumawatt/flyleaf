// Cross-user authorization matrix (FN-72, PRD §25.3 "this suite is the actual
// security control", §26.1–26.3, §11.4, §16.3, AC-13; Audit 05).
//
// Every user-owned resource × every viewer state × account kind × item
// visibility. Adding a resource is one row in SINGLE, LISTS or WRITES.
//
// The oracle below is written from the PRD tables, NOT from canView(): a test
// that derives its expectations from the code under test proves nothing.
//
// For each denial the 404 body must equal the body the same route returns for
// a random id, as the same viewer: a different message is a leak.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';

import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { ActivityService } from '../activity/index.js';
import { type Db } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import { MemoryObjectStorage } from '../providers/storage/index.js';
import {
  users, reviews, shelves, shelfItems, shelfSaves, readComments, readLikes, follows, blocks,
  imports, importRows, exports, refreshTokens, reads,
} from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, unlimited, type TestUser } from './interaction-fixtures.js';

const VIEWERS = ['guest', 'stranger', 'pending', 'follower', 'blockedBy', 'blocker', 'owner', 'unverified'] as const;
type Viewer = (typeof VIEWERS)[number];
// "private-account owner" (00-method's eighth state) is owner × ACCOUNTS.private.
const ACCOUNTS = ['public', 'private', 'deleted'] as const;
type Account = (typeof ACCOUNTS)[number];
const VIS = ['public', 'followers', 'private'] as const;
type Vis = (typeof VIS)[number];

/** PRD §26.1–26.2, §11.4, §25.4: may this viewer see an item of this visibility? */
function oracle(viewer: Viewer, account: Account, vis: Vis): boolean {
  if (account === 'deleted') return false; // §25.4: hidden platform-wide
  if (viewer === 'blockedBy' || viewer === 'blocker') return false; // §11.4
  if (viewer === 'owner') return true;
  if (vis === 'private') return false;
  if (account === 'private' || vis === 'followers') return viewer === 'follower'; // pending is not following
  return true;
}

/** Account-level content (stats, follower lists, the account itself): §16.3. */
const accountOracle = (viewer: Viewer, account: Account) => oracle(viewer, account, 'public');

/** Owner-only resources (imports, exports, sessions). */
const ownerOnly = (viewer: Viewer, account: Account) => viewer === 'owner' && account !== 'deleted';

interface OwnerFixture {
  user: TestUser;
  read: Record<Vis, string>;
  review: Record<Vis, string>;
  reviewRead: Record<Vis, string>;
  shelf: Record<Vis, { id: string; slug: string }>;
  comment: string;
  importId: string;
  exportId: string;
  sessionFamily: string;
}

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let mailer: MemoryEmailSender;
const viewers = {} as Record<Exclude<Viewer, 'guest' | 'owner'>, TestUser>;
const owners = {} as Record<Account, OwnerFixture>;
const workByVis = {} as Record<Vis, string>;
let reviewWork: string;
let spareWork: string;

function headersFor(viewer: Viewer, account: Account): Record<string, string> {
  if (viewer === 'guest') return {};
  if (viewer === 'owner') return owners[account].user.auth;
  return viewers[viewer].auth;
}

async function get(url: string, headers: Record<string, string>) {
  const res = await app.inject({ method: 'GET', url, headers });
  let body: any = res.payload;
  try { body = JSON.parse(res.payload); } catch { /* HTML routes */ }
  return { status: res.statusCode, body };
}

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  close = () => fresh.client.close();
  mailer = new MemoryEmailSender();
  app = await buildApp({
    db,
    identity: new IdentityService(db, unlimited, mailer),
    reading: new ReadingService(db),
    limiter: unlimited,
    storage: new MemoryObjectStorage(),
    mailer,
  });
  await app.ready();

  for (const v of VIS) workByVis[v] = await makeWork(db, `Work ${v}`);
  reviewWork = await makeWork(db, 'Reviewed work');
  spareWork = await makeWork(db, 'Spare work');

  viewers.stranger = await makeUser(db, 'v_stranger');
  viewers.pending = await makeUser(db, 'v_pending');
  viewers.follower = await makeUser(db, 'v_follower');
  viewers.blockedBy = await makeUser(db, 'v_blocked_by');
  viewers.blocker = await makeUser(db, 'v_blocker');
  viewers.unverified = await makeUser(db, 'v_unverified', { verified: false });

  const activityService = new ActivityService(db);

  for (const account of ACCOUNTS) {
    const user = await makeUser(db, `owner_${account}`, { isPrivate: account === 'private' });
    const o = { user, read: {}, review: {}, reviewRead: {}, shelf: {} } as OwnerFixture;

    await db.insert(follows).values([
      { followerId: viewers.pending.id, followeeId: user.id, state: 'pending' },
      { followerId: viewers.follower.id, followeeId: user.id, state: 'accepted' },
      // Followers lists need at least one row to show.
      { followerId: user.id, followeeId: viewers.stranger.id, state: 'accepted' },
    ]);
    await db.insert(blocks).values([
      { blockerId: user.id, blockedId: viewers.blockedBy.id },
      { blockerId: viewers.blocker.id, blockedId: user.id },
    ]);

    let attempt = 1;
    for (const v of VIS) {
      o.read[v] = await makeRead(db, user.id, workByVis[v], { visibility: v });
      // Reviews sit on PUBLIC reads, so only the review's own visibility varies.
      o.reviewRead[v] = await makeRead(db, user.id, reviewWork, { visibility: 'public', attemptNo: attempt++ });
      const [rv] = await db.insert(reviews).values({
        readId: o.reviewRead[v], userId: user.id, workId: reviewWork, body: `Review ${account} ${v}`, visibility: v,
      }).returning({ id: reviews.id });
      o.review[v] = rv!.id;
      const [sh] = await db.insert(shelves).values({
        userId: user.id, name: `Shelf ${v}`, slug: `shelf-${v}`, privacy: v, itemCount: 1, coverWorkIds: [workByVis[v]],
      }).returning({ id: shelves.id, slug: shelves.slug });
      o.shelf[v] = sh!;
      // Every signed-in viewer saved every shelf (before any block or privacy change).
      await db.insert(shelfSaves).values(
        (['stranger', 'pending', 'follower', 'blockedBy', 'blocker', 'unverified'] as const)
          .map((k) => ({ shelfId: sh!.id, userId: viewers[k].id })),
      );
      await db.insert(shelfItems).values({ shelfId: sh!.id, workId: workByVis[v], position: 1 } as any);
      // A like and a comment from the follower, so the lists have content.
      await db.insert(readLikes).values({ readId: o.read[v], userId: viewers.follower.id });
      await db.insert(readComments).values({ readId: o.read[v], userId: viewers.follower.id, body: 'Nice' });
      await activityService.recordActivity(db, {
        actorId: user.id, verb: 'finished', workId: workByVis[v], objectType: 'read', objectId: o.read[v],
        metadata: { readId: o.read[v] }, visibility: v, source: 'app',
      });
    }
    const [c] = await db.select({ id: readComments.id }).from(readComments)
      .where(eq(readComments.readId, o.read.public));
    o.comment = c!.id;

    const [imp] = await db.insert(imports).values({ userId: user.id, source: 'goodreads', state: 'completed' })
      .returning({ id: imports.id });
    o.importId = imp!.id;
    await db.insert(importRows).values({ importId: imp!.id, rowNo: 1, state: 'unmatched', raw: {} } as any);
    const [exp] = await db.insert(exports).values({ userId: user.id, format: 'csv', state: 'queued' } as any)
      .returning({ id: exports.id });
    o.exportId = exp!.id;
    o.sessionFamily = randomUUID();
    await db.insert(refreshTokens).values({
      userId: user.id, tokenHash: randomUUID(), familyId: o.sessionFamily, expiresAt: new Date(Date.now() + 86_400_000),
    });

    owners[account] = o;
  }

  await db.update(users).set({ deletedAt: new Date() }).where(eq(users.id, owners.deleted.user.id));
}, 60_000);

afterAll(async () => {
  await app?.close();
  await close?.();
});

// ---------------------------------------------------------------------------
// Single resources: 200 when visible; otherwise 404 with the random-id body.
// ---------------------------------------------------------------------------

interface SingleRow {
  name: string;
  /** null = the resource has no item visibility (account-level or owner-only). */
  vis: readonly Vis[] | null;
  url: (o: OwnerFixture, vis: Vis) => string;
  randomUrl: () => string;
  expected: (viewer: Viewer, account: Account, vis: Vis) => boolean;
  /** Routes that need a signed-in caller answer a guest 401, which reveals nothing. */
  signedInOnly?: boolean;
}

const R = () => randomUUID();
const SINGLE: SingleRow[] = [
  { name: 'GET /v1/reads/:id', vis: VIS, url: (o, v) => `/v1/reads/${o.read[v]}`, randomUrl: () => `/v1/reads/${R()}`, expected: oracle },
  { name: 'GET /v1/reviews/:id', vis: VIS, url: (o, v) => `/v1/reviews/${o.review[v]}`, randomUrl: () => `/v1/reviews/${R()}`, expected: oracle },
  { name: 'GET /v1/shelves/:id', vis: VIS, url: (o, v) => `/v1/shelves/${o.shelf[v].id}`, randomUrl: () => `/v1/shelves/${R()}`, expected: oracle },
  { name: 'GET /v1/shelves/:id/items', vis: VIS, url: (o, v) => `/v1/shelves/${o.shelf[v].id}/items`, randomUrl: () => `/v1/shelves/${R()}/items`, expected: oracle },
  {
    name: 'GET /v1/shelves/by-slug/:username/:slug', vis: VIS,
    url: (o, v) => `/v1/shelves/by-slug/${o.user.username}/${o.shelf[v].slug}`,
    randomUrl: () => `/v1/shelves/by-slug/nobody_here/shelf-public`, expected: oracle,
  },
  {
    name: 'GET /v1/users/:username/shelves/slug/:slug', vis: VIS,
    url: (o, v) => `/v1/users/${o.user.username}/shelves/slug/${o.shelf[v].slug}`,
    randomUrl: () => `/v1/users/nobody_here/shelves/slug/shelf-public`, expected: oracle,
  },
  { name: 'GET /v1/reads/:id/likes', vis: VIS, url: (o, v) => `/v1/reads/${o.read[v]}/likes`, randomUrl: () => `/v1/reads/${R()}/likes`, expected: oracle },
  { name: 'GET /v1/reads/:id/comments', vis: VIS, url: (o, v) => `/v1/reads/${o.read[v]}/comments`, randomUrl: () => `/v1/reads/${R()}/comments`, expected: oracle },
  { name: 'GET /v1/users/:id/stats', vis: null, url: (o) => `/v1/users/${o.user.id}/stats`, randomUrl: () => `/v1/users/${R()}/stats`, expected: accountOracle },
  { name: 'GET /v1/users/:id/followers', vis: null, url: (o) => `/v1/users/${o.user.id}/followers`, randomUrl: () => `/v1/users/${R()}/followers`, expected: accountOracle },
  { name: 'GET /v1/users/:id/following', vis: null, url: (o) => `/v1/users/${o.user.id}/following`, randomUrl: () => `/v1/users/${R()}/following`, expected: accountOracle },
  { name: 'GET /v1/users/:id/shelves', vis: null, url: (o) => `/v1/users/${o.user.id}/shelves`, randomUrl: () => `/v1/users/${R()}/shelves`, expected: accountOracle },
  { name: 'GET /v1/imports/:id', vis: null, url: (o) => `/v1/imports/${o.importId}`, randomUrl: () => `/v1/imports/${R()}`, expected: ownerOnly, signedInOnly: true },
  { name: 'GET /v1/imports/:id/rows', vis: null, url: (o) => `/v1/imports/${o.importId}/rows`, randomUrl: () => `/v1/imports/${R()}/rows`, expected: ownerOnly, signedInOnly: true },
  { name: 'GET /v1/exports/:id', vis: null, url: (o) => `/v1/exports/${o.exportId}`, randomUrl: () => `/v1/exports/${R()}`, expected: ownerOnly, signedInOnly: true },
];

/** Guest-only HTML/OG pages: public items only, and a denial looks like a missing page. */
const WEB: SingleRow[] = [
  { name: 'GET /shelf/:id', vis: VIS, url: (o, v) => `/shelf/${o.shelf[v].id}`, randomUrl: () => `/shelf/${R()}`, expected: oracle },
  {
    name: 'GET /u/:username/shelves/:slug', vis: VIS,
    url: (o, v) => `/u/${o.user.username}/shelves/${o.shelf[v].slug}`, randomUrl: () => `/u/nobody_here/shelves/shelf-public`, expected: oracle,
  },
];

async function runSingle(row: SingleRow, viewerList: readonly Viewer[]) {
  const mismatches: string[] = [];
  for (const account of ACCOUNTS) {
    for (const viewer of viewerList) {
      if (viewer === 'owner' && account === 'deleted') continue; // a deleted owner cannot sign in
      const headers = headersFor(viewer, account);
      if (viewer === 'guest' && row.signedInOnly) {
        const res = await get(row.url(owners[account], 'public'), headers);
        if (res.status !== 401) mismatches.push(`guest → ${account}: want 401, got ${res.status}`);
        continue;
      }
      const random = await get(row.randomUrl(), headers);
      for (const vis of row.vis ?? (['public'] as const)) {
        const res = await get(row.url(owners[account], vis), headers);
        const want = row.expected(viewer, account, vis);
        const label = `${viewer} → ${account} account, ${row.vis ? vis : 'n/a'}`;
        if (want && res.status !== 200) mismatches.push(`${label}: want 200, got ${res.status}`);
        if (!want) {
          if (res.status !== 404) mismatches.push(`${label}: want 404, got ${res.status}`);
          else if (JSON.stringify(res.body) !== JSON.stringify(random.body)) {
            mismatches.push(`${label}: 404 body differs from random id (${JSON.stringify(res.body)} vs ${JSON.stringify(random.body)})`);
          }
        }
      }
    }
  }
  return mismatches;
}

describe('authorization matrix: single resources (FN-72)', () => {
  it.each(SINGLE.map((r) => [r.name, r] as const))('%s', async (_name, row) => {
    expect(await runSingle(row, VIEWERS)).toEqual([]);
  });

  it.each(WEB.map((r) => [r.name, r] as const))('%s (web)', async (_name, row) => {
    expect(await runSingle(row, ['guest'])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Profiles: §16.3 and AC-13. A private account shows its header to signed-in
// non-followers (so they can request to follow); favourites are followers-only.
// Guests: 404 (§4.2 "private accounts are invisible to guests"; D-05-2).
// ---------------------------------------------------------------------------

function profileOracle(viewer: Viewer, account: Account): 'full' | 'restricted' | 'hidden' {
  if (account === 'deleted') return 'hidden';
  if (viewer === 'blockedBy' || viewer === 'blocker') return 'hidden';
  if (viewer === 'owner' || account === 'public' || viewer === 'follower') return 'full';
  if (viewer === 'guest') return 'hidden';
  return 'restricted';
}

describe('authorization matrix: profiles (§16.3, AC-13)', () => {
  it('GET /v1/users/:id', async () => {
    const mismatches: string[] = [];
    for (const account of ACCOUNTS) {
      for (const viewer of VIEWERS) {
        if (viewer === 'owner' && account === 'deleted') continue;
        const headers = headersFor(viewer, account);
        const random = await get(`/v1/users/${R()}`, headers);
        const res = await get(`/v1/users/${owners[account].user.id}`, headers);
        const want = profileOracle(viewer, account);
        const label = `${viewer} → ${account}`;
        if (want === 'hidden') {
          if (res.status !== 404 || JSON.stringify(res.body) !== JSON.stringify(random.body)) {
            mismatches.push(`${label}: want 404 like random, got ${res.status} ${JSON.stringify(res.body)}`);
          }
          continue;
        }
        if (res.status !== 200) { mismatches.push(`${label}: want 200 (${want}), got ${res.status}`); continue; }
        const restricted = res.body.isRestricted === true;
        if (restricted !== (want === 'restricted')) mismatches.push(`${label}: want ${want}, isRestricted=${res.body.isRestricted}`);
        if (want === 'restricted' && (res.body.favourites?.length ?? 0) + (res.body.favourite_work_ids?.length ?? 0) > 0) {
          mismatches.push(`${label}: restricted profile exposes favourites`);
        }
        if (viewer === 'pending' && res.body.followStatus !== 'pending') {
          mismatches.push(`${label}: pending viewer should see followStatus=pending, got ${res.body.followStatus}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Lists: an item appears iff the oracle allows it. A list the viewer may not
// see at all (404) counts as "absent".
// ---------------------------------------------------------------------------

interface ListRow {
  name: string;
  url: (o: OwnerFixture) => string;
  ids: (body: any) => string[];
  item: (o: OwnerFixture, vis: Vis) => string;
  /** Feeds are ranked and filtered for other reasons: only check that nothing leaks. */
  leakOnly?: boolean;
  viewers?: readonly Viewer[];
}

const LISTS: ListRow[] = [
  { name: 'GET /v1/users/:id/reads', url: (o) => `/v1/users/${o.user.id}/reads`, ids: (b) => (Array.isArray(b) ? b : b.data ?? b.reads ?? []).map((r: any) => r.id), item: (o, v) => o.read[v] },
  { name: 'GET /v1/users/:id/shelves', url: (o) => `/v1/users/${o.user.id}/shelves`, ids: (b) => (b.shelves ?? []).map((s: any) => s.id), item: (o, v) => o.shelf[v].id },
  { name: 'GET /v1/works/:id/reviews', url: () => `/v1/works/${reviewWork}/reviews?limit=100`, ids: (b) => (b.data ?? []).map((r: any) => r.id), item: (o, v) => o.review[v] },
  { name: 'GET /v1/shelves/browse', url: () => `/v1/shelves/browse?limit=50`, ids: (b) => (b.shelves ?? []).map((s: any) => s.id), item: (o, v) => o.shelf[v].id, leakOnly: true },
  {
    name: 'GET /v1/shelves/saved', url: () => '/v1/shelves/saved', ids: (b) => (b.shelves ?? []).map((s: any) => s.id),
    item: (o, v) => o.shelf[v].id, viewers: VIEWERS.filter((v) => v !== 'guest' && v !== 'owner'),
  },
  {
    name: 'GET /v1/feed?tab=popular', url: () => `/v1/feed?tab=popular&limit=50`, leakOnly: true,
    ids: (b) => (b.items ?? b.data ?? []).map((a: any) => a.object_id ?? a.read_id),
    item: (o, v) => o.read[v], viewers: VIEWERS.filter((v) => v !== 'guest'),
  },
  {
    name: 'GET /v1/feed?tab=friends', url: () => `/v1/feed?tab=friends&limit=50`, leakOnly: true,
    ids: (b) => (b.items ?? b.data ?? []).map((a: any) => a.object_id ?? a.read_id),
    item: (o, v) => o.read[v], viewers: VIEWERS.filter((v) => v !== 'guest'),
  },
];

describe('authorization matrix: lists (FN-71 equivalence, seen from HTTP)', () => {
  it.each(LISTS.map((r) => [r.name, r] as const))('%s', async (_name, row) => {
    const mismatches: string[] = [];
    for (const account of ACCOUNTS) {
      for (const viewer of row.viewers ?? VIEWERS) {
        if (viewer === 'owner' && account === 'deleted') continue;
        const res = await get(row.url(owners[account]), headersFor(viewer, account));
        if (res.status !== 200 && res.status !== 404) {
          mismatches.push(`${viewer} → ${account}: status ${res.status}`);
          continue;
        }
        const present = new Set(res.status === 200 ? row.ids(res.body) : []);
        for (const vis of VIS) {
          const want = oracle(viewer, account, vis);
          const has = present.has(row.item(owners[account], vis));
          if (has && !want) mismatches.push(`${viewer} → ${account}, ${vis}: LEAKED`);
          if (!row.leakOnly && want && !has) mismatches.push(`${viewer} → ${account}, ${vis}: missing`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Writes on someone else's resource: 404 like a random id, and no effect.
// ---------------------------------------------------------------------------

interface WriteRow {
  name: string;
  method: 'POST' | 'PATCH' | 'PUT' | 'DELETE';
  url: (o: OwnerFixture, vis: Vis) => string;
  randomUrl: () => string;
  body?: () => unknown;
  /** Which of the owner's items to target. Default: every visibility. */
  vis?: readonly Vis[];
  /** Viewers for whom the target is their own (e.g. the comment's author). */
  except?: readonly Viewer[];
}

const WRITES: WriteRow[] = [
  { name: 'PATCH /v1/reviews/:id', method: 'PATCH', url: (o, v) => `/v1/reviews/${o.review[v]}`, randomUrl: () => `/v1/reviews/${R()}`, body: () => ({ body: 'hijacked' }) },
  { name: 'DELETE /v1/reviews/:id', method: 'DELETE', url: (o, v) => `/v1/reviews/${o.review[v]}`, randomUrl: () => `/v1/reviews/${R()}` },
  { name: 'POST /v1/reads/:id/review', method: 'POST', url: (o, v) => `/v1/reads/${o.read[v]}/review`, randomUrl: () => `/v1/reads/${R()}/review`, body: () => ({ body: 'hijacked' }) },
  { name: 'POST /v1/reads/:id/progress', method: 'POST', url: (o, v) => `/v1/reads/${o.read[v]}/progress`, randomUrl: () => `/v1/reads/${R()}/progress`, body: () => ({ client_event_id: randomUUID(), page: 5 }) },
  { name: 'POST /v1/reads/:id/finish', method: 'POST', url: (o, v) => `/v1/reads/${o.read[v]}/finish`, randomUrl: () => `/v1/reads/${R()}/finish`, body: () => ({}) },
  { name: 'POST /v1/reads/:id/dnf', method: 'POST', url: (o, v) => `/v1/reads/${o.read[v]}/dnf`, randomUrl: () => `/v1/reads/${R()}/dnf`, body: () => ({}) },
  { name: 'PATCH /v1/shelves/:id', method: 'PATCH', url: (o, v) => `/v1/shelves/${o.shelf[v].id}`, randomUrl: () => `/v1/shelves/${R()}`, body: () => ({ name: 'hijacked' }) },
  { name: 'DELETE /v1/shelves/:id', method: 'DELETE', url: (o, v) => `/v1/shelves/${o.shelf[v].id}`, randomUrl: () => `/v1/shelves/${R()}` },
  { name: 'POST /v1/shelves/:id/items', method: 'POST', url: (o, v) => `/v1/shelves/${o.shelf[v].id}/items`, randomUrl: () => `/v1/shelves/${R()}/items`, body: () => ({ work_id: spareWork }) },
  { name: 'PATCH /v1/shelves/:id/items/:workId', method: 'PATCH', url: (o, v) => `/v1/shelves/${o.shelf[v].id}/items/${workByVis[v]}`, randomUrl: () => `/v1/shelves/${R()}/items/${spareWork}`, body: () => ({ note: 'hijacked' }) },
  { name: 'DELETE /v1/shelves/:id/items/:workId', method: 'DELETE', url: (o, v) => `/v1/shelves/${o.shelf[v].id}/items/${workByVis[v]}`, randomUrl: () => `/v1/shelves/${R()}/items/${spareWork}` },
  { name: 'PUT /v1/shelves/:id/order', method: 'PUT', url: (o, v) => `/v1/shelves/${o.shelf[v].id}/order`, randomUrl: () => `/v1/shelves/${R()}/order`, body: () => ({ work_ids: [spareWork] }) },
  { name: 'DELETE /v1/comments/:id', method: 'DELETE', url: (o) => `/v1/comments/${o.comment}`, randomUrl: () => `/v1/comments/${R()}`, vis: ['public'], except: ['follower'] },
  { name: 'DELETE /v1/auth/sessions/:id', method: 'DELETE', url: (o) => `/v1/auth/sessions/${o.sessionFamily}`, randomUrl: () => `/v1/auth/sessions/${R()}`, vis: ['public'] },
  { name: 'POST /v1/imports/:id/rows/:rowNo/skip', method: 'POST', url: (o) => `/v1/imports/${o.importId}/rows/1/skip`, randomUrl: () => `/v1/imports/${R()}/rows/1/skip`, vis: ['public'] },
  { name: 'POST /v1/imports/:id/rows/:rowNo/resolve', method: 'POST', url: (o) => `/v1/imports/${o.importId}/rows/1/resolve`, randomUrl: () => `/v1/imports/${R()}/rows/1/resolve`, body: () => ({ work_id: spareWork }), vis: ['public'] },
  // Social writes on something the viewer cannot see: the hidden read.
  { name: 'POST /v1/reads/:id/like (hidden read)', method: 'POST', url: (o) => `/v1/reads/${o.read.private}/like`, randomUrl: () => `/v1/reads/${R()}/like`, vis: ['private'] },
  { name: 'DELETE /v1/reads/:id/like (hidden read)', method: 'DELETE', url: (o) => `/v1/reads/${o.read.private}/like`, randomUrl: () => `/v1/reads/${R()}/like`, vis: ['private'] },
  { name: 'POST /v1/reads/:id/comments (hidden read)', method: 'POST', url: (o) => `/v1/reads/${o.read.private}/comments`, randomUrl: () => `/v1/reads/${R()}/comments`, body: () => ({ body: 'hi' }), vis: ['private'] },
  { name: 'POST /v1/shelves/:id/save (hidden shelf)', method: 'POST', url: (o) => `/v1/shelves/${o.shelf.private.id}/save`, randomUrl: () => `/v1/shelves/${R()}/save`, vis: ['private'] },
];

/** Signed-in non-owners, verified, with every relationship to the owner. */
const WRITERS = ['stranger', 'pending', 'follower', 'blockedBy', 'blocker'] as const;

describe('authorization matrix: writes on another user\'s resource', () => {
  it.each(WRITES.map((r) => [r.name, r] as const))('%s → 404 like a random id', async (_name, row) => {
    const mismatches: string[] = [];
    for (const account of ['public', 'private'] as const) {
      for (const viewer of WRITERS) {
        if (row.except?.includes(viewer)) continue;
        const headers = viewers[viewer].auth;
        const random = await app.inject({ method: row.method, url: row.randomUrl(), headers, payload: row.body?.() as any });
        for (const vis of row.vis ?? VIS) {
          const res = await app.inject({ method: row.method, url: row.url(owners[account], vis), headers, payload: row.body?.() as any });
          const label = `${viewer} → ${account}, ${vis}`;
          if (res.statusCode !== 404) mismatches.push(`${label}: want 404, got ${res.statusCode} ${res.payload.slice(0, 120)}`);
          else if (res.payload !== random.payload) mismatches.push(`${label}: body differs from random (${res.payload} vs ${random.payload})`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('left every owner resource untouched', async () => {
    const o = owners.public;
    const [rv] = await db.select({ body: reviews.body, deletedAt: reviews.deletedAt }).from(reviews).where(eq(reviews.id, o.review.public));
    expect(rv).toEqual({ body: 'Review public public', deletedAt: null });
    const [sh] = await db.select({ name: shelves.name, deletedAt: shelves.deletedAt }).from(shelves).where(eq(shelves.id, o.shelf.public.id));
    expect(sh).toEqual({ name: 'Shelf public', deletedAt: null });
    const items = await db.select().from(shelfItems).where(eq(shelfItems.shelfId, o.shelf.public.id));
    expect(items.map((i) => [i.workId, i.note ?? null])).toEqual([[workByVis.public, null]]);
    const [rd] = await db.select({ status: reads.status }).from(reads).where(eq(reads.id, o.read.public));
    expect(rd!.status).toBe('finished');
    const [pe] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM progress_events`);
    expect(pe!.n).toBe(0);
    const [cm] = await db.select({ deletedAt: readComments.deletedAt }).from(readComments).where(eq(readComments.id, o.comment));
    expect(cm!.deletedAt).toBeNull();
    const [tok] = await db.select({ revokedAt: refreshTokens.revokedAt }).from(refreshTokens).where(eq(refreshTokens.familyId, o.sessionFamily));
    expect(tok!.revokedAt).toBeNull();
    const [row] = await db.select({ state: importRows.state }).from(importRows).where(eq(importRows.importId, o.importId));
    expect(row!.state).toBe('unmatched');
  });
});

// ---------------------------------------------------------------------------
// The ninth viewer: signed in, email unverified (D-04-1, PRD §25.3, §6.6).
// Reading, logging and shelving stay open; reviews, comments and follows are
// refused with 403 email_unverified, before any write.
// ---------------------------------------------------------------------------

describe('authorization matrix: unverified accounts (D-04-1)', () => {
  const refused = (res: { statusCode: number; payload: string }) =>
    res.statusCode === 403 && JSON.parse(res.payload).error.code === 'email_unverified';

  it('cannot publish a review, and the refused request writes nothing', async () => {
    const u = viewers.unverified;
    const readId = await makeRead(db, u.id, spareWork, { rating: '3.0' });
    const res = await app.inject({
      method: 'POST', url: `/v1/reads/${readId}/review`, headers: u.auth,
      payload: { body: 'My take', rating: 5 },
    });
    expect(refused(res)).toBe(true);
    const [rd] = await db.select({ rating: reads.rating }).from(reads).where(eq(reads.id, readId));
    expect(rd!.rating).toBe('3.0');
    const rows = await db.select().from(reviews).where(eq(reviews.readId, readId));
    expect(rows).toHaveLength(0);
  });

  it('cannot comment', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/reads/${owners.public.read.public}/comments`, headers: viewers.unverified.auth,
      payload: { body: 'hello' },
    });
    expect(refused(res)).toBe(true);
  });

  it.each([
    ['POST /v1/users/:id/follow', (id: string) => `/v1/users/${id}/follow`],
    ['POST /v1/follows/:userId', (id: string) => `/v1/follows/${id}`],
  ])('cannot follow via %s', async (_n, url) => {
    const res = await app.inject({ method: 'POST', url: url(owners.public.user.id), headers: viewers.unverified.auth });
    expect(refused(res)).toBe(true);
    const rows = await db.select().from(follows).where(eq(follows.followerId, viewers.unverified.id));
    expect(rows).toHaveLength(0);
  });

  it('can still read, log reads, like and shelve', async () => {
    const h = viewers.unverified.auth;
    expect((await app.inject({ method: 'GET', url: `/v1/reads/${owners.public.read.public}`, headers: h })).statusCode).toBe(200);
    const logged = await app.inject({ method: 'POST', url: '/v1/reads', headers: h, payload: { work_id: workByVis.public, status: 'reading' } });
    expect(logged.statusCode).toBeLessThan(300);
    const shelf = await app.inject({ method: 'POST', url: '/v1/shelves', headers: h, payload: { name: 'Mine' } });
    expect(shelf.statusCode).toBeLessThan(300);
    const item = await app.inject({ method: 'POST', url: `/v1/shelves/${JSON.parse(shelf.payload).shelf.id}/items`, headers: h, payload: { work_id: workByVis.public } });
    expect(item.statusCode, item.payload).toBeLessThan(300);
    const like = await app.inject({ method: 'POST', url: `/v1/reads/${owners.public.read.public}/like`, headers: h });
    expect(like.statusCode).toBe(200);
  });

  it('a verified account passes the same gates', async () => {
    const res = await app.inject({
      method: 'POST', url: `/v1/reads/${owners.public.read.public}/comments`, headers: viewers.stranger.auth,
      payload: { body: 'hello' },
    });
    expect(res.statusCode).toBe(201);
  });
});

// ---------------------------------------------------------------------------
// A review sits on a read; each has its own visibility (PRD §26.2). What is
// shown is the stricter of the two, on the detail route and in the list.
// ---------------------------------------------------------------------------

describe('review visibility is the stricter of review and read (lead 3)', () => {
  it.each([
    ['private', { guest: false, stranger: false, follower: false, owner: true }],
    ['followers', { guest: false, stranger: false, follower: true, owner: true }],
  ] as const)('public review on a %s read', async (readVis, want) => {
    const o = owners.public;
    const work = await makeWork(db, `Stricter ${readVis}`);
    const readId = await makeRead(db, o.user.id, work, { visibility: readVis });
    const [rv] = await db.insert(reviews).values({
      readId, userId: o.user.id, workId: work, body: 'Public review, restricted read', visibility: 'public',
    }).returning({ id: reviews.id });

    for (const [viewer, visible] of Object.entries(want) as [Viewer, boolean][]) {
      const headers = headersFor(viewer, 'public');
      const one = await app.inject({ method: 'GET', url: `/v1/reviews/${rv!.id}`, headers });
      expect(one.statusCode, `${viewer} GET`).toBe(visible ? 200 : 404);
      const list = JSON.parse((await app.inject({ method: 'GET', url: `/v1/works/${work}/reviews`, headers })).payload);
      expect(list.data.map((r: { id: string }) => r.id).includes(rv!.id), `${viewer} list`).toBe(visible);
    }
  });
});

// ---------------------------------------------------------------------------
// Follow is idempotent (Audit 05): a replayed follow (offline queue, double
// tap) must not demote an accepted follow to a request after the account
// went private, nor record a second 'followed' activity.
// ---------------------------------------------------------------------------

describe('follow replay is idempotent', () => {
  it('re-following an account that went private keeps the accepted follow', async () => {
    const a = await makeUser(db, 'replay_follower');
    const b = await makeUser(db, 'replay_target');
    const first = await app.inject({ method: 'POST', url: `/v1/users/${b.id}/follow`, headers: a.auth });
    expect(JSON.parse(first.payload).status).toBe('accepted');

    await db.execute(sql`UPDATE profiles SET is_private = true WHERE user_id = ${b.id}::uuid`);
    const replay = await app.inject({ method: 'POST', url: `/v1/users/${b.id}/follow`, headers: a.auth });
    expect(replay.statusCode).toBe(200);
    expect(JSON.parse(replay.payload).status).toBe('accepted');

    const [row] = await db.select({ state: follows.state }).from(follows)
      .where(sql`${follows.followerId} = ${a.id}::uuid AND ${follows.followeeId} = ${b.id}::uuid`);
    expect(row!.state).toBe('accepted');
    const [n] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM activity WHERE actor_id = ${a.id}::uuid AND verb = 'followed'`);
    expect(n!.n).toBe(1);
  });

  // Audit 07b (D-07-2): the offline queue replays follow and unfollow as desired states.
  it('a replayed request to a private account stays one pending request', async () => {
    const a = await makeUser(db, 'replay_requester');
    const b = await makeUser(db, 'replay_private', { isPrivate: true });
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'POST', url: `/v1/users/${b.id}/follow`, headers: a.auth });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).status).toBe('pending');
    }
    const [n] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM follows WHERE follower_id = ${a.id}::uuid AND followee_id = ${b.id}::uuid`);
    expect(n!.n).toBe(1);
  });

  it('a replayed unfollow is a 200 with nothing left to remove', async () => {
    const a = await makeUser(db, 'replay_unfollower');
    const b = await makeUser(db, 'replay_unfollowed');
    await app.inject({ method: 'POST', url: `/v1/users/${b.id}/follow`, headers: a.auth });
    for (let i = 0; i < 2; i++) {
      const res = await app.inject({ method: 'DELETE', url: `/v1/users/${b.id}/follow`, headers: a.auth });
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.payload).status).toBe('none');
    }
    const [n] = await db.execute<{ n: number }>(sql`
      SELECT count(*)::int AS n FROM follows WHERE follower_id = ${a.id}::uuid AND followee_id = ${b.id}::uuid`);
    expect(n!.n).toBe(0);
  });
});

describe('the feed is served once, under /v1 (lead 4)', () => {
  it('GET /feed (no prefix) is a plain 404', async () => {
    const res = await app.inject({ method: 'GET', url: '/feed', headers: viewers.stranger.auth });
    expect(res.statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/v1/feed', headers: viewers.stranger.auth })).statusCode).toBe(200);
  });
});
