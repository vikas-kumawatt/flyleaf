// Admin console and authentication routes (FN-90, FN-93, PRD §27.5, Architecture §3.7).
//
// Provides:
// 1. REST endpoints for admin login (with mandatory 2FA), session inspection, 2FA setup, and audit log.
// 2. Server-rendered HTML web views for login, audit trail, and session management.

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Db } from '../platform/index.js';
import { requireAdmin, requireModerator } from '../http.js';
import {
  loginAdmin,
  setup2fa,
  verify2fa,
  getAdminAuditLog,
  logAdminAction,
} from './auth.js';
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

export function adminAuthRoutes(db: Db) {
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
        return loginAdmin(db, {
          email: body.email,
          password: body.password,
          totpCode: body.totp_code,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
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
        const result = await setup2fa(db, admin.id);
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
        return verify2fa(db, admin.id, body.code);
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

    app.get('/admin/login', async (req, reply) => {
      if (req.admin) {
        return reply.redirect('/admin/merges');
      }

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Flyleaf Admin — Login</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: rgba(22, 27, 34, 0.75);
      --border: rgba(255, 255, 255, 0.1);
      --text: #f0f6fc;
      --text-muted: #8b949e;
      --accent: #d4a373;
      --accent-hover: #faedcd;
      --error: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 0%, #1a1e29 0%, var(--bg) 80%);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .login-card {
      background: var(--card-bg);
      backdrop-filter: blur(16px);
      -webkit-backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 16px;
      padding: 36px;
      width: 100%;
      max-width: 420px;
      box-shadow: 0 20px 40px rgba(0, 0, 0, 0.5);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      margin-bottom: 24px;
    }
    .brand-title {
      font-size: 20px;
      font-weight: 700;
      letter-spacing: -0.5px;
    }
    .badge-2fa {
      background: rgba(212, 163, 115, 0.15);
      color: var(--accent);
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
    }
    h1 {
      font-size: 24px;
      margin-bottom: 8px;
      font-weight: 600;
    }
    p.subtitle {
      color: var(--text-muted);
      font-size: 13px;
      margin-bottom: 28px;
      line-height: 1.4;
    }
    .form-group {
      margin-bottom: 18px;
    }
    label {
      display: block;
      font-size: 13px;
      font-weight: 500;
      margin-bottom: 6px;
      color: var(--text);
    }
    input {
      width: 100%;
      background: rgba(13, 17, 23, 0.8);
      border: 1px solid var(--border);
      border-radius: 8px;
      padding: 12px 14px;
      color: var(--text);
      font-size: 14px;
      outline: none;
      transition: border-color 0.2s;
    }
    input:focus {
      border-color: var(--accent);
    }
    .totp-input {
      font-family: monospace;
      letter-spacing: 4px;
      font-size: 18px;
      text-align: center;
    }
    .btn-login {
      width: 100%;
      background: var(--accent);
      color: #090a0f;
      border: none;
      border-radius: 8px;
      padding: 12px;
      font-size: 15px;
      font-weight: 600;
      cursor: pointer;
      margin-top: 10px;
      transition: background 0.2s, transform 0.1s;
    }
    .btn-login:hover {
      background: var(--accent-hover);
    }
    .btn-login:active {
      transform: scale(0.99);
    }
    .error-msg {
      background: rgba(248, 81, 73, 0.15);
      border: 1px solid var(--error);
      color: var(--error);
      padding: 10px 14px;
      border-radius: 8px;
      font-size: 13px;
      margin-bottom: 18px;
      display: none;
    }
    .footer {
      margin-top: 24px;
      text-align: center;
      font-size: 12px;
      color: var(--text-muted);
    }
  </style>
</head>
<body>
  <div class="login-card">
    <div class="brand">
      <span class="brand-title">Flyleaf Console</span>
      <span class="badge-2fa">2FA Protected</span>
    </div>
    <h1>Sign In</h1>
    <p class="subtitle">Enter your administrator credentials and 6-digit authenticator code (PRD §27.5).</p>

    <div id="error-box" class="error-msg"></div>

    <form id="login-form" onsubmit="handleLogin(event)">
      <div class="form-group">
        <label for="email">Admin Email</label>
        <input type="email" id="email" name="email" required placeholder="admin@flyleaf.app" autofocus autocomplete="username" />
      </div>

      <div class="form-group">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" required placeholder="••••••••••••" autocomplete="current-password" />
      </div>

      <div class="form-group">
        <label for="totp_code">Authenticator Code / Backup Code</label>
        <input type="text" id="totp_code" name="totp_code" class="totp-input" required placeholder="123456" maxlength="10" autocomplete="one-time-code" />
      </div>

      <button type="submit" class="btn-login" id="submit-btn">Verify & Sign In</button>
    </form>

    <div class="footer">
      Isolated authentication layer · Actions audit-logged
    </div>
  </div>

  <script>
    async function handleLogin(e) {
      e.preventDefault();
      const errBox = document.getElementById('error-box');
      const btn = document.getElementById('submit-btn');
      errBox.style.display = 'none';
      btn.disabled = true;
      btn.innerText = 'Verifying...';

      const email = document.getElementById('email').value.trim();
      const password = document.getElementById('password').value;
      const totp_code = document.getElementById('totp_code').value.trim();

      try {
        const res = await fetch('/v1/admin/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password, totp_code })
        });

        const data = await res.json();
        if (res.ok) {
          // Set session cookie valid for /admin routes
          document.cookie = 'flyleaf_admin_session=' + encodeURIComponent(data.token) + '; path=/admin; max-age=7200; SameSite=Lax';
          location.href = '/admin/merges';
        } else {
          errBox.innerText = data.error?.message || 'Login failed.';
          errBox.style.display = 'block';
          btn.disabled = false;
          btn.innerText = 'Verify & Sign In';
        }
      } catch (err) {
        errBox.innerText = 'Network error: ' + err.message;
        errBox.style.display = 'block';
        btn.disabled = false;
        btn.innerText = 'Verify & Sign In';
      }
    }
  </script>
</body>
</html>`;

      return reply.type('text/html').send(html);
    });

    app.post('/admin/logout', async (req, reply) => {
      if (req.admin) {
        await logAdminAction(db, {
          actorId: req.admin.id,
          action: 'admin.logout',
          reason: 'Explicit admin console sign out',
        }).catch(() => {});
      }
      reply.header('Set-Cookie', 'flyleaf_admin_session=; Path=/admin; Max-Age=0; HttpOnly; SameSite=Lax');
      return reply.redirect('/admin/login');
    });

    app.get('/admin/audit-log', async (req, reply) => {
      if (!req.admin) {
        return reply.redirect('/admin/login');
      }

      const logs = await getAdminAuditLog(db, { limit: 100 });

      const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Flyleaf Admin — Audit Log (FN-93)</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: rgba(22, 27, 34, 0.7);
      --border: rgba(255, 255, 255, 0.1);
      --text: #f0f6fc;
      --text-muted: #8b949e;
      --accent: #d4a373;
      --danger: #f85149;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background: radial-gradient(circle at 50% 0%, #1a1e29 0%, var(--bg) 80%);
      color: var(--text);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      padding: 32px 24px;
      min-height: 100vh;
    }
    .container { max-width: 1200px; margin: 0 auto; }
    header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 28px;
      padding-bottom: 20px;
      border-bottom: 1px solid var(--border);
    }
    .nav { display: flex; gap: 16px; align-items: center; }
    .nav a {
      color: var(--text-muted);
      text-decoration: none;
      font-size: 14px;
      font-weight: 500;
      transition: color 0.2s;
    }
    .nav a:hover, .nav a.active { color: var(--accent); }
    .user-pill {
      background: rgba(255, 255, 255, 0.05);
      border: 1px solid var(--border);
      padding: 6px 14px;
      border-radius: 20px;
      font-size: 13px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .role-badge {
      background: var(--accent);
      color: #090a0f;
      font-size: 10px;
      font-weight: 700;
      padding: 2px 6px;
      border-radius: 4px;
      text-transform: uppercase;
    }
    .btn-logout {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--text-muted);
      padding: 6px 12px;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
    }
    .btn-logout:hover { color: var(--danger); border-color: var(--danger); }
    .card {
      background: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 24px;
      overflow-x: auto;
    }
    table { width: 100%; border-collapse: collapse; font-size: 13px; }
    th { text-align: left; padding: 12px 14px; color: var(--text-muted); border-bottom: 1px solid var(--border); }
    td { padding: 12px 14px; border-bottom: 1px solid rgba(255, 255, 255, 0.05); vertical-align: top; }
    code { font-family: monospace; background: rgba(0, 0, 0, 0.3); padding: 2px 6px; border-radius: 4px; }
    .action-tag {
      display: inline-block;
      padding: 3px 8px;
      border-radius: 6px;
      font-size: 11px;
      font-weight: 600;
      background: rgba(212, 163, 115, 0.15);
      color: var(--accent);
    }
  </style>
</head>
<body>
  <div class="container">
    <header>
      <div>
        <h1 style="font-size: 24px; margin-bottom: 4px;">Flyleaf Admin Audit Trail</h1>
        <p style="color: var(--text-muted); font-size: 13px;">FN-93: Non-negotiable audit log across all administrative actions.</p>
      </div>
      <div class="nav">
        <a href="/admin/merges">Merge Review</a>
        <a href="/admin/catalog/maturity">Maturity</a>
        <a href="/admin/ingest">Ingestion</a>
        <a href="/admin/audit-log" class="active">Audit Trail</a>
        <div class="user-pill">
          <span>${escapeHtml(req.admin.email)}</span>
          <span class="role-badge">${req.admin.role}</span>
        </div>
        <form method="POST" action="/admin/logout">
          <button type="submit" class="btn-logout">Sign Out</button>
        </form>
      </div>
    </header>

    <div class="card">
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
              ? `<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 32px;">No audit events recorded yet.</td></tr>`
              : logs
                  .map(
                    (l) => `
            <tr>
              <td style="white-space: nowrap; color: var(--text-muted);">${new Date(l.createdAt).toLocaleString()}</td>
              <td>
                <div style="font-weight: 500;">${escapeHtml(l.actorEmail)}</div>
                <div style="font-size: 11px; color: var(--text-muted);">${l.actorRole}</div>
              </td>
              <td><span class="action-tag">${escapeHtml(l.action)}</span></td>
              <td>${l.subjectType ? `${escapeHtml(l.subjectType)} <br><code style="font-size: 10px;">${l.subjectId ?? ''}</code>` : '—'}</td>
              <td>${escapeHtml(l.reason ?? '—')}</td>
              <td><pre style="font-size: 11px; max-width: 320px; overflow: hidden; text-overflow: ellipsis; white-space: pre-wrap;">${escapeHtml(JSON.stringify(l.payload))}</pre></td>
            </tr>
          `,
                  )
                  .join('')
          }
        </tbody>
      </table>
    </div>
  </div>
</body>
</html>`;

      return reply.type('text/html').send(html);
    });
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
