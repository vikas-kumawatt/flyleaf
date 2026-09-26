// Admin authentication and audit logging service (FN-90, FN-93, PRD §27.5, Architecture §3.7).
//
// Admin auth is strictly isolated from app accounts:
// 1. Mandatory 2FA via RFC 6238 TOTP. Password alone never grants access.
// 2. Dedicated Admin JWTs with audience 'flyleaf-admin' and scope 'admin'.
//    Stolen mobile app tokens cannot access admin routes.
// 3. Role-based enforcement: 'moderator' is read-only on catalog; 'admin' can merge & undo.
//    The role is read from the database on every request (lookupAdmin), so a
//    demoted, disabled or deleted admin loses access at once (Audit 06).
// 4. Every action, and every failed or denied attempt, is recorded in admin_audit_log (FN-93).

import { randomBytes } from 'node:crypto';
import { verify as argonVerify, hash as argonHash } from '@node-rs/argon2';
import { sql } from 'drizzle-orm';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { FastifyRequest } from 'fastify';
import * as jose from 'jose';
import { z } from 'zod';

import { config, type Db } from '../platform/index.js';
import { ApiError } from '../http.js';
import {
  normaliseEmail,
  normalisePassword,
  passwordSchema,
  verifyAgainstDummy,
} from '../identity/index.js';
import {
  generateTotpSecret,
  generateBackupCodes,
  hashBackupCode,
  matchTotpStep,
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
  /** admin_credentials.session_version when the token was issued. */
  sv: number;
};

/** Where an audited request came from. `req.ip` honours TRUST_PROXY only (A-04-002). */
export type AuditContext = { ip?: string; userAgent?: string };

export function auditContext(req: FastifyRequest): AuditContext {
  const ua = req.headers['user-agent'];
  return { ip: req.ip, userAgent: typeof ua === 'string' ? ua : undefined };
}

const jwtKey = new TextEncoder().encode(config.jwtSecret);

function toTextArraySql(arr: string[]) {
  if (arr.length === 0) return sql`'{}'::text[]`;
  return sql`ARRAY[${sql.join(arr.map((s) => sql`${s}`), sql`, `)}]::text[]`;
}

const invalidCredentials = () => ApiError.unauthorized('invalid_credentials', 'Invalid email or password.');
const invalidTotp = () => ApiError.unauthorized('invalid_totp', 'Invalid two-factor authentication code.');

/**
 * Issues an Admin JWT strictly scoped to the admin console (audience 'flyleaf-admin').
 * Expires in 2 hours. `sessionVersion` must be the admin's current
 * admin_credentials.session_version or lookupAdmin refuses the token.
 */
export async function signAdminToken(
  admin: AdminViewer & { sessionVersion?: number },
  expiresIn = '2h',
  secret = jwtKey,
): Promise<string> {
  return new jose.SignJWT({
    email: admin.email,
    role: admin.role,
    scope: 'admin',
    sv: admin.sessionVersion ?? 0,
  })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(admin.id)
    .setAudience('flyleaf-admin')
    .setIssuer('flyleaf')
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret);
}

async function decodeAdminToken(
  token: string,
  secret: Uint8Array,
): Promise<(AdminViewer & { sessionVersion: number }) | null> {
  try {
    const { payload } = await jose.jwtVerify(token, secret, {
      audience: 'flyleaf-admin',
      issuer: 'flyleaf',
      // Same pinning as app tokens (A-04-004): one algorithm, expiry required.
      algorithms: ['HS256'],
      requiredClaims: ['exp', 'iat', 'sub'],
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
        sessionVersion: typeof payload.sv === 'number' ? payload.sv : -1,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Verifies an Admin JWT's signature and claims only. Strictly asserts audience === 'flyleaf-admin'.
 * Rejects standard mobile app tokens even if signed with the same key.
 * Requests go through lookupAdmin, which also checks the account.
 */
export async function verifyAdminToken(
  token: string,
  secret = jwtKey,
): Promise<AdminViewer | null> {
  const decoded = await decodeAdminToken(token, secret);
  return decoded ? { id: decoded.id, email: decoded.email, role: decoded.role } : null;
}

/**
 * The admin a request's token belongs to, as the database says NOW: the
 * account must still be staff, not deleted, with 2FA configured, and the token
 * must carry the current session version (logout and disable bump it). The
 * role returned is the current one, not the one in the token (Audit 06).
 */
export async function lookupAdmin(db: Db, token: string): Promise<AdminViewer | null> {
  const decoded = await decodeAdminToken(token, jwtKey);
  if (!decoded) return null;
  const [row] = await db.execute<{ id: string; email: string; role: AdminRole }>(sql`
    SELECT u.id, u.email, u.role
    FROM users u
    JOIN admin_credentials c ON c.user_id = u.id
    WHERE u.id = ${decoded.id}
      AND u.deleted_at IS NULL
      AND u.role IN ('admin', 'moderator')
      AND c.session_version = ${decoded.sessionVersion}
  `);
  return row ? { id: row.id, email: row.email, role: row.role } : null;
}

/** Ends every live session of one admin (logout, disable). */
export async function revokeAdminSessions(db: Db, userId: string): Promise<void> {
  await db.execute(sql`
    UPDATE admin_credentials SET session_version = session_version + 1, updated_at = now()
    WHERE user_id = ${userId}
  `);
}

/**
 * Logs an administrative action to admin_audit_log (FN-93, PRD §27.5).
 * `actorId` is null only for a failed login whose email is not a staff account.
 * Never put secrets (passwords, codes, tokens, TOTP seeds) in `payload`.
 */
export async function logAdminAction(
  db: Db | PgTransaction<any, any, any>,
  entry: {
    actorId: string | null;
    action: string;
    subjectType?: string;
    subjectId?: string;
    reason?: string;
    payload?: Record<string, unknown>;
  } & AuditContext,
): Promise<number> {
  const userAgent = entry.userAgent?.replace(/\p{Cc}+/gu, ' ').slice(0, 400);
  const [row] = await db.execute<{ id: string | number }>(sql`
    INSERT INTO admin_audit_log (actor_id, action, subject_type, subject_id, reason, payload, ip, user_agent)
    VALUES (
      ${entry.actorId},
      ${entry.action},
      ${entry.subjectType ?? null},
      ${entry.subjectId ?? null},
      ${entry.reason ?? null},
      ${JSON.stringify(entry.payload ?? {})}::jsonb,
      ${entry.ip ?? null},
      ${userAgent ?? null}
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
    actor_id: string | null;
    actor_email: string | null;
    actor_role: string | null;
    action: string;
    subject_type: string | null;
    subject_id: string | null;
    reason: string | null;
    payload: Record<string, unknown>;
    ip: string | null;
    user_agent: string | null;
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
      l.ip,
      l.user_agent,
      l.created_at
    FROM admin_audit_log l
    LEFT JOIN users u ON u.id = l.actor_id
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
      ip: r.ip,
      userAgent: r.user_agent,
      user_agent: r.user_agent,
      createdAt: createdAtStr,
      created_at: createdAtStr,
    };
  });
}

/**
 * Admin login authenticating email, password, and mandatory 2FA TOTP code (FN-90).
 *
 * Unknown email, app account and wrong password all get the same 401 after the
 * same argon2 cost, so this endpoint reveals nothing about app accounts (PRD
 * §42 #13). A TOTP code is single-use: its step must be later than the last
 * accepted one. A backup code is removed in the same statement that checks it,
 * so two concurrent logins cannot both spend it. Every failure is audited.
 */
export async function loginAdmin(
  db: Db,
  input: {
    email: string;
    password: string;
    totpCode: string;
  } & AuditContext,
): Promise<{ token: string; admin: AdminViewer }> {
  const ctx: AuditContext = { ip: input.ip, userAgent: input.userAgent };
  const [user] = await db.execute<{
    id: string;
    email: string;
    password_hash: string;
    role: string;
    has_2fa: boolean;
    totp_secret: string | null;
  }>(sql`
    SELECT u.id, u.email, u.password_hash, u.role,
           c.user_id IS NOT NULL AS has_2fa, c.totp_secret
    FROM users u
    LEFT JOIN admin_credentials c ON c.user_id = u.id
    WHERE u.email = ${normaliseEmail(input.email)} AND u.deleted_at IS NULL
  `);

  if (!user || (user.role !== 'admin' && user.role !== 'moderator')) {
    await verifyAgainstDummy(input.password);
    // No actor and no email: the attempt is recorded, the address is not.
    await logAdminAction(db, { actorId: null, action: 'admin.login_failed', payload: { reason: 'unknown_account' }, ...ctx });
    throw invalidCredentials();
  }

  if (!(await argonVerify(user.password_hash, normalisePassword(input.password)))) {
    await logAdminAction(db, { actorId: user.id, action: 'admin.login_failed', payload: { reason: 'password' }, ...ctx });
    throw invalidCredentials();
  }

  if (!user.has_2fa || !user.totp_secret) {
    await logAdminAction(db, { actorId: user.id, action: 'admin.login_failed', payload: { reason: 'no_2fa' }, ...ctx });
    throw ApiError.forbidden('2fa_not_configured', 'Two-factor authentication is not configured for this account.');
  }

  const code = input.totpCode.trim();
  const step = matchTotpStep(code, user.totp_secret);
  let sessionVersion: number | undefined;

  if (step !== null) {
    const [accepted] = await db.execute<{ session_version: number }>(sql`
      UPDATE admin_credentials SET last_totp_step = ${step}
      WHERE user_id = ${user.id} AND (last_totp_step IS NULL OR last_totp_step < ${step})
      RETURNING session_version
    `);
    if (!accepted) {
      await logAdminAction(db, { actorId: user.id, action: 'admin.login_failed', payload: { reason: 'totp_replay' }, ...ctx });
      throw invalidTotp();
    }
    sessionVersion = accepted.session_version;
  } else {
    const hashed = hashBackupCode(code);
    const [spent] = await db.execute<{ session_version: number }>(sql`
      UPDATE admin_credentials
      SET backup_codes = array_remove(backup_codes, ${hashed}), updated_at = now()
      WHERE user_id = ${user.id} AND ${hashed} = ANY(backup_codes)
      RETURNING session_version
    `);
    if (!spent) {
      await logAdminAction(db, { actorId: user.id, action: 'admin.login_failed', payload: { reason: 'totp' }, ...ctx });
      throw invalidTotp();
    }
    sessionVersion = spent.session_version;
    await logAdminAction(db, {
      actorId: user.id,
      action: 'admin.backup_code_used',
      reason: 'Consumed one-time recovery backup code for login',
      ...ctx,
    });
  }

  const admin: AdminViewer = {
    id: user.id,
    email: user.email,
    role: user.role as AdminRole,
  };

  const adminJwt = await signAdminToken({ ...admin, sessionVersion });

  // Record successful login audit event
  await logAdminAction(db, {
    actorId: admin.id,
    action: 'admin.login',
    reason: 'Admin console login via password + 2FA',
    payload: { ip: input.ip, userAgent: input.userAgent },
    ...ctx,
  });

  return { token: adminJwt, admin };
}

/**
 * Starts a 2FA rotation for an admin/moderator user. The new secret and backup
 * codes are PENDING: login keeps using the current ones until verify2fa
 * confirms a code from the new secret, so a lost setup response cannot lock
 * the admin out and an unconfirmed secret is never live (Audit 06).
 */
export async function setup2fa(
  db: Db,
  userId: string,
  ctx: AuditContext = {},
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
    UPDATE admin_credentials
    SET pending_totp_secret = ${secret}, pending_backup_codes = ${toTextArraySql(hashed)}, updated_at = now()
    WHERE user_id = ${user.id}
  `);

  await logAdminAction(db, {
    actorId: user.id,
    action: 'admin.2fa_setup',
    reason: 'Generated a pending TOTP secret and backup codes',
    ...ctx,
  });

  return { secret, otpauthUri, backupCodes: plain };
}

/**
 * Confirms a pending 2FA rotation with the first code from the new secret,
 * then makes the new secret and backup codes the live ones.
 */
export async function verify2fa(
  db: Db,
  userId: string,
  code: string,
  ctx: AuditContext = {},
): Promise<{ success: true }> {
  const [creds] = await db.execute<{ pending_totp_secret: string | null }>(sql`
    SELECT pending_totp_secret FROM admin_credentials WHERE user_id = ${userId}
  `);

  if (!creds?.pending_totp_secret) {
    throw ApiError.badRequest('no_pending_2fa', 'Start two-factor setup before verifying a code.');
  }

  const step = matchTotpStep(code, creds.pending_totp_secret);
  if (step === null) {
    await logAdminAction(db, { actorId: userId, action: 'admin.2fa_verify_failed', ...ctx });
    throw ApiError.badRequest('invalid_totp', 'Invalid verification code. Ensure your device clock is accurate.');
  }

  await db.execute(sql`
    UPDATE admin_credentials
    SET totp_secret = pending_totp_secret,
        backup_codes = pending_backup_codes,
        pending_totp_secret = NULL,
        pending_backup_codes = NULL,
        totp_verified = true,
        last_totp_step = ${step},
        updated_at = now()
    WHERE user_id = ${userId} AND pending_totp_secret = ${creds.pending_totp_secret}
  `);

  await logAdminAction(db, {
    actorId: userId,
    action: 'admin.2fa_verified',
    reason: 'Confirmed and activated two-factor authentication',
    ...ctx,
  });

  return { success: true };
}

const adminEmailSchema = z.string().email('That does not look like an email address.');

/**
 * Provisions an admin or moderator user with pre-configured 2FA.
 * Used by the admin CLI (src/admin-cli.ts) and test fixtures. The email and
 * password go through the same normaliser and rules as app accounts
 * (A-04-011, D-04-2). Everything is written in one transaction.
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
  const email = normaliseEmail(opts.email);
  const emailCheck = adminEmailSchema.safeParse(email);
  if (!emailCheck.success) throw ApiError.unprocessable('invalid_field', emailCheck.error.issues[0]!.message, 'email');
  const passwordCheck = passwordSchema.safeParse(opts.password);
  if (!passwordCheck.success) throw ApiError.unprocessable('invalid_field', passwordCheck.error.issues[0]!.message, 'password');

  const username = opts.username ?? `admin_${randomBytes(4).toString('hex')}`;
  const dob = opts.dateOfBirth ?? '1990-01-01';
  const passwordHash = await argonHash(normalisePassword(opts.password));
  const secret = generateTotpSecret();
  const { plain, hashed } = generateBackupCodes(8);

  const createdUser = await db.transaction(async (tx) => {
    const [u] = await tx.execute<{ id: string; email: string; role: string }>(sql`
      INSERT INTO users (email, password_hash, date_of_birth, role, email_verified_at)
      VALUES (${email}, ${passwordHash}, ${dob}::date, ${role}, now())
      RETURNING id, email, role
    `);
    if (!u) throw new Error('Failed to create admin user');

    await tx.execute(sql`
      INSERT INTO profiles (user_id, username, display_name)
      VALUES (${u.id}, ${username}, ${username})
    `);

    await tx.execute(sql`
      INSERT INTO admin_credentials (user_id, totp_secret, totp_verified, backup_codes)
      VALUES (${u.id}, ${secret}, true, ${toTextArraySql(hashed)})
    `);
    return u;
  });

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

/**
 * Takes staff access away from an account: role back to 'user' and every live
 * admin session ended. Audited with no actor (it is run from the CLI).
 */
export async function disableAdmin(db: Db, email: string): Promise<AdminViewer> {
  const [row] = await db.execute<{ id: string; email: string; role: AdminRole }>(sql`
    SELECT id, email, role FROM users
    WHERE email = ${normaliseEmail(email)} AND role IN ('admin', 'moderator')
  `);
  if (!row) throw ApiError.notFound('No admin or moderator has that email.');

  await db.transaction(async (tx) => {
    await tx.execute(sql`UPDATE users SET role = 'user' WHERE id = ${row.id}`);
    await tx.execute(sql`
      UPDATE admin_credentials SET session_version = session_version + 1, updated_at = now()
      WHERE user_id = ${row.id}
    `);
    await logAdminAction(tx, {
      actorId: null,
      action: 'admin.disabled',
      subjectType: 'user',
      subjectId: row.id,
      reason: 'Staff access removed from the command line',
      payload: { previous_role: row.role, via: 'cli' },
    });
  });
  return row;
}
