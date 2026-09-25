// Fixtures shared by the SO-2x interaction suites.
//
// Users are inserted directly and given signed tokens rather than going
// through register(): argon2 costs ~100ms per user, and these suites need
// many users. The auth path itself is covered by identity.test.ts.

import { randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { isNull } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { PgRateLimiter, type Db, type RateLimiter } from '../platform/index.js';
import { users, profiles, works, reads, follows, blocks } from '../db/schema.js';
import { freshDrizzle } from './pg.js';

export interface TestUser {
  id: string;
  username: string;
  token: string;
  auth: { authorization: string };
}

export async function interactionHarness(opts: { limiter?: RateLimiter } = {}) {
  const { db, client } = await freshDrizzle();
  const identity = new IdentityService(db, new PgRateLimiter(db));
  const app: FastifyInstance = await buildApp({ db, identity, limiter: opts.limiter });
  await app.ready();
  return { db, client, app };
}

/**
 * A user with a signed token. Verified by default: reviews, comments and
 * follows need a verified email (D-04-1). Pass `verified: false` to test the gate.
 */
export async function makeUser(
  db: Db,
  username: string,
  opts: { isPrivate?: boolean; verified?: boolean } = {},
): Promise<TestUser> {
  const id = randomUUID();
  await db.insert(users).values({
    id,
    email: `${username}@example.com`,
    passwordHash: 'unused',
    dateOfBirth: '1990-01-01',
    emailVerifiedAt: opts.verified === false ? null : new Date(),
  });
  await db.insert(profiles).values({
    userId: id,
    username,
    displayName: username,
    isPrivate: opts.isPrivate ?? false,
  });
  const token = await signAccessToken(id);
  return { id, username, token, auth: { authorization: `Bearer ${token}` } };
}

export async function makeWork(db: Db, title: string): Promise<string> {
  const [w] = await db.insert(works).values({ title }).returning({ id: works.id });
  return w!.id;
}

export async function makeRead(
  db: Db,
  userId: string,
  workId: string,
  opts: {
    status?: 'want' | 'reading' | 'paused' | 'finished' | 'dnf';
    visibility?: 'public' | 'followers' | 'private';
    attemptNo?: number;
    rating?: string | null;
  } = {},
): Promise<string> {
  const [r] = await db
    .insert(reads)
    .values({
      userId,
      workId,
      status: opts.status ?? 'finished',
      visibility: opts.visibility ?? 'public',
      attemptNo: opts.attemptNo ?? 1,
      rating: opts.rating ?? null,
    })
    .returning({ id: reads.id });
  return r!.id;
}

export async function follow(db: Db, followerId: string, followeeId: string) {
  await db.insert(follows).values({ followerId, followeeId, state: 'accepted' });
}

export async function block(db: Db, blockerId: string, blockedId: string) {
  await db.insert(blocks).values({ blockerId, blockedId });
}

/**
 * Mark every user in this database as email-verified. For suites that create
 * users through IdentityService.register (unverified) and then review,
 * comment or follow; the D-04-1 gate is tested in authorization-matrix.test.ts.
 */
export async function verifyAllUsers(db: Db) {
  await db.update(users).set({ emailVerifiedAt: new Date() }).where(isNull(users.emailVerifiedAt));
}

/** A limiter that always allows — for suites that are not testing throttling. */
export const unlimited: RateLimiter = { allow: async () => true };
