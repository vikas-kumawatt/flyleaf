// Admin console and authentication routes (FN-90, FN-93, PRD §27.5, Architecture §3.7).
//
// Provides:
// 1. REST endpoints for admin login (with mandatory 2FA), session inspection, 2FA setup, and audit log.
// 2. Server-rendered HTML web views for login, audit trail, and session management.

import { RateLimits } from '../platform/rate-limits.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/index.js';
import { ApiError, requireAdmin, requireModerator } from '../http.js';
import {
  auditContext,
  loginAdmin,
  setup2fa,
  verify2fa,
  getAdminAuditLog,
  logAdminAction,
  revokeAdminSessions,
} from './auth.js';
import { ADMIN_CSS, adminPage, clearAdminSession, escapeHtml, sendAdminHtml, setAdminSession } from './html.js';
import {
  adminLoginBodySchema,
  adminLoginResponseSchema,
  adminMeResponseSchema,
  admin2faSetupResponseSchema,
  admin2faVerifyBodySchema,
  admin2faVerifyResponseSchema,
  adminAuditLogQuerySchema,
  adminAuditLogListResponseSchema,
  errorResponseSchema,
} from '../contract/schemas.js';

const loginBody = z.object({
  email: z.string().email(),
  password: z.string().min(1),
  totp_code: z.string().min(6).max(10),
});

const verifyBody = z.object({
  code: z.string().length(6),
});

const auditQuery = z.object({
  action: z.string().optional(),
  actor_id: z.string().uuid().optional(),
  subject_type: z.string().optional(),
  limit: z.coerce.number().optional(),
  offset: z.coerce.number().optional(),
});

export function adminAuthRoutes(db: Db, limits: RateLimits = RateLimits.off()) {
  return async (app: FastifyInstance) => {
    // -----------------------------------------------------------------------
    // REST API Endpoints
    // -----------------------------------------------------------------------

    app.post(
      '/v1/admin/auth/login',
      {
        schema: {
          tags: ['Admin Auth'],
          summary: 'Admin login with password and mandatory 2FA',
          description: 'Authenticates administrator or moderator credentials with TOTP 2FA, issuing a scoped Admin JWT.',
          body: adminLoginBodySchema,
          response: {
            200: adminLoginResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const body = loginBody.parse(req.body);
        // A-06-RL1: 10 a minute per account (the IP tier is the route's group).
        await limits.enforce('admin-login', body.email.trim().toLowerCase());
        return loginAdmin(db, {
          email: body.email,
          password: body.password,
          totpCode: body.totp_code,
          ...auditContext(req),
        });
      },
    );

    app.get(
      '/v1/admin/auth/me',
      {
        schema: {
          tags: ['Admin Auth'],
          summary: 'Get current admin session',
          description: 'Returns the authenticated administrator or moderator viewer context.',
          response: {
            200: adminMeResponseSchema,
            401: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const admin = requireModerator(req);
        return { admin };
      },
    );

    app.post(
      '/v1/admin/auth/2fa/setup',
      {
        schema: {
          tags: ['Admin Auth'],
          summary: 'Initialize 2FA setup for admin account',
          description: 'Generates a new TOTP secret, otpauth URI, and one-time backup codes.',
          response: {
            200: admin2faSetupResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const admin = requireAdmin(req);
        const result = await setup2fa(db, admin.id, auditContext(req));
        return {
          secret: result.secret,
          otpauth_uri: result.otpauthUri,
          backup_codes: result.backupCodes,
        };
      },
    );

    app.post(
      '/v1/admin/auth/2fa/verify',
      {
        schema: {
          tags: ['Admin Auth'],
          summary: 'Verify and activate 2FA setup',
          description: 'Verifies the first 6-digit TOTP code to confirm two-factor setup.',
          body: admin2faVerifyBodySchema,
          response: {
            200: admin2faVerifyResponseSchema,
            400: errorResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        const admin = requireAdmin(req);
        const body = verifyBody.parse(req.body);
        return verify2fa(db, admin.id, body.code, auditContext(req));
      },
    );

    app.get(
      '/v1/admin/audit-log',
      {
        schema: {
          tags: ['Admin Audit'],
          summary: 'List admin audit log entries',
          description: 'Non-negotiable audit trail of administrative actions (FN-93).',
          querystring: adminAuditLogQuerySchema,
          response: {
            200: adminAuditLogListResponseSchema,
            401: errorResponseSchema,
            403: errorResponseSchema,
            500: errorResponseSchema,
          },
        },
      },
      async (req) => {
        requireModerator(req);
        const query = auditQuery.parse(req.query);
        const data = await getAdminAuditLog(db, {
          action: query.action,
          actorId: query.actor_id,
          subjectType: query.subject_type,
          limit: query.limit,
          offset: query.offset,
        });
        return { data };
      },
    );

    // -----------------------------------------------------------------------
    // Server-Rendered HTML Web Views
    // -----------------------------------------------------------------------

    // The browser flow never hands the token to page script: the form posts
    // here, the session comes back as an HttpOnly cookie (Audit 06, A-06-002).
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
      done(null, Object.fromEntries(new URLSearchParams(body as string)));
    });

    app.get('/admin/login', { schema: { hide: true } }, async (req, reply) => {
      if (req.admin) {
        return reply.redirect('/admin/merges');
      }
      return sendAdminHtml(reply, () => renderLoginPage());
    });

    app.post('/admin/login', { schema: { hide: true } }, async (req, reply) => {
      const form = loginBody.safeParse(req.body);
      if (!form.success) {
        return sendAdminHtml(reply, () => renderLoginPage('Enter your email, password and authenticator code.'), 400);
      }
      try {
        await limits.enforce('admin-login', form.data.email.trim().toLowerCase());
        const { token } = await loginAdmin(db, {
          email: form.data.email,
          password: form.data.password,
          totpCode: form.data.totp_code,
          ...auditContext(req),
        });
        setAdminSession(reply, req, token);
        return reply.redirect('/admin/merges', 303);
      } catch (err) {
        if (err instanceof ApiError && (err.status === 401 || err.status === 403 || err.status === 429)) {
          if (err.retryAfterSeconds !== undefined) reply.header('retry-after', String(err.retryAfterSeconds));
          return sendAdminHtml(reply, () => renderLoginPage(err.message), err.status);
        }
        throw err;
      }
    });

    app.post('/admin/logout', { schema: { hide: true } }, async (req, reply) => {
      // Signing out ends every session of this admin, not just this cookie:
      // a JWT cannot be recalled one by one (Audit 06, A-06-009).
      if (req.admin) {
        await revokeAdminSessions(db, req.admin.id);
        await logAdminAction(db, {
          actorId: req.admin.id,
          action: 'admin.logout',
          reason: 'Explicit admin console sign out',
          ...auditContext(req),
        });
      }
      clearAdminSession(reply, req);
      return reply.redirect('/admin/login');
    });

    app.get('/admin/audit-log', { schema: { hide: true } }, async (req, reply) => {
      if (!req.admin) {
        return reply.redirect('/admin/login');
      }

      const admin = req.admin;
      const logs = await getAdminAuditLog(db, { limit: 100 });

      return sendAdminHtml(reply, () =>
        adminPage({
          title: 'Audit trail',
          path: '/admin/audit-log',
          admin,
          body: `
    <div class="page-head">
      <div>
        <h1>Audit trail</h1>
        <p class="sub">Every administrative action, newest first</p>
      </div>
    </div>

    <div class="card flush table-wrap">
      <table>
        <thead>
          <tr>
            <th>Time</th>
            <th>Actor</th>
            <th>Action</th>
            <th>Subject</th>
            <th>Reason</th>
            <th>Payload</th>
          </tr>
        </thead>
        <tbody>
          ${
            logs.length === 0
              ? `<tr><td colspan="6" class="empty">No audit events yet</td></tr>`
              : logs
                  .map(
                    (l) => `
            <tr>
              <td class="nowrap mono meta">${escapeHtml(new Date(l.createdAt).toLocaleString())}</td>
              <td>
                <div>${escapeHtml(l.actorEmail ?? '—')}</div>
                <div class="meta">${escapeHtml(l.actorRole ?? 'no account')}</div>
                <div class="mono meta">${escapeHtml(l.ip ?? '')}</div>
              </td>
              <td><code>${escapeHtml(l.action)}</code></td>
              <td>${l.subjectType ? `${escapeHtml(l.subjectType)}<br><code>${escapeHtml(l.subjectId ?? '')}</code>` : '—'}</td>
              <td>${escapeHtml(l.reason ?? '—')}</td>
              <td><pre class="snip" style="max-width: 320px;">${escapeHtml(JSON.stringify(l.payload))}</pre></td>
            </tr>
          `,
                  )
                  .join('')
          }
        </tbody>
      </table>
    </div>`,
        }),
      );
    });
  };
}

/** The console login: a plain form, no script (Audit 06). `error` is escaped. */
function renderLoginPage(error?: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sign in — Flyleaf admin</title>
  <style>${ADMIN_CSS}
    body { display: flex; align-items: center; justify-content: center; padding: 24px 16px; }
    .panel { width: 100%; max-width: 400px; display: flex; flex-direction: column; gap: 24px; padding: 32px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; }
    .totp-input { font-family: "JetBrains Mono", ui-monospace, monospace; font-variant-numeric: tabular-nums; letter-spacing: .2em; }
  </style>
</head>
<body>
  <main class="panel">
    <div class="stack" style="gap: 8px;">
      <div class="brand" style="padding: 0;">Flyleaf <span>admin</span></div>
      <h1>Sign in</h1>
      <p class="sub">Your administrator email, password and the 6-digit code from your authenticator app</p>
    </div>

    ${error ? `<div class="notice critical" role="alert">${escapeHtml(error)}</div>` : ''}

    <form method="POST" action="/admin/login" class="stack">
      <label for="email">Email
        <input type="email" id="email" name="email" required placeholder="admin@flyleaf.app" autofocus autocomplete="username" />
      </label>

      <label for="password">Password
        <input type="password" id="password" name="password" required autocomplete="current-password" />
      </label>

      <label for="totp_code">Authenticator or backup code
        <input type="text" id="totp_code" name="totp_code" class="totp-input" required placeholder="123456" maxlength="10" autocomplete="one-time-code" />
      </label>

      <button type="submit" class="primary block">Sign in</button>
    </form>

    <p class="meta">Two-factor sign in. Every action here is kept in the audit trail</p>
  </main>
</body>
</html>`;
}
