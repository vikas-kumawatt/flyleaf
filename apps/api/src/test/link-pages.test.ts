// Audit 07b (D-07-1): the emailed verify and reset links, and /.well-known.
//  - a GET never spends a token (mail scanners and previews fetch links)
//  - the POST spends it once
//  - nonce CSP (Part 06 pattern), Referrer-Policy no-referrer, no-store
//  - the well-known files are exactly what the configuration says, or 404

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { eq } from 'drizzle-orm';

import { buildApp } from '../app.js';
import { IdentityService } from '../identity/index.js';
import { readFileSync } from 'node:fs';
import { PRODUCTION_APP_BASE_URL, PgRateLimiter, parseAppLinks, type AppLinks, type Db } from '../platform/index.js';
import { MemoryEmailSender } from '../providers/email/index.js';
import { emailVerificationTokens, passwordResetTokens, users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, type TestUser } from './interaction-fixtures.js';

const FINGERPRINT = Array.from({ length: 32 }, (_, i) => (i * 7).toString(16).padStart(2, '0').toUpperCase()).join(':');

let db: Db;
let close: () => Promise<void>;
let mailer: MemoryEmailSender;
let service: IdentityService;

async function appWith(appLinks: AppLinks): Promise<FastifyInstance> {
  const app = await buildApp({ db, identity: service, appLinks });
  await app.ready();
  return app;
}

const unset: AppLinks = { android: null, ios: null };
let app: FastifyInstance;

beforeAll(async () => {
  const fresh = await freshDrizzle();
  db = fresh.db;
  close = () => fresh.client.close();
  mailer = new MemoryEmailSender();
  service = new IdentityService(db, new PgRateLimiter(db), mailer);
  app = await appWith(unset);
}, 60_000);

afterAll(async () => {
  await app?.close();
  await close?.();
});

function tokenFromLastEmail(path: string): string {
  const text = mailer.lastMessage()?.text ?? '';
  const m = new RegExp(`/${path}\\?token=([A-Za-z0-9_-]+)`).exec(text);
  if (!m?.[1]) throw new Error(`no ${path} link in: ${text}`);
  return m[1];
}

async function verifyToken(u: TestUser): Promise<string> {
  await service.sendVerificationEmail(u.id, `${u.username}@example.com`);
  return tokenFromLastEmail('verify-email');
}

async function resetToken(u: TestUser): Promise<string> {
  await service.forgotPassword(`${u.username}@example.com`);
  return tokenFromLastEmail('reset-password');
}

const form = (url: string, fields: Record<string, string>) =>
  app.inject({
    method: 'POST',
    url,
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams(fields).toString(),
  });

/** The page headers every link page must carry. Returns the CSP nonce. */
function expectPageHeaders(res: LightMyRequestResponse): string {
  expect(res.headers['content-type']).toMatch(/^text\/html/);
  expect(res.headers['referrer-policy']).toBe('no-referrer');
  expect(res.headers['cache-control']).toBe('no-store');
  const csp = String(res.headers['content-security-policy']);
  const nonce = /script-src 'nonce-([A-Za-z0-9+/=]+)'/.exec(csp)?.[1];
  expect(nonce).toBeTruthy();
  expect(csp).not.toContain("'unsafe-inline' 'nonce"); // script is nonce-only
  expect(csp).not.toMatch(/script-src[^;]*unsafe-inline/);
  expect(csp).toContain("frame-ancestors 'none'");
  expect(csp).toContain("form-action 'self'");
  // Every script on the page carries the nonce; nothing inline runs without it.
  for (const tag of res.body.match(/<script[^>]*>/g) ?? []) expect(tag).toContain(`nonce="${nonce}"`);
  expect(res.body).not.toMatch(/\son[a-z]+=/i);
  return nonce!;
}

const verifyRow = async (token: string) => {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await db.select().from(emailVerificationTokens).where(eq(emailVerificationTokens.tokenHash, hash));
  return row!;
};
const resetRow = async (token: string) => {
  const { createHash } = await import('node:crypto');
  const hash = createHash('sha256').update(token).digest('hex');
  const [row] = await db.select().from(passwordResetTokens).where(eq(passwordResetTokens.tokenHash, hash));
  return row!;
};
const account = async (u: TestUser) =>
  (await db.select({ verifiedAt: users.emailVerifiedAt, hash: users.passwordHash }).from(users).where(eq(users.id, u.id)))[0]!;

describe('verify-email page', () => {
  it('GET shows a button and leaves the token unused, however often it is fetched', async () => {
    const u = await makeUser(db, 'lp_verify_get', { verified: false });
    const token = await verifyToken(u);

    for (let i = 0; i < 3; i++) {
      const res = await app.inject({ method: 'GET', url: `/verify-email?token=${token}` });
      expect(res.statusCode).toBe(200);
      expectPageHeaders(res);
      expect(res.body).toContain('<form method="post" action="/verify-email">');
      expect(res.body).toContain(`name="token" value="${token}"`);
      expect(res.body).toContain(`href="flyleaf://verify-email?token=${token}"`);
    }
    expect((await verifyRow(token)).usedAt).toBeNull();
    expect((await account(u)).verifiedAt).toBeNull();
    // HEAD (link previews) is served by the same GET handler: also harmless.
    expect((await app.inject({ method: 'HEAD', url: `/verify-email?token=${token}` })).statusCode).toBe(200);
    expect((await verifyRow(token)).usedAt).toBeNull();
  });

  it('POST verifies once; the second POST says the link has expired', async () => {
    const u = await makeUser(db, 'lp_verify_post', { verified: false });
    const token = await verifyToken(u);

    const first = await form('/verify-email', { token });
    expect(first.statusCode).toBe(200);
    expectPageHeaders(first);
    expect(first.body).toContain('Email verified');
    expect((await verifyRow(token)).usedAt).not.toBeNull();
    expect((await account(u)).verifiedAt).not.toBeNull();

    const second = await form('/verify-email', { token });
    expect(second.statusCode).toBe(400);
    expectPageHeaders(second);
    expect(second.body).toContain('This link has expired');
  });

  it('a missing, empty or oversized token is an incomplete link, not a 500', async () => {
    for (const url of ['/verify-email', '/verify-email?token=', `/verify-email?token=${'a'.repeat(300)}`]) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('This link is incomplete');
    }
    expect((await form('/verify-email', {})).statusCode).toBe(400);
  });

  it('a hostile token is escaped, never markup', async () => {
    const res = await app.inject({ method: 'GET', url: `/verify-email?token=${encodeURIComponent('"><script>alert(1)</script>')}` });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain('<script>alert(1)');
    expect(res.body).toContain('&quot;&gt;&lt;script&gt;');
  });
});

describe('reset-password page', () => {
  it('GET shows the form and leaves the token unused', async () => {
    const u = await makeUser(db, 'lp_reset_get');
    const before = (await account(u)).hash;
    const token = await resetToken(u);

    const res = await app.inject({ method: 'GET', url: `/reset-password?token=${token}` });
    expect(res.statusCode).toBe(200);
    const nonce = expectPageHeaders(res);
    expect(res.body).toContain(`<script nonce="${nonce}">`);
    expect(res.body).toContain('<form method="post" action="/reset-password"');
    expect(res.body).toContain(`href="flyleaf://reset-password?token=${token}"`);
    expect((await resetRow(token)).usedAt).toBeNull();
    expect((await account(u)).hash).toBe(before);
  });

  it('refuses mismatched or common passwords without spending the token or echoing the password', async () => {
    const u = await makeUser(db, 'lp_reset_bad');
    const token = await resetToken(u);

    const mismatch = await form('/reset-password', { token, newPassword: 'a long new passphrase', confirmPassword: 'a different passphrase' });
    expect(mismatch.statusCode).toBe(422);
    expectPageHeaders(mismatch);
    expect(mismatch.body).toContain('The passwords do not match.');
    expect(mismatch.body).not.toContain('a long new passphrase');

    const common = await form('/reset-password', { token, newPassword: 'password1234', confirmPassword: 'password1234' });
    expect(common.statusCode).toBe(422);
    expect(common.body).toContain('That password is too common to be safe.');
    expect(common.body).not.toContain('value="password1234"');

    expect((await resetRow(token)).usedAt).toBeNull();
  });

  it('POST changes the password once; the second POST says the link has expired', async () => {
    const u = await makeUser(db, 'lp_reset_post');
    const before = (await account(u)).hash;
    const token = await resetToken(u);
    const fields = { token, newPassword: 'a long new passphrase', confirmPassword: 'a long new passphrase' };

    const first = await form('/reset-password', fields);
    expect(first.statusCode).toBe(200);
    expectPageHeaders(first);
    expect(first.body).toContain('Password changed');
    expect((await resetRow(token)).usedAt).not.toBeNull();
    expect((await account(u)).hash).not.toBe(before);

    const second = await form('/reset-password', fields);
    expect(second.statusCode).toBe(400);
    expect(second.body).toContain('This link has expired');
  });

  it('urlencoded bodies are parsed only here: the JSON API still refuses them', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/auth/reset-password',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: 'token=x&newPassword=y',
    });
    expect(res.statusCode).toBe(415);
  });
});

describe('/.well-known (App Links, Universal Links)', () => {
  it('404 while unconfigured', async () => {
    expect((await app.inject({ method: 'GET', url: '/.well-known/assetlinks.json' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' })).statusCode).toBe(404);
  });

  it('serve exactly what the environment configures', async () => {
    const links = parseAppLinks({
      ANDROID_APP_PACKAGE: 'app.flyleaf.skeleton',
      ANDROID_CERT_SHA256: ` ${FINGERPRINT.toLowerCase()} `,
      IOS_TEAM_ID: 'ABCDE12345',
      IOS_BUNDLE_ID: 'app.flyleaf.skeleton',
    });
    const configured = await appWith(links);
    try {
      const android = await configured.inject({ method: 'GET', url: '/.well-known/assetlinks.json' });
      expect(android.statusCode).toBe(200);
      expect(android.headers['content-type']).toMatch(/^application\/json/);
      expect(JSON.parse(android.body)).toEqual([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: { namespace: 'android_app', package_name: 'app.flyleaf.skeleton', sha256_cert_fingerprints: [FINGERPRINT] },
        },
      ]);

      const ios = await configured.inject({ method: 'GET', url: '/.well-known/apple-app-site-association' });
      expect(ios.statusCode).toBe(200);
      expect(ios.headers['content-type']).toMatch(/^application\/json/);
      expect(JSON.parse(ios.body)).toEqual({
        applinks: {
          details: [
            {
              appIDs: ['ABCDE12345.app.flyleaf.skeleton'],
              components: [{ '/': '/verify-email' }, { '/': '/reset-password' }],
            },
          ],
        },
      });
    } finally {
      await configured.close();
    }
  });

  it('half a configuration serves nothing; a malformed value stops the process', () => {
    expect(parseAppLinks({ ANDROID_APP_PACKAGE: 'app.flyleaf.skeleton' })).toEqual({ android: null, ios: null });
    expect(parseAppLinks({ IOS_TEAM_ID: 'ABCDE12345' })).toEqual({ android: null, ios: null });
    expect(() => parseAppLinks({ ANDROID_APP_PACKAGE: 'app.flyleaf.skeleton', ANDROID_CERT_SHA256: 'AB:CD' })).toThrow(/ANDROID_CERT_SHA256/);
    expect(() => parseAppLinks({ ANDROID_APP_PACKAGE: 'not a package', ANDROID_CERT_SHA256: FINGERPRINT })).toThrow(/ANDROID_APP_PACKAGE/);
    expect(() => parseAppLinks({ IOS_TEAM_ID: 'short', IOS_BUNDLE_ID: 'app.flyleaf.skeleton' })).toThrow(/IOS_TEAM_ID/);
  });
});

// D-07b-2: the app's link host is fixed at build time and the emails' at run
// time. If one moves without the other, the links stop opening the app.
it("the app's App Links and associated domains name the production APP_BASE_URL host", () => {
  const appJson = JSON.parse(readFileSync(new URL('../../../mobile/app.json', import.meta.url), 'utf8'));
  const host = new URL(PRODUCTION_APP_BASE_URL).host;
  const filterHosts = (appJson.expo.android.intentFilters as { data: { scheme?: string; host?: string }[] }[])
    .flatMap((f) => f.data)
    .filter((d) => d.scheme === 'https')
    .map((d) => d.host);
  const domains = (appJson.expo.ios.associatedDomains as string[]).map((d) => d.replace(/^applinks:/, ''));
  expect(filterHosts.length).toBeGreaterThan(0);
  expect(domains.length).toBeGreaterThan(0);
  expect(new Set([...filterHosts, ...domains])).toEqual(new Set([host]));
});
