// Admin authentication and audit logging service (FN-90, FN-93, PRD §27.5, Architecture §3.7).
//
// Admin auth is strictly isolated from app accounts:
// 1. Mandatory 2FA via RFC 6238 TOTP. Password alone never grants access.
// 2. Dedicated Admin JWTs with audience 'flyleaf-admin' and scope 'admin'.
//    Stolen mobile app tokens cannot access admin routes.
// 3. Role-based enforcement: 'moderator' is read-only on catalog; 'admin' can merge & undo.
// 4. Every action is recorded in admin_audit_log (FN-93).

import { verify as argonVerify, hash as argonHash } from '@node-rs/argon2';
import { and, desc, eq, sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import * as jose from 'jose';
import { z } from 'zod';

import { config, type Db } from '../platform/index.js';
import { users, profiles, adminCredentials, adminAuditLog } from '../db/schema.js';
import { ApiError } from '../http.js';
import {
  generateTotpSecret,
  generateBackupCodes,
  hashBackupCode,
  verifyTotp,
  getOtpAuthUri,
} from './totp.js';

export type AdminRole = 'admin' | 'moderator';

export type AdminViewer = {
  id: string;
  email: string;
  role: AdminRole;
};

export type AdminTokenPayload = {
  sub: string;
  email: string;
  role: AdminRole;
  scope: 'admin';
  aud: 'flyleaf-admin';
};

const jwtKey = new TextEncoder().encode(config.jwtSecret);

function toTextArraySql(arr: string[]) {
  if (arr.length === 0) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(arr.map((s) => sql`${s}`), sql`, `)}]::text[]`;
}

/**
 * Issues an Admin JWT strictly scoped to the admin console (audience 'flyleaf-admin').
 * Expires in 2 hours.
 */
export async function signAdminToken(
  admin: AdminViewer,
  expiresIn = '2h',
  secret = jwtKey,
): Promise<string> {
  return new jose.SignJWT({
    email: admin.email,
    role: admin.role,
    scope: 'admin',
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(admin.id)
    .setAudience('flyleaf-admin')
    .setIssuer('flyleaf')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

/**
 * Verifies an Admin JWT. Strictly asserts audience === 'flyleaf-admin'.
 * Rejects standard mobile app tokens even if signed with the same key.
 */
export async function verifyAdminToken(
  token: string,
  secret = jwtKey,
): Promise<AdminViewer | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      audience: 'flyleaf-admin',
      issuer: 'flyleaf',
    });

    if (
      typeof payload.sub === 'string' &&
      typeof payload.email === 'string' &&
      (payload.role === 'admin' || payload.role === 'moderator') &&
      payload.scope === 'admin'
    ) {
      return {
        id: payload.sub,
        email: payload.email,
        role: payload.role as AdminRole,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Logs an administrative action to admin_audit_log (FN-93, PRD §27.5).
 */
export async function logAdminAction(
  db: Db | PgTransaction<any, any, any>,
  entry: {
    actorId: string;
    action: string;
    subjectType?: string;
    subjectId?: string;
    reason?: string;
    payload?: Record<string, unknown>;
  },
): Promise<number> {
  const [row] = await db.execute<{ id: string | number }>(sql`
    INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id, reason, payload)
    VALUES (
      ${entry.actorId},
      ${entry.action},
      ${entry.subjectType ?? null},
      ${entry.subjectId ?? null},
      ${entry.reason ?? null},
      ${JSON.stringify(entry.payload ?? {})}::jsonb
    )
    RETURNING id
  `);

  return Number(row?.id ?? 0);
}

/**
 * Retrieves paginated audit log entries with joined actor details.
 */
export async function getAdminAuditLog(
  db: Db,
  filter: {
    action?: string;
    actorId?: string;
    subjectType?: string;
    limit?: number;
    offset?: number;
  } = {},
) {
  const limit = Math.min(filter.limit ?? 50, 100);
  const offset = filter.offset ?? 0;

  const rows = await db.execute<{
    id: string | number;
    actor_id: string;
    actor_email: string;
    actor_role: string;
    action: string;
    subject_type: string | null;
    subject_id: string | null;
    reason: string | null;
    payload: Record<string, unknown>;
    created_at: string;
  }>(sql`
    SELECT
      l.id,
      l.actor_id,
      u.email AS actor_email,
      u.role AS actor_role,
      l.action,
      l.subject_type,
      l.subject_id,
      l.reason,
      l.payload,
      l.created_at
    FROM admin_audit_log l
    JOIN users u ON u.id = l.actor_id
    WHERE (${filter.action ? sql`l.action = ${filter.action}` : sql`TRUE`})
      AND (${filter.actorId ? sql`l.actor_id = ${filter.actorId}` : sql`TRUE`})
      AND (${filter.subjectType ? sql`l.subject_type = ${filter.subjectType}` : sql`TRUE`})
    ORDER BY l.created_at DESC, l.id DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  return rows.map((r) => {
    const rawDate = r.created_at as unknown;
    const createdAtStr =
      rawDate instanceof Date
        ? rawDate.toISOString()
        : typeof r.created_at === 'string'
        ? r.created_at
        : new Date(String(r.created_at)).toISOString();

    return {
      id: Number(r.id),
      actorId: r.actor_id,
      actor_id: r.actor_id,
      actorEmail: r.actor_email,
      actor_email: r.actor_email,
      actorRole: r.actor_role,
      actor_role: r.actor_role,
      action: r.action,
      subjectType: r.subject_type,
      subject_type: r.subject_type,
      subjectId: r.subject_id,
      subject_id: r.subject_id,
      reason: r.reason,
      payload: r.payload ?? {},
      createdAt: createdAtStr,
      created_at: createdAtStr,
    };
  });
}

/**
 * Admin login authenticating email, password, and mandatory 2FA TOTP code (FN-90).
 */
export async function loginAdmin(
  db: Db,
  input: {
    email: string;
    password: string;
    totpCode: string;
    ip?: string;
    userAgent?: string;
  },
): Promise<{ token: string; admin: AdminViewer }> {
  const [user] = await db.execute<{
    id: string;
    email: string;
    password_hash: string;
    role: string;
    deleted_at: string | null;
  }>(sql`
    SELECT id, email, password_hash, role, deleted_at
    FROM users
    WHERE lower(email) = lower(${input.email})
  `);

  if (!user || user.deleted_at) {
    throw ApiError.unauthorized('invalid_credentials', 'Invalid email or password.');
  }

  // Reject non-admin / non-moderator roles
  if (user.role !== 'admin' && user.role !== 'moderator') {
    throw ApiError.forbidden('admin_access_denied', 'Admin access required.');
  }

  // Verify argon2id password
  const passwordValid = await argonVerify(user.password_hash, input.password);
  if (!passwordValid) {
    throw ApiError.unauthorized('invalid_credentials', 'Invalid email or password.');
  }

  // Fetch admin credentials & 2FA state
  const [creds] = await db.execute<{
    totp_secret: string;
    totp_verified: boolean;
    backup_codes: string[];
  }>(sql`
    SELECT totp_secret, totp_verified, backup_codes
    FROM admin_credentials
    WHERE user_id = ${user.id}
  `);

  if (!creds) {
    throw ApiError.forbidden('2fa_not_configured', 'Two-factor authentication is not configured for this account.');
  }

  const token = input.totpCode.trim();
  let verified = verifyTotp(token, creds.totp_secret);

  // Check if a backup code was provided
  if (!verified && creds.backup_codes && creds.backup_codes.length > 0) {
    const hashedAttempt = hashBackupCode(token);
    const backupIndex = creds.backup_codes.indexOf(hashedAttempt);
    if (backupIndex !== -1) {
      verified = true;
      // Consume the used backup code
      const remainingCodes = creds.backup_codes.filter((_, i) => i !== backupIndex);
      await db.execute(sql`
        UPDATE admin_credentials
        SET backup_codes = ${toTextArraySql(remainingCodes)}, updated_at = now()
        WHERE user_id = ${user.id}
      `);
      await logAdminAction(db, {
        actorId: user.id,
        action: 'admin.backup_code_used',
        reason: 'Consumed one-time recovery backup code for login',
      });
    }
  }

  if (!verified) {
    throw ApiError.unauthorized('invalid_totp', 'Invalid two-factor authentication code.');
  }

  const admin: AdminViewer = {
    id: user.id,
    email: user.email,
    role: user.role as AdminRole,
  };

  const adminJwt = await signAdminToken(admin);

  // Record successful login audit event
  await logAdminAction(db, {
    actorId: admin.id,
    action: 'admin.login',
    reason: 'Admin console login via password + 2FA',
    payload: { ip: input.ip, userAgent: input.userAgent },
  });

  return { token: adminJwt, admin };
}

/**
 * Initializes or resets 2FA for an admin/moderator user.
 */
export async function setup2fa(
  db: Db,
  userId: string,
): Promise<{ secret: string; otpauthUri: string; backupCodes: string[] }> {
  const [user] = await db.execute<{ id: string; email: string; role: string }>(sql`
    SELECT id, email, role FROM users WHERE id = ${userId}
  `);

  if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
    throw ApiError.forbidden('admin_access_denied', 'Admin access required.');
  }

  const secret = generateTotpSecret();
  const { plain, hashed } = generateBackupCodes(8);
  const otpauthUri = getOtpAuthUri({ email: user.email, secret });

  await db.execute(sql`
    INSERT INTO admin_credentials (user_id, totp_secret, totp_verified, backup_codes, updated_at)
    VALUES (${user.id}, ${secret}, false, ${toTextArraySql(hashed)}, now())
    ON CONFLICT (user_id) DO UPDATE SET
      totp_secret = EXCLUDED.totp_secret,
      totp_verified = false,
      backup_codes = EXCLUDED.backup_codes,
      updated_at = now()
  `);

  await logAdminAction(db, {
    actorId: user.id,
    action: 'admin.2fa_setup',
    reason: 'Generated new TOTP secret and backup codes',
  });

  return { secret, otpauthUri, backupCodes: plain };
}

/**
 * Confirms 2FA setup by validating the user's first 6-digit TOTP token.
 */
export async function verify2fa(
  db: Db,
  userId: string,
  code: string,
): Promise<{ success: true }> {
  const [creds] = await db.execute<{ totp_secret: string }>(sql`
    SELECT totp_secret FROM admin_credentials WHERE user_id = ${userId}
  `);

  if (!creds) {
    throw ApiError.notFound('2FA setup has not been initiated.');
  }

  if (!verifyTotp(code, creds.totp_secret)) {
    throw ApiError.badRequest('invalid_totp', 'Invalid verification code. Ensure your device clock is accurate.');
  }

  await db.execute(sql`
    UPDATE admin_credentials
    SET totp_verified = true, updated_at = now()
    WHERE user_id = ${userId}
  `);

  await logAdminAction(db, {
    actorId: userId,
    action: 'admin.2fa_verified',
    reason: 'Confirmed and activated two-factor authentication',
  });

  return { success: true };
}

/**
 * Helper to provision an admin or moderator user with pre-configured 2FA.
 * Primarily used in test fixtures, seed runners, and CLI tools.
 */
export async function createAdminUser(
  db: Db,
  opts: {
    email: string;
    password: string;
    role?: AdminRole;
    username?: string;
    dateOfBirth?: string;
  },
): Promise<{ user: AdminViewer; secret: string; backupCodes: string[] }> {
  const role = opts.role ?? 'admin';
  const username = opts.username ?? `admin_${Date.now().toString(36)}`;
  const dob = opts.dateOfBirth ?? '1990-01-01';
  const passwordHash = await argonHash(opts.password);
  const secret = generateTotpSecret();
  const { plain, hashed } = generateBackupCodes(8);

  const [createdUser] = await db.execute<{ id: string; email: string; role: string }>(sql`
    INSERT INTO users (email, password_hash, date_of_birth, role, email_verified_at)
    VALUES (${opts.email}, ${passwordHash}, ${dob}::date, ${role}, now())
    RETURNING id, email, role
  `);

  if (!createdUser) throw new Error('Failed to create admin user');

  await db.execute(sql`
    INSERT INTO profiles (user_id, username, display_name)
    VALUES (${createdUser.id}, ${username}, ${username})
    ON CONFLICT (username) DO NOTHING
  `);

  await db.execute(sql`
    INSERT INTO admin_credentials (user_id, totp_secret, totp_verified, backup_codes)
    VALUES (${createdUser.id}, ${secret}, true, ${toTextArraySql(hashed)})
  `);

  return {
    user: {
      id: createdUser.id,
      email: createdUser.email,
      role: createdUser.role as AdminRole,
    },
    secret,
    backupCodes: plain,
  };
}
