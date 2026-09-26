// Admin console security (Audit 06: FN-90 … FN-93, PRD §27.5, §7.9, §42).
//
// admin.test.ts and admin-catalog.test.ts cover the happy paths. This suite
// attacks what they assumed: the browser flow (cookie scope, CSRF), TOTP
// replay, revocation, every route × role, stored and reflected XSS, the audit
// trail's completeness and immutability, and that a locked maturity override
// survives the next ingest.

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';
import { sql } from 'drizzle-orm';
import * as jose from 'jose';

import { buildApp, registerCoreHooks } from '../app.js';
import {
  createAdminUser,
  disableAdmin,
  loginAdmin,
  lookupAdmin,
  setup2fa,
  signAdminToken,
  verify2fa,
  verifyAdminToken,
} from '../admin/auth.js';
import { generateTotp } from '../admin/totp.js';
import { overrideWorkMaturity, getIngestDashboardStatus } from '../admin/catalog.js';
import { queueReportedDuplicate } from '../catalog/dedupe.js';
import { MERGE_WORKS, STAGING } from '../catalog/ingest/writer.js';
import { GapFillService } from '../catalog/gapfill.js';
import { OpenLibrarySource } from '../providers/catalog/index.js';
import { outbound } from '../platform/outbound.js';
import { IdentityService } from '../identity/index.js';
import { isCommonPassword } from '../identity/common-passwords.js';
import { config, PgRateLimiter, type Db } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import { freshDrizzle } from './pg.js';
import { makeUser, unlimited } from './interaction-fixtures.js';

const PW = 'Admin-Console-Passphrase-1';
const HOST = 'admin.flyleaf.app';
const ORIGIN = `https://${HOST}`;

type Staff = { id: string; email: string; secret: string; backupCodes: string[]; token: string };

async function staff(db: Db, email: string, role: 'admin' | 'moderator'): Promise<Staff> {
  const created = await createAdminUser(db, { email, password: PW, role, username: email.split('@')[0]!.replace(/\W/g, '_') });
  const token = await signAdminToken(created.user);
  return { id: created.user.id, email, secret: created.secret, backupCodes: created.backupCodes, token };
}

/** The TOTP code for the step after `last`, so two logins in one test never collide. */
function codeAt(secret: string, stepOffset: number): { code: string; at: number } {
  const at = Date.now() + stepOffset * 30_000;
  return { code: generateTotp(secret, at), at };
}

const cookieFor = (token: string) => ({ cookie: `flyleaf_admin_session=${encodeURIComponent(token)}` });

/** Every attribute NAME in every tag (values skipped, so escaped text inside one cannot match). */
function attributeNames(html: string): string[] {
  const names: string[] = [];
  for (const [, attrs] of html.matchAll(/<[a-zA-Z][\w-]*((?:\s+[^\s=>/]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?)*)\s*\/?>/g)) {
    for (const [, name] of attrs!.matchAll(/\s+([^\s=>/]+)(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]+))?/g)) names.push(name!);
  }
  return names;
}

async function auditRows(db: Db, action?: string) {
  return db.execute<{
    action: string; actor_id: string | null; ip: string | null; user_agent: string | null;
    reason: string | null; payload: Record<string, unknown>;
  }>(sql`
    SELECT action, actor_id, ip, user_agent, reason, payload FROM admin_audit_log
    WHERE ${action ? sql`action = ${action}` : sql`TRUE`} ORDER BY id`);
}

// ---------------------------------------------------------------- TOTP

describe('TOTP (RFC 6238, FN-90)', () => {
  // RFC 6238 Appendix B, SHA-1 key "12345678901234567890". The RFC lists
  // 8-digit codes; a 6-digit code is the same value mod 10^6.
  const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  const vectors: [number, string][] = [
    [59, '94287082'],
    [1111111109, '07081804'],
    [1111111111, '14050471'],
    [1234567890, '89005924'],
    [2000000000, '69279037'],
    [20000000000, '65353130'],
  ];

  it.each(vectors)('T = %i s matches the RFC 6238 vector', (seconds, eight) => {
    expect(generateTotp(RFC_SECRET, seconds * 1000)).toBe(eight.slice(-6));
  });
});

describe('admin login (FN-90)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let admin: Staff;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    admin = await staff(db, 'totp_admin@flyleaf.app', 'admin');
  });
  afterAll(async () => close?.());

  it('a TOTP code is accepted once: the same code again is refused (replay)', async () => {
    const code = generateTotp(admin.secret);
    await loginAdmin(db, { email: admin.email, password: PW, totpCode: code });
    await expect(loginAdmin(db, { email: admin.email, password: PW, totpCode: code }))
      .rejects.toMatchObject({ status: 401, code: 'invalid_totp' });
  });

  it('after a code is used, an OLDER code inside the drift window is refused too', async () => {
    const fresh = await staff(db, 'drift_admin@flyleaf.app', 'admin');
    // The next step's code first (a fast clock), then the current one.
    await loginAdmin(db, { email: fresh.email, password: PW, totpCode: codeAt(fresh.secret, 1).code });
    await expect(loginAdmin(db, { email: fresh.email, password: PW, totpCode: codeAt(fresh.secret, 0).code }))
      .rejects.toMatchObject({ code: 'invalid_totp' });
  });

  it('a backup code cannot be spent twice by two concurrent logins', async () => {
    const fresh = await staff(db, 'race_admin@flyleaf.app', 'admin');
    const code = fresh.backupCodes[0]!;
    const results = await Promise.allSettled([
      loginAdmin(db, { email: fresh.email, password: PW, totpCode: code }),
      loginAdmin(db, { email: fresh.email, password: PW, totpCode: code }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
  });

  it('an app account gets the same 401 as a wrong password, whatever the password', async () => {
    const identity = new IdentityService(db, unlimited, new MemoryEmailSender());
    await identity.register('reader_probe@example.com', 'reader_probe', 'Reader-Passphrase-42', '1990-01-01');

    for (const password of ['Reader-Passphrase-42', 'wrong-password-xx']) {
      await expect(loginAdmin(db, { email: 'reader_probe@example.com', password, totpCode: '123456' }))
        .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
    }
    await expect(loginAdmin(db, { email: 'nobody_here@example.com', password: PW, totpCode: '123456' }))
      .rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('every failed attempt is audited, with no secret in the entry', async () => {
    const before = (await auditRows(db, 'admin.login_failed')).length;
    const ctx = { ip: '203.0.113.9', userAgent: 'probe/1.0' };
    await loginAdmin(db, { email: admin.email, password: 'not-the-password', totpCode: '000000', ...ctx }).catch(() => {});
    await loginAdmin(db, { email: admin.email, password: PW, totpCode: '000000', ...ctx }).catch(() => {});
    await loginAdmin(db, { email: 'ghost@example.com', password: PW, totpCode: '000000', ...ctx }).catch(() => {});

    const rows = (await auditRows(db, 'admin.login_failed')).slice(before);
    expect(rows.map((r) => r.payload.reason)).toEqual(['password', 'totp', 'unknown_account']);
    expect(rows[0]!.actor_id).toBe(admin.id);
    expect(rows[1]!.actor_id).toBe(admin.id);
    expect(rows[2]!.actor_id).toBeNull(); // an unknown email is not stored either
    for (const r of rows) {
      expect(r.ip).toBe('203.0.113.9');
      expect(r.user_agent).toBe('probe/1.0');
      const text = JSON.stringify(r);
      expect(text).not.toContain('not-the-password');
      expect(text).not.toContain(PW);
      expect(text).not.toContain('ghost@example.com');
      expect(text).not.toContain(admin.secret);
    }
  });

  it('2FA setup does not replace the working secret until the new one is verified', async () => {
    const fresh = await staff(db, 'rotate_admin@flyleaf.app', 'admin');
    const pending = await setup2fa(db, fresh.id);

    // The new secret is not live yet; the old one still is.
    await expect(loginAdmin(db, { email: fresh.email, password: PW, totpCode: generateTotp(pending.secret) }))
      .rejects.toMatchObject({ code: 'invalid_totp' });
    await loginAdmin(db, { email: fresh.email, password: PW, totpCode: codeAt(fresh.secret, -1).code });

    await verify2fa(db, fresh.id, generateTotp(pending.secret));
    await expect(loginAdmin(db, { email: fresh.email, password: PW, totpCode: codeAt(fresh.secret, 1).code }))
      .rejects.toMatchObject({ code: 'invalid_totp' });
    await expect(loginAdmin(db, { email: fresh.email, password: PW, totpCode: fresh.backupCodes[0]! }))
      .rejects.toMatchObject({ code: 'invalid_totp' });
    await loginAdmin(db, { email: fresh.email, password: PW, totpCode: pending.backupCodes[0]! });
  });

  it('an admin token with another alg or without exp is refused', async () => {
    const key = new TextEncoder().encode(config.jwtSecret);
    const claims = { email: admin.email, role: 'admin', scope: 'admin' };
    const hs512 = await new jose.SignJWT(claims).setProtectedHeader({ alg: 'HS512' }).setSubject(admin.id)
      .setAudience('flyleaf-admin').setIssuer('flyleaf').setIssuedAt().setExpirationTime('1h').sign(key);
    const noExp = await new jose.SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(admin.id)
      .setAudience('flyleaf-admin').setIssuer('flyleaf').setIssuedAt().sign(key);
    expect(await verifyAdminToken(hs512)).toBeNull();
    expect(await verifyAdminToken(noExp)).toBeNull();
  });
});

// ---------------------------------------------------------------- accounts

describe('admin accounts share the app normaliser and password rules (A-04-011, D-04-2)', () => {
  let db: Db;
  let close: () => Promise<void>;
  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
  });
  afterAll(async () => close?.());

  it('stores the email trimmed and lowercased, and logs in with any case', async () => {
    const created = await createAdminUser(db, { email: '  Mixed.Case@Flyleaf.APP ', password: PW, username: 'mixed_admin' });
    expect(created.user.email).toBe('mixed.case@flyleaf.app');
    await loginAdmin(db, { email: 'MIXED.case@flyleaf.app', password: PW, totpCode: generateTotp(created.secret) });
  });

  it('cannot create an admin whose email differs from an app account only by case', async () => {
    await makeUser(db, 'casey');
    await expect(createAdminUser(db, { email: 'CASEY@example.com', password: PW, username: 'casey_admin' })).rejects.toThrow();
  });

  it('an NFD-typed password matches an NFC-created one', async () => {
    const nfc = 'Café-au-lait-2026';
    const nfd = 'Café-au-lait-2026';
    const created = await createAdminUser(db, { email: 'nfc_admin@flyleaf.app', password: nfc, username: 'nfc_admin' });
    await loginAdmin(db, { email: 'nfc_admin@flyleaf.app', password: nfd, totpCode: generateTotp(created.secret) });
  });

  it('refuses a short or common admin password', async () => {
    await expect(createAdminUser(db, { email: 'weak1@flyleaf.app', password: 'short', username: 'weak1' })).rejects.toThrow(/at least 10/);
    await expect(createAdminUser(db, { email: 'weak2@flyleaf.app', password: 'baseball12', username: 'weak2' })).rejects.toThrow(/too common/);
  });

  it('the bundled list refuses listed passwords and accepts near misses', () => {
    // From the bundled SecLists list, none of them in the old 32-entry list.
    for (const listed of ['baseball12', 'Basketball', 'BASKET-ball', 'Chocolate1', '1q2w3e4r5t']) {
      expect(isCommonPassword(listed), listed).toBe(true);
    }
    for (const nearMiss of ['baseball12x', 'basketball!', 'Chocolate1!', '1q2w3e4r5t6']) {
      expect(isCommonPassword(nearMiss), nearMiss).toBe(false);
    }
  });

  it('app signup refuses a listed password with 422', async () => {
    const app = await buildApp({ db, identity: new IdentityService(db, unlimited, new MemoryEmailSender()) });
    const res = await app.inject({
      method: 'POST', url: '/v1/auth/register',
      payload: { email: 'common@example.com', username: 'common_pw', password: 'basketball', dateOfBirth: '1990-01-01' },
    });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.message).toMatch(/too common/);
    await app.close();
  });
});

// ---------------------------------------------------------------- browser session

describe('admin browser session: server-set cookie, scope and CSRF (A-05-022)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let admin: Staff;
  let workId: string;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)) });
    await app.ready();
    admin = await staff(db, 'browser_admin@flyleaf.app', 'admin');
    const [w] = await db.execute<{ id: string }>(sql`INSERT INTO works (title) VALUES ('CSRF target') RETURNING id`);
    workId = w!.id;
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  const form = (fields: Record<string, string>) => new URLSearchParams(fields).toString();

  it('the login page has no script that could read or write the session', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/login', headers: { host: HOST } });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('document.cookie');
    expect(res.body).toMatch(/<form[^>]+method="POST"[^>]+action="\/admin\/login"/);
  });

  it('a successful form login sets HttpOnly, Secure, SameSite=Strict cookies for /admin and /v1/admin', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ email: admin.email, password: PW, totp_code: codeAt(admin.secret, -1).code }),
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/admin/merges');
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
    expect(cookies.map((c) => /Path=([^;]+)/.exec(c)?.[1]).sort()).toEqual(['/admin', '/v1/admin']);
    for (const c of cookies) {
      expect(c).toMatch(/^flyleaf_admin_session=[^;]+;/);
      expect(c).toContain('HttpOnly');
      expect(c).toContain('Secure');
      expect(c).toContain('SameSite=Strict');
    }
    // The token is never handed to page script.
    const token = /^flyleaf_admin_session=([^;]+)/.exec(cookies[0]!)![1]!;
    expect(res.body).not.toContain(decodeURIComponent(token));

    const page = await app.inject({ method: 'GET', url: '/admin/merges', headers: { host: HOST, cookie: `flyleaf_admin_session=${token}` } });
    expect(page.statusCode).toBe(200);
  });

  it('Secure is left off only for plain http on localhost outside production', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/login',
      headers: { host: 'localhost:3000', origin: 'http://localhost:3000', 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ email: admin.email, password: PW, totp_code: codeAt(admin.secret, 1).code }),
    });
    expect(res.statusCode).toBe(303);
    for (const c of ([] as string[]).concat(res.headers['set-cookie'] as string | string[])) {
      expect(c).not.toContain('Secure');
      expect(c).toContain('HttpOnly');
    }
  });

  it('a failed form login re-renders the page with 401 and sets no cookie', async () => {
    const res = await app.inject({
      method: 'POST', url: '/admin/login',
      headers: { host: HOST, origin: ORIGIN, 'content-type': 'application/x-www-form-urlencoded' },
      payload: form({ email: admin.email, password: 'wrong-password-xx', totp_code: '000000' }),
    });
    expect(res.statusCode).toBe(401);
    expect(res.headers['set-cookie']).toBeUndefined();
    expect(res.body).toContain('Invalid email or password.');
  });

  const override = (headers: Record<string, string>) =>
    app.inject({
      method: 'POST', url: `/v1/admin/catalog/works/${workId}/maturity`,
      headers: { host: HOST, ...headers },
      payload: { maturity: 'mature', reason: 'csrf probe' },
    });

  it('a cookie-authenticated write from another origin, or with no Origin, is refused', async () => {
    expect((await override({ ...cookieFor(admin.token), origin: 'https://evil.example' })).statusCode).toBe(401);
    expect((await override({ ...cookieFor(admin.token), origin: `https://${HOST}.evil.example` })).statusCode).toBe(401);
    expect((await override({ ...cookieFor(admin.token) })).statusCode).toBe(401);
    const [w] = await db.execute<{ maturity: string }>(sql`SELECT maturity FROM works WHERE id = ${workId}`);
    expect(w!.maturity).toBe('unclassified');
  });

  it('the same write from the console origin succeeds, and a bearer token needs no Origin', async () => {
    expect((await override({ ...cookieFor(admin.token), origin: ORIGIN })).statusCode).toBe(200);
    expect((await override({ authorization: `Bearer ${admin.token}` })).statusCode).toBe(200);
  });

  it('logout clears both cookies and ends every session of that admin', async () => {
    const other = await staff(db, 'logout_admin@flyleaf.app', 'admin');
    const res = await app.inject({ method: 'POST', url: '/admin/logout', headers: { host: HOST, origin: ORIGIN, ...cookieFor(other.token) } });
    expect(res.statusCode).toBe(302);
    const cookies = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
    expect(cookies.map((c) => /Path=([^;]+)/.exec(c)?.[1]).sort()).toEqual(['/admin', '/v1/admin']);
    for (const c of cookies) expect(c).toContain('Max-Age=0');

    const me =await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { authorization: `Bearer ${other.token}` } });
    expect(me.statusCode).toBe(401);
  });
});

describe('the auth hook honours the admin cookie only on admin paths', () => {
  it('ignores the cookie elsewhere and uses the lookup it is given', async () => {
    const probe = Fastify();
    const seen: string[] = [];
    registerCoreHooks(probe, {
      adminLookup: async (token) => {
        seen.push(token);
        return { id: 'a1', email: 'a@x', role: 'admin' };
      },
    });
    probe.get('/v1/probe', async (req) => ({ admin: req.admin?.id ?? null }));
    probe.get('/v1/admin/probe', async (req) => ({ admin: req.admin?.id ?? null }));
    probe.get('/admin/probe', async (req) => ({ admin: req.admin?.id ?? null }));
    await probe.ready();

    const hit = async (url: string) => (await probe.inject({ method: 'GET', url, headers: { cookie: 'flyleaf_admin_session=tok' } })).json().admin ?? null;
    expect(await hit('/v1/probe')).toBeNull();
    expect(await hit('/v1/administrator')).toBeNull(); // a 404, and the cookie must not even be looked up
    expect(await hit('/v1/admin/probe')).toBe('a1');
    expect(await hit('/admin/probe')).toBe('a1');
    expect(seen).toEqual(['tok', 'tok']);
    await probe.close();
  });
});

// ---------------------------------------------------------------- revocation

describe('admin revocation takes effect immediately (FN-90)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    app = await buildApp({ db });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  const me = (token: string) => app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { authorization: `Bearer ${token}` } });

  it('a demoted admin acts with the current role, a removed one not at all', async () => {
    const a = await staff(db, 'demote_admin@flyleaf.app', 'admin');
    expect((await me(a.token)).json().admin.role).toBe('admin');

    await db.execute(sql`UPDATE users SET role = 'moderator' WHERE id = ${a.id}`);
    const undo = await app.inject({
      method: 'POST', url: '/v1/admin/merges/00000000-0000-0000-0000-000000000001/undo',
      headers: { authorization: `Bearer ${a.token}` },
    });
    expect(undo.statusCode).toBe(403);

    await db.execute(sql`UPDATE users SET role = 'user' WHERE id = ${a.id}`);
    expect((await me(a.token)).statusCode).toBe(401);
  });

  it('a deleted admin, and one disabled from the CLI, is refused', async () => {
    const del = await staff(db, 'deleted_admin@flyleaf.app', 'admin');
    await db.execute(sql`UPDATE users SET deleted_at = now() WHERE id = ${del.id}`);
    expect((await me(del.token)).statusCode).toBe(401);

    const dis = await staff(db, 'disabled_admin@flyleaf.app', 'moderator');
    await disableAdmin(db, 'DISABLED_admin@flyleaf.app');
    expect((await me(dis.token)).statusCode).toBe(401);
    expect(await lookupAdmin(db, dis.token)).toBeNull();
    await expect(loginAdmin(db, { email: dis.email, password: PW, totpCode: generateTotp(dis.secret) }))
      .rejects.toMatchObject({ status: 401 });
  });
});

// ---------------------------------------------------------------- role × route

describe('every admin route × {guest, app user, moderator, admin} (FN-91, FN-92)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let tokens: Record<'guest' | 'user' | 'moderator' | 'admin', Record<string, string>>;
  let workA: string;
  let workB: string;
  const RANDOM = '00000000-0000-0000-0000-00000000abcd';

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    app = await buildApp({ db, identity: new IdentityService(db, new PgRateLimiter(db)) });
    await app.ready();
    const user = await makeUser(db, 'matrix_reader');
    const mod = await staff(db, 'matrix_mod@flyleaf.app', 'moderator');
    const adm = await staff(db, 'matrix_admin@flyleaf.app', 'admin');
    tokens = {
      guest: {},
      user: { authorization: `Bearer ${user.token}` },
      moderator: { authorization: `Bearer ${mod.token}` },
      admin: { authorization: `Bearer ${adm.token}` },
    };
    const [a] = await db.execute<{ id: string }>(sql`INSERT INTO works (title) VALUES ('Matrix A') RETURNING id`);
    const [b] = await db.execute<{ id: string }>(sql`INSERT INTO works (title) VALUES ('Matrix B') RETURNING id`);
    workA = a!.id;
    workB = b!.id;
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  type Row = { method: 'GET' | 'POST'; name: string; url: () => string; payload?: () => object; expect: [number, number, number, number] };
  // [guest, app user, moderator, admin]
  const REST: Row[] = [
    { method: 'GET', name: '/v1/admin/auth/me', url: () => '/v1/admin/auth/me', expect: [401, 401, 200, 200] },
    { method: 'POST', name: '/v1/admin/auth/2fa/setup', url: () => '/v1/admin/auth/2fa/setup', expect: [401, 401, 403, 200] },
    { method: 'POST', name: '/v1/admin/auth/2fa/verify', url: () => '/v1/admin/auth/2fa/verify', payload: () => ({ code: '000000' }), expect: [401, 401, 403, 400] },
    { method: 'GET', name: '/v1/admin/audit-log', url: () => '/v1/admin/audit-log', expect: [401, 401, 200, 200] },
    { method: 'GET', name: '/v1/admin/dedupe/queue', url: () => '/v1/admin/dedupe/queue', expect: [401, 401, 200, 200] },
    { method: 'GET', name: '/v1/admin/dedupe/preview/:a/:b', url: () => `/v1/admin/dedupe/preview/${workA}/${workB}`, expect: [401, 401, 200, 200] },
    { method: 'POST', name: '/v1/admin/dedupe/queue/:random/resolve', url: () => `/v1/admin/dedupe/queue/${RANDOM}/resolve`, payload: () => ({ action: 'dismiss', reason: 'probe' }), expect: [401, 401, 403, 404] },
    { method: 'POST', name: '/v1/admin/dedupe/report', url: () => '/v1/admin/dedupe/report', payload: () => ({ survivor_id: workA, loser_id: workB, reason: 'same book' }), expect: [401, 200, 200, 200] },
    { method: 'GET', name: '/v1/admin/merges', url: () => '/v1/admin/merges', expect: [401, 401, 200, 200] },
    { method: 'POST', name: '/v1/admin/merges/:random/undo', url: () => `/v1/admin/merges/${RANDOM}/undo`, payload: () => ({ reason: 'probing the role matrix' }), expect: [401, 401, 403, 404] },
    { method: 'GET', name: '/v1/admin/catalog/works', url: () => '/v1/admin/catalog/works', expect: [401, 401, 200, 200] },
    { method: 'GET', name: '/v1/admin/catalog/works/:a', url: () => `/v1/admin/catalog/works/${workA}`, expect: [401, 401, 200, 200] },
    { method: 'POST', name: '/v1/admin/catalog/works/:a/maturity', url: () => `/v1/admin/catalog/works/${workA}/maturity`, payload: () => ({ maturity: 'general', reason: 'matrix' }), expect: [401, 401, 403, 200] },
    { method: 'GET', name: '/v1/admin/ingest/status', url: () => '/v1/admin/ingest/status', expect: [401, 401, 200, 200] },
    { method: 'GET', name: '/admin/telemetry/budgets', url: () => '/admin/telemetry/budgets', expect: [401, 401, 200, 200] },
  ];
  const roles = ['guest', 'user', 'moderator', 'admin'] as const;

  for (const row of REST) {
    it(`${row.method} ${row.name}`, async () => {
      const got: number[] = [];
      for (const role of roles) {
        const res = await app.inject({ method: row.method, url: row.url(), headers: tokens[role], payload: row.payload?.() });
        got.push(res.statusCode);
      }
      expect(got).toEqual(row.expect);
    });
  }

  it('HTML pages: guests and app users are sent to login; staff get the page', async () => {
    for (const url of ['/admin/merges', '/admin/catalog/maturity', '/admin/ingest', '/admin/audit-log']) {
      for (const role of ['guest', 'user'] as const) {
        const res = await app.inject({ method: 'GET', url, headers: tokens[role] });
        expect([url, role, res.statusCode, res.headers.location]).toEqual([url, role, 302, '/admin/login']);
      }
      for (const role of ['moderator', 'admin'] as const) {
        const res = await app.inject({ method: 'GET', url, headers: tokens[role] });
        expect([url, role, res.statusCode]).toEqual([url, role, 200]);
      }
    }
  });

  it('an admin token is a guest on app routes', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me', headers: tokens.admin });
    expect(res.statusCode).toBe(401);
  });

  it('a moderator denied a write is audited', async () => {
    await app.inject({ method: 'POST', url: `/v1/admin/merges/${RANDOM}/undo`, headers: tokens.moderator });
    const rows = await auditRows(db, 'admin.denied');
    expect(rows.at(-1)).toMatchObject({ payload: { method: 'POST', route: '/v1/admin/merges/:id/undo' } });
  });
});

// ---------------------------------------------------------------- XSS + CSP

describe('admin HTML escapes every value and runs only nonced script (PRD §42 #9)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let admin: Staff;

  const TITLE = `"><img src=x onerror=alert(1)>`;
  const SUBTITLE = `<script>alert(2)</script>`;
  const AUTHOR = `<svg onload=alert(3)>`;
  const REASON = `</script><script>alert(4)</script>`;
  const QUOTE_TITLE = `x'); alert(5); ('`;
  const PAYLOADS = ['<img src=x', '<script>alert', '<svg onload', "x'); alert(5)"];

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    app = await buildApp({ db });
    await app.ready();
    admin = await staff(db, 'xss_admin@flyleaf.app', 'admin');

    const [a] = await db.execute<{ id: string }>(sql`INSERT INTO authors (name) VALUES (${AUTHOR}) RETURNING id`);
    const [w1] = await db.execute<{ id: string }>(sql`
      INSERT INTO works (title, subtitle, log_count) VALUES (${TITLE}, ${SUBTITLE}, 10) RETURNING id`);
    const [w2] = await db.execute<{ id: string }>(sql`INSERT INTO works (title, log_count) VALUES (${QUOTE_TITLE}, 9) RETURNING id`);
    await db.execute(sql`INSERT INTO work_authors (work_id, author_id, role, position) VALUES (${w1!.id}, ${a!.id}, 'author', 0)`);
    await queueReportedDuplicate(db, { survivorId: w1!.id, loserId: w2!.id, reason: REASON });
    await overrideWorkMaturity(db, { workId: w1!.id, maturity: 'mature', reason: REASON, actor: { id: admin.id, email: admin.email, role: 'admin' } });
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  const pages = [
    '/admin/login',
    '/admin/merges',
    '/admin/catalog/maturity',
    '/admin/catalog/maturity?q=' + encodeURIComponent(`"><script>alert(6)</script>`),
    '/admin/ingest',
    '/admin/audit-log',
  ];

  it.each(pages)('%s: no payload survives unescaped, no inline handler, every script nonced', async (url) => {
    const res = await app.inject({ method: 'GET', url, headers: url === '/admin/login' ? {} : cookieFor(admin.token) });
    expect(res.statusCode).toBe(200);
    for (const p of [...PAYLOADS, '<script>alert(6)']) expect(res.body).not.toContain(p);
    expect(attributeNames(res.body).filter((n) => /^on/i.test(n))).toEqual([]);
    expect(res.body).not.toMatch(/javascript:/i);

    const csp = String(res.headers['content-security-policy']);
    const scriptSrc = /script-src ([^;]+)/.exec(csp)?.[1] ?? '';
    expect(scriptSrc).not.toContain('unsafe-inline');
    const nonce = /'nonce-([^']+)'/.exec(scriptSrc)?.[1];
    for (const tag of res.body.match(/<script[^>]*>/g) ?? []) {
      expect(tag).toBe(`<script nonce="${nonce}">`);
    }
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the nonce is new on every response', async () => {
    const a = await app.inject({ method: 'GET', url: '/admin/merges', headers: cookieFor(admin.token) });
    const b = await app.inject({ method: 'GET', url: '/admin/merges', headers: cookieFor(admin.token) });
    expect(a.headers['content-security-policy']).not.toBe(b.headers['content-security-policy']);
  });

  it('the maturity page still shows the title, escaped', async () => {
    const res = await app.inject({ method: 'GET', url: '/admin/catalog/maturity', headers: cookieFor(admin.token) });
    expect(res.body).toContain('&quot;&gt;&lt;img src=x onerror=alert(1)&gt;');
  });

  it('HTML without its own policy may run no script at all', async () => {
    const { HTML_BASELINE_CSP } = await import('../app.js');
    expect(HTML_BASELINE_CSP).toContain("default-src 'none'");
    expect(HTML_BASELINE_CSP).not.toMatch(/script-src/);
  });
});

// ---------------------------------------------------------------- audit log

describe('admin audit log (FN-93)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let admin: Staff;
  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    app = await buildApp({ db });
    await app.ready();
    admin = await staff(db, 'audit_admin@flyleaf.app', 'admin');
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it('is append-only: UPDATE and DELETE are refused by the database', async () => {
    await db.execute(sql`INSERT INTO admin_audit_log (actor_id, action) VALUES (${admin.id}, 'test.row')`);
    const refused = { cause: expect.objectContaining({ message: expect.stringMatching(/append-only/) }) };
    await expect(db.execute(sql`UPDATE admin_audit_log SET reason = 'rewritten'`)).rejects.toMatchObject(refused);
    await expect(db.execute(sql`DELETE FROM admin_audit_log`)).rejects.toMatchObject(refused);
    const [n] = await db.execute<{ n: number }>(sql`SELECT count(*)::int AS n FROM admin_audit_log WHERE reason = 'rewritten'`);
    expect(n!.n).toBe(0);
  });

  it('a maturity override records who, what, why, from where, and the before/after', async () => {
    const [w] = await db.execute<{ id: string }>(sql`INSERT INTO works (title, maturity) VALUES ('Audited', 'general') RETURNING id`);
    const res = await app.inject({
      method: 'POST', url: `/v1/admin/catalog/works/${w!.id}/maturity`,
      headers: { authorization: `Bearer ${admin.token}`, 'user-agent': 'AuditUA/2' },
      payload: { maturity: 'explicit', reason: 'Publisher imprint is erotica' },
    });
    expect(res.statusCode).toBe(200);
    const [row] = (await auditRows(db, 'catalog.maturity_override')).slice(-1);
    expect(row).toMatchObject({
      actor_id: admin.id,
      reason: 'Publisher imprint is erotica',
      user_agent: 'AuditUA/2',
      ip: '127.0.0.1',
      payload: { previous_maturity: 'general', new_maturity: 'explicit' },
    });
  });

  it('lists failed logins whose actor is unknown (LEFT JOIN, not dropped)', async () => {
    await loginAdmin(db, { email: 'stranger@example.com', password: PW, totpCode: '000000' }).catch(() => {});
    const res = await app.inject({ method: 'GET', url: '/v1/admin/audit-log?action=admin.login_failed', headers: { authorization: `Bearer ${admin.token}` } });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.some((e: { actor_id: string | null }) => e.actor_id === null)).toBe(true);
  });
});

// ---------------------------------------------------------------- provenance lock

describe('a locked maturity override survives re-ingest (PRD §7.9 [LOCKED])', () => {
  let db: Db;
  let close: () => Promise<void>;
  let admin: Staff;
  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    for (const ddl of Object.values(STAGING)) await fresh.client.exec(ddl.replace('UNLOGGED ', ''));
    admin = await staff(db, 'lock_admin@flyleaf.app', 'admin');
  });
  afterAll(async () => close?.());

  const stageWork = async (key: string, title: string, maturity: string) => {
    await db.execute(sql`TRUNCATE stage_works`);
    await db.execute(sql`
      INSERT INTO stage_works (ol_work_key, title, subtitle, description, alternate_titles, first_publish_year, ol_cover_id, maturity)
      VALUES (${key}, ${title}, NULL, NULL, '{}', 1999, NULL, ${maturity})`);
    await db.execute(sql.raw(MERGE_WORKS));
  };

  it('the dump merge keeps the override and still updates the unlocked fields', async () => {
    await stageWork('/works/OLLOCK1W', 'Original', 'explicit');
    const [w] = await db.execute<{ id: string }>(sql`SELECT id FROM works WHERE ol_work_key = '/works/OLLOCK1W'`);
    await overrideWorkMaturity(db, { workId: w!.id, maturity: 'general', reason: 'Misclassified by imprint', actor: { id: admin.id, email: admin.email, role: 'admin' } });

    await stageWork('/works/OLLOCK1W', 'Retitled in the dump', 'explicit');
    const [after] = await db.execute<{ maturity: string; title: string }>(sql`SELECT maturity, title FROM works WHERE id = ${w!.id}`);
    expect(after).toEqual({ maturity: 'general', title: 'Retitled in the dump' });
  });

  it('an unlocked work still takes the dump classification', async () => {
    await stageWork('/works/OLLOCK2W', 'Free', 'general');
    await stageWork('/works/OLLOCK2W', 'Free', 'mature');
    const [after] = await db.execute<{ maturity: string }>(sql`SELECT maturity FROM works WHERE ol_work_key = '/works/OLLOCK2W'`);
    expect(after!.maturity).toBe('mature');
  });

  it('gap-fill does not overwrite a locked title', async () => {
    await stageWork('/works/OLLOCK3W', 'Corrected Title', 'general');
    const [w] = await db.execute<{ id: string }>(sql`SELECT id FROM works WHERE ol_work_key = '/works/OLLOCK3W'`);
    await db.execute(sql`
      INSERT INTO field_provenance (entity_type, entity_id, field_name, provider, confidence, is_locked)
      VALUES ('work', ${w!.id}, 'title', 'user', 100, true)`);
    await new GapFillService(db, new OpenLibrarySource(outbound)).persist([
      { olWorkKey: '/works/OLLOCK3W', title: 'Wrong OL Title', firstPublishYear: 2001, coverId: null, authorKeys: [], authorNames: [], editionCount: 1 },
    ]);
    const [after] = await db.execute<{ title: string; first_publish_year: number }>(sql`SELECT title, first_publish_year FROM works WHERE id = ${w!.id}`);
    expect(after).toEqual({ title: 'Corrected Title', first_publish_year: 2001 });
  });
});

// ---------------------------------------------------------------- ingest status

describe('ingestion status reads statistics, not full counts (FN-92)', () => {
  it('reports planner estimates once tables are analysed, exact counts before', async () => {
    const { db, client } = await freshDrizzle();
    await db.execute(sql`INSERT INTO works (title, maturity) SELECT 'W' || g, CASE WHEN g % 4 = 0 THEN 'explicit' ELSE 'general' END FROM generate_series(1, 400) g`);

    const exact = await getIngestDashboardStatus(db);
    expect(exact.counts_are_estimates).toBe(false);
    expect(exact.catalog.works_count).toBe(400);
    expect(exact.maturity_breakdown.explicit).toBe(100);

    await db.execute(sql`ANALYZE works`);
    const estimated = await getIngestDashboardStatus(db);
    expect(estimated.counts_are_estimates).toBe(true);
    expect(estimated.catalog.works_count).toBe(400);
    expect(estimated.maturity_breakdown.explicit).toBe(100);
    expect(estimated.maturity_breakdown.general).toBe(300);
    await client.close();
  });
});

// ---------------------------------------------------------------- CORS

describe('CORS allows only configured origins (A-05-022)', () => {
  it('does not reflect an arbitrary origin', async () => {
    const { db, client } = await freshDrizzle();
    const app = await buildApp({ db });
    const evil = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' } });
    expect(evil.headers['access-control-allow-origin']).toBeUndefined();
    const allowed = new URL(config.appBaseUrl).origin;
    const ok = await app.inject({ method: 'GET', url: '/healthz', headers: { origin: allowed } });
    expect(ok.headers['access-control-allow-origin']).toBe(allowed);
    await app.close();
    await client.close();
  });
});

// ---------------------------------------------------------------- small robustness cases

describe('admin paths never 500 on hand-made input (A-06-021, A-06-022)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let admin: Staff;
  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    app = await buildApp({ db });
    await app.ready();
    admin = await staff(db, 'robust_admin@flyleaf.app', 'admin');
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  it('a malformed session cookie is a guest, not a 500', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/admin/auth/me', headers: { cookie: 'flyleaf_admin_session=%E0%A4%A' } });
    expect(res.statusCode).toBe(401);
    const page = await app.inject({ method: 'GET', url: '/admin/merges', headers: { cookie: 'flyleaf_admin_session=%E0' } });
    expect(page.statusCode).toBe(302);
  });

  it('an unknown maturity filter shows the unfiltered list', async () => {
    await db.execute(sql`INSERT INTO works (title) VALUES ('Filter probe')`);
    const res = await app.inject({ method: 'GET', url: '/admin/catalog/maturity?maturity=bogus', headers: cookieFor(admin.token) });
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('Filter probe');
  });
});

// ---------------------------------------------------------------- D-06-1 reasons

describe('merge, dismiss and undo carry a reason into the audit log (D-06-1)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let adm: Staff;
  let auth: Record<string, string>;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    app = await buildApp({ db });
    await app.ready();
    adm = await staff(db, 'reason_admin@flyleaf.app', 'admin');
    auth = { authorization: `Bearer ${adm.token}` };
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  const pair = async (stage: number) => {
    const [a] = await db.execute<{ id: string }>(sql`INSERT INTO works (title, log_count) VALUES ('Survivor', 5) RETURNING id`);
    const [b] = await db.execute<{ id: string }>(sql`INSERT INTO works (title, log_count) VALUES ('Loser', 1) RETURNING id`);
    const [q] = await db.execute<{ id: string }>(sql`
      INSERT INTO dedupe_queue (survivor_id, loser_id, stage, reason) VALUES (${a!.id}, ${b!.id}, ${stage}, 'rule text')
      RETURNING id`);
    return q!.id;
  };
  const resolve = (id: string, payload: object) =>
    app.inject({ method: 'POST', url: `/v1/admin/dedupe/queue/${id}/resolve`, headers: auth, payload });
  const lastAudit = async (action: string) => (await auditRows(db, action)).at(-1);
  const status = async (id: string) =>
    (await db.execute<{ status: string }>(sql`SELECT status FROM dedupe_queue WHERE id = ${id}`))[0]!.status;

  it('a rule-queued pair merged without a reason stores the rule', async () => {
    const id = await pair(2);
    const res = await resolve(id, { action: 'merge' });
    expect(res.statusCode).toBe(200);
    expect(await lastAudit('catalog.merge')).toMatchObject({ reason: 'stage 2: title + author' });
  });

  it('a rule-queued pair dismissed with a typed reason stores that reason', async () => {
    const id = await pair(1);
    const res = await resolve(id, { action: 'dismiss', reason: '  Different printings of one anthology  ' });
    expect(res.statusCode).toBe(200);
    expect(await lastAudit('catalog.dismiss_duplicate')).toMatchObject({ reason: 'Different printings of one anthology' });
  });

  it('a typed reason under 10 characters is refused even on a rule-queued pair', async () => {
    const id = await pair(3);
    const res = await resolve(id, { action: 'merge', reason: 'dupe' });
    expect(res.statusCode).toBe(422);
    expect(res.json().error).toMatchObject({ code: 'reason_required', field: 'reason' });
    expect(await status(id)).toBe('pending');
  });

  it('a user-reported pair (manual merge) needs a typed reason of 10+ characters', async () => {
    const id = await pair(4);
    const before = (await auditRows(db)).length;
    for (const payload of [{ action: 'merge' }, { action: 'merge', reason: '   short   ' }, { action: 'dismiss', reason: '' }]) {
      const res = await resolve(id, payload);
      expect(res.statusCode).toBe(422);
    }
    expect(await status(id)).toBe('pending');
    expect((await auditRows(db)).length).toBe(before);

    const ok = await resolve(id, { action: 'merge', reason: 'Same ISBN printed on both covers' });
    expect(ok.statusCode).toBe(200);
    expect(await lastAudit('catalog.merge')).toMatchObject({ reason: 'Same ISBN printed on both covers' });
  });

  it('undo needs a typed reason of 10+ characters and stores it', async () => {
    const id = await pair(2);
    const merged = await resolve(id, { action: 'merge' });
    const mergeId = merged.json().merge_id as string;
    const undo = (payload?: object) =>
      app.inject({ method: 'POST', url: `/v1/admin/merges/${mergeId}/undo`, headers: auth, payload });

    expect((await undo()).statusCode).toBe(422);
    expect((await undo({ reason: 'oops' })).statusCode).toBe(422);
    expect((await undo({ reason: '          ' })).statusCode).toBe(422);
    const ok = await undo({ reason: 'Merged two different editions' });
    expect(ok.statusCode).toBe(200);
    expect(await lastAudit('catalog.undo_merge')).toMatchObject({ reason: 'Merged two different editions' });
  });

  it('the console prefills the rule and asks for a reason on every action', async () => {
    const id = await pair(2);
    const page = await app.inject({ method: 'GET', url: '/admin/merges', headers: cookieFor(adm.token) });
    expect(page.body).toContain(`data-resolve="${id}" data-action="merge" data-rule="stage 2: title + author"`);
    expect(page.body).toContain('JSON.stringify({ reason })');
    expect(page.body).toContain('JSON.stringify({ action, reason })');
  });
});

// ---------------------------------------------------------------- D-06-2 staff on the app

describe('staff accounts cannot use the app login (D-06-2)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;
  let identity: IdentityService;
  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    identity = new IdentityService(db, unlimited, new MemoryEmailSender());
    app = await buildApp({ db, identity });
    await app.ready();
  });
  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  const login = (email: string, password: string) =>
    app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

  it('refuses admins and moderators with the same body as a wrong password', async () => {
    await staff(db, 'app_admin@flyleaf.app', 'admin');
    await staff(db, 'app_mod@flyleaf.app', 'moderator');
    const wrong = await login('app_admin@flyleaf.app', 'not-the-password-x');
    expect(wrong.statusCode).toBe(401);
    for (const email of ['app_admin@flyleaf.app', 'app_mod@flyleaf.app']) {
      const res = await login(email, PW);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual(wrong.json());
    }
  });

  it('a staff account cannot refresh an app session it held before promotion', async () => {
    const reg = await identity.register('promoted@example.com', 'promoted', 'Reader-Passphrase-42', '1990-01-01');
    await db.execute(sql`UPDATE users SET role = 'moderator' WHERE email = 'promoted@example.com'`);
    const res = await app.inject({ method: 'POST', url: '/v1/auth/refresh', payload: { refreshToken: reg.refreshToken } });
    expect(res.statusCode).toBe(401);

    await db.execute(sql`UPDATE users SET role = 'user' WHERE email = 'promoted@example.com'`);
    expect((await login('promoted@example.com', 'Reader-Passphrase-42')).statusCode).toBe(200);
  });
});
