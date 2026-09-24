// SO-22: comments — single-level, rate-limited, attached to the read.
//
// PRD §6.28 (flat thread, 5/min, deleted review → read-only), §10.3 (target
// the read, terminal only), §11.4 (block hides the other party's comments).

import { describe, it, expect, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { ReviewService } from '../reviews/index.js';
import type { Db, RateLimiter } from '../platform/index.js';
import {
  interactionHarness,
  makeUser,
  makeWork,
  makeRead,
  follow,
  block,
  unlimited,
  type TestUser,
} from './interaction-fixtures.js';

describe('SO-22: comments on reads', () => {
  let db: Db;
  let app: FastifyInstance;
  let alice: TestUser;
  let bob: TestUser;
  let carol: TestUser;
  let workId: string;
  let readId: string;

  const post = (who: TestUser | null, body: unknown, id = readId) =>
    app.inject({
      method: 'POST',
      url: `/v1/reads/${id}/comments`,
      headers: who ? who.auth : {},
      payload: body as object,
    });
  const list = (who: TestUser | null, query = '', id = readId) =>
    app.inject({ method: 'GET', url: `/v1/reads/${id}/comments${query}`, headers: who ? who.auth : {} });

  /** 'production' = no limiter injected, so buildApp's Postgres-backed default is what runs. */
  async function setup(limiter: RateLimiter | 'production' = unlimited) {
    ({ db, app } = await interactionHarness({ limiter: limiter === 'production' ? undefined : limiter }));
    alice = await makeUser(db, 'alice');
    bob = await makeUser(db, 'bob');
    carol = await makeUser(db, 'carol');
    workId = await makeWork(db, 'A Wizard of Earthsea');
    readId = await makeRead(db, alice.id, workId, { status: 'finished' });
  }

  describe('with throttling out of the way', () => {
    beforeEach(() => setup());

    it('posts and lists oldest-first, and the read\'s comment_count follows', async () => {
      const first = await post(bob, { body: '  First!  ' });
      expect(first.statusCode).toBe(201);
      expect(first.json()).toMatchObject({ body: 'First!', read_id: readId, viewer_can_delete: true });
      expect(first.json().author.username).toBe('bob');
      await post(carol, { body: 'Second.' });

      const res = await list(alice);
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.comment_count).toBe(2);
      expect(body.locked).toBe(false);
      expect(body.comments.map((c: { body: string }) => c.body)).toEqual(['First!', 'Second.']);
      // Alice owns the read but not the comments: delete-own only (PRD §6.28).
      expect(body.comments.every((c: { viewer_can_delete: boolean }) => !c.viewer_can_delete)).toBe(true);
    });

    it('a finish with no review can be commented on; a non-terminal read cannot', async () => {
      expect((await post(bob, { body: 'Nice' })).statusCode).toBe(201);
      const reading = await makeRead(db, alice.id, await makeWork(db, 'Tehanu'), { status: 'reading' });
      const res = await post(bob, { body: 'Nice' }, reading);
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('not_commentable');
    });

    it('single-level: a parent_id is not part of the contract and cannot create nesting', async () => {
      const parent = (await post(bob, { body: 'Parent' })).json();
      const reply = await post(carol, { body: 'Reply?', parent_id: parent.id });
      // Fastify strips unknown properties; the comment is simply top-level.
      expect(reply.statusCode).toBe(201);
      expect(reply.json()).not.toHaveProperty('parent_id');
      const thread = (await list(bob)).json().comments;
      expect(thread).toHaveLength(2);
      expect(thread.every((c: object) => !('parent_id' in c) && !('replies' in c))).toBe(true);
    });

    it('rejects empty, whitespace-only and over-length bodies', async () => {
      expect((await post(bob, { body: '' })).statusCode).toBe(422);
      const ws = await post(bob, { body: '     ' });
      expect(ws.statusCode).toBe(400);
      expect(ws.json().error.code).toBe('empty_body');
      expect((await post(bob, { body: 'x'.repeat(2001) })).statusCode).toBe(422);
      expect((await post(bob, { body: 'x'.repeat(2000) })).statusCode).toBe(201);
    });

    it('guests can read a public thread but cannot post', async () => {
      await post(bob, { body: 'Hello' });
      expect((await list(null)).json().comments).toHaveLength(1);
      expect((await post(null, { body: 'Hi' })).statusCode).toBe(401);
    });

    it('delete own → 204 and the count drops; someone else\'s → 404', async () => {
      const mine = (await post(bob, { body: 'Mine' })).json();
      const theirs = (await post(carol, { body: 'Theirs' })).json();

      const stolen = await app.inject({ method: 'DELETE', url: `/v1/comments/${theirs.id}`, headers: bob.auth });
      expect(stolen.statusCode).toBe(404);
      // The read owner is not a moderator of the thread either.
      const byOwner = await app.inject({ method: 'DELETE', url: `/v1/comments/${theirs.id}`, headers: alice.auth });
      expect(byOwner.statusCode).toBe(404);

      const del = await app.inject({ method: 'DELETE', url: `/v1/comments/${mine.id}`, headers: bob.auth });
      expect(del.statusCode).toBe(204);
      const again = await app.inject({ method: 'DELETE', url: `/v1/comments/${mine.id}`, headers: bob.auth });
      expect(again.statusCode).toBe(404);

      const thread = (await list(alice)).json();
      expect(thread.comment_count).toBe(1);
      expect(thread.comments.map((c: { body: string }) => c.body)).toEqual(['Theirs']);
    });

    it('a deleted review locks its thread: readable, not writable (PRD §6.28)', async () => {
      const reviews = new ReviewService(db);
      const review = await reviews.upsertReview(alice.id, readId, { body: 'Deep and strange.' });
      await post(bob, { body: 'Agreed' });
      await reviews.deleteReview(review.id, alice.id);

      const res = await post(carol, { body: 'Too late' });
      expect(res.statusCode).toBe(409);
      expect(res.json().error.code).toBe('thread_locked');

      const thread = (await list(carol)).json();
      expect(thread.locked).toBe(true);
      expect(thread.comments).toHaveLength(1);
    });

    it('cursor pagination walks the whole thread exactly once', async () => {
      for (let i = 1; i <= 7; i++) await post(bob, { body: `c${i}` });
      const seen: string[] = [];
      let cursor: string | null = null;
      let pages = 0;
      do {
        const q: string = `?limit=3${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page: { comments: { body: string }[]; next_cursor: string | null } = (await list(alice, q)).json();
        seen.push(...page.comments.map((c) => c.body));
        cursor = page.next_cursor;
        pages++;
      } while (cursor && pages < 10);
      expect(seen).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
      expect(pages).toBe(3);
    });

    it('a malformed cursor is a 400, not a 500', async () => {
      const res = await list(alice, '?cursor=not-a-cursor');
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe('invalid_cursor');
    });

    describe('privacy and blocking', () => {
      it('cannot comment on, or read comments of, a read you cannot see (404)', async () => {
        const hidden = await makeRead(db, alice.id, await makeWork(db, 'Tehanu'), { visibility: 'followers' });
        expect((await post(bob, { body: 'hi' }, hidden)).statusCode).toBe(404);
        expect((await list(bob, '', hidden)).statusCode).toBe(404);
        await follow(db, bob.id, alice.id);
        expect((await post(bob, { body: 'hi' }, hidden)).statusCode).toBe(201);
      });

      it('a blocked user cannot comment: the read does not exist for them', async () => {
        await block(db, alice.id, bob.id);
        expect((await post(bob, { body: 'hi' })).statusCode).toBe(404);
      });

      it('existing comments from someone you blocked are hidden from you, not from others', async () => {
        await post(bob, { body: 'from bob' });
        await post(carol, { body: 'from carol' });
        await block(db, alice.id, carol.id);

        const forAlice = (await list(alice)).json().comments.map((c: { body: string }) => c.body);
        expect(forAlice).toEqual(['from bob']);
        const forBob = (await list(bob)).json().comments.map((c: { body: string }) => c.body);
        expect(forBob).toEqual(['from bob', 'from carol']);
      });
    });

    it('feed cards carry comment_count', async () => {
      await follow(db, bob.id, alice.id);
      const reviews = new ReviewService(db);
      await reviews.upsertReview(alice.id, readId, { body: 'Quiet power.' });
      await post(carol, { body: 'Yes' });
      const feed = await app.inject({ method: 'GET', url: '/v1/feed?tab=friends', headers: bob.auth });
      const card = feed.json().items.find((i: { verb: string }) => i.verb === 'reviewed');
      expect(card.interaction.comment_count).toBe(1);
    });
  });

  describe('rate limit: 5 comments per minute (PRD §11.7)', () => {
    it('the sixth comment inside a minute is 429, and it is per user', async () => {
      await setup('production');
      for (let i = 1; i <= 5; i++) expect((await post(bob, { body: `c${i}` })).statusCode).toBe(201);
      const sixth = await post(bob, { body: 'c6' });
      expect(sixth.statusCode).toBe(429);
      expect(sixth.json().error.code).toBe('rate_limited');
      // Carol has her own bucket.
      expect((await post(carol, { body: 'hi' })).statusCode).toBe(201);
      // The rejected comment was never written.
      expect((await list(alice)).json().comment_count).toBe(6);
    });

    it('rejections that never reach the write do not consume the budget', async () => {
      await setup('production');
      const reading = await makeRead(db, alice.id, await makeWork(db, 'Tehanu'), { status: 'reading' });
      for (let i = 0; i < 6; i++) await post(bob, { body: 'x' }, reading); // 409s
      expect((await post(bob, { body: 'real one' })).statusCode).toBe(201);
    });

    it('uses the injected limiter bucket and window', async () => {
      const calls: [string, number, number][] = [];
      await setup({ allow: async (b, l, w) => (calls.push([b, l, w]), true) });
      await post(bob, { body: 'hi' });
      expect(calls).toEqual([[`comments:${bob.id}`, 5, 60]]);
    });
  });
});
