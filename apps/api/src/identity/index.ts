// Users, profiles, JWT, and rotating refresh tokens (FN-60 through FN-64).
//
// argon2id is correct from day one — password hashing is not a thing to
// prototype. Real auth is a 15-minute JWT plus an opaque rotating refresh token
// with family reuse detection (PRD §25, Architecture §3.3 & §7).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { eq } from 'drizzle-orm';
import * as jose from 'jose';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { config, type Db, type RateLimiter } from '../platform/index.js';
import { users, profiles, refreshTokens } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { isCommonPassword } from './common-passwords.js';
import { canView } from '../authorization/index.js';

export type Profile = {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarKey: string | null;
  isPrivate: boolean;
  followerCount: number;
  followingCount: number;
  createdAt: Date;
};

// ---------------------------------------------------------------- validation

// No composition rules: they reduce real entropy. Length and dictionary check matter.
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .refine((p) => !isCommonPassword(p), 'That password is too common to be safe.');

export const usernameSchema = z
  .string()
  .regex(/^[a-z0-9_]{3,20}$/, '3–20 characters: lowercase letters, numbers and underscores.');

/** Age gate at registration: users under 13 cannot register (PRD §26.6). */
export function isAtLeast13(dobStr: string, now: Date = new Date()): boolean {
  const dob = new Date(dobStr);
  if (isNaN(dob.getTime())) return false;
  let age = now.getFullYear() - dob.getFullYear();
  const m = now.getMonth() - dob.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < dob.getDate())) {
    age--;
  }
  return age >= 13;
}

export const dobSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD for date of birth.')
  .refine(isAtLeast13, 'You must be at least 13 years old to use Flyleaf.');

const registerBody = z.object({
  email: z.string().email('That does not look like an email address.'),
  username: usernameSchema,
  password: passwordSchema,
  dateOfBirth: dobSchema,
});

const loginBody = z.object({
  email: z.string(),
  password: z.string(),
});

const refreshBody = z.object({
  refreshToken: z.string().min(1, 'Refresh token is required.'),
});

// ---------------------------------------------------------------- JWT

const jwtKey = new TextEncoder().encode(config.jwtSecret);

/** Issue a 15-minute access JWT (FN-63). */
export async function signAccessToken(userId: string, secret = jwtKey): Promise<string> {
  return new jose.SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuedAt()
    .setExpirationTime('15m')
    .sign(secret);
}

/** Verify a 15-minute access JWT statelessly (FN-63). */
export async function verifyAccessToken(
  token: string,
  secret = jwtKey,
): Promise<{ sub: string } | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secret);
    return typeof payload.sub === 'string' ? { sub: payload.sub } : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- pg errors

/**
 * Which unique constraint a failed insert violated, or null if it was not a
 * unique violation at all. SQLSTATE 23505 is the stable contract.
 */
export function uniqueViolationField(err: unknown): 'email' | 'username' | 'other' | null {
  let node: unknown = err;

  for (let depth = 0; depth < 5 && node; depth++) {
    const e = node as { code?: unknown; constraint_name?: unknown; constraint?: unknown; cause?: unknown };

    if (e.code === '23505') {
      const constraint = String(e.constraint_name ?? e.constraint ?? '').toLowerCase();
      if (constraint.includes('email')) return 'email';
      if (constraint.includes('username')) return 'username';
      return 'other';
    }
    node = e.cause;
  }
  return null;
}

// ---------------------------------------------------------------- service

export type User = { id: string; email: string; username: string };

export class IdentityService {
  constructor(private db: Db, private limiter: RateLimiter) {}

  async register(email: string, username: string, password: string, dateOfBirth: string) {
    const passwordHash = await argonHash(password);
    const familyId = randomUUID();
    const rawRefreshToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000); // 60 days

    let userRow: { id: string; email: string };
    let profileRow: { username: string };

    try {
      [userRow, profileRow] = await this.db.transaction(async (tx) => {
        const [u] = await tx
          .insert(users)
          .values({
            email: email.trim().toLowerCase(),
            passwordHash,
            dateOfBirth,
          })
          .returning({ id: users.id, email: users.email });
        if (!u) throw new Error('user insert returned no row');

        const [p] = await tx
          .insert(profiles)
          .values({
            userId: u.id,
            username: username.trim().toLowerCase(),
          })
          .returning({ username: profiles.username });
        if (!p) throw new Error('profile insert returned no row');

        await tx.insert(refreshTokens).values({
          userId: u.id,
          tokenHash,
          familyId,
          expiresAt,
        });

        return [u, p];
      });
    } catch (err) {
      const field = uniqueViolationField(err);
      if (field === 'email') {
        throw new ApiError(409, 'email_taken', 'That email already has an account.', 'email');
      }
      if (field === 'username') {
        throw new ApiError(409, 'username_taken', 'That username is taken.', 'username');
      }
      if (field === 'other') {
        throw ApiError.conflict('already_taken', 'That already exists.');
      }
      throw err;
    }

    const accessToken = await signAccessToken(userRow.id);
    return {
      user: { id: userRow.id, email: userRow.email, username: profileRow.username } as User,
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }

  async login(email: string, password: string) {
    const allowed = await this.limiter.allow(`login:${email.trim().toLowerCase()}`, 10, 60);
    if (!allowed) throw ApiError.rateLimited();

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        username: profiles.username,
      })
      .from(users)
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(eq(users.email, email.trim().toLowerCase()))
      .limit(1);

    const generic = new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    if (!row) throw generic;
    if (!(await argonVerify(row.passwordHash, password))) throw generic;

    const familyId = randomUUID();
    const rawRefreshToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    await this.db.insert(refreshTokens).values({
      userId: row.id,
      tokenHash,
      familyId,
      expiresAt,
    });

    const accessToken = await signAccessToken(row.id);
    return {
      user: { id: row.id, email: row.email, username: row.username } as User,
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }

  /**
   * Rotate a refresh token (FN-63/64).
   *
   * If a token is presented whose `used_at` is already set, an attacker has
   * replayed a compromised token. We immediately revoke the ENTIRE family.
   */
  async refresh(rawRefreshToken: string) {
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const [row] = await this.db
      .select({
        id: refreshTokens.id,
        userId: refreshTokens.userId,
        familyId: refreshTokens.familyId,
        expiresAt: refreshTokens.expiresAt,
        usedAt: refreshTokens.usedAt,
        revokedAt: refreshTokens.revokedAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row || row.revokedAt !== null || row.expiresAt < new Date()) {
      throw new ApiError(401, 'invalid_refresh_token', 'Invalid or expired refresh token.');
    }

    // Reuse detection (FN-64)
    if (row.usedAt !== null) {
      await this.db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.familyId, row.familyId));
      throw new ApiError(
        403,
        'token_reused',
        'Refresh token was already used. All sessions in this family have been revoked.',
      );
    }

    // Valid: consume current token and issue the next one in the same family
    const nextRawRefreshToken = randomBytes(32).toString('base64url');
    const nextTokenHash = createHash('sha256').update(nextRawRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    await this.db.transaction(async (tx) => {
      await tx
        .update(refreshTokens)
        .set({ usedAt: new Date() })
        .where(eq(refreshTokens.id, row.id));

      await tx.insert(refreshTokens).values({
        userId: row.userId,
        tokenHash: nextTokenHash,
        familyId: row.familyId,
        expiresAt,
      });
    });

    const accessToken = await signAccessToken(row.userId);
    return { accessToken, refreshToken: nextRawRefreshToken };
  }

  async logout(rawRefreshToken: string) {
    const tokenHash = createHash('sha256').update(rawRefreshToken).digest('hex');
    const [row] = await this.db
      .select({ familyId: refreshTokens.familyId })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    if (row) {
      await this.db
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.familyId, row.familyId));
    }
    return { status: 'ok' };
  }

  /** Look up viewer from access JWT statelessly. */
  async lookup(token: string): Promise<string | null> {
    const verified = await verifyAccessToken(token);
    return verified?.sub ?? null;
  }

  async get(id: string): Promise<User | null> {
    const [row] = await this.db
      .select({ id: users.id, email: users.email, username: profiles.username })
      .from(users)
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(eq(users.id, id))
      .limit(1);
    return (row as User | undefined) ?? null;
  }

  /**
   * Public profile lookup respecting privacy (Architecture §4, PRD §24).
   * Takes viewer as required first argument (FN-70).
   * If the account is private and viewer cannot view, returns null -> 404 (never 403).
   */
  async getProfile(viewer: string | null, userId: string): Promise<Profile | null> {
    const [row] = await this.db
      .select({
        id: users.id,
        username: profiles.username,
        displayName: profiles.displayName,
        bio: profiles.bio,
        avatarKey: profiles.avatarKey,
        isPrivate: profiles.isPrivate,
        followerCount: profiles.followerCount,
        followingCount: profiles.followingCount,
        createdAt: profiles.createdAt,
      })
      .from(users)
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) return null;

    const allowed = canView({
      viewer,
      ownerId: row.id,
      isOwnerPrivate: row.isPrivate,
    });

    if (!allowed) return null;

    return row;
  }
}

import {
  registerBodySchema,
  registerResponseSchema,
  loginBodySchema,
  loginResponseSchema,
  refreshBodySchema,
  refreshResponseSchema,
  logoutResponseSchema,
  userSchema,
  profileSchema,
  idParamSchema,
  errorResponseSchema,
} from '../contract/schemas.js';

export function identityRoutes(service: IdentityService) {
  return async (app: FastifyInstance) => {
    app.post(
      '/auth/register',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Register account',
          description: 'Creates user and profile with age gate check (PRD §26.6).',
          body: registerBodySchema,
          response: {
            201: registerResponseSchema,
            409: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req, reply) => {
        const parsed = registerBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable(
            'invalid_field',
            issue?.message ?? 'Check that.',
            String(issue?.path[0] ?? ''),
          );
        }
        const { email, username, password, dateOfBirth } = parsed.data;
        const result = await service.register(email, username, password, dateOfBirth);
        return reply.status(201).send(result);
      },
    );

    app.post(
      '/auth/login',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Sign in',
          description: 'Authenticates with email and password, returning 15m JWT + 60d refresh token.',
          body: loginBodySchema,
          response: {
            200: loginResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const parsed = loginBody.safeParse(req.body);
        if (!parsed.success) throw ApiError.unauthorized('Email or password is incorrect.');
        return service.login(parsed.data.email, parsed.data.password);
      },
    );

    app.post(
      '/auth/refresh',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Rotate refresh token',
          description: 'Rotates opaque refresh token. Reusing an old token revokes the entire family (FN-64).',
          body: refreshBodySchema,
          response: {
            200: refreshResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const parsed = refreshBody.safeParse(req.body);
        if (!parsed.success) {
          throw ApiError.unprocessable('invalid_field', 'Refresh token is required.', 'refreshToken');
        }
        return service.refresh(parsed.data.refreshToken);
      },
    );

    app.post(
      '/auth/logout',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Sign out',
          description: 'Revokes the presented refresh token family.',
          body: refreshBodySchema,
          response: {
            200: logoutResponseSchema,
          },
        },
      },
      async (req) => {
        const parsed = refreshBody.safeParse(req.body);
        if (!parsed.success) return { status: 'ok' };
        return service.logout(parsed.data.refreshToken);
      },
    );

    app.get(
      '/me',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Get current user',
          description: 'Returns private user account details for the authenticated viewer.',
          security: [{ BearerAuth: [] }],
          response: {
            200: userSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const user = await service.get(viewer);
        if (!user) throw ApiError.notFound('No such account.');
        return user;
      },
    );

    // Public user profile (optional auth: guest viewer is null, PRD §24)
    app.get<{ Params: { id: string } }>(
      '/users/:id',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Get public profile',
          description: 'Returns public user profile. Private accounts return 404 for non-followers (Architecture §4).',
          params: idParamSchema,
          response: {
            200: profileSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const profile = await service.getProfile(req.viewer, req.params.id);
        if (!profile) throw ApiError.notFound('No such user.');
        return profile;
      },
    );
  };
}
