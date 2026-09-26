// Admin authentication, 2FA, role-based access, and audit log tests (FN-90, FN-93).

import { describe, expect, it } from 'vitest';
import { freshDrizzle } from './pg.js';
import { buildApp } from '../app.js';
import {
  base32Decode,
  base32Encode,
  generateBackupCodes,
  generateTotp,
  generateTotpSecret,
  getOtpAuthUri,
  hashBackupCode,
  verifyTotp,
} from '../admin/totp.js';
import {
  createAdminUser,
  getAdminAuditLog,
  logAdminAction,
  loginAdmin,
  setup2fa,
  verify2fa,
  verifyAdminToken,
} from '../admin/auth.js';
import { IdentityService } from '../identity/index.js';
import { CatalogService } from '../catalog/index.js';
import { ReadingService } from '../reading/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';

describe('TOTP Two-Factor Engine (FN-90)', () => {
  it('encodes and decodes base32 symmetrically', () => {
    const buffer = Buffer.from('hello flyleaf world 2fa');
    const encoded = base32Encode(buffer);
    expect(typeof encoded).toBe('string');
    expect(encoded.length).toBeGreaterThan(0);

    const decoded = base32Decode(encoded);
    expect(decoded.toString()).toBe('hello flyleaf world 2fa');
  });

  it('generates a 32-character base32 secret', () => {
    const secret = generateTotpSecret();
    expect(secret).toMatch(/^[A-Z2-7]{32}$/);
  });

  it('generates and verifies 6-digit TOTP code within current time step', () => {
    const secret = generateTotpSecret();
    const now = Date.now();
    const token = generateTotp(secret, now);

    expect(token).toMatch(/^\d{6}$/);
    expect(verifyTotp(token, secret, { timestampMs: now })).toBe(true);
  });

  it('tolerates ±1 step clock drift but rejects older time steps', () => {
    const secret = generateTotpSecret();
    const now = 1700000000000;
    const tokenCurrent = generateTotp(secret, now);
    const tokenMinus30s = generateTotp(secret, now - 30_000);
    const tokenPlus30s = generateTotp(secret, now + 30_000);
    const tokenMinus90s = generateTotp(secret, now - 90_000);

    expect(verifyTotp(tokenCurrent, secret, { timestampMs: now, window: 1 })).toBe(true);
    expect(verifyTotp(tokenMinus30s, secret, { timestampMs: now, window: 1 })).toBe(true);
    expect(verifyTotp(tokenPlus30s, secret, { timestampMs: now, window: 1 })).toBe(true);
    expect(verifyTotp(tokenMinus90s, secret, { timestampMs: now, window: 1 })).toBe(false);
    expect(verifyTotp('000000', secret, { timestampMs: now })).toBe(false);
  });

  it('generates single-use backup recovery codes', () => {
    const { plain, hashed } = generateBackupCodes(8);
    expect(plain).toHaveLength(8);
    expect(hashed).toHaveLength(8);

    for (const code of plain) {
      expect(code).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}$/);
      expect(hashBackupCode(code)).toBe(hashBackupCode(code.toLowerCase()));
    }
  });

  it('formats otpauth URI compatible with authenticators', () => {
    const uri = getOtpAuthUri({ email: 'admin@flyleaf.app', secret: 'JBSWY3DPEHPK3PXP' });
    expect(uri).toContain('otpauth://totp/Flyleaf:admin%40flyleaf.app?secret=JBSWY3DPEHPK3PXP');
    expect(uri).toContain('issuer=Flyleaf');
  });
});

describe('Admin Authentication & Isolation (FN-90)', () => {
  it('provisions admin user and logs in with password and 2FA code', async () => {
    const { db } = await freshDrizzle();
    const { user, secret } = await createAdminUser(db, {
      email: 'founder@flyleaf.app',
      password: 'CorrectHorseBatteryStaple123',
      role: 'admin',
    });

    const totp = generateTotp(secret);
    const loginRes = await loginAdmin(db, {
      email: 'founder@flyleaf.app',
      password: 'CorrectHorseBatteryStaple123',
      totpCode: totp,
    });

    expect(loginRes.admin).toEqual({
      id: user.id,
      email: 'founder@flyleaf.app',
      role: 'admin',
    });
    expect(typeof loginRes.token).toBe('string');

    // Token has audience 'flyleaf-admin' and scope 'admin'
    const verified = await verifyAdminToken(loginRes.token);
    expect(verified).toMatchObject({
      id: user.id,
      email: 'founder@flyleaf.app',
      role: 'admin',
    });
  });

  it('rejects login with invalid password', async () => {
    const { db } = await freshDrizzle();
    const { secret } = await createAdminUser(db, {
      email: 'admin2@flyleaf.app',
      password: 'StrongAdminPassword99',
    });

    const totp = generateTotp(secret);
    await expect(
      loginAdmin(db, {
        email: 'admin2@flyleaf.app',
        password: 'WrongPassword123',
        totpCode: totp,
      }),
    ).rejects.toThrow(/Invalid email or password/);
  });

  it('rejects login with invalid 2FA code', async () => {
    const { db } = await freshDrizzle();
    await createAdminUser(db, {
      email: 'admin3@flyleaf.app',
      password: 'StrongAdminPassword99',
    });

    await expect(
      loginAdmin(db, {
        email: 'admin3@flyleaf.app',
        password: 'StrongAdminPassword99',
        totpCode: '000000',
      }),
    ).rejects.toThrow(/Invalid two-factor authentication code/);
  });

  it('allows login using a backup code and consumes it', async () => {
    const { db } = await freshDrizzle();
    const { backupCodes } = await createAdminUser(db, {
      email: 'admin_backup@flyleaf.app',
      password: 'StrongAdminPassword99',
    });

    const backupCodeToUse = backupCodes[0]!;

    // First use: succeeds
    const res = await loginAdmin(db, {
      email: 'admin_backup@flyleaf.app',
      password: 'StrongAdminPassword99',
      totpCode: backupCodeToUse,
    });
    expect(res.admin.email).toBe('admin_backup@flyleaf.app');

    // Second use of same backup code: rejected
    await expect(
      loginAdmin(db, {
        email: 'admin_backup@flyleaf.app',
        password: 'StrongAdminPassword99',
        totpCode: backupCodeToUse,
      }),
    ).rejects.toThrow(/Invalid two-factor authentication code/);
  });

  it('rejects admin login for regular app users (role: user)', async () => {
    const { db } = await freshDrizzle();
    const emailSender = new MemoryEmailSender();
    const identity = new IdentityService(db, new PgRateLimiter(db), emailSender);

    await identity.register(
      'reader@example.com',
      'bookworm',
      'MyReaderPassword123',
      '1995-05-05',
    );

    // Refused with the same generic 401 as a wrong password: a distinct error
    // would confirm the email has an app account (PRD §42 #13, Audit 06).
    await expect(
      loginAdmin(db, {
        email: 'reader@example.com',
        password: 'MyReaderPassword123',
        totpCode: '123456',
      }),
    ).rejects.toMatchObject({ status: 401, code: 'invalid_credentials' });
  });

  it('allows 2FA setup and verification flow', async () => {
    const { db } = await freshDrizzle();
    const { user } = await createAdminUser(db, {
      email: 'mod@flyleaf.app',
      password: 'ModPassword123',
      role: 'moderator',
    });

    const setup = await setup2fa(db, user.id);
    expect(setup.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(setup.backupCodes).toHaveLength(8);

    const validCode = generateTotp(setup.secret);
    const verifyRes = await verify2fa(db, user.id, validCode);
    expect(verifyRes.success).toBe(true);
  });
});

describe('Role-Based Access Control & Stolen Token Isolation (PRD §27.5)', () => {
  async function setupHarness() {
    const { db } = await freshDrizzle();
    const emailSender = new MemoryEmailSender();
    const identity = new IdentityService(db, new PgRateLimiter(db), emailSender);
    const catalog = new CatalogService(db, new MemoryCache());
    const reading = new ReadingService(db);

    const app = await buildApp({ db, identity, catalog, reading });

    const admin = await createAdminUser(db, {
      email: 'superadmin@flyleaf.app',
      password: 'AdminPassword123',
      role: 'admin',
    });
    const adminLogin = await loginAdmin(db, {
      email: 'superadmin@flyleaf.app',
      password: 'AdminPassword123',
      totpCode: generateTotp(admin.secret),
    });

    const mod = await createAdminUser(db, {
      email: 'moderator@flyleaf.app',
      password: 'ModPassword123',
      role: 'moderator',
    });
    const modLogin = await loginAdmin(db, {
      email: 'moderator@flyleaf.app',
      password: 'ModPassword123',
      totpCode: generateTotp(mod.secret),
    });

    const regular = await identity.register(
      'regular@example.com',
      'regularuser',
      'RegularPassword123',
      '1995-01-01',
    );

    return { app, db, adminToken: adminLogin.token, modToken: modLogin.token, userToken: regular.accessToken };
  }

  it('rejects regular app tokens on admin endpoints (stolen token isolation)', async () => {
    const { app, userToken } = await setupHarness();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/dedupe/queue',
      headers: { Authorization: `Bearer ${userToken}` },
    });

    expect(res.statusCode).toBe(401);
    expect(res.json().error.code).toBe('admin_auth_required');
  });

  it('allows moderator to inspect review queue and audit log', async () => {
    const { app, modToken } = await setupHarness();

    const queueRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/dedupe/queue',
      headers: { Authorization: `Bearer ${modToken}` },
    });
    expect(queueRes.statusCode).toBe(200);

    const auditRes = await app.inject({
      method: 'GET',
      url: '/v1/admin/audit-log',
      headers: { Authorization: `Bearer ${modToken}` },
    });
    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.json()).toHaveProperty('data');
  });

  it('forbids moderator from resolving or merging catalog candidates (read-only by default, PRD §27.5)', async () => {
    const { app, modToken } = await setupHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/dedupe/queue/00000000-0000-0000-0000-000000000001/resolve',
      headers: { Authorization: `Bearer ${modToken}` },
      payload: { action: 'merge' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_role');
  });

  it('forbids moderator from undoing merges', async () => {
    const { app, modToken } = await setupHarness();

    const res = await app.inject({
      method: 'POST',
      url: '/v1/admin/merges/00000000-0000-0000-0000-000000000001/undo',
      headers: { Authorization: `Bearer ${modToken}` },
    });

    expect(res.statusCode).toBe(403);
    expect(res.json().error.code).toBe('insufficient_role');
  });

  it('returns current admin viewer profile via /v1/admin/auth/me', async () => {
    const { app, adminToken } = await setupHarness();

    const res = await app.inject({
      method: 'GET',
      url: '/v1/admin/auth/me',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().admin).toMatchObject({
      email: 'superadmin@flyleaf.app',
      role: 'admin',
    });
  });
});

describe('Admin Audit Log (FN-93)', () => {
  it('logs admin login and actions in admin_audit_log', async () => {
    const { db } = await freshDrizzle();
    const { user, secret } = await createAdminUser(db, {
      email: 'audited_admin@flyleaf.app',
      password: 'Password123456',
      role: 'admin',
    });

    await loginAdmin(db, {
      email: 'audited_admin@flyleaf.app',
      password: 'Password123456',
      totpCode: generateTotp(secret),
      ip: '127.0.0.1',
      userAgent: 'FlyleafTestRunner/1.0',
    });

    await logAdminAction(db, {
      actorId: user.id,
      action: 'catalog.test_action',
      reason: 'Testing audit trail persistence',
      payload: { testKey: 'testValue' },
    });

    const logs = await getAdminAuditLog(db, { actorId: user.id });
    expect(logs.length).toBeGreaterThanOrEqual(2);

    const loginEntry = logs.find((l) => l.action === 'admin.login');
    expect(loginEntry).toBeDefined();
    expect(loginEntry?.actorEmail).toBe('audited_admin@flyleaf.app');
    expect(loginEntry?.payload).toMatchObject({ ip: '127.0.0.1' });

    const testEntry = logs.find((l) => l.action === 'catalog.test_action');
    expect(testEntry).toBeDefined();
    expect(testEntry?.reason).toBe('Testing audit trail persistence');
  });
});

describe('Server-Rendered HTML Admin Console (PRD §27.5)', () => {
  it('renders login page with form and 2FA input', async () => {
    const { db } = await freshDrizzle();
    const app = await buildApp({ db });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/login',
    });

    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Flyleaf Console');
    expect(res.body).toContain('2FA Protected');
    expect(res.body).toContain('totp_code');
  });

  it('redirects unauthenticated visitor from /admin/merges to /admin/login', async () => {
    const { db } = await freshDrizzle();
    const app = await buildApp({ db });

    const res = await app.inject({
      method: 'GET',
      url: '/admin/merges',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
  });

  it('allows access to /admin/merges and /admin/audit-log with session cookie', async () => {
    const { db } = await freshDrizzle();
    const app = await buildApp({ db });

    const { secret } = await createAdminUser(db, {
      email: 'cookie_admin@flyleaf.app',
      password: 'Password123456',
      role: 'admin',
    });

    const loginRes = await loginAdmin(db, {
      email: 'cookie_admin@flyleaf.app',
      password: 'Password123456',
      totpCode: generateTotp(secret),
    });

    const mergesRes = await app.inject({
      method: 'GET',
      url: '/admin/merges',
      headers: {
        cookie: `flyleaf_admin_session=${encodeURIComponent(loginRes.token)}`,
      },
    });

    expect(mergesRes.statusCode).toBe(200);
    expect(mergesRes.headers['content-type']).toContain('text/html');
    expect(mergesRes.body).toContain('cookie_admin@flyleaf.app');
    expect(mergesRes.body).toContain('ADMIN');
    expect(mergesRes.body).toContain('Audit Trail');

    const auditRes = await app.inject({
      method: 'GET',
      url: '/admin/audit-log',
      headers: {
        cookie: `flyleaf_admin_session=${encodeURIComponent(loginRes.token)}`,
      },
    });

    expect(auditRes.statusCode).toBe(200);
    expect(auditRes.headers['content-type']).toContain('text/html');
    expect(auditRes.body).toContain('Flyleaf Admin Audit Trail');
    expect(auditRes.body).toContain('admin.login');
  });

  it('clears session cookie on logout', async () => {
    const { db } = await freshDrizzle();
    const app = await buildApp({ db });

    const res = await app.inject({
      method: 'POST',
      url: '/admin/logout',
    });

    expect(res.statusCode).toBe(302);
    expect(res.headers.location).toBe('/admin/login');
    // One cookie per admin path since Audit 06 (/admin and /v1/admin); both cleared.
    const cleared = ([] as string[]).concat(res.headers['set-cookie'] as string | string[]);
    expect(cleared).toHaveLength(2);
    for (const c of cleared) expect(c).toContain('Max-Age=0');
  });
});
