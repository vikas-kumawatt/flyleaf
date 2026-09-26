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

import { config, type Db, type RateLimiter } from '../platform/index.js';
import { type EmailSender, ConsoleEmailSender } from '../providers/email/index.js';
import { users, profiles, works, follows, blocks, refreshTokens, emailVerificationTokens, passwordResetTokens } from '../db/schema.js';
import { ApiError, requireViewer } from '../http.js';
import { isCommonPassword } from './common-passwords.js';
import { canViewWith, loadRelationship } from '../authorization/index.js';

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
// The cap is hygiene, not DoS protection: argon2 pre-hashes its input, so a
// 1 MB password costs the same ~20 ms as a short one (audit A-04-009).
export const passwordSchema = z
  .string()
  .min(10, 'Use at least 10 characters.')
  .max(1024, 'Use at most 1,024 characters.')
  .refine((p) => !isCommonPassword(p), 'That password is too common to be safe.');

/**
 * The same password typed on two keyboards can arrive as NFC or NFD; hash and
 * verify one form so both log in (A-04-009). Admin accounts use it too (Audit 06).
 */
export function normalisePassword(password: string): string {
  return password.normalize('NFC');
}

/**
 * The stored and looked-up form of every email, app and admin alike: the
 * unique constraint is on this form, not on citext (A-04-011, Audit 06).
 */
export function normaliseEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Hashed on first use; login verifies against it when the email has no account. */
let dummyPasswordHash: Promise<string> | undefined;

/**
 * Spend the same argon2 verify as a wrong password, so response time does not
 * reveal whether the email has an account (PRD §6.4, A-04-006). App and admin
 * login both use it.
 */
export async function verifyAgainstDummy(password: string): Promise<void> {
  await argonVerify(await (dummyPasswordHash ??= argonHash('flyleaf-login-timing-equaliser')), normalisePassword(password));
}

/** Session label from User-Agent: control characters removed, at most 200 characters (A-04-012). */
function deviceLabel(userAgent: string | undefined): string | undefined {
  const label = userAgent?.replace(/\p{Cc}+/gu, ' ').trim().slice(0, 200);
  return label || undefined;
}

/** PRD §6.7. Must match RESERVED_USERNAMES in apps/mobile/src/lib/auth-validation.ts (SL-22). */
export const RESERVED_USERNAMES: ReadonlySet<string> = new Set([
  'admin', 'administrator', 'flyleaf', 'support', 'help', 'root', 'api', 'staff',
  'moderator', 'mod', 'official', 'system', 'about', 'legal', 'terms', 'privacy',
  'security', 'billing', 'press', 'contact', 'null', 'undefined', 'guest',
  'anonymous', 'me', 'you', 'everyone',
]);

export const usernameSchema = z
  .string()
  .regex(/^[a-z0-9_]{3,20}$/, '3–20 characters: lowercase letters, numbers and underscores.')
  .refine((u) => !RESERVED_USERNAMES.has(u), 'That username is reserved.');

/** A real calendar date `YYYY-MM-DD` from 1900 on, or null. */
function parseDob(dobStr: string): { y: number; m: number; d: number } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dobStr);
  if (!match) return null;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < 1900) return null;
  const date = new Date(Date.UTC(y, m - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== m - 1 || date.getUTCDate() !== d) return null;
  return { y, m, d };
}

/**
 * Age gate at registration: users under 13 cannot register (PRD §26.6).
 * Compared as calendar dates in UTC, so the result does not depend on the
 * server's time zone; a 29 February birthday turns 13 on 1 March.
 */
export function isAtLeast13(dobStr: string, now: Date = new Date()): boolean {
  const dob = parseDob(dobStr);
  if (!dob) return false;
  let age = now.getUTCFullYear() - dob.y;
  const m = now.getUTCMonth() + 1 - dob.m;
  if (m < 0 || (m === 0 && now.getUTCDate() < dob.d)) {
    age--;
  }
  return age >= 13;
}

export const dobSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD for date of birth.')
  .refine((s) => parseDob(s) !== null, 'Enter a real date of birth.')
  .refine((s) => isAtLeast13(s), 'You must be at least 13 years old to use Flyleaf.');

const registerBody = z.object({
  email: z.string().email('That does not look like an email address.'),
  username: usernameSchema,
  password: passwordSchema,
  dateOfBirth: dobSchema,
});

const confirmDobBody = z.object({ dateOfBirth: dobSchema });

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

// Admin tokens share the key (admin/auth.ts) with audience 'flyleaf-admin'.
// The app audience is what stops one from authenticating app routes (A-04-003).
const APP_AUDIENCE = 'flyleaf-app';
const ISSUER = 'flyleaf';

/** Issue a 15-minute access JWT (FN-63). */
export async function signAccessToken(userId: string, secret = jwtKey): Promise<string> {
  return new jose.SignJWT({ sub: userId })
    .setProtectedHeader({ alg: 'HS256' })
    .setAudience(APP_AUDIENCE)
    .setIssuer(ISSUER)
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
    const { payload } = await jose.jwtVerify(token, secret, {
      algorithms: ['HS256'],
      audience: APP_AUDIENCE,
      issuer: ISSUER,
      requiredClaims: ['exp', 'iat', 'sub'],
    });
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

export type User = { id: string; email: string; username: string; emailVerified?: boolean; dobConfirmed?: boolean };

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

  /**
   * Live availability for the signup username field (PRD §6.7). Public: it
   * reveals nothing register's 409 username_taken does not. A taken name
   * comes with up to three free alternatives ("Taken → suggest three").
   */
  async usernameAvailability(raw: string): Promise<{
    username: string;
    available: boolean;
    reason?: 'invalid' | 'reserved' | 'taken';
    suggestions?: string[];
  }> {
    const username = raw.trim().toLowerCase();
    if (!/^[a-z0-9_]{3,20}$/.test(username)) return { username, available: false, reason: 'invalid' };
    if (RESERVED_USERNAMES.has(username)) return { username, available: false, reason: 'reserved' };

    const base = username.slice(0, 14);
    const year = new Date().getUTCFullYear() % 100;
    const candidates = [username, `${base}_reads`, `${base}_books`, `${base}${year}`, `the_${base}`, `${base}_${year}`, `${base}_page`]
      .filter((c, i, all) => c.length <= 20 && all.indexOf(c) === i && !RESERVED_USERNAMES.has(c));
    const taken = new Set(
      (
        await this.db
          .select({ username: profiles.username })
          .from(profiles)
          .where(inArray(profiles.username, candidates))
      ).map((r) => r.username),
    );
    if (!taken.has(username)) return { username, available: true };
    return {
      username,
      available: false,
      reason: 'taken',
      suggestions: candidates.filter((c) => c !== username && !taken.has(c)).slice(0, 3),
    };
  }

  async register(email: string, username: string, password: string, dateOfBirth: string, device?: string) {
    const passwordHash = await argonHash(normalisePassword(password));
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
            email: normaliseEmail(email),
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
        // PRD §6.3: an existing but unverified email gets its verification
        // email again rather than a dead end. The response is the same 409 as
        // for a verified account, so it says nothing about verification, and
        // no tokens are ever issued for the existing account (D-04-1, D-05-1).
        await this.#resendForExistingUnverified(email);
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
    const allowed = await this.limiter.allow(`login:${normaliseEmail(email)}`, 10, 60);
    if (!allowed) throw ApiError.rateLimited();

    const [row] = await this.db
      .select({
        id: users.id,
        email: users.email,
        passwordHash: users.passwordHash,
        username: profiles.username,
        role: users.role,
      })
      .from(users)
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(and(eq(users.email, normaliseEmail(email)), isNull(users.deletedAt)))
      .limit(1);

    const generic = new ApiError(401, 'invalid_credentials', 'Email or password is incorrect.');
    if (!row) {
      await verifyAgainstDummy(password);
      throw generic;
    }
    // Staff accounts are for the admin console only (D-06-2, PRD §27.5): the
    // same generic 401 after the same argon2 cost, right password or not, so
    // this endpoint says nothing about which emails belong to staff.
    const passwordOk = await argonVerify(row.passwordHash, normalisePassword(password));
    if (!passwordOk || row.role !== 'user') throw generic;

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
    const nextRawRefreshToken = randomBytes(32).toString('base64url');
    const nextTokenHash = createHash('sha256').update(nextRawRefreshToken).digest('hex');
    const expiresAt = new Date(Date.now() + 60 * 24 * 60 * 60 * 1000);

    // Consume and reissue atomically. The conditional UPDATE is the lock: of
    // two concurrent refreshes with one token exactly one gets the row, and the
    // other is treated as reuse below (A-04-005). Strict by design: the mobile
    // client single-flights refreshes (apps/mobile/src/lib/api.ts).
    const consumed = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(refreshTokens)
        .set({ usedAt: new Date() })
        .where(
          and(
            eq(refreshTokens.tokenHash, tokenHash),
            isNull(refreshTokens.usedAt),
            isNull(refreshTokens.revokedAt),
            gt(refreshTokens.expiresAt, new Date()),
            // Deleted accounts and staff accounts (D-06-2) cannot refresh.
            sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${refreshTokens.userId} AND u.deleted_at IS NULL AND u.role = 'user')`,
          ),
        )
        .returning({ userId: refreshTokens.userId, familyId: refreshTokens.familyId, device: refreshTokens.device });
      if (!row) return null;

      await tx.insert(refreshTokens).values({
        userId: row.userId,
        tokenHash: nextTokenHash,
        familyId: row.familyId,
        device: row.device,
        expiresAt,
      });
      return row;
    });

    if (consumed) {
      const accessToken = await signAccessToken(consumed.userId);
      return { accessToken, refreshToken: nextRawRefreshToken };
    }

    const [row] = await this.db
      .select({
        familyId: refreshTokens.familyId,
        expiresAt: refreshTokens.expiresAt,
        usedAt: refreshTokens.usedAt,
        revokedAt: refreshTokens.revokedAt,
      })
      .from(refreshTokens)
      .where(eq(refreshTokens.tokenHash, tokenHash))
      .limit(1);

    // Reuse detection (FN-64)
    if (row && row.usedAt !== null && row.revokedAt === null && row.expiresAt >= new Date()) {
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

    // Unknown, revoked, expired, or the account was deleted.
    throw new ApiError(401, 'invalid_refresh_token', 'Invalid or expired refresh token.');
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
      .select({
        id: users.id,
        email: users.email,
        username: profiles.username,
        emailVerified: sql<boolean>`${users.emailVerifiedAt} IS NOT NULL`,
        dobConfirmed: users.dobConfirmed,
      })
      .from(users)
      .innerJoin(profiles, eq(users.id, profiles.userId))
      .where(eq(users.id, id))
      .limit(1);
    return row ? { ...row, emailVerified: Boolean(row.emailVerified) } : null;
  }

  /**
   * Records the date of birth of an account whose stored one was never entered
   * (dob_confirmed false, D-07-3). Validated like signup by the route. Once:
   * a confirmed date is not editable here, or anyone could rewrite their age.
   */
  async confirmDateOfBirth(userId: string, dateOfBirth: string): Promise<User> {
    const updated = await this.db
      .update(users)
      .set({ dateOfBirth, dobConfirmed: true })
      .where(and(eq(users.id, userId), eq(users.dobConfirmed, false), isNull(users.deletedAt)))
      .returning({ id: users.id });
    if (updated.length === 0) {
      const current = await this.get(userId);
      if (!current) throw ApiError.notFound('No such account.');
      throw ApiError.conflict('dob_already_confirmed', 'Your date of birth is already confirmed.');
    }
    const user = await this.get(userId);
    if (!user) throw ApiError.notFound('No such account.');
    return user;
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

    // One relationship query (Audit 05). Missing, deleted and blocked (either
    // way) are the same 404 as a random id (PRD §11.4).
    const rel = await loadRelationship(this.db, viewer, row.id);
    if (!rel.ownerExists || rel.isBlocked) return null;
    const followStatus = rel.followStatus;
    const followedBy = rel.followedBy;

    if (!canViewWith(viewer, row.id, rel)) {
      // Private account, viewer not an accepted follower. PRD §16.3 / AC-13:
      // header, bio, avatar and follower counts stay visible, so a signed-in
      // reader can request to follow; favourites are followers-only. Guests
      // get 404: §4.2 makes private accounts invisible to them (D-05-2).
      if (viewer === null) return null;
      return {
        id: row.id,
        username: row.username,
        displayName: row.displayName,
        bio: row.bio,
        avatarKey: row.avatarKey,
        isPrivate: row.isPrivate,
        isRestricted: true,
        followerCount: row.followerCount,
        followingCount: row.followingCount,
        favourite_work_ids: [],
        favourites: [],
        createdAt: row.createdAt,
        followStatus,
        followedBy,
      };
    }

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
      text: `Welcome to Flyleaf! Please verify your email using this token:\n${rawToken}\n\nOr click: ${config.appBaseUrl}/verify-email?token=${rawToken}\n\nThis token expires in 24 hours.`,
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

  /** Silent: throttled (shared with resend-verification) and never throws. */
  async #resendForExistingUnverified(email: string): Promise<void> {
    try {
      const [user] = await this.db
        .select({ id: users.id, email: users.email })
        .from(users)
        .where(
          and(
            eq(users.email, normaliseEmail(email)),
            isNull(users.emailVerifiedAt),
            isNull(users.deletedAt),
          ),
        )
        .limit(1);
      if (!user) return;
      if (!(await this.limiter.allow(`resend_verification:${user.id}`, 1, 60))) return;
      await this.sendVerificationEmail(user.id, user.email);
    } catch {
      // A failed resend must not turn a 409 into a 500 (or reveal anything).
    }
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
    const normalized = normaliseEmail(email);
    const allowed = await this.limiter.allow(`forgot_pwd:${normalized}`, 5, 900);
    if (!allowed) {
      throw ApiError.rateLimited('Too many password reset requests. Please try again later.');
    }

    const [user] = await this.db
      .select({ id: users.id, email: users.email })
      .from(users)
      .where(and(eq(users.email, normalized), isNull(users.deletedAt)))
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
        text: `You requested a password reset for your Flyleaf account.\nUse this token to reset your password:\n${rawToken}\n\nOr click: ${config.appBaseUrl}/reset-password?token=${rawToken}\n\nThis link is single-use and expires in 60 minutes.\nIf you did not request this, you can safely ignore this email.`,
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

    // Hash only after the cheap check above, so bogus tokens cost no argon2.
    const passwordHash = await argonHash(normalisePassword(newPassword));

    // Burn the token conditionally: of two concurrent resets with one token,
    // only the one that flips used_at changes the password (A-04-013).
    const spent = await this.db.transaction(async (tx) => {
      const burned = await tx
        .update(passwordResetTokens)
        .set({ usedAt: new Date() })
        .where(and(eq(passwordResetTokens.id, row.id), isNull(passwordResetTokens.usedAt)))
        .returning({ id: passwordResetTokens.id });
      if (burned.length === 0) return false;

      await tx
        .update(users)
        .set({ passwordHash })
        .where(eq(users.id, row.userId));

      await tx
        .update(refreshTokens)
        .set({ revokedAt: new Date() })
        .where(eq(refreshTokens.userId, row.userId));
      return true;
    });

    if (!spent) {
      throw new ApiError(400, 'invalid_or_expired_token', 'Password reset link is invalid or has expired.');
    }
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
  usernameAvailableQuerySchema,
  usernameAvailableResponseSchema,
  resendVerificationResponseSchema,
  forgotPasswordBodySchema,
  forgotPasswordResponseSchema,
  resetPasswordBodySchema,
  resetPasswordResponseSchema,
  sessionListResponseSchema,
  revokeSessionResponseSchema,
  userSchema,
  confirmDobBodySchema,
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
        const device = deviceLabel(req.headers['user-agent']);
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
        const device = deviceLabel(req.headers['user-agent']);
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

    app.get<{ Querystring: { username?: string } }>(
      '/auth/username-available',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Check username availability',
          description:
            'Live check for the signup username field (PRD §6.7). Invalid, reserved and taken names return 200 with available=false and a reason; a taken name comes with up to three free suggestions.',
          querystring: usernameAvailableQuerySchema,
          response: {
            200: usernameAvailableResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const username = req.query.username;
        if (typeof username !== 'string' || username.length === 0 || username.length > 64) {
          throw ApiError.unprocessable('invalid_field', 'Send a username to check.', 'username');
        }
        return service.usernameAvailability(username);
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

    app.post(
      '/me/date-of-birth',
      {
        schema: {
          tags: ['Auth'],
          summary: 'Confirm date of birth',
          description:
            'For an account whose date of birth was never entered (GET /me dobConfirmed false, D-07-3). Same rules as signup (PRD §26.6). Until it is confirmed the account is treated as a minor for maturity rules (PRD §7.8). Allowed once: 409 dob_already_confirmed afterwards.',
          security: [{ BearerAuth: [] }],
          body: confirmDobBodySchema,
          response: {
            200: userSchema,
            401: errorResponseSchema,
            404: errorResponseSchema,
            409: errorResponseSchema,
            422: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const viewer = requireViewer(req);
        const parsed = confirmDobBody.safeParse(req.body);
        if (!parsed.success) {
          const issue = parsed.error.issues[0];
          throw ApiError.unprocessable('invalid_field', issue?.message ?? 'Check that.', 'dateOfBirth');
        }
        return service.confirmDateOfBirth(viewer, parsed.data.dateOfBirth);
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
