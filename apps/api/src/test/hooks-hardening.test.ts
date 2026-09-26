// Hook chain hardening against the REAL app (FN-82, Audit 05).
//
// hooks.test.ts drives registerCoreHooks with a stubbed identity lookup; this
// suite uses buildApp() with the real IdentityService, so a forged or
// alg:none token is checked by the code production runs.

import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import * as jose from 'jose';
import { eq } from 'drizzle-orm';

import { buildApp, redactUrl, REQUEST_ID_PATTERN, HTML_BASELINE_CSP } from '../app.js';
import { IdentityService, signAccessToken } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { config, PgRateLimiter, type Db } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import { sanitizeContext } from '../telemetry/errors.js';
import { shelves, users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, makeWork, makeRead, unlimited, type TestUser } from './interaction-fixtures.js';

let db: Db;
let close: () => Promise<void>;
let app: FastifyInstance;
let mailer: MemoryEmailSender;
let user: TestUser;

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  close = () => fresh.client.close();
  mailer = new MemoryEmailSender();
  app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db), mailer),
    reading: new ReadingService(db),
    limiter: unlimited,
  });
  await app.ready();
  user = await makeUser(db, 'hook_user');
});

afterAll(async () => {
  await app?.close();
  await close?.();
});

describe('auth hook never rejects: bad tokens become guests (FN-82, PRD §4.2)', () => {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');

  const badTokens: [string, () => Promise<string>][] = [
    ['malformed', async () => 'not.a.jwt'],
    ['alg:none', async () => `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: user.id, aud: 'flyleaf-app', iss: 'flyleaf', iat: 1, exp: 9_999_999_999 })}.`],
    ['forged (wrong key)', async () => signAccessToken(user.id, new TextEncoder().encode('x'.repeat(48)))],
    [
      'expired',
      async () =>
        new jose.SignJWT({ sub: user.id })
          .setProtectedHeader({ alg: 'HS256' })
          .setAudience('flyleaf-app')
          .setIssuer('flyleaf')
          .setIssuedAt(Math.floor(Date.now() / 1000) - 3600)
          .setExpirationTime(Math.floor(Date.now() / 1000) - 1800)
          .sign(new TextEncoder().encode(config.jwtSecret)), // the real key: only exp is wrong
    ],
    ['huge (6 KB)', async () => 'a'.repeat(6_000)],
  ];

  it.each(badTokens)('%s: guest route 200, protected route 401', async (_n, make) => {
    const headers = { authorization: `Bearer ${await make()}` };
    const guest = await app.inject({ method: 'GET', url: `/v1/users/${user.id}`, headers });
    expect(guest.statusCode).toBe(200);
    expect(JSON.parse(guest.payload).followStatus).toBe('none'); // a guest, not the user
    const prot = await app.inject({ method: 'GET', url: '/v1/me', headers });
    expect(prot.statusCode).toBe(401);
    expect(JSON.parse(prot.payload).error.code).toBe('auth_required');
  });
});

describe('X-Request-Id is validated before it reaches logs and headers', () => {
  it('keeps a plain id', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': 'abc-123_X.9' } });
    expect(res.headers['x-request-id']).toBe('abc-123_X.9');
  });

  it.each([
    ['too long', 'a'.repeat(65)],
    // Real CR/LF never gets this far: Node rejects such a header first.
    ['escaped newline and JSON','abc\\n{"level":50}'],
    ['spaces and quotes', 'a b"c'],
    ['non-ASCII', 'idé'],
    ['empty', ''],
  ])('replaces %s with a fresh UUID', async (_n, value) => {
    const res = await app.inject({ method: 'GET', url: '/healthz', headers: { 'x-request-id': value } });
    const id = String(res.headers['x-request-id']);
    expect(id).not.toBe(value);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(REQUEST_ID_PATTERN.test(id)).toBe(true);
  });
});

describe('database constraint violations are 4xx, never 500', () => {
  it('POST /v1/reads with a work that does not exist → 422 invalid_reference (was 500)', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/reads', headers: user.auth, payload: { work_id: randomUUID(), status: 'reading' },
    });
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.payload);
    expect(body.error.code).toBe('invalid_reference');
    expect(res.payload).not.toMatch(/fkey|constraint|reads_|work_id/i);
  });

  it('progress page beyond int4 → 422 (was 500)', async () => {
    const readId = await makeRead(db, user.id, await makeWork(db, 'Int overflow'), { status: 'reading' });
    const res = await app.inject({
      method: 'POST', url: `/v1/reads/${readId}/progress`, headers: user.auth,
      payload: { client_event_id: randomUUID(), page: 2_147_483_648 },
    });
    expect(res.statusCode).toBe(422);
    expect(JSON.parse(res.payload).error.code).toBe('invalid_field');
  });

  it('an oversized JSON body says so, not "export file exceeds 10MB"', async () => {
    const res = await app.inject({
      method: 'POST', url: '/v1/shelves', headers: { ...user.auth, 'content-type': 'application/json' },
      payload: JSON.stringify({ name: 'x'.repeat(1_100_000) }),
    });
    expect(res.statusCode).toBe(413);
    expect(JSON.parse(res.payload).error.code).toBe('body_too_large');
  });
});

describe('security headers on HTML (PRD §42 #9)', () => {
  it('shelf share page: strict CSP, no script at all', async () => {
    const [sh] = await db.insert(shelves).values({ userId: user.id, name: 'Share me', slug: 'share-me', privacy: 'public' })
      .returning({ id: shelves.id });
    const res = await app.inject({ method: 'GET', url: `/shelf/${sh!.id}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toContain("default-src 'none'");
    expect(csp).not.toContain('script-src');
    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['x-content-type-options']).toBe('nosniff');
  });

  // Audit 06 replaced the admin pages' inline-script baseline with a
  // per-response nonce policy; admin-security.test.ts checks every page.
  it('admin HTML gets a nonce policy, other HTML a script-free baseline', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/login' });
    expect(res.headers['content-type']).toMatch(/^text\/html/);
    const csp = String(res.headers['content-security-policy']);
    expect(csp).toMatch(/script-src 'nonce-[A-Za-z0-9+/=]+';/);
    expect(csp).not.toContain("'unsafe-inline'; style-src 'self'");
    expect(/script-src ([^;]+)/.exec(csp)![1]).not.toContain('unsafe-inline');
    expect(HTML_BASELINE_CSP).not.toContain('script-src');
  });

  it('JSON responses carry no CSP (nothing to protect, fewer bytes)', async () => {
    const res = await app.inject({ method: 'GET', url: '/healthz' });
    expect(res.headers['content-security-policy']).toBeUndefined();
  });
});

describe('secrets never reach logs or error reports (PRD §42.1)', () => {
  it('redactUrl hides the export download token', () => {
    expect(redactUrl('/v1/exports/abc/download?token=s3cr3t&x=1')).toBe('/v1/exports/abc/download?token=[redacted]&x=1');
    expect(redactUrl('/v1/feed?tab=popular')).toBe('/v1/feed?tab=popular');
  });

  it('sanitizeContext scrubs query tokens and newPassword', () => {
    const out = sanitizeContext({ query: { token: 's3cr3t', tab: 'x' }, body: { newPassword: 'hunter2hunter2', token: 't' } });
    expect(out.query).toEqual({ token: '[REDACTED]', tab: 'x' });
    expect(out.body).toEqual({ newPassword: '[REDACTED]', token: '[REDACTED]' });
  });
});

describe('signing up again with an existing email (D-04-1, PRD §6.3)', () => {
  const register = (email: string, username: string) =>
    app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email, username, password: 'a-long-enough-password-9', dateOfBirth: '1990-01-01' },
    });

  it('unverified: resends verification, answers exactly like a verified account, issues no tokens', async () => {
    expect((await register('pending@example.com', 'pending_one')).statusCode).toBe(201);
    expect((await register('done@example.com', 'done_one')).statusCode).toBe(201);
    await db.update(users).set({ emailVerifiedAt: new Date() }).where(eq(users.email, 'done@example.com'));
    mailer.clear();

    const again = await register('pending@example.com', 'pending_two');
    const verifiedAgain = await register('done@example.com', 'done_two');

    expect(again.statusCode).toBe(409);
    expect(again.payload).toBe(verifiedAgain.payload); // says nothing about verification
    expect(again.payload).not.toMatch(/accessToken|refreshToken/);
    expect(mailer.sentMessages.map((m) => m.to)).toEqual(['pending@example.com']);
    expect(mailer.lastMessage()!.subject).toMatch(/verify/i);

    // Throttled like resend-verification: a burst sends one email, silently.
    const third = await register('pending@example.com', 'pending_three');
    expect(third.payload).toBe(verifiedAgain.payload);
    expect(mailer.sentMessages).toHaveLength(1);
  }, 60_000);
});

describe('GET /v1/me exposes emailVerified for the banner (D-04-1)', () => {
  it('true for a verified user, false for an unverified one', async () => {
    const unverified = await makeUser(db, 'me_unverified', { verified: false });
    const a = JSON.parse((await app.inject({ method: 'GET', url: '/v1/me', headers: user.auth })).payload);
    const b = JSON.parse((await app.inject({ method: 'GET', url: '/v1/me', headers: unverified.auth })).payload);
    expect(a.emailVerified).toBe(true);
    expect(b.emailVerified).toBe(false);
  });
});
