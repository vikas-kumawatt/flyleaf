import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { hash, verify } from '@node-rs/argon2';
import type { PGlite } from '@electric-sql/pglite';

import {
  passwordSchema,
  usernameSchema,
  isAtLeast13,
  dobSchema,
  uniqueViolationField,
  signAccessToken,
  verifyAccessToken,
  IdentityService,
} from '../identity/index.js';
import { MemoryCache, PgRateLimiter, type Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { ApiError } from '../http.js';

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

  beforeAll(async () => {
    ({ db, client } = await freshDrizzle());
    service = new IdentityService(db, new PgRateLimiter(db));
  }, 60_000);

  afterAll(async () => {
    await client?.close();
  });

  beforeEach(async () => {
    await client.exec('TRUNCATE users, profiles, refresh_tokens RESTART IDENTITY CASCADE');
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
