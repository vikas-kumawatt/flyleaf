// LA-01 (PRD §25.4, AC-17): in-app account deletion. Password re-entry, the
// account gone everywhere at once with every session ended, the 30-day grace
// in which signing in restores it, and a ban that signing in never undoes.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { users } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import { freshDrizzle } from './pg.js';
import { makeUser, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let app: FastifyInstance;
let mailer: MemoryEmailSender;
let viewer: TestUser;

const PASSWORD = 'goodpassword123';

type Account = { id: string; email: string; auth: { authorization: string }; refreshToken: string };

async function register(username: string): Promise<Account> {
  const email = `${username}@example.com`;
  const res = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email, username, password: PASSWORD, dateOfBirth: '1990-01-01' },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  return { id: body.user.id, email, auth: { authorization: `Bearer ${body.accessToken}` }, refreshToken: body.refreshToken };
}

const deleteAccount = (who: Account, password: unknown = PASSWORD) =>
  app.inject({ method: 'DELETE', url: '/v1/me', headers: who.auth, payload: { password } });
const login = (who: Account, password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email: who.email, password } });
const profileSeenBy = (who: Account) => app.inject({ method: 'GET', url: `/v1/users/${who.id}`, headers: viewer.auth });
const deletedAt = async (who: Account) =>
  (await db.select({ d: users.deletedAt }).from(users).where(eq(users.id, who.id)))[0]!.d;

beforeAll(async () => {
  ({ db } = await freshDrizzle());
  mailer = new MemoryEmailSender();
  app = await buildApp({ db, identity: new IdentityService(db, unlimited, mailer) });
  viewer = await makeUser(db, 'la01_viewer');
}, 60_000);
afterAll(async () => app?.close());

describe('DELETE /v1/me', () => {
  it('needs the password: a wrong one is 422 wrong_password and changes nothing', async () => {
    const a = await register('la01_wrong');
    const res = await deleteAccount(a, 'notmypassword1');
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'wrong_password', field: 'password' });
    expect(await deletedAt(a)).toBeNull();
    expect((await profileSeenBy(a)).statusCode).toBe(200);
  });

  it('a guest cannot call it, and an empty password is refused', async () => {
    expect((await app.inject({ method: 'DELETE', url: '/v1/me', payload: { password: PASSWORD } })).statusCode).toBe(401);
    const a = await register('la01_empty');
    expect((await deleteAccount(a, '')).statusCode).toBe(422);
    expect(await deletedAt(a)).toBeNull();
  });

  it('hides the account at once, ends every session, and states the 30-day grace in the answer and by email', async () => {
    const a = await register('la01_gone');
    expect((await profileSeenBy(a)).statusCode).toBe(200);
    mailer.clear();

    const res = await deleteAccount(a);
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('scheduled');
    const days = (Date.parse(body.purgeAfter) - Date.parse(body.deletedAt)) / 86_400_000;
    expect(days).toBe(30);

    // Gone everywhere a deleted account is gone (the same 404 as a random id).
    expect((await profileSeenBy(a)).statusCode).toBe(404);
    // Every session ended: the refresh token is refused.
    const refreshed = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: a.refreshToken } });
    expect(refreshed.statusCode).toBe(401);
    // Deleting twice is not possible: the account no longer exists for the caller.
    expect((await deleteAccount(a)).statusCode).toBe(401);

    await new Promise((r) => setImmediate(r)); // the email is not awaited
    const mail = mailer.sentMessages.find((m) => m.to === a.email);
    expect(mail?.subject).toMatch(/deleted/);
    expect(mail?.text).toMatch(/signing in to the app before then restores/);
  });
});

describe('the 30-day grace (PRD §25.4 step 5)', () => {
  it('signing in restores the account, says so, and brings the profile back', async () => {
    const a = await register('la01_back');
    expect((await deleteAccount(a)).statusCode).toBe(200);

    const wrong = await login(a, 'notmypassword1');
    expect(wrong.statusCode).toBe(401);
    expect(await deletedAt(a)).not.toBeNull(); // a wrong password restores nothing

    const res = await login(a);
    expect(res.statusCode).toBe(200);
    expect(res.json().restored).toBe(true);
    expect(await deletedAt(a)).toBeNull();
    expect((await profileSeenBy(a)).statusCode).toBe(200);

    // An ordinary sign-in afterwards restores nothing.
    expect((await login(a)).json().restored).toBe(false);
  });

  it('after 30 days signing in is refused like an unknown account', async () => {
    const a = await register('la01_late');
    await db.execute(sql`UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = ${a.id}::uuid`);
    const res = await login(a);
    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('invalid_credentials');
    expect(await deletedAt(a)).not.toBeNull();
  });

  it('a banned account is never restored by signing in (a ban is also a soft delete)', async () => {
    const a = await register('la01_banned');
    await db.update(users).set({ deletedAt: new Date(), bannedAt: new Date() }).where(eq(users.id, a.id));
    const res = await login(a);
    expect(res.statusCode).toBe(401);
    expect(await deletedAt(a)).not.toBeNull();
  });

  it('forgot password reaches an account in its grace period, so an owner without the password can still restore it', async () => {
    const a = await register('la01_forgot');
    expect((await deleteAccount(a)).statusCode).toBe(200);
    mailer.clear();
    await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', payload: { email: a.email } });
    await new Promise((r) => setImmediate(r));
    const token = mailer.lastMessage()?.text.match(/token=([A-Za-z0-9_-]+)/)?.[1];
    expect(token).toBeDefined();
    const reset = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token, newPassword: 'brandnewpassword9' },
    });
    expect(reset.statusCode).toBe(200);
    const res = await login(a, 'brandnewpassword9');
    expect(res.statusCode).toBe(200);
    expect(res.json().restored).toBe(true);
  });

  it('forgot password stays silent for an account past its grace or banned', async () => {
    const late = await register('la01_forgot_late');
    await db.execute(sql`UPDATE users SET deleted_at = now() - interval '31 days' WHERE id = ${late.id}::uuid`);
    const banned = await register('la01_forgot_ban');
    await db.update(users).set({ deletedAt: new Date(), bannedAt: new Date() }).where(eq(users.id, banned.id));
    mailer.clear();
    for (const who of [late, banned]) {
      await app.inject({ method: 'POST', url: '/v1/auth/forgot-password', payload: { email: who.email } });
    }
    await new Promise((r) => setImmediate(r));
    expect(mailer.sentMessages).toHaveLength(0);
  });
});
