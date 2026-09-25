// Integration tests for SO-10: activity table + write-on-action, respecting visibility.

import { describe, it, expect, beforeEach } from 'vitest';
import { eq, and } from 'drizzle-orm';
import { freshDrizzle } from './pg.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { ReviewService } from '../reviews/index.js';
import { ShelvesService } from '../shelves/index.js';
import { SocialService } from '../social/index.js';
import { ActivityService } from '../activity/index.js';
import { PgRateLimiter } from '../platform/index.js';
import { activity, works } from '../db/schema.js';
import { verifyAllUsers } from './interaction-fixtures.js';

describe('SO-10: Activity Table + Write-on-Action + Visibility Enforcement', () => {
  let db: any;
  let identity: IdentityService;
  let reading: ReadingService;
  let reviewsSvc: ReviewService;
  let shelvesSvc: ShelvesService;
  let social: SocialService;
  let activitySvc: ActivityService;

  let userPublic: { id: string; token: string; username: string };
  let userPrivate: { id: string; token: string; username: string };
  let testWorkId: string;

  beforeEach(async () => {
    const res = await freshDrizzle();
    db = res.db;
    const limiter = new PgRateLimiter(db);

    identity = new IdentityService(db, limiter);
    reading = new ReadingService(db);
    reviewsSvc = new ReviewService(db);
    shelvesSvc = new ShelvesService(db);
    social = new SocialService(db);
    activitySvc = new ActivityService(db);

    // Create test user (public)
    const resPub = await identity.register(
      'pubuser@example.com',
      'pub_user',
      'a_very_secure_password_123',
      '1995-05-15',
    );
    userPublic = { id: resPub.user.id, token: resPub.accessToken, username: resPub.user.username };

    // Create test user (private account)
    const resPriv = await identity.register(
      'privuser@example.com',
      'priv_user',
      'a_very_secure_password_123',
      '1995-05-15',
    );
    userPrivate = { id: resPriv.user.id, token: resPriv.accessToken, username: resPriv.user.username };
    await identity.updateProfile(userPrivate.id, { isPrivate: true });

    // Seed a work
    const [w] = await db.insert(works).values({ title: 'Test Activity Book' }).returning({ id: works.id });
    testWorkId = w.id;
    // Reviews, comments and follows need a verified email (D-04-1); the gate has its own tests.
    await verifyAllUsers(db);
  });

  it('records started activity when user starts reading a book', async () => {
    await reading.upsert(userPublic.id, testWorkId, 'reading');

    const rows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'started')));

    expect(rows.length).toBe(1);
    expect(rows[0].workId).toBe(testWorkId);
    expect(rows[0].visibility).toBe('public');
  });

  it('records finished activity when user finishes a book', async () => {
    const read = await reading.upsert(userPublic.id, testWorkId, 'reading');
    await reading.finish(userPublic.id, read.id, { rating: 4.5 });

    const rows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'finished')));

    expect(rows.length).toBe(1);
    expect(rows[0].workId).toBe(testWorkId);
    expect(rows[0].metadata.rating).toBe(4.5);
    expect(rows[0].visibility).toBe('public');
  });

  it('records dnf activity when user marks a book as DNF', async () => {
    const read = await reading.upsert(userPublic.id, testWorkId, 'reading');
    await reading.dnf(userPublic.id, read.id, { dnfReason: 'Pacing issues', abandonedPage: 120 });

    const rows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'dnf')));

    expect(rows.length).toBe(1);
    expect(rows[0].metadata.dnfReason).toBe('Pacing issues');
  });

  it('IM-07: excludes imported reads from generating activity rows', async () => {
    await activitySvc.recordActivity(db, {
      actorId: userPublic.id,
      verb: 'started',
      workId: testWorkId,
      source: 'import',
    });

    const rows = await db
      .select()
      .from(activity)
      .where(eq(activity.actorId, userPublic.id));

    expect(rows.length).toBe(0);
  });

  it('PRD §26.2: private reads generate NO activity row at all', async () => {
    await reading.upsert(userPublic.id, testWorkId, 'reading', null, null, 'private');

    const rows = await db
      .select()
      .from(activity)
      .where(eq(activity.actorId, userPublic.id));

    expect(rows.length).toBe(0);
  });

  it('PRD §16.3: forces followers visibility for activity created on private accounts', async () => {
    await reading.upsert(userPrivate.id, testWorkId, 'reading');

    const rows = await db
      .select()
      .from(activity)
      .where(eq(activity.actorId, userPrivate.id));

    expect(rows.length).toBe(1);
    expect(rows[0].visibility).toBe('followers');
  });

  it('PRD §16.3: retroactively restricts public activity to followers when account toggles to private', async () => {
    await reading.upsert(userPublic.id, testWorkId, 'reading');

    const initialRows = await db
      .select()
      .from(activity)
      .where(eq(activity.actorId, userPublic.id));
    expect(initialRows[0].visibility).toBe('public');

    // Toggle userPublic to private
    await identity.updateProfile(userPublic.id, { isPrivate: true });

    const updatedRows = await db
      .select()
      .from(activity)
      .where(eq(activity.actorId, userPublic.id));
    expect(updatedRows[0].visibility).toBe('followers');
  });

  it('records reviewed activity on review publication and deletes it on review deletion', async () => {
    const read = await reading.upsert(userPublic.id, testWorkId, 'finished');
    const review = await reviewsSvc.upsertReview(userPublic.id, read.id, {
      body: 'A truly magnificent piece of literature!',
      rating: 5,
    });

    const reviewActivities = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'reviewed')));

    expect(reviewActivities.length).toBe(1);
    expect(reviewActivities[0].objectId).toBe(review.id);
    expect(reviewActivities[0].metadata.snippet).toBe('A truly magnificent piece of literature!');

    // Delete review
    await reviewsSvc.deleteReview(review.id, userPublic.id);

    const afterDelete = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'reviewed')));

    expect(afterDelete.length).toBe(0);
  });

  it('records shelved activity on adding item to shelf', async () => {
    const shelf = await shelvesSvc.create(userPublic.id, { name: 'Favorites', privacy: 'public' });
    await shelvesSvc.addItem(userPublic.id, shelf.id, { work_id: testWorkId, note: 'Must read again' });

    const shelvedActivities = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'shelved')));

    expect(shelvedActivities.length).toBe(1);
    expect(shelvedActivities[0].metadata.shelfName).toBe('Favorites');
  });

  it('records followed activity when following a public user and deletes it on unfollow', async () => {
    await social.followUser(userPublic.id, userPrivate.id); // pending since userPrivate is private
    let followedRows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'followed')));
    expect(followedRows.length).toBe(0); // pending follow yields no activity

    // Follow a public user
    const res3 = await identity.register(
      'third@example.com',
      'third_user',
      'a_very_secure_password_123',
      '1995-05-15',
    );
    await social.followUser(userPublic.id, res3.user.id);

    followedRows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'followed')));
    expect(followedRows.length).toBe(1);
    expect(followedRows[0].objectId).toBe(res3.user.id);

    // Unfollow
    await social.unfollowUser(userPublic.id, res3.user.id);
    followedRows = await db
      .select()
      .from(activity)
      .where(and(eq(activity.actorId, userPublic.id), eq(activity.verb, 'followed')));
    expect(followedRows.length).toBe(0);
  });
});
