// Users and sessions.
//
// argon2id is correct from day one — password hashing is not a thing to
// prototype. Opaque bearer tokens are NOT correct: real auth is a 15-minute
// JWT plus a rotating refresh token with family reuse detection (FN-63/64).

import { randomBytes } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import type { Db, RateLimiter } from '../platform/index.js';
import { users, sessions } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';

// ---------------------------------------------------------------- validation

// No composition rules: they reduce real entropy. Length is what matters.
export const passwordSchema = z.string().min(10, 'Use at least 10 characters.');
export const usernameSchema = z
  .string()
  .regex(/^[a-z0-9_]{3,20}$/, '3–20 characters: lowercase letters, numbers and underscores.');

const registerBody = z.object({
  email: z.email('That does not look like an email address.'),
  username: usernameSchema,
  password: passwordSchema,
});

const loginBody = z.object({
  email: z.string(),
  password: z.string(),
});

// ---------------------------------------------------------------- service

export type User = { id: string; email: string; username: string };

export class IdentityService {
  constructor(private db: Db, private limiter: RateLimiter) {}

  async register(email: string, username: string, password: string) {
    const passwordHash = await argonHash(password);
    let row;
    try {
      [row] = await this.db
        .insert(users)
        .values({ email: email.trim(), username: username.trim().toLowerCase(), passwordHash })
        .returning({ id: users.id, email: users.email, username: users.username });
    } catch (err) {
      if (String(err).includes('duplicate key')) {
        throw ApiError.conflict('already_taken', 'That email or username is already in use.');
      }
      throw err;
    }
    if (!row) throw new Error('insert returned no row');
    return { user: row as User, token: await this.#issue(row.id) };
  }

  async login(email: string, password: string) {
    // Rate limited in Postgres, not in memory: an in-process counter is
    // per-instance, so two API processes would double the real limit.
    const allowed = await this.limiter.allow(`login:${email.trim().toLowerCase()}`, 10, 60);
    if (!allowed) throw ApiError.rateLimited();

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        passwordHash: users.passwordHash,
      })
      .from(users)
      .where(eq(users.email, email.trim()))
      .limit(1);

    // Identical error whether the account is missing or the password is
    // wrong: never confirm that an account exists (account enumeration).
    const generic = new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    if (!row) throw generic;
    if (!(await argonVerify(row.passwordHash, password))) throw generic;

    const { passwordHash: _drop, ...user } = row;
    return { user: user as User, token: await this.#issue(row.id) };
  }

  async lookup(token: string): Promise<string | null> {
    const [row] = await this.db
      .select({ userId: sessions.userId })
      .from(sessions)
      .where(eq(sessions.token, token))
      .limit(1);
    return row?.userId ?? null;
  }

  async get(id: string): Promise<User | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, username: users.username })
      .from(users)
      .where(eq(users.id, id))
      .limit(1);
    return (row as User | undefined) ?? null;
  }

  async #issue(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    await this.db.insert(sessions).values({ token, userId });
    return token;
  }
}

// ---------------------------------------------------------------- routes

export function identityRoutes(service: IdentityService) {
  return async (app: FastifyInstance) => {
    app.post('/auth/register', async (req, reply) => {
      const parsed = registerBody.safeParse(req.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        throw ApiError.unprocessable('invalid_field', issue?.message ?? 'Check that.', String(issue?.path[0] ?? ''));
      }
      const { email, username, password } = parsed.data;
      const result = await service.register(email, username, password);
      return reply.status(201).send(result);
    });

    app.post('/auth/login', async (req) => {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) throw ApiError.unauthorized('Email or password is incorrect.');
      return service.login(parsed.data.email, parsed.data.password);
    });

    app.get('/me', async (req) => {
      const viewer = requireViewer(req);
      const user = await service.get(viewer);
      if (!user) throw ApiError.notFound('No such account.');
      return user;
    });
  };
}
