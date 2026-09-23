// Users, profiles, JWT, and rotating refresh tokens (FN-60 through FN-64).
//
// argon2id is correct from day one — password hashing is not a thing to
// prototype. Real auth is a 15-minute JWT plus an opaque rotating refresh token
// with family reuse detection (PRD §25, Architecture §3.3 & §7).

import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { hash as argonHash, verify as argonVerify } from '@node-rs/argon2';
import { and, eq, gt, isNull, inArray, or, sql } from 'drizzle-orm';
import * as jose from 'jose';
import { z } from 'zod';
import type { FastifyInstance } from 'fastify';

import { config, type Db, type RateLimiter, type EmailSender, ConsoleEmailSender } from '../platform/index.js';
import { users, profiles, works, follows, blocks, refreshTokens, emailVerificationTokens, passwordResetTokens } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { isCommonPassword } from './common-passwords.js';
import { canView } from '../authorization/index.js';

export type ProfileFavourite = {
  id: string;
  title: string;
  author_name: string;
  cover_id: number | null;
};

export type Profile = {
  id: string;
  username: string;
  displayName: string | null;
  bio: string | null;
  avatarKey: string | null;
  isPrivate: boolean;
  isRestricted?: boolean;
  followerCount: number;
  followingCount: number;
  favourite_work_ids: string[];
  favourites: ProfileFavourite[];
  createdAt: Date;
  followStatus?: 'none' | 'pending' | 'accepted' | 'self';
  followedBy?: boolean;
};

export type Session = {
  id: string;
  device: string | null;
  createdAt: Date;
  lastUsedAt: Date;
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

const verifyEmailBody = z.object({
  token: z.string().min(1, 'Token is required.'),
});

const forgotPasswordBody = z.object({
  email: z.string().email('That does not look like an email address.'),
});

const resetPasswordBody = z.object({
  token: z.string().min(1, 'Token is required.'),
  newPassword: passwordSchema,
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

import { ActivityService } from '../activity/index.js';

export class IdentityService {
  private activityService: ActivityService;

  constructor(
    private db: Db,
    private limiter: RateLimiter,
    private mailer: EmailSender = new ConsoleEmailSender(),
  ) {
    this.activityService = new ActivityService(db);
  }

  async register(email: string, username: string, password: string, dateOfBirth: string, device?: string) {
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
          device: device ?? null,
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
    await this.sendVerificationEmail(userRow.id, userRow.email);

    return {
      user: { id: userRow.id, email: userRow.email, username: profileRow.username } as User,
      accessToken,
      refreshToken: rawRefreshToken,
    };
  }

  async login(email: string, password: string, device?: string) {
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
      device: device ?? null,
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
        device: refreshTokens.device,
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
        device: row.device,
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
  /**
   * Public profile lookup respecting privacy (Architecture §4, PRD §24, AC-13, SO-02).
   * Takes viewer as required first argument (FN-70).
   * If blocked: returns null -> 404 (never revealing block).
   * If private account & non-follower: returns restricted header profile with followStatus/followedBy.
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
        favouriteWorkIds: profiles.favouriteWorkIds,
        createdAt: profiles.createdAt,
      })
      .from(users)
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(eq(users.id, userId))
      .limit(1);

    if (!row) return null;

    // Check relationship (blocks and follows)
    let isBlocked = false;
    let followStatus: 'none' | 'pending' | 'accepted' | 'self' = 'none';
    let followedBy = false;

    if (viewer) {
      if (viewer === row.id) {
        followStatus = 'self';
      } else {
        const [blockRow] = await this.db
          .select({ blockerId: blocks.blockerId })
          .from(blocks)
          .where(
            or(
              and(eq(blocks.blockerId, viewer), eq(blocks.blockedId, row.id)),
              and(eq(blocks.blockerId, row.id), eq(blocks.blockedId, viewer)),
            ),
          )
          .limit(1);

        if (blockRow) isBlocked = true;

        const [followRow] = await this.db
          .select({ state: follows.state })
          .from(follows)
          .where(and(eq(follows.followerId, viewer), eq(follows.followeeId, row.id)))
          .limit(1);

        if (followRow) {
          followStatus = followRow.state === 'accepted' ? 'accepted' : 'pending';
        }

        const [reverseRow] = await this.db
          .select({ state: follows.state })
          .from(follows)
          .where(and(eq(follows.followerId, row.id), eq(follows.followeeId, viewer), eq(follows.state, 'accepted')))
          .limit(1);

        followedBy = Boolean(reverseRow);
      }
    }

    if (isBlocked) return null;

    const isFollower = followStatus === 'accepted';
    const allowed = canView({
      viewer,
      ownerId: row.id,
      isOwnerPrivate: row.isPrivate,
      isBlocked: false,
      isFollower,
    });

    if (!allowed) return null;

    let favourites: ProfileFavourite[] = [];
    const favIds = (row.favouriteWorkIds ?? []) as string[];
    if (favIds.length > 0) {
      const favRows = await this.db
        .select({
          id: works.id,
          title: works.title,
          coverId: works.olCoverId,
          authorName: sql<string>`COALESCE((
            SELECT a.name
            FROM work_authors wa JOIN authors a ON a.id = wa.author_id
            WHERE wa.work_id = works.id
            ORDER BY wa.position, a.name
            LIMIT 1
          ), 'Unknown Author')`.as('author_name'),
        })
        .from(works)
        .where(inArray(works.id, favIds));

      const byId = new Map(favRows.map((r) => [r.id, r]));
      favourites = favIds
        .map((id) => byId.get(id))
        .filter((r): r is NonNullable<typeof r> => Boolean(r))
        .map((r) => ({
          id: r.id,
          title: r.title,
          author_name: r.authorName,
          cover_id: r.coverId,
        }));
    }

    return {
      id: row.id,
      username: row.username,
      displayName: row.displayName,
      bio: row.bio,
      avatarKey: row.avatarKey,
      isPrivate: row.isPrivate,
      isRestricted: false,
      followerCount: row.followerCount,
      followingCount: row.followingCount,
      favourite_work_ids: favIds,
      favourites,
      createdAt: row.createdAt,
      followStatus,
      followedBy,
    };
  }

  async updateProfile(
    userId: string,
    data: {
      displayName?: string | null;
      bio?: string | null;
      isPrivate?: boolean;
      favouriteWorkIds?: string[];
    },
  ): Promise<Profile> {
      if (data.bio !== undefined && data.bio !== null && data.bio.length > 160) {
        throw ApiError.unprocessable('bio_too_long', 'Bio must not exceed 160 characters.', 'bio');
      }
      if (data.displayName !== undefined && data.displayName !== null && data.displayName.length > 100) {
        throw ApiError.unprocessable('display_name_too_long', 'Display name must not exceed 100 characters.', 'displayName');
      }
      if (data.favouriteWorkIds !== undefined) {
        if (data.favouriteWorkIds.length > 4) {
          throw ApiError.unprocessable('too_many_favourites', 'You can pick at most 4 favourite books.', 'favouriteWorkIds');
        }
      }

      // Check if toggling from private to public
      let goingPublic = false;
      if (data.isPrivate === false) {
        const [existing] = await this.db
          .select({ isPrivate: profiles.isPrivate })
          .from(profiles)
          .where(eq(profiles.userId, userId))
          .limit(1);
        if (existing?.isPrivate) {
          goingPublic = true;
        }
      }

      const updates: Record<string, any> = {};
      if (data.displayName !== undefined) updates.displayName = data.displayName;
      if (data.bio !== undefined) updates.bio = data.bio;
      if (data.isPrivate !== undefined) updates.isPrivate = data.isPrivate;
      if (data.favouriteWorkIds !== undefined) updates.favouriteWorkIds = data.favouriteWorkIds;

      if (Object.keys(updates).length > 0) {
        await this.db
          .update(profiles)
          .set(updates)
          .where(eq(profiles.userId, userId));

        if (data.isPrivate === true) {
          await this.activityService.setAccountPrivacy(this.db, userId, true);
        }
      }

      // If going public, auto-accept pending requests
      if (goingPublic) {
        await this.db
          .update(follows)
          .set({ state: 'accepted' })
          .where(and(eq(follows.followeeId, userId), eq(follows.state, 'pending')));
      }

      const updated = await this.getProfile(userId, userId);
      if (!updated) throw ApiError.notFound('Profile not found.');
      return updated;
  }

  async sendVerificationEmail(userId: string, email: string): Promise<void> {
    const rawToken = randomBytes(32).toString('base64url');
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const expiresAt = new Date(Date.now() + 24 * 60 * 60 * 1000); // 24 hours

    await this.db.transaction(async (tx) => {
      await tx
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationTokens.userId, userId));

      await tx.insert(emailVerificationTokens).values({
        userId,
        tokenHash,
        expiresAt,
      });
    });

    await this.mailer.send({
      to: email,
      subject: 'Verify your email for Flyleaf',
      text: `Welcome to Flyleaf! Please verify your email using this token:\n${rawToken}\n\nOr click: https://flyleaf.app/verify-email?token=${rawToken}\n\nThis token expires in 24 hours.`,
    });
  }

  async verifyEmail(rawToken: string): Promise<{ status: 'ok'; message: string }> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const [row] = await this.db
      .select({
        id: emailVerificationTokens.id,
        userId: emailVerificationTokens.userId,
        expiresAt: emailVerificationTokens.expiresAt,
        usedAt: emailVerificationTokens.usedAt,
      })
      .from(emailVerificationTokens)
      .where(eq(emailVerificationTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row || row.usedAt !== null || row.expiresAt < new Date()) {
      throw new ApiError(400, 'invalid_or_expired_token', 'Verification link is invalid or has expired.');
    }

    await this.db.transaction(async (tx) => {
      await tx
        .update(emailVerificationTokens)
        .set({ usedAt: new Date() })
        .where(eq(emailVerificationTokens.id, row.id));

      await tx
        .update(users)
        .set({ emailVerifiedAt: new Date() })
        .where(eq(users.id, row.userId));
    });

    return { status: 'ok', message: 'Email verified successfully.' };
  }

  async resendVerification(userId: string): Promise<{ status: 'ok'; message: string }> {
    const allowed = await this.limiter.allow(`resend_verification:${userId}`, 1, 60);
    if (!allowed) {
      throw ApiError.rateLimited('Please wait a minute before requesting another verification email.');
    }

    const [user] = await this.db
      .select({ id: users.id, email: users.email, emailVerifiedAt: users.emailVerifiedAt })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    if (!user) throw ApiError.notFound('User not found.');

    if (user.emailVerifiedAt !== null) {
      return { status: 'ok', message: 'Email is already verified.' };
    }

    await this.sendVerificationEmail(user.id, user.email);
    return { status: 'ok', message: 'Verification email sent.' };
  }

  async forgotPassword(email: string): Promise<{ status: 'ok'; message: string }> {
    const normalized = email.trim().toLowerCase();
    const allowed = await this.limiter.allow(`forgot_pwd:${normalized}`, 5, 900);
    if (!allowed) {
      throw ApiError.rateLimited('Too many password reset requests. Please try again later.');
    }

    const [user] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);

    if (user) {
      const rawToken = randomBytes(32).toString('base64url');
      const tokenHash = createHash('sha256').update(rawToken).digest('hex');
      const expiresAt = new Date(Date.now() + 60 * 60 * 1000); // 60 minutes (PRD §6.5)

      await this.db.transaction(async (tx) => {
        await tx
          .update(passwordResetTokens)
          .set({ usedAt: new Date() })
          .where(eq(passwordResetTokens.userId, user.id));

        await tx.insert(passwordResetTokens).values({
          userId: user.id,
          tokenHash,
          expiresAt,
        });
      });

      await this.mailer.send({
        to: user.email,
        subject: 'Reset your Flyleaf password',
        text: `You requested a password reset for your Flyleaf account.\nUse this token to reset your password:\n${rawToken}\n\nOr click: https://flyleaf.app/reset-password?token=${rawToken}\n\nThis link is single-use and expires in 60 minutes.\nIf you did not request this, you can safely ignore this email.`,
      });
    }

    return {
      status: 'ok',
      message: "If that email exists in our system, we've sent a password reset link.",
    };
  }

  async resetPassword(rawToken: string, newPassword: string): Promise<{ status: 'ok'; message: string }> {
    const tokenHash = createHash('sha256').update(rawToken).digest('hex');
    const [row] = await this.db
      .select({
        id: passwordResetTokens.id,
        userId: passwordResetTokens.userId,
        expiresAt: passwordResetTokens.expiresAt,
        usedAt: passwordResetTokens.usedAt,
      })
      .from(passwordResetTokens)
      .where(eq(passwordResetTokens.tokenHash, tokenHash))
      .limit(1);

    if (!row || row.usedAt !== null || row.expiresAt < new Date()) {
      throw new ApiError(400, 'invalid_or_expired_token', 'Password reset link is invalid or has expired.');
    }

    const passwordHash = await argonHash(newPassword);

    await this.db.transaction(async (tx) => {
      await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(eq(passwordResetTokens.id, row.id));

      await tx
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, row.userId));

      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.userId, row.userId));
    });

    return { status: 'ok', message: 'Password has been reset successfully.' };
  }

  async listSessions(userId: string): Promise<Session[]> {
    const rows = await this.db
      .select({
        id: refreshTokens.familyId,
        device: refreshTokens.device,
        createdAt: sql<string>`min(${refreshTokens.createdAt})`,
        lastUsedAt: sql<string>`max(coalesce(${refreshTokens.usedAt}, ${refreshTokens.createdAt}))`,
      })
      .from(refreshTokens)
      .where(
        and(
          eq(refreshTokens.userId, userId),
          isNull(refreshTokens.revokedAt),
          gt(refreshTokens.expiresAt, new Date()),
        ),
      )
      .groupBy(refreshTokens.familyId, refreshTokens.device)
      .orderBy(sql`max(coalesce(${refreshTokens.usedAt}, ${refreshTokens.createdAt})) desc`);

    return rows.map((r) => ({
      id: r.id,
      device: r.device ?? null,
      createdAt: new Date(r.createdAt),
      lastUsedAt: new Date(r.lastUsedAt),
    }));
  }

  async revokeSession(userId: string, familyId: string): Promise<{ status: 'ok'; message: string }> {
    const result = await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(
        and(
          eq(refreshTokens.userId, userId),
          eq(refreshTokens.familyId, familyId),
          isNull(refreshTokens.revokedAt),
        ),
      )
      .returning({ id: refreshTokens.id });

    if (result.length === 0) {
      throw ApiError.notFound('Session not found.');
    }

    return { status: 'ok', message: 'Session revoked.' };
  }

  async logoutAll(userId: string): Promise<{ status: 'ok'; message: string }> {
    await this.db
      .update(refreshTokens)
      .set({ revokedAt: new Date() })
      .where(and(eq(refreshTokens.userId, userId), isNull(refreshTokens.revokedAt)));

    return { status: 'ok', message: 'All sessions revoked.' };
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
  verifyEmailBodySchema,
  verifyEmailResponseSchema,
  resendVerificationResponseSchema,
  forgotPasswordBodySchema,
  forgotPasswordResponseSchema,
  resetPasswordBodySchema,
  resetPasswordResponseSchema,
  sessionListResponseSchema,
  revokeSessionResponseSchema,
  userSchema,
  profileSchema,
  updateProfileBodySchema,
  updateProfileResponseSchema,
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
        const device = (req.headers['user-agent'] as string) || undefined;
        const result = await service.register(email, username, password, dateOfBirth, device);
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
        const device = (req.headers['user-agent'] as string) || undefined;
        return service.login(parsed.data.email, parsed.data.password, device);
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

    app.post(
      '/auth/verify-email',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Verify email',
          description: 'Verifies email ownership using single-use verification token (PRD §6.6).',
          body: verifyEmailBodySchema,
          response: {
            200: verifyEmailResponseSchema,
            400: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const parsed = verifyEmailBody.safeParse(req.body);
        if (!parsed.success) {
          throw ApiError.unprocessable('invalid_field', 'Verification token is required.', 'token');
        }
        return service.verifyEmail(parsed.data.token);
      },
    );

    app.post(
      '/auth/resend-verification',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Resend email verification',
          description: 'Resends verification email with 60s rate limit (PRD §6.6, §24.2).',
          security: [{ BearerAuth: [] }],
          response: {
            200: resendVerificationResponseSchema,
            401: errorResponseSchema,
            429: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        return service.resendVerification(viewer);
      },
    );

    app.post(
      '/auth/forgot-password',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Forgot password',
          description: 'Requests password reset link. Always returns 200 to prevent user enumeration (PRD §6.5, §24.2).',
          body: forgotPasswordBodySchema,
          response: {
            200: forgotPasswordResponseSchema,
            422: errorResponseSchema,
            429: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const parsed = forgotPasswordBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable('invalid_field', issue?.message ?? 'Valid email is required.', 'email');
        }
        return service.forgotPassword(parsed.data.email);
      },
    );

    app.post(
      '/auth/reset-password',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Reset password',
          description: 'Resets password and revokes all active refresh token families (PRD §6.5, Architecture §7).',
          body: resetPasswordBodySchema,
          response: {
            200: resetPasswordResponseSchema,
            400: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const parsed = resetPasswordBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable(
            'invalid_field',
            issue?.message ?? 'Check that.',
            String(issue?.path[0] ?? ''),
          );
        }
        return service.resetPassword(parsed.data.token, parsed.data.newPassword);
      },
    );

    app.get(
      '/auth/sessions',
      {
        schema: {
          tags: ['Auth'],
          summary: 'List active sessions',
          description: 'Lists active device sessions for the authenticated user (PRD §24.2, §25).',
          security: [{ BearerAuth: [] }],
          response: {
            200: sessionListResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const data = await service.listSessions(viewer);
        return { data };
      },
    );

    app.delete<{ Params: { id: string } }>(
      '/auth/sessions/:id',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Revoke session',
          description: 'Revokes an active device session by family UUID (PRD §24.2, §25).',
          security: [{ BearerAuth: [] }],
          params: idParamSchema,
          response: {
            200: revokeSessionResponseSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        return service.revokeSession(viewer, req.params.id);
      },
    );

    app.post(
      '/auth/logout-all',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Revoke all sessions',
          description: 'Revokes all device sessions for the authenticated user (PRD §24.2, §25).',
          security: [{ BearerAuth: [] }],
          response: {
            200: revokeSessionResponseSchema,
            401: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        return service.logoutAll(viewer);
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

    app.get(
      '/me/profile',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Get my profile',
          description: 'Returns the full profile and favourite books for the authenticated viewer.',
          security: [{ BearerAuth: [] }],
          response: {
            200: profileSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const profile = await service.getProfile(viewer, viewer);
        if (!profile) throw ApiError.notFound('Profile not found.');
        return profile;
      },
    );

    app.patch(
      '/me/profile',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Update my profile',
          description: 'Updates bio, display name, privacy, or 4 favourite books for the authenticated viewer (PRD §6.38, §6.39).',
          security: [{ BearerAuth: [] }],
          body: updateProfileBodySchema,
          response: {
            200: updateProfileResponseSchema,
            401: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        return service.updateProfile(viewer, req.body as any);
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
