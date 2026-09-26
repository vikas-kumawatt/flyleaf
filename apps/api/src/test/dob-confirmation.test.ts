// Audit 07b (D-07-3, A-07-004): accounts whose date of birth was never entered.
//  - 0025 flags role 'user' accounts with exactly 2000-01-01, once
//  - GET /v1/me says so (dobConfirmed)
//  - POST /v1/me/date-of-birth applies the signup rules, and only once
//  - until then the account is the most restricted viewer: the explicit
//    filter stays on whatever the stored date and the setting say

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { PGlite } from '@electric-sql/pglite';
import { pg_trgm } from '@electric-sql/pglite/contrib/pg_trgm';
import { unaccent } from '@electric-sql/pglite/contrib/unaccent';
import { sql } from 'drizzle-orm';

import { buildApp } from '../app.js';
import { CatalogService } from '../catalog/index.js';
import { IdentityService } from '../identity/index.js';
import { PREREQUISITE_SQL } from '../migrate.js';
import { MemoryCache, PgRateLimiter, type Db } from '../platform/index.js';
import { freshDrizzle, migrationFiles } from './pg.js';
import { makeUser, type TestUser } from './interaction-fixtures.js';

describe('migration 0025: who is asked to confirm', () => {
  let pg: PGlite;

  beforeAll(async () => {
    pg = new PGlite({ extensions: { pg_trgm, unaccent } });
    for (const statement of PREREQUISITE_SQL) await pg.exec(statement);
    const files = migrationFiles();
    expect(files.at(-1)?.tag).toBe('0025_dob_confirmation');
    for (const { sql: text } of files.slice(0, -1)) await pg.exec(text);
    await pg.exec(`
      INSERT INTO users (email, password_hash, date_of_birth, role) VALUES
        ('placeholder@x.test', 'h', '2000-01-01', 'user'),
        ('deleted@x.test', 'h', '2000-01-01', 'user'),
        ('entered@x.test', 'h', '1990-05-05', 'user'),
        ('near@x.test', 'h', '2000-01-02', 'user'),
        ('staff@x.test', 'h', '2000-01-01', 'admin');
      UPDATE users SET deleted_at = now() WHERE email = 'deleted@x.test';
    `);
    await pg.exec(files.at(-1)!.sql);
  }, 60_000);

  afterAll(async () => {
    await pg?.close();
  });

  const confirmed = async () =>
    Object.fromEntries(
      (await pg.query<{ email: string; dob_confirmed: boolean }>(`SELECT email, dob_confirmed FROM users ORDER BY email`))
        .rows.map((r) => [r.email, r.dob_confirmed]),
    );

  it('flags app accounts with exactly 2000-01-01, and nothing else', async () => {
    expect(await confirmed()).toEqual({
      'deleted@x.test': false,
      'entered@x.test': true,
      'near@x.test': true,
      'placeholder@x.test': false,
      'staff@x.test': true,
    });
  });

  it('a re-run does not un-confirm someone who has since confirmed 2000-01-01', async () => {
    await pg.exec(`UPDATE users SET dob_confirmed = true WHERE email = 'placeholder@x.test'`);
    await pg.exec(migrationFiles().at(-1)!.sql);
    expect((await confirmed())['placeholder@x.test']).toBe(true);
  });

  it('a new account is confirmed by default', async () => {
    await pg.exec(`INSERT INTO users (email, password_hash, date_of_birth) VALUES ('new@x.test', 'h', '2000-01-01')`);
    expect((await confirmed())['new@x.test']).toBe(true);
  });
});

describe('confirming a date of birth (D-07-3)', () => {
  let db: Db;
  let close: () => Promise<void>;
  let app: FastifyInstance;

  beforeAll(async () => {
    const fresh = await freshDrizzle();
    db = fresh.db;
    close = () => fresh.client.close();
    app = await buildApp({
      db,
      identity: new IdentityService(db, new PgRateLimiter(db)),
      catalog: new CatalogService(db, new MemoryCache()),
    });
    await app.ready();
    await db.execute(sql`
      INSERT INTO works (title, log_count, maturity) VALUES
        ('Velvet Nights', 900, 'explicit'),
        ('Velvet Morning', 3, 'general')`);
    await db.execute(sql`
      INSERT INTO editions (work_id, isbn_13, format)
      SELECT id, '9780140328721', 'paperback' FROM works WHERE title = 'Velvet Nights'`);
  }, 60_000);

  afterAll(async () => {
    await app?.close();
    await close?.();
  });

  /** An adult by the stored date who opted in to explicit titles: only dob_confirmed differs. */
  async function unconfirmedAdult(name: string): Promise<TestUser> {
    const u = await makeUser(db, name);
    await db.execute(sql`UPDATE users SET date_of_birth = '2000-01-01', dob_confirmed = false WHERE id = ${u.id}`);
    await db.execute(sql`UPDATE profiles SET show_explicit = true WHERE user_id = ${u.id}`);
    return u;
  }

  const me = async (u: TestUser) => JSON.parse((await app.inject({ method: 'GET', url: '/v1/me', headers: u.auth })).body);
  const confirm = (u: TestUser | null, dateOfBirth: unknown) =>
    app.inject({
      method: 'POST',
      url: '/v1/me/date-of-birth',
      headers: u ? u.auth : {},
      payload: dateOfBirth === undefined ? {} : { dateOfBirth },
    });
  const titles = async (u: TestUser) =>
    (JSON.parse((await app.inject({ method: 'GET', url: '/v1/search?q=velvet', headers: u.auth })).body).data as {
      title: string;
    }[]).map((w) => w.title);
  const storedDob = async (u: TestUser) =>
    (await db.execute<{ dob: string; ok: boolean }>(sql`
      SELECT to_char(date_of_birth, 'YYYY-MM-DD') AS dob, dob_confirmed AS ok FROM users WHERE id = ${u.id}`))[0];

  it('GET /v1/me exposes dobConfirmed', async () => {
    const pending = await unconfirmedAdult('dob_me_pending');
    const fine = await makeUser(db, 'dob_me_fine');
    expect((await me(pending)).dobConfirmed).toBe(false);
    expect((await me(fine)).dobConfirmed).toBe(true);
  });

  it('the explicit filter is forced on until the date is confirmed, then follows the real date', async () => {
    const u = await unconfirmedAdult('dob_filter');
    // Stored 2000-01-01 is 18+, and the setting is on: only dob_confirmed hides them.
    expect(await titles(u)).not.toContain('Velvet Nights');
    expect(await titles(u)).toContain('Velvet Morning');
    const scan = JSON.parse((await app.inject({ method: 'GET', url: '/v1/editions/isbn/9780140328721', headers: u.auth })).body);
    expect(scan.content_warning).toBe(true);

    const res = await confirm(u, '1985-03-14');
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toMatchObject({ id: u.id, dobConfirmed: true });
    expect(await titles(u)).toContain('Velvet Nights');
  });

  it('confirming a date under 18 keeps the filter on', async () => {
    const u = await unconfirmedAdult('dob_teen');
    const now = new Date();
    const fifteen = `${now.getUTCFullYear() - 15}-01-01`;
    expect((await confirm(u, fifteen)).statusCode).toBe(200);
    expect(await storedDob(u)).toEqual({ dob: fifteen, ok: true });
    expect(await titles(u)).not.toContain('Velvet Nights');
  });

  it.each([
    ['not a date', 'yesterday'],
    ['impossible date', '2001-02-30'],
    ['before 1900', '1899-12-31'],
    ['under 13', `${new Date().getUTCFullYear() - 10}-06-01`],
    ['wrong format', '14/03/1985'],
  ])('refuses %s with the same message as signup, and stays unconfirmed', async (_label, value) => {
    const u = await unconfirmedAdult(`dob_bad_${Math.random().toString(36).slice(2, 8)}`);
    const res = await confirm(u, value);
    expect(res.statusCode).toBe(422);
    const body = JSON.parse(res.body);
    expect(body.error).toMatchObject({ code: 'invalid_field', field: 'dateOfBirth' });

    // Signup refuses the same value before hashing anything, with the same words.
    const signup = await app.inject({
      method: 'POST',
      url: '/v1/auth/register',
      payload: { email: `x${Date.now()}@example.com`, username: `p${Date.now() % 1e9}`, password: 'a long enough passphrase', dateOfBirth: value },
    });
    expect(signup.statusCode).toBe(422);
    expect(JSON.parse(signup.body).error.message).toBe(body.error.message);

    expect((await storedDob(u))?.ok).toBe(false);
  });

  it('refuses a missing date, and a guest', async () => {
    const u = await unconfirmedAdult('dob_missing');
    expect((await confirm(u, undefined)).statusCode).toBe(422);
    expect((await confirm(null, '1985-03-14')).statusCode).toBe(401);
  });

  it('works once: a confirmed date cannot be rewritten here', async () => {
    const u = await unconfirmedAdult('dob_once');
    expect((await confirm(u, '1985-03-14')).statusCode).toBe(200);
    const again = await confirm(u, '1970-01-01');
    expect(again.statusCode).toBe(409);
    expect(JSON.parse(again.body).error.code).toBe('dob_already_confirmed');
    expect(await storedDob(u)).toEqual({ dob: '1985-03-14', ok: true });

    const neverAsked = await makeUser(db, 'dob_never_asked');
    expect((await confirm(neverAsked, '1970-01-01')).statusCode).toBe(409);
  });

  it('two confirmations at once: one wins, the other is a 409, never a 500', async () => {
    const u = await unconfirmedAdult('dob_race');
    const [a, b] = await Promise.all([confirm(u, '1985-03-14'), confirm(u, '1970-01-01')]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 409]);
  });
});
