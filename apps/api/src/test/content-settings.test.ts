// Audit 10: the §7.8 [LOCKED] setting "Show explicit titles in search"
// (A-07-036) and the neutral under-13 gate at date-of-birth confirmation
// (D-07b-1).

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { eq, sql } from 'drizzle-orm';
import type { Db } from '../platform/index.js';
import { MemoryCache, PgRateLimiter } from '../platform/index.js';
import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { ReadingService } from '../reading/index.js';
import { profiles, users } from '../db/schema.js';
import { freshDrizzle } from './pg.js';
import { makeUser, type TestUser } from './interaction-fixtures.js';

let db: Db;
let client: { close: () => Promise<void> };
let app: FastifyInstance;

beforeAll(async () => {
  ({ db, client } = await freshDrizzle());
  app = await buildApp({
    db,
    identity: new IdentityService(db, new PgRateLimiter(db)),
    catalog: new CatalogService(db, new MemoryCache()),
    reading: new ReadingService(db),
  });
  await app.ready();
});
afterAll(async () => {
  await app.close();
  await client.close();
});

const yearsAgo = (n: number) => `${new Date().getUTCFullYear() - n}-01-01`;
async function person(name: string, dob: string, confirmed = true): Promise<TestUser> {
  const u = await makeUser(db, name);
  await db.update(users).set({ dateOfBirth: dob, dobConfirmed: confirmed }).where(eq(users.id, u.id));
  return u;
}
const me = async (u: TestUser) => (await app.inject({ method: 'GET', url: '/v1/me', headers: u.auth })).json();
const setContent = (u: TestUser | null, payload: object) =>
  app.inject({ method: 'PUT', url: '/v1/me/content-settings', headers: u ? u.auth : {}, payload });
const stored = async (u: TestUser) =>
  (await db.select({ show: profiles.showExplicit }).from(profiles).where(eq(profiles.userId, u.id)))[0]!.show;

describe('Show explicit titles in search (PRD §7.8, A-07-036)', () => {
  it('GET /me says whether the control exists for this account, and its value', async () => {
    const adult = await person('cs_adult', '1990-05-01');
    const teen = await person('cs_teen', yearsAgo(15));
    const unconfirmed = await person('cs_unconfirmed', '1990-05-01', false);
    expect(await me(adult)).toMatchObject({ showExplicit: false, explicitSettingAvailable: true });
    expect(await me(teen)).toMatchObject({ showExplicit: false, explicitSettingAvailable: false });
    expect(await me(unconfirmed)).toMatchObject({ showExplicit: false, explicitSettingAvailable: false });
  });

  it('turning it on needs the date of birth re-entered, and it must match', async () => {
    const adult = await person('cs_on', '1990-05-01');
    const missing = await setContent(adult, { showExplicit: true });
    expect(missing.statusCode).toBe(422);
    expect(missing.json().error.code).toBe('dob_required');
    const wrong = await setContent(adult, { showExplicit: true, dateOfBirth: '1990-05-02' });
    expect(wrong.statusCode).toBe(422);
    expect(wrong.json().error.code).toBe('dob_mismatch');
    expect(await stored(adult)).toBe(false);

    const ok = await setContent(adult, { showExplicit: true, dateOfBirth: '1990-05-01' });
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toMatchObject({ showExplicit: true, explicitSettingAvailable: true });
    expect(await stored(adult)).toBe(true);
  });

  it('turning it off never needs the date', async () => {
    const adult = await person('cs_off', '1990-05-01');
    await db.update(profiles).set({ showExplicit: true }).where(eq(profiles.userId, adult.id));
    const res = await setContent(adult, { showExplicit: false });
    expect(res.statusCode).toBe(200);
    expect(await stored(adult)).toBe(false);
  });

  it('an under-18 or unconfirmed account can never turn it on, even with its own date', async () => {
    const teen = await person('cs_teen2', yearsAgo(17));
    const unconfirmed = await person('cs_unconf2', '1990-05-01', false);
    for (const [u, dob] of [[teen, yearsAgo(17)], [unconfirmed, '1990-05-01']] as const) {
      const res = await setContent(u, { showExplicit: true, dateOfBirth: dob });
      expect(res.statusCode).toBe(403);
      expect(res.json().error.code).toBe('setting_unavailable');
      expect(await stored(u)).toBe(false);
    }
  });

  it('a guest is 401; a malformed body is 422', async () => {
    expect((await setContent(null, { showExplicit: true })).statusCode).toBe(401);
    const adult = await person('cs_bad', '1990-05-01');
    expect((await setContent(adult, { showExplicit: 'yes' })).statusCode).toBe(422);
    expect((await setContent(adult, {})).statusCode).toBe(422);
  });
});

describe('neutral age gate (D-07b-1)', () => {
  const confirm = (u: TestUser, dateOfBirth: string) =>
    app.inject({ method: 'POST', url: '/v1/me/date-of-birth', headers: u.auth, payload: { dateOfBirth } });

  it('an under-13 date is refused in words that do not say which answer would pass', async () => {
    const u = await person('gate_words', '2000-01-01', false);
    const res = await confirm(u, yearsAgo(10));
    expect(res.statusCode).toBe(422);
    const message: string = res.json().error.message;
    expect(message).not.toMatch(/\d|old|age|young/i);
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: 'kid@example.com', username: 'kid_gate', password: 'a long enough passphrase', dateOfBirth: yearsAgo(10) },
    });
    expect(signup.statusCode).toBe(422);
    expect(signup.json().error.message).toBe(message);
  });

  it('after an under-13 attempt, an older date is refused too, identically, and the account stays unconfirmed', async () => {
    const u = await person('gate_retry', '2000-01-01', false);
    const first = await confirm(u, yearsAgo(10));
    const second = await confirm(u, '1985-03-14');
    expect(second.statusCode).toBe(422);
    expect(second.body).toBe(first.body);
    const [row] = await db.execute<{ ok: boolean; flagged: boolean }>(sql`
      SELECT dob_confirmed AS ok, underage_attempt_at IS NOT NULL AS flagged FROM users WHERE id = ${u.id}`);
    expect(row).toEqual({ ok: false, flagged: true });
    expect((await me(u)).dobConfirmed).toBe(false);
  });

  it('an adult date first is confirmed as before, and nothing is recorded', async () => {
    const u = await person('gate_adult', '2000-01-01', false);
    expect((await confirm(u, '1985-03-14')).statusCode).toBe(200);
    const [row] = await db.execute<{ flagged: boolean }>(sql`
      SELECT underage_attempt_at IS NOT NULL AS flagged FROM users WHERE id = ${u.id}`);
    expect(row!.flagged).toBe(false);
  });
});
