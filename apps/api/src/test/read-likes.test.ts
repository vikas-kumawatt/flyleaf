// SO-21 ⚠️: likes target the READ — a finish with no review is likeable.
//
// PRD §10.3 [LOCKED]. The core social event (a finish, with or without a
// review) must be likeable, only terminal reads are social objects, and a
// like button must never reveal a read the caller cannot see.

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReadingService } from '../reading/index.js';
import { ReviewService } from '../reviews/index.js';
import type { Db } from '../platform/index.js';
import {
  interactionHarness,
  makeUser,
  makeWork,
  makeRead,
  follow,
  block,
  type TestUser,
} from './interaction-fixtures.js';

describe('SO-21: likes target the read', () => {
  let db: Db;
  let app: FastifyInstance;
  let alice: TestUser; // owner
  let bob: TestUser; // likes things
  let carol: TestUser;
  let workId: string;

  const like = (readId: string, who: TestUser | null) =>
    app.inject({ method: 'POST', url: `/v1/reads/${readId}/like`, headers: who ? who.auth : {} });
  const unlike = (readId: string, who: TestUser) =>
    app.inject({ method: 'DELETE', url: `/v1/reads/${readId}/like`, headers: who.auth });

  beforeEach(async () => {
    ({ db, app } = await interactionHarness());
    alice = await makeUser(db, 'alice');
    bob = await makeUser(db, 'bob');
    carol = await makeUser(db, 'carol');
    workId = await makeWork(db, 'The Left Hand of Darkness');
  });

  it('⚠️ a finish with NO review is likeable', async () => {
    const readId = await makeRead(db, alice.id, workId, { status: 'finished', rating: '4.0' });
    const res = await like(readId, bob);
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ liked: true, like_count: 1 });
  });

  it('a DNF is likeable too — it is a terminal read', async () => {
    const readId = await makeRead(db, alice.id, workId, { status: 'dnf' });
    expect((await like(readId, bob)).statusCode).toBe(200);
  });

  it.each(['want', 'reading', 'paused'] as const)(
    'a %s read is not a social object: 409 not_likeable',
    async (status) => {
      const readId = await makeRead(db, alice.id, workId, { status });
      const res = await like(readId, bob);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('not_likeable');
    },
  );

  it('POST is idempotent (safe for offline replay); DELETE unlikes and is idempotent too', async () => {
    const readId = await makeRead(db, alice.id, workId);
    await like(readId, bob);
    await like(readId, bob);
    expect((await like(readId, carol)).json().like_count).toBe(2);

    expect((await unlike(readId, bob)).json()).toEqual({ liked: false, like_count: 1 });
    expect((await unlike(readId, bob)).json()).toEqual({ liked: false, like_count: 1 });
  });

  it('guests cannot like', async () => {
    const readId = await makeRead(db, alice.id, workId);
    expect((await like(readId, null)).statusCode).toBe(401);
  });

  it('a review\'s likes ARE its read\'s likes: the permalink shows the same number', async () => {
    const readId = await makeRead(db, alice.id, workId);
    const review = await new ReviewService(db).upsertReview(alice.id, readId, { body: 'Quietly enormous.' });
    await like(readId, bob);
    await like(readId, carol);

    const res = await app.inject({ method: 'GET', url: `/v1/reviews/${review.id}`, headers: bob.auth });
    expect(res.json()).toMatchObject({ like_count: 2, comment_count: 0, viewer_has_liked: true });
  });

  it('a re-read is a separate read and collects its own likes', async () => {
    const first = await makeRead(db, alice.id, workId, { attemptNo: 1 });
    const second = await makeRead(db, alice.id, workId, { attemptNo: 2 });
    await like(first, bob);
    await like(first, carol);
    expect((await like(second, bob)).json().like_count).toBe(1);
  });

  describe('visibility: every denial is the same 404 as a read that does not exist', () => {
    const missing = '00000000-0000-4000-8000-000000000000';

    async function expectIndistinguishable(readId: string, who: TestUser) {
      const denied = await like(readId, who);
      const absent = await like(missing, who);
      expect(denied.statusCode).toBe(404);
      expect(denied.json()).toEqual(absent.json());
    }

    it('private read', async () => {
      await expectIndistinguishable(await makeRead(db, alice.id, workId, { visibility: 'private' }), bob);
    });

    it('followers-only read: 404 for a stranger, allowed for a follower', async () => {
      const readId = await makeRead(db, alice.id, workId, { visibility: 'followers' });
      await expectIndistinguishable(readId, bob);
      await follow(db, carol.id, alice.id);
      expect((await like(readId, carol)).statusCode).toBe(200);
    });

    it('public read on a private account', async () => {
      const dora = await makeUser(db, 'dora', { isPrivate: true });
      await expectIndistinguishable(await makeRead(db, dora.id, workId), bob);
    });

    it('blocked in either direction', async () => {
      const readId = await makeRead(db, alice.id, workId);
      await block(db, alice.id, bob.id);
      await expectIndistinguishable(readId, bob);
      await block(db, carol.id, alice.id);
      await expectIndistinguishable(readId, carol);
    });

    it('unlike on a hidden read is also a 404, not a silent success', async () => {
      const readId = await makeRead(db, alice.id, workId, { visibility: 'private' });
      expect((await unlike(readId, bob)).statusCode).toBe(404);
    });
  });

  it('likers list: newest first, and users in a block relationship with the viewer are hidden', async () => {
    const readId = await makeRead(db, alice.id, workId);
    await like(readId, bob);
    await like(readId, carol);
    await block(db, alice.id, carol.id); // carol's like stays, but alice no longer sees it

    const res = await app.inject({ method: 'GET', url: `/v1/reads/${readId}/likes`, headers: alice.auth });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users.map((u: { username: string }) => u.username)).toEqual(['bob']);

    const guest = await app.inject({ method: 'GET', url: `/v1/reads/${readId}/likes` });
    expect(guest.json().users.map((u: { username: string }) => u.username).sort()).toEqual(['bob', 'carol']);
  });

  describe('feed cards carry the read\'s interaction state', () => {
    it('⚠️ a finished-no-review card is likeable in the feed; a "started" card is not', async () => {
      const reading = new ReadingService(db);
      await follow(db, bob.id, alice.id);

      const started = await reading.upsert(alice.id, workId, 'reading');
      const otherWork = await makeWork(db, 'Piranesi');
      const toFinish = await reading.upsert(alice.id, otherWork, 'reading');
      await reading.finish(alice.id, toFinish.id, { rating: 4.5 });
      await like(toFinish.id, carol);

      const feed = await app.inject({ method: 'GET', url: '/v1/feed?tab=friends', headers: bob.auth });
      expect(feed.statusCode).toBe(200);
      const items = feed.json().items as Array<{ verb: string; object_id: string; interaction: unknown }>;

      const finishCard = items.find((i) => i.verb === 'finished');
      expect(finishCard?.interaction).toEqual({
        read_id: toFinish.id,
        like_count: 1,
        comment_count: 0,
        viewer_has_liked: false,
      });

      // Every non-social card (started, possibly aggregated) carries null.
      const nonSocial = items.filter((i) => !['finished', 'dnf', 'reviewed'].includes(i.verb));
      expect(nonSocial.some((i) => i.verb === 'started')).toBe(true);
      for (const card of nonSocial) expect(card.interaction).toBeNull();
      // The started read itself refuses a like.
      expect((await like(started.id, bob)).statusCode).toBe(409);

      // And liking straight from the card works with the id it carries.
      expect((await like(toFinish.id, bob)).json().like_count).toBe(2);
    });

    it('a review card points at the review\'s parent read', async () => {
      await follow(db, bob.id, alice.id);
      const readId = await makeRead(db, alice.id, workId);
      await new ReviewService(db).upsertReview(alice.id, readId, { body: 'A masterpiece of estrangement.' });
      await like(readId, bob);

      const feed = await app.inject({ method: 'GET', url: '/v1/feed?tab=friends', headers: bob.auth });
      const reviewCard = feed.json().items.find((i: { verb: string }) => i.verb === 'reviewed');
      expect(reviewCard.interaction).toMatchObject({ read_id: readId, like_count: 1, viewer_has_liked: true });
    });
  });
});
