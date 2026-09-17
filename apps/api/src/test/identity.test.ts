import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hash, verify } from '@node-rs/argon2';
import type { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';

import {
  passwordSchema,
  usernameSchema,
  isAtLeast13,
  dobSchema,
  uniqueViolationField,
  signAccessToken,
  verifyAccessToken,
  IdentityService,
  identityRoutes,
} from '../identity/index.js';
import { MemoryCache, MemoryEmailSender, PgRateLimiter, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { ApiError } from '../http.js';
import { registerCoreHooks } from '../app.js';

describe('password hashing', () => {
  it('round-trips', async () => {
    const h = await hash('correct horse battery staple');
    expect(await verify(h, 'correct horse battery staple')).toBe(true);
    expect(await verify(h, 'wrong password entirely')).toBe(false);
  });

  it('is salted — two hashes of the same password differ', async () => {
    const [a, b] = await Promise.all([hash('same password'), hash('same password')]);
    expect(a).not.toBe(b);
  });
});

describe('password rule', () => {
  it('requires 10 characters and nothing else', () => {
    expect(passwordSchema.safeParse('123456789').success).toBe(false);
    expect(passwordSchema.safeParse('all lowercase no digits').success).toBe(true);
  });

  it('rejects common passwords regardless of length (FN-61)', () => {
    expect(passwordSchema.safeParse('1234567890').success).toBe(false);
    expect(passwordSchema.safeParse('password1234').success).toBe(false);
    expect(passwordSchema.safeParse('qwertyuiop').success).toBe(false);
    expect(passwordSchema.safeParse('iloveyou1234').success).toBe(false);
  });
});

describe('username rule', () => {
  it.each(['gaurav', 'a_b_c', 'reader99', 'abc'])('accepts %s', (s) => {
    expect(usernameSchema.safeParse(s).success).toBe(true);
  });

  it.each(['ab', 'has space', 'Upper', 'way_too_long_a_username_here', 'emoji🙂', ''])(
    'rejects %s',
    (s) => {
      expect(usernameSchema.safeParse(s).success).toBe(false);
    },
  );
});

describe('age gate (DOB rule, PRD §26.6)', () => {
  it('accepts dates for users 13 and older', () => {
    expect(isAtLeast13('2000-01-01', new Date('2026-09-15'))).toBe(true);
    expect(isAtLeast13('2013-09-14', new Date('2026-09-15'))).toBe(true);
    expect(dobSchema.safeParse('2005-06-15').success).toBe(true);
  });

  it('rejects users under 13', () => {
    expect(isAtLeast13('2018-01-01', new Date('2026-09-15'))).toBe(false);
    expect(isAtLeast13('2013-09-16', new Date('2026-09-15'))).toBe(false);
    expect(dobSchema.safeParse('2020-01-01').success).toBe(false);
  });

  it('rejects invalid date formats', () => {
    expect(dobSchema.safeParse('01/01/2000').success).toBe(false);
    expect(dobSchema.safeParse('not-a-date').success).toBe(false);
  });
});

describe('MemoryCache', () => {
  it('stores and returns a value', async () => {
    const c = new MemoryCache();
    await c.set('k', { a: 1 }, 60);
    expect(await c.get<{ a: number }>('k')).toEqual({ a: 1 });
  });

  it('expires', async () => {
    const c = new MemoryCache();
    await c.set('k', 'v', -1);
    expect(await c.get('k')).toBeUndefined();
  });

  it('evicts the oldest entry past its limit', async () => {
    const c = new MemoryCache(2);
    await c.set('a', 1, 60);
    await c.set('b', 2, 60);
    await c.set('c', 3, 60);
    expect(await c.get('a')).toBeUndefined();
    expect(await c.get('c')).toBe(3);
  });

  it('deletes', async () => {
    const c = new MemoryCache();
    await c.set('k', 'v', 60);
    await c.del('k');
    expect(await c.get('k')).toBeUndefined();
  });
});

describe('uniqueViolationField', () => {
  it('reads a bare postgres.js error', () => {
    expect(uniqueViolationField({ code: '23505', constraint_name: 'users_email_key' })).toBe('email');
    expect(uniqueViolationField({ code: '23505', constraint_name: 'profiles_username_key' })).toBe('username');
  });

  it('walks the cause chain when Drizzle wraps the driver error', () => {
    const wrapped = new Error('Failed query: insert into "users" ...');
    (wrapped as unknown as { cause: unknown }).cause = {
      code: '23505',
      constraint_name: 'users_email_unique',
    };
    expect(uniqueViolationField(wrapped)).toBe('email');
  });

  it('walks more than one level', () => {
    const outer = { cause: { cause: { code: '23505', constraint: 'profiles_username_unique' } } };
    expect(uniqueViolationField(outer)).toBe('username');
  });

  it('reports an unknown constraint rather than guessing', () => {
    expect(uniqueViolationField({ code: '23505', constraint_name: 'some_other_pkey' })).toBe('other');
  });

  it('returns null for anything that is not a unique violation', () => {
    expect(uniqueViolationField(null)).toBeNull();
    expect(uniqueViolationField(new Error('boom'))).toBeNull();
    expect(uniqueViolationField({ code: '23503' })).toBeNull();
    expect(uniqueViolationField({ code: '42P01' })).toBeNull();
  });

  it('does not loop forever on a cyclic cause chain', () => {
    const a: Record<string, unknown> = {};
    a.cause = a;
    expect(uniqueViolationField(a)).toBeNull();
  });
});

describe('IdentityService (FN-60 through FN-64)', () => {
  let db: Db;
  let client: PGlite;
  let service: IdentityService;
  let mailer: MemoryEmailSender;

  beforeAll(async () => {
    ({ db, client } = await freshDrizzle());
    mailer = new MemoryEmailSender();
    service = new IdentityService(db, new PgRateLimiter(db), mailer);
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await client.exec(
      'TRUNCATE users, profiles, refresh_tokens, email_verification_tokens, password_reset_tokens RESTART IDENTITY CASCADE',
    );
    mailer.clear();
  });

  it('registers a user with profile and returns tokens (FN-60, FN-62, FN-63)', async () => {
    const result = await service.register('alice@example.com', 'alice_reader', 'goodpassword123', '2000-01-01');
    expect(result.user.email).toBe('alice@example.com');
    expect(result.user.username).toBe('alice_reader');
    expect(result.accessToken).toBeDefined();
    expect(result.refreshToken).toBeDefined();

    const verified = await verifyAccessToken(result.accessToken);
    expect(verified?.sub).toBe(result.user.id);
  });

  it('rejects duplicate emails with 409 email_taken', async () => {
    await service.register('bob@example.com', 'bob1', 'goodpassword123', '2000-01-01');
    await expect(service.register('bob@example.com', 'bob2', 'goodpassword123', '2000-01-01')).rejects.toThrowError(
      expect.objectContaining({ status: 409, code: 'email_taken' }),
    );
  });

  it('rejects duplicate usernames with 409 username_taken', async () => {
    await service.register('first@example.com', 'samereader', 'goodpassword123', '2000-01-01');
    await expect(service.register('second@example.com', 'samereader', 'goodpassword123', '2000-01-01')).rejects.toThrowError(
      expect.objectContaining({ status: 409, code: 'username_taken' }),
    );
  });

  it('logs in an existing user and returns a fresh token pair', async () => {
    await service.register('clara@example.com', 'clara_r', 'mypassword10', '1998-05-20');
    const loginRes = await service.login('clara@example.com', 'mypassword10');

    expect(loginRes.user.email).toBe('clara@example.com');
    expect(loginRes.user.username).toBe('clara_r');
    expect(loginRes.accessToken).toBeDefined();
    expect(loginRes.refreshToken).toBeDefined();
  });

  it('rejects login with invalid credentials with generic 401', async () => {
    await service.register('clara@example.com', 'clara_r', 'mypassword10', '1998-05-20');
    await expect(service.login('clara@example.com', 'wrongpassword')).rejects.toThrowError(
      expect.objectContaining({ status: 401, code: 'invalid_credentials' }),
    );
    await expect(service.login('nonexistent@example.com', 'mypassword10')).rejects.toThrowError(
      expect.objectContaining({ status: 401, code: 'invalid_credentials' }),
    );
  });

  it('rotates refresh tokens within the same family (FN-63)', async () => {
    const reg = await service.register('david@example.com', 'david_w', 'mypassword10', '1995-10-10');
    const rotated = await service.refresh(reg.refreshToken);

    expect(rotated.accessToken).toBeDefined();
    expect(rotated.refreshToken).toBeDefined();
    expect(rotated.refreshToken).not.toBe(reg.refreshToken);

    const viewer = await service.lookup(rotated.accessToken);
    expect(viewer).toBe(reg.user.id);
  });

  it('detects token reuse and revokes the whole family (FN-64)', async () => {
    const reg = await service.register('eve@example.com', 'eve_r', 'mypassword10', '1992-03-15');
    const rotated = await service.refresh(reg.refreshToken);

    // Replay attack: presenting the already-consumed initial token
    await expect(service.refresh(reg.refreshToken)).rejects.toThrowError(
      expect.objectContaining({ status: 403, code: 'token_reused' }),
    );

    // Because the family was revoked, the rotated token must also be rejected
    await expect(service.refresh(rotated.refreshToken)).rejects.toThrowError(
      expect.objectContaining({ status: 401, code: 'invalid_refresh_token' }),
    );
  });

  it('logout revokes the refresh family', async () => {
    const reg = await service.register('frank@example.com', 'frank_b', 'mypassword10', '1990-12-01');
    await service.logout(reg.refreshToken);

    await expect(service.refresh(reg.refreshToken)).rejects.toThrowError(
      expect.objectContaining({ status: 401, code: 'invalid_refresh_token' }),
    );
  });
});

describe('Email verification and password reset (FN-65)', () => {
  let db: Db;
  let client: PGlite;
  let service: IdentityService;
  let mailer: MemoryEmailSender;
  let app: FastifyInstance;

  beforeAll(async () => {
    ({ db, client } = await freshDrizzle());
    mailer = new MemoryEmailSender();
    service = new IdentityService(db, new PgRateLimiter(db), mailer);

    app = Fastify();
    registerCoreHooks(app, {
      identityLookup: (token) => service.lookup(token),
    });
    await app.register(identityRoutes(service), { prefix: '/v1' });
    await app.ready();
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await client?.close();
  });

  beforeEach(async () => {
    await client.exec(
      'TRUNCATE users, profiles, refresh_tokens, email_verification_tokens, password_reset_tokens, rate_limits RESTART IDENTITY CASCADE',
    );
    mailer.clear();
  });

  it('registration dispatches verification email with a usable token', async () => {
    const reg = await service.register('grace@example.com', 'grace_reads', 'goodpassword123', '1995-04-12');
    expect(mailer.sentMessages).toHaveLength(1);
    const sent = mailer.sentMessages[0]!;
    expect(sent.to).toBe('grace@example.com');
    expect(sent.subject).toContain('Verify your email');

    // Extract the raw token from the email body
    const match = sent.text.match(/token=([a-zA-Z0-9_-]+)/);
    expect(match).not.toBeNull();
    const rawToken = match![1]!;

    const verifyRes = await service.verifyEmail(rawToken);
    expect(verifyRes.status).toBe('ok');

    // Token is single-use: replay must fail
    await expect(service.verifyEmail(rawToken)).rejects.toThrowError(
      expect.objectContaining({ status: 400, code: 'invalid_or_expired_token' }),
    );
  });

  it('verifyEmail rejects forged or non-existent tokens', async () => {
    await expect(service.verifyEmail('nonexistent-raw-token')).rejects.toThrowError(
      expect.objectContaining({ status: 400, code: 'invalid_or_expired_token' }),
    );
  });

  it('resendVerification dispatches fresh token and enforces 60s cooldown (PRD §6.6)', async () => {
    const reg = await service.register('heidi@example.com', 'heidi_reads', 'goodpassword123', '1996-08-20');
    mailer.clear();

    const resendRes = await service.resendVerification(reg.user.id);
    expect(resendRes.status).toBe('ok');
    expect(mailer.sentMessages).toHaveLength(1);

    // Immediate second call triggers 429 rate limit
    await expect(service.resendVerification(reg.user.id)).rejects.toThrowError(
      expect.objectContaining({ status: 429, code: 'rate_limited' }),
    );
  });

  it('resendVerification is a no-op if user is already verified', async () => {
    const reg = await service.register('ian@example.com', 'ian_reads', 'goodpassword123', '1994-02-14');
    const match = mailer.sentMessages[0]?.text.match(/token=([a-zA-Z0-9_-]+)/);
    expect(match).not.toBeNull();
    await service.verifyEmail(match![1]!);
    mailer.clear();

    // Clear rate limits table for test
    await client.exec('TRUNCATE rate_limits');

    const resendRes = await service.resendVerification(reg.user.id);
    expect(resendRes.status).toBe('ok');
    expect(resendRes.message).toBe('Email is already verified.');
    expect(mailer.sentMessages).toHaveLength(0);
  });

  it('forgotPassword always returns generic 200 without leaking email presence (PRD §6.5)', async () => {
    // Non-existent email
    const res1 = await service.forgotPassword('nonexistent@example.com');
    expect(res1.status).toBe('ok');
    expect(res1.message).toContain('If that email exists');
    expect(mailer.sentMessages).toHaveLength(0);

    // Existing email
    await service.register('julia@example.com', 'julia_reads', 'goodpassword123', '1993-11-05');
    mailer.clear();

    const res2 = await service.forgotPassword('julia@example.com');
    expect(res2.status).toBe('ok');
    expect(res2.message).toBe(res1.message); // IDENTICAL message
    expect(mailer.sentMessages).toHaveLength(1);
    expect(mailer.sentMessages[0]?.to).toBe('julia@example.com');
    expect(mailer.sentMessages[0]?.subject).toContain('Reset your Flyleaf password');
  });

  it('resetPassword changes password, burns reset token, and revokes all active refresh families (PRD §6.5 & Architecture §7)', async () => {
    const reg = await service.register('kyle@example.com', 'kyle_reads', 'oldpassword10', '1991-07-22');
    const initialRefresh = reg.refreshToken;
    mailer.clear();

    await service.forgotPassword('kyle@example.com');
    expect(mailer.sentMessages).toHaveLength(1);
    const match = mailer.sentMessages[0]?.text.match(/token=([a-zA-Z0-9_-]+)/);
    expect(match).not.toBeNull();
    const resetToken = match![1]!;

    // Reset password with a fresh valid password
    const resetRes = await service.resetPassword(resetToken, 'brandnewpassword123');
    expect(resetRes.status).toBe('ok');

    // 1. Old password login must fail
    await expect(service.login('kyle@example.com', 'oldpassword10')).rejects.toThrowError(
      expect.objectContaining({ status: 401, code: 'invalid_credentials' }),
    );

    // 2. New password login must succeed
    const newLogin = await service.login('kyle@example.com', 'brandnewpassword123');
    expect(newLogin.accessToken).toBeDefined();

    // 3. Old refresh token family is REVOKED
    await expect(service.refresh(initialRefresh)).rejects.toThrowError(
      expect.objectContaining({ status: 401, code: 'invalid_refresh_token' }),
    );

    // 4. Reset token cannot be reused
    await expect(service.resetPassword(resetToken, 'anotherpassword123')).rejects.toThrowError(
      expect.objectContaining({ status: 400, code: 'invalid_or_expired_token' }),
    );
  });

  it('HTTP endpoints verify full request/response cycle and input validation', async () => {
    // 1. Register via HTTP
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: {
        email: 'leo@example.com',
        username: 'leo_reader',
        password: 'securepassword123',
        dateOfBirth: '1990-01-01',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken } = JSON.parse(regRes.payload);

    const emailMatch = mailer.sentMessages[0]?.text.match(/token=([a-zA-Z0-9_-]+)/);
    expect(emailMatch).not.toBeNull();
    const verifyToken = emailMatch![1]!;

    // 2. Verify email via HTTP
    const verifyRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/verify-email',
      payload: { token: verifyToken },
    });
    expect(verifyRes.statusCode).toBe(200);

    // 3. Resend verification via HTTP (with Bearer auth)
    const resendRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/resend-verification',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(resendRes.statusCode).toBe(200);
    expect(JSON.parse(resendRes.payload).message).toBe('Email is already verified.');

    // 4. Forgot password via HTTP
    const forgotRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/forgot-password',
      payload: { email: 'leo@example.com' },
    });
    expect(forgotRes.statusCode).toBe(200);

    const resetMatch = mailer.lastMessage()?.text.match(/token=([a-zA-Z0-9_-]+)/);
    expect(resetMatch).not.toBeNull();
    const resetToken = resetMatch![1]!;

    // 5. Reset password with weak password fails (422)
    const weakResetRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: resetToken, newPassword: 'short' },
    });
    expect(weakResetRes.statusCode).toBe(422);

    // 6. Reset password with common password fails (422)
    const commonResetRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: resetToken, newPassword: 'password1234' },
    });
    expect(commonResetRes.statusCode).toBe(422);

    // 7. Reset password with valid password succeeds (200)
    const validResetRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      payload: { token: resetToken, newPassword: 'brandnewpassword123' },
    });
    expect(validResetRes.statusCode).toBe(200);
  });

  it('listSessions groups active tokens by device family and reflects rotation (FN-66)', async () => {
    const reg = await service.register('maya@example.com', 'maya_reads', 'goodpassword123', '1992-03-10', 'Firefox on macOS');
    const login2 = await service.login('maya@example.com', 'goodpassword123', 'Safari on iOS');

    let sessions = await service.listSessions(reg.user.id);
    expect(sessions).toHaveLength(2);
    const devices = sessions.map((s) => s.device).sort();
    expect(devices).toEqual(['Firefox on macOS', 'Safari on iOS']);

    // Rotate refresh token on device 2
    const rotated = await service.refresh(login2.refreshToken);
    expect(rotated.refreshToken).toBeDefined();

    // Session count is still 2 (rotation preserves family)
    sessions = await service.listSessions(reg.user.id);
    expect(sessions).toHaveLength(2);
  });

  it('revokeSession revokes specific session family, leaving other devices intact (FN-66)', async () => {
    const reg = await service.register('noah@example.com', 'noah_reads', 'goodpassword123', '1991-07-22', 'Desktop');
    const login2 = await service.login('noah@example.com', 'goodpassword123', 'Mobile');

    const sessions = await service.listSessions(reg.user.id);
    expect(sessions).toHaveLength(2);

    const desktopSession = sessions.find((s) => s.device === 'Desktop')!;
    const mobileSession = sessions.find((s) => s.device === 'Mobile')!;

    // Revoke desktop session
    const revokeRes = await service.revokeSession(reg.user.id, desktopSession.id);
    expect(revokeRes.status).toBe('ok');

    // Desktop refresh now fails
    await expect(service.refresh(reg.refreshToken)).rejects.toThrowError(
      expect.objectContaining({ status: 401, code: 'invalid_refresh_token' }),
    );

    // Mobile refresh still works
    const refreshedMobile = await service.refresh(login2.refreshToken);
    expect(refreshedMobile.accessToken).toBeDefined();

    // Active session list only contains Mobile
    const remaining = await service.listSessions(reg.user.id);
    expect(remaining).toHaveLength(1);
    expect(remaining[0]!.id).toBe(mobileSession.id);
  });

  it('revokeSession returns 404 for unknown or other user session (FN-66)', async () => {
    const userA = await service.register('usera@example.com', 'usera', 'goodpassword123', '1990-01-01', 'Device A');
    const userB = await service.register('userb@example.com', 'userb', 'goodpassword123', '1990-01-01', 'Device B');

    const sessionsB = await service.listSessions(userB.user.id);
    const sessionBId = sessionsB[0]!.id;

    // User A cannot revoke User B's session (404 not found, never 403)
    await expect(service.revokeSession(userA.user.id, sessionBId)).rejects.toThrowError(
      expect.objectContaining({ status: 404, code: 'not_found' }),
    );

    // Non-existent UUID returns 404
    await expect(service.revokeSession(userA.user.id, '00000000-0000-0000-0000-000000000000')).rejects.toThrowError(
      expect.objectContaining({ status: 404, code: 'not_found' }),
    );
  });

  it('logoutAll revokes all active session families for user (FN-66)', async () => {
    const reg = await service.register('oliver@example.com', 'oliver_reads', 'goodpassword123', '1993-11-05', 'Tablet');
    const login2 = await service.login('oliver@example.com', 'goodpassword123', 'Phone');
    const login3 = await service.login('oliver@example.com', 'goodpassword123', 'Laptop');

    const sessions = await service.listSessions(reg.user.id);
    expect(sessions).toHaveLength(3);

    const logoutRes = await service.logoutAll(reg.user.id);
    expect(logoutRes.status).toBe('ok');

    // All refresh tokens are now revoked
    for (const token of [reg.refreshToken, login2.refreshToken, login3.refreshToken]) {
      await expect(service.refresh(token)).rejects.toThrowError(
        expect.objectContaining({ status: 401, code: 'invalid_refresh_token' }),
      );
    }

    // Active session list is empty
    const remaining = await service.listSessions(reg.user.id);
    expect(remaining).toHaveLength(0);
  });

  it('HTTP session endpoints enforce authentication, device headers, and revocation (FN-66)', async () => {
    // 1. Unauthenticated requests fail with 401
    const unauthGet = await app.inject({ method: 'GET', url: '/v1/auth/sessions' });
    expect(unauthGet.statusCode).toBe(401);

    const unauthDel = await app.inject({
      method: 'DELETE',
      url: '/v1/auth/sessions/00000000-0000-0000-0000-000000000000',
    });
    expect(unauthDel.statusCode).toBe(401);

    const unauthLogoutAll = await app.inject({ method: 'POST', url: '/v1/auth/logout-all' });
    expect(unauthLogoutAll.statusCode).toBe(401);

    // 2. Register via HTTP with User-Agent
    const regRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0) Chrome/120.0' },
      payload: {
        email: 'paula@example.com',
        username: 'paula_reads',
        password: 'goodpassword123',
        dateOfBirth: '1995-10-10',
      },
    });
    expect(regRes.statusCode).toBe(201);
    const { accessToken } = JSON.parse(regRes.payload);

    // 3. Login second device via HTTP
    const loginRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/login',
      headers: { 'user-agent': 'FlyleafMobile/1.0 (iOS 17)' },
      payload: {
        email: 'paula@example.com',
        password: 'goodpassword123',
      },
    });
    expect(loginRes.statusCode).toBe(200);

    // 4. List sessions via HTTP
    const listRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listRes.statusCode).toBe(200);
    const { data: sessionList } = JSON.parse(listRes.payload);
    expect(sessionList).toHaveLength(2);
    expect(sessionList[0].id).toBeDefined();
    expect(sessionList[0].createdAt).toBeDefined();
    expect(sessionList[0].lastUsedAt).toBeDefined();

    // 5. Revoke one session via HTTP
    const targetSessionId = sessionList[0].id;
    const deleteRes = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${targetSessionId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(deleteRes.statusCode).toBe(200);
    expect(JSON.parse(deleteRes.payload).status).toBe('ok');

    // 6. Revoking already-revoked session returns 404
    const repeatDeleteRes = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${targetSessionId}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(repeatDeleteRes.statusCode).toBe(404);

    // 7. Logout all sessions via HTTP
    const logoutAllRes = await app.inject({
      method: 'POST',
      url: '/v1/auth/logout-all',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(logoutAllRes.statusCode).toBe(200);
    expect(JSON.parse(logoutAllRes.payload).status).toBe('ok');

    // 8. Session list is now empty
    const listAfterRes = await app.inject({
      method: 'GET',
      url: '/v1/auth/sessions',
      headers: { authorization: `Bearer ${accessToken}` },
    });
    expect(listAfterRes.statusCode).toBe(200);
    expect(JSON.parse(listAfterRes.payload).data).toHaveLength(0);
  });
});
