// Audit Part 04 (FN-60 … FN-66): auth edge cases the original suite did not cover.
// Each test here was seen failing against the pre-audit code; see
// docs/audit/findings/04-auth.md for the finding it pins.

import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { PGlite } from '@electric-sql/pglite';
import Fastify, { type FastifyInstance } from 'fastify';
import * as jose from 'jose';

import {
  IdentityService,
  identityRoutes,
  isAtLeast13,
  RESERVED_USERNAMES,
  verifyAccessToken,
} from '../identity/index.js';
import { signAdminToken } from '../admin/auth.js';
import { buildApp, registerCoreHooks } from '../app.js';
import {
  config,
  MemoryEmailSender,
  parseTrustProxy,
  PgRateLimiter,
  resolveJwtSecret,
  type Db,
} from '../platform/index.js';
import { freshDrizzle } from './pg.js';

const run = promisify(execFile);
const PLATFORM = pathToFileURL(fileURLToPath(new URL('../platform/index.ts', import.meta.url))).href;

/** Import the config module in a child process, as a server boot would. */
async function bootConfig(env: Record<string, string | undefined>) {
  const childEnv: NodeJS.ProcessEnv = { ...process.env };
  delete childEnv.JWT_SECRET;
  delete childEnv.NODE_ENV;
  for (const [k, v] of Object.entries(env)) if (v !== undefined) childEnv[k] = v;
  try {
    await run(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `await import(${JSON.stringify(PLATFORM)})`], {
      env: childEnv,
      timeout: 60_000,
    });
    return { code: 0, stderr: '' };
  } catch (err) {
    const e = err as { code?: number; stderr?: string };
    return { code: e.code ?? 1, stderr: e.stderr ?? '' };
  }
}

describe('JWT_SECRET at boot (A-04-001)', () => {
  it('refuses to start in production without JWT_SECRET', async () => {
    const r = await bootConfig({ NODE_ENV: 'production' });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('JWT_SECRET');
  }, 60_000);

  it('refuses to start in production with a secret shorter than 32 bytes', async () => {
    const r = await bootConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(31) });
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain('JWT_SECRET');
  }, 60_000);

  it('refuses the public dev secret in production', () => {
    const dev = resolveJwtSecret('development', undefined);
    expect(() => resolveJwtSecret('production', dev)).toThrow(/JWT_SECRET/);
    expect(resolveJwtSecret('test', undefined)).toBe(dev);
  });

  it('starts in production with a 32-byte secret, and in development without one', async () => {
    expect((await bootConfig({ NODE_ENV: 'production', JWT_SECRET: 'x'.repeat(32) })).code).toBe(0);
    expect((await bootConfig({ NODE_ENV: 'development' })).code).toBe(0);
  }, 60_000);
});

describe('proxy trust (A-04-002)', () => {
  async function ipApp(trustProxy?: boolean) {
    const app = await buildApp(trustProxy === undefined ? {} : { trustProxy });
    app.get('/test/ip', async (req) => ({ ip: req.ip }));
    await app.ready();
    return app;
  }

  it('ignores a client-supplied X-Forwarded-For by default', async () => {
    const app = await ipApp();
    const res = await app.inject({ method: 'GET', url: '/test/ip', headers: { 'x-forwarded-for': '6.6.6.6' } });
    expect(res.json().ip).not.toBe('6.6.6.6');
    await app.close();
  });

  it('TRUST_PROXY parses to off unless set', () => {
    expect(parseTrustProxy(undefined)).toBe(false);
    expect(parseTrustProxy('')).toBe(false);
    expect(parseTrustProxy('false')).toBe(false);
    expect(parseTrustProxy('true')).toBe(true);
    expect(parseTrustProxy('127.0.0.1,10.0.0.0/8')).toBe('127.0.0.1,10.0.0.0/8');
  });

  it('uses X-Forwarded-For only when proxy trust is switched on', async () => {
    const app = await ipApp(true);
    const res = await app.inject({ method: 'GET', url: '/test/ip', headers: { 'x-forwarded-for': '6.6.6.6' } });
    expect(res.json().ip).toBe('6.6.6.6');
    await app.close();
  });
});

describe('access token verification (A-04-003, A-04-004)', () => {
  const key = new TextEncoder().encode(config.jwtSecret);
  const uid = '11111111-1111-1111-1111-111111111111';

  it('rejects an admin token on app routes', async () => {
    const admin = await signAdminToken({ id: uid, email: 'a@example.com', role: 'admin' });
    expect(await verifyAccessToken(admin)).toBeNull();
  });

  it('rejects a token signed with an algorithm other than HS256', async () => {
    const t = await new jose.SignJWT({ sub: uid }).setProtectedHeader({ alg: 'HS512' })
      .setAudience('flyleaf-app').setIssuer('flyleaf').setIssuedAt().setExpirationTime('15m').sign(key);
    expect(await verifyAccessToken(t)).toBeNull();
  });

  it('rejects a token with no expiry', async () => {
    const t = await new jose.SignJWT({ sub: uid }).setProtectedHeader({ alg: 'HS256' })
      .setAudience('flyleaf-app').setIssuer('flyleaf').setIssuedAt().sign(key);
    expect(await verifyAccessToken(t)).toBeNull();
  });

  it('rejects an unsigned (alg none) token', async () => {
    const t = new jose.UnsecuredJWT({ sub: uid }).setAudience('flyleaf-app').setIssuer('flyleaf')
      .setIssuedAt().setExpirationTime('15m').encode();
    expect(await verifyAccessToken(t)).toBeNull();
  });
});

describe('age gate edge cases (A-04-008)', () => {
  it('rejects calendar-invalid, pre-1900 and year-0 dates', () => {
    const now = new Date('2026-09-25T12:00:00Z');
    for (const d of ['2013-02-30', '2013-02-29', '1899-12-31', '0000-01-01', '2000-13-01', '2000-00-10']) {
      expect(isAtLeast13(d, now), d).toBe(false);
    }
    expect(isAtLeast13('1900-01-01', now)).toBe(true);
  });

  it('a 29 February birthday turns 13 on 1 March in a non-leap year', () => {
    expect(isAtLeast13('2012-02-29', new Date('2025-02-28T12:00:00Z'))).toBe(false);
    expect(isAtLeast13('2012-02-29', new Date('2025-03-01T12:00:00Z'))).toBe(true);
  });

  it('turns 13 on the UTC birthday, whatever the server time zone', () => {
    const tz = process.env.TZ;
    try {
      for (const zone of ['America/Los_Angeles', 'Asia/Kolkata', 'Pacific/Kiritimati', 'UTC']) {
        process.env.TZ = zone;
        expect(isAtLeast13('2013-09-25', new Date('2026-09-24T23:00:00Z')), zone).toBe(false);
        expect(isAtLeast13('2013-09-25', new Date('2026-09-25T00:30:00Z')), zone).toBe(true);
      }
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });
});

describe('reserved usernames (A-04-010)', () => {
  it('server list matches the mobile list (SL-22)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../../../mobile/src/lib/auth-validation.ts', import.meta.url)),
      'utf8',
    );
    const block = src.match(/RESERVED_USERNAMES = new Set\(\[([\s\S]*?)\]\)/)?.[1] ?? '';
    const mobile = [...block.matchAll(/'([^']+)'/g)].map((m) => m[1]).sort();
    expect(mobile.length).toBeGreaterThan(0);
    expect([...RESERVED_USERNAMES].sort()).toEqual(mobile);
  });
});

describe('IdentityService edge cases (Part 04)', () => {
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
    registerCoreHooks(app, { identityLookup: (t) => service.lookup(t) });
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

  const register = (payload: Record<string, unknown>, headers: Record<string, string> = {}) =>
    app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      headers,
      payload: { email: 'a@example.com', username: 'reader_a', password: 'goodpassword123', dateOfBirth: '1990-01-01', ...payload },
    });

  it('an admin token does not authenticate an app route (A-04-003)', async () => {
    const reg = await service.register('adm@example.com', 'adm_user', 'goodpassword123', '1990-01-01');
    const admin = await signAdminToken({ id: reg.user.id, email: 'adm@example.com', role: 'admin' });
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${admin}` } });
    expect(res.statusCode).toBe(401);
  });

  it('two concurrent refreshes with one token never both succeed (A-04-005)', async () => {
    const reg = await service.register('race@example.com', 'race_r', 'goodpassword123', '1990-01-01');
    const results = await Promise.allSettled([service.refresh(reg.refreshToken), service.refresh(reg.refreshToken)]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toMatchObject({ status: 403, code: 'token_reused' });
  });

  it('a password reset token can be spent only once under concurrency (A-04-013)', async () => {
    await service.register('rr@example.com', 'rr_user', 'goodpassword123', '1990-01-01');
    await service.forgotPassword('rr@example.com');
    const token = mailer.lastMessage()!.text.match(/token=([a-zA-Z0-9_-]+)/)![1]!;
    const results = await Promise.allSettled([
      service.resetPassword(token, 'firstnewpassword1'),
      service.resetPassword(token, 'secondnewpassword2'),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('a deleted user can neither log in nor refresh (A-04-007)', async () => {
    const reg = await service.register('gone@example.com', 'gone_user', 'goodpassword123', '1990-01-01');
    await client.query(`UPDATE users SET deleted_at = now() WHERE id = $1`, [reg.user.id]);
    await expect(service.login('gone@example.com', 'goodpassword123')).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    await expect(service.refresh(reg.refreshToken)).rejects.toMatchObject({ status: 401, code: 'invalid_refresh_token' });
  });

  it('login for an unknown email costs about as much as a wrong password (A-04-006)', async () => {
    await service.register('timing@example.com', 'timing_u', 'goodpassword123', '1990-01-01');
    const time = async (email: string) => {
      const t = performance.now();
      await service.login(email, 'wrongpassword99').catch(() => undefined);
      return performance.now() - t;
    };
    await time('timing@example.com'); // warm-up
    let known = 0;
    let unknown = 0;
    for (let i = 0; i < 3; i++) {
      await client.exec('TRUNCATE rate_limits');
      known += await time('timing@example.com');
      unknown += await time(`nobody${i}@example.com`);
    }
    // Before the fix `unknown` was one indexed query (~1 ms) against ~20 ms of argon2.
    expect(unknown).toBeGreaterThan(known * 0.5);
  });

  it('a password over 1,024 characters is rejected with 422 (A-04-009)', async () => {
    const res = await register({ password: 'long pass phrase '.repeat(61).slice(0, 1025) });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.field).toBe('password');
    expect((await register({ password: 'long pass phrase '.repeat(61).slice(0, 1024) })).statusCode).toBe(201);
  });

  it('a password typed in NFD matches the same password registered in NFC (A-04-009)', async () => {
    const nfc = 'caf' + String.fromCharCode(0xe9) + ' au lait 42';
    const nfd = 'cafe' + String.fromCharCode(0x301) + ' au lait 42';
    await service.register('nfc@example.com', 'nfc_user', nfc, '1990-01-01');
    const res = await service.login('nfc@example.com', nfd);
    expect(res.user.email).toBe('nfc@example.com');
  });

  it.each(['2013-02-30', '0000-01-01', '1899-12-31'])('an invalid date of birth %s is a 422, not a 500 (A-04-008)', async (dob) => {
    const res = await register({ dateOfBirth: dob });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.field).toBe('dateOfBirth');
    const [{ n }] = (await client.query<{ n: number }>('SELECT count(*)::int AS n FROM users')).rows as [{ n: number }];
    expect(n).toBe(0);
  });

  it('an under-13 attempt leaves no partial account behind (PRD §26.6)', async () => {
    const res = await register({ dateOfBirth: '2020-01-01' });
    expect(res.statusCode).toBe(422);
    const rows = (await client.query('SELECT 1 FROM users UNION ALL SELECT 1 FROM profiles UNION ALL SELECT 1 FROM refresh_tokens')).rows;
    expect(rows).toHaveLength(0);
    expect(mailer.sentMessages).toHaveLength(0);
  });

  it('email case never creates a second account; usernames must arrive lowercase (A-04-011)', async () => {
    const first = await register({ email: 'Alice@Example.COM', username: 'alice_r' });
    expect(first.statusCode).toBe(201);
    expect(first.json().user.email).toBe('alice@example.com');
    const dupe = await register({ email: 'aLiCe@example.com', username: 'other_name' });
    expect(dupe.statusCode).toBe(409);
    expect(dupe.json().error.code).toBe('email_taken');
    // The contract pattern is lowercase-only; the mobile client lowercases (auth.tsx).
    const upper = await register({ email: 'b@example.com', username: 'ALICE_R' });
    expect(upper.statusCode).toBe(422);
    const login = await service.login(' ALICE@example.com ', 'goodpassword123');
    expect(login.user.username).toBe('alice_r');
  });

  it.each(['admin', 'Flyleaf', 'support'])('reserved username %s is rejected (A-04-010)', async (username) => {
    const res = await register({ username });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.field).toBe('username');
  });

  it('the device label is truncated and stripped of control characters (A-04-012)', async () => {
    const ua = 'Evil' + String.fromCharCode(0) + String.fromCharCode(10) + '<b>x</b>' + 'A'.repeat(5000);
    expect((await register({}, { 'user-agent': ua })).statusCode).toBe(201);
    const [{ device }] = (await client.query<{ device: string }>('SELECT device FROM refresh_tokens')).rows as [{ device: string }];
    expect(device.length).toBeLessThanOrEqual(200);
    expect(device).not.toMatch(/[\u0000-\u001f\u007f]/);
    expect(device.startsWith('Evil')).toBe(true);
  });

  it('email links use the configured base URL and carry only the token (A-04-014)', async () => {
    const reg = await service.register('link@example.com', 'link_user', 'goodpassword123', '1990-01-01');
    const verify = mailer.lastMessage()!.text;
    expect(verify).toContain(`${config.appBaseUrl}/verify-email?token=`);
    await service.forgotPassword('link@example.com');
    const reset = mailer.lastMessage()!.text;
    expect(reset).toContain(`${config.appBaseUrl}/reset-password?token=`);
    for (const body of [verify, reset]) {
      expect(body).not.toContain(reg.user.id);
      expect(body).not.toContain('goodpassword123');
    }
  });

  it('sessions: lastUsedAt advances on rotation; revoking the current session ends refresh but not the live access token', async () => {
    const reg = await service.register('sess@example.com', 'sess_user', 'goodpassword123', '1990-01-01', 'Phone');
    const [before] = await service.listSessions(reg.user.id);
    await new Promise((r) => setTimeout(r, 20));
    const rotated = await service.refresh(reg.refreshToken);
    const [after] = await service.listSessions(reg.user.id);
    expect(after!.id).toBe(before!.id);
    expect(after!.lastUsedAt.getTime()).toBeGreaterThan(before!.lastUsedAt.getTime());

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/auth/sessions/${after!.id}`,
      headers: { authorization: `Bearer ${rotated.accessToken}` },
    });
    expect(del.statusCode).toBe(200);
    await expect(service.refresh(rotated.refreshToken)).rejects.toMatchObject({ status: 401 });
    // Stateless access token: valid until its 15-minute expiry (documented, PRD §25.2).
    const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${rotated.accessToken}` } });
    expect(me.statusCode).toBe(200);
  });
});
