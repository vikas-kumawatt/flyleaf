// Live username availability (PRD §6.7, SL-22; audit 07 A-07-010).
// The mobile field checks it 400 ms after typing stops.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

import { registerCoreHooks } from '../app.js';
import { IdentityService, identityRoutes } from '../identity/index.js';
import { PgRateLimiter, type Db } from '../platform/index.js';
import { users, profiles } from '../db/schema.js';
import { freshDrizzle } from './pg.js';

describe('GET /v1/auth/username-available', () => {
  let db: Db;
  let client: { close: () => Promise<void> };
  let app: FastifyInstance;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    client = fresh.client;
    for (const username of ['reader', 'reader_reads', 'private_one']) {
      const id = randomUUID();
      await db.insert(users).values({ id, email: `${username}@example.com`, passwordHash: 'x', dateOfBirth: '1990-01-01' });
      await db.insert(profiles).values({ userId: id, username, isPrivate: username === 'private_one' });
    }
    const service = new IdentityService(db, new PgRateLimiter(db));
    app = Fastify();
    registerCoreHooks(app, { identityLookup: (token) => service.lookup(token) });
    await app.register(identityRoutes(service), { prefix: '/v1' });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  const check = async (username: string) => {
    const res = await app.inject({ method: 'GET', url: `/v1/auth/username-available?username=${encodeURIComponent(username)}` });
    return { status: res.statusCode, body: JSON.parse(res.body) };
  };

  it('a free, valid username is available, for a guest', async () => {
    expect(await check('new_reader')).toEqual({ status: 200, body: { username: 'new_reader', available: true } });
  });

  it('is case-insensitive and trims, like register', async () => {
    const { body } = await check('  ReAdEr ');
    expect(body.username).toBe('reader');
    expect(body.available).toBe(false);
    expect(body.reason).toBe('taken');
  });

  it('a taken username comes with three free alternatives', async () => {
    const { body } = await check('reader');
    expect(body.suggestions).toHaveLength(3);
    expect(body.suggestions).not.toContain('reader_reads'); // taken
    for (const s of body.suggestions) {
      expect(s).toMatch(/^[a-z0-9_]{3,20}$/);
      expect((await check(s)).body.available).toBe(true);
    }
  });

  it('reserved and malformed names are unavailable with their reason, not an error', async () => {
    expect((await check('admin')).body).toMatchObject({ available: false, reason: 'reserved' });
    for (const bad of ['ab', 'a'.repeat(21), 'has space', 'émile', 'x%_', "o'neil"]) {
      const { status, body } = await check(bad);
      expect(status).toBe(200);
      expect(body).toMatchObject({ available: false, reason: 'invalid' });
    }
  });

  it('a missing parameter is a 422', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/auth/username-available' });
    expect(res.statusCode).toBe(422);
  });
});
