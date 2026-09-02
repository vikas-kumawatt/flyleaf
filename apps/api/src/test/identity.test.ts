import { describe, expect, it } from 'vitest';
import { hash, verify } from '@node-rs/argon2';
import { passwordSchema, usernameSchema, uniqueViolationField } from '../identity/index.js';
import { MemoryCache } from '../platform/index.js';

// Password hashing and the validation rules are the parts of Phase -1 that
// are already production shaped, so they are the parts worth testing here.
// Everything else in identity is replaced in FN-6x.

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

// Regression: the smoke test caught a duplicate email returning 500 instead
// of 409. Cause was matching on the error *message*, which Drizzle hides
// behind its own wrapper error. SQLSTATE 23505 is the stable contract.
describe('uniqueViolationField', () => {
  it('reads a bare postgres.js error', () => {
    expect(uniqueViolationField({ code: '23505', constraint_name: 'users_email_key' })).toBe('email');
    expect(uniqueViolationField({ code: '23505', constraint_name: 'users_username_key' })).toBe('username');
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
    const outer = { cause: { cause: { code: '23505', constraint: 'users_username_unique' } } };
    expect(uniqueViolationField(outer)).toBe('username');
  });

  it('reports an unknown constraint rather than guessing', () => {
    expect(uniqueViolationField({ code: '23505', constraint_name: 'sessions_pkey' })).toBe('other');
  });

  it('returns null for anything that is not a unique violation', () => {
    expect(uniqueViolationField(null)).toBeNull();
    expect(uniqueViolationField(new Error('boom'))).toBeNull();
    expect(uniqueViolationField({ code: '23503' })).toBeNull();   // FK violation
    expect(uniqueViolationField({ code: '42P01' })).toBeNull();   // undefined table
  });

  it('does not loop forever on a cyclic cause chain', () => {
    const a: Record<string, unknown> = {};
    a.cause = a;
    expect(uniqueViolationField(a)).toBeNull();
  });
});
