// The emailed verify and reset links, for a phone without the app or where
// App Links are not verified (D-07-1, PRD §6.5, §6.6), and the /.well-known
// files that let Android and iOS open those links in the app instead.
//
// A GET never spends a token: mail scanners and link previews fetch URLs.
// The verify page is a button that POSTs; the reset page is a form that POSTs.
// Each page also offers the same link in the app (flyleaf://…).
//
// Headers: Part 06's per-response nonce CSP (script only from the nonce'd
// block), Referrer-Policy no-referrer (the token is in the URL), no-store.

import { randomBytes } from 'node:crypto';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';

import { escapeHtml } from '../admin/html.js';
import { ApiError } from '../http.js';
import type { AppLinks } from '../platform/index.js';
import { passwordSchema, type IdentityService } from './index.js';

const APP_SCHEME = 'flyleaf://';
/** Tokens are 43 characters (32 bytes, base64url); anything far longer is not one. */
const MAX_TOKEN = 256;

export function linkPageCsp(nonce: string): string {
  return (
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
    "form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

function sendPage(reply: FastifyReply, status: number, title: string, body: (nonce: string) => string) {
  const nonce = randomBytes(16).toString('base64');
  return reply
    .status(status)
    .header('content-security-policy', linkPageCsp(nonce))
    .header('referrer-policy', 'no-referrer')
    .header('cache-control', 'no-store')
    .header('x-robots-tag', 'noindex')
    .type('text/html; charset=utf-8')
    .send(`<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>${escapeHtml(title)} · Flyleaf</title>
<style>
  :root { color-scheme: light dark; --ground: #FAF7F2; --ink: #1F1B16; --muted: #6E747C; --accent: #7A4E2D; --line: #E4DED4; }
  @media (prefers-color-scheme: dark) { :root { --ground: #16181B; --ink: #ECE7DF; --muted: #868D96; --accent: #D9A574; --line: #2C3036; } }
  body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; margin: 0 auto; padding: 3rem 1rem; }
  h1 { font: 600 1.5rem/1.3 Georgia, serif; margin: 0 0 .75rem; }
  p { margin: 0 0 1rem; }
  .muted { color: var(--muted); font-size: .9rem; }
  .error { color: #B3261E; }
  label { display: block; margin: 0 0 .25rem; font-size: .9rem; }
  input { box-sizing: border-box; width: 100%; padding: .7rem; margin: 0 0 1rem; font: inherit; color: var(--ink); background: transparent; border: 1px solid var(--line); border-radius: 8px; }
  button, .app { display: block; box-sizing: border-box; width: 100%; padding: .8rem; margin: 0 0 .75rem; border-radius: 8px; font: 600 1rem system-ui, sans-serif; text-align: center; text-decoration: none; cursor: pointer; }
  button { border: 0; background: var(--accent); color: var(--ground); }
  button[disabled] { opacity: .6; }
  .app { border: 1px solid var(--line); color: var(--accent); }
</style>
</head>
<body><main>
${body(nonce)}
</main></body>
</html>`);
}

function appLink(path: string, token?: string): string {
  const href = token ? `${APP_SCHEME}${path}?token=${encodeURIComponent(token)}` : `${APP_SCHEME}${path}`;
  return `<a class="app" href="${escapeHtml(href)}">Open in the app</a>`;
}

function queryToken(query: unknown): string | null {
  const t = (query as { token?: unknown } | null)?.token;
  return typeof t === 'string' && t.length > 0 && t.length <= MAX_TOKEN ? t : null;
}

function bodyField(body: unknown, name: string): string {
  const v = (body as Record<string, unknown> | null)?.[name];
  return typeof v === 'string' ? v : '';
}

const incompleteLink = (reply: FastifyReply) =>
  sendPage(reply, 400, 'Link incomplete', () => `<h1>This link is incomplete</h1>
<p>Copy the whole link from the email, or open the app and ask for a new one.</p>
${appLink('')}`);

function isExpired(err: unknown): boolean {
  return err instanceof ApiError && err.code === 'invalid_or_expired_token';
}

// ---------------------------------------------------------------- verify

function verifyForm(token: string) {
  return `<h1>Confirm your email</h1>
<p>Tap the button to finish verifying your Flyleaf account.</p>
<form method="post" action="/verify-email">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<button type="submit">Verify my email</button>
</form>
${appLink('verify-email', token)}`;
}

// ---------------------------------------------------------------- reset

function resetForm(token: string, nonce: string, error?: string) {
  return `<h1>Choose a new password</h1>
${error ? `<p class="error" role="alert">${escapeHtml(error)}</p>` : ''}
<form method="post" action="/reset-password" id="reset">
<input type="hidden" name="token" value="${escapeHtml(token)}">
<label for="newPassword">New password (at least 10 characters)</label>
<input id="newPassword" name="newPassword" type="password" autocomplete="new-password" minlength="10" maxlength="1024" required>
<label for="confirmPassword">Type it again</label>
<input id="confirmPassword" name="confirmPassword" type="password" autocomplete="new-password" minlength="10" maxlength="1024" required>
<button type="submit">Change password</button>
</form>
${appLink('reset-password', token)}
<p class="muted">Changing it signs you out on every device.</p>
<script nonce="${escapeHtml(nonce)}">
  var form = document.getElementById('reset');
  form.addEventListener('submit', function (e) {
    var a = form.elements.newPassword, b = form.elements.confirmPassword;
    if (a.value !== b.value) { e.preventDefault(); b.setCustomValidity('The passwords do not match.'); b.reportValidity(); return; }
    form.querySelector('button').disabled = true;
  });
  form.elements.confirmPassword.addEventListener('input', function () { this.setCustomValidity(''); });
</script>`;
}

const resetFields = z.object({ token: z.string().min(1).max(MAX_TOKEN), newPassword: passwordSchema });

export function identityLinkPages(service: IdentityService, appLinks: AppLinks) {
  return async (app: FastifyInstance) => {
    // HTML forms post urlencoded; only these routes accept it (this plugin's scope).
    app.addContentTypeParser(
      'application/x-www-form-urlencoded',
      { parseAs: 'string', bodyLimit: 8192 },
      (_req, body, done) => done(null, Object.fromEntries(new URLSearchParams(body as string))),
    );

    app.get('/verify-email', { schema: { hide: true } }, async (req, reply) => {
      const token = queryToken(req.query);
      if (!token) return incompleteLink(reply);
      return sendPage(reply, 200, 'Verify your email', () => verifyForm(token));
    });

    app.post('/verify-email', { schema: { hide: true } }, async (req, reply) => {
      const token = bodyField(req.body, 'token');
      if (!token || token.length > MAX_TOKEN) return incompleteLink(reply);
      try {
        await service.verifyEmail(token);
      } catch (err) {
        if (!isExpired(err)) throw err;
        return sendPage(reply, 400, 'Link expired', () => `<h1>This link has expired</h1>
<p>It was already used, or it is more than a day old. Open the app to send a new one.</p>
${appLink('')}`);
      }
      return sendPage(reply, 200, 'Email verified', () => `<h1>Email verified</h1>
<p>Your email address is confirmed. You can post reviews, comment and follow readers.</p>
${appLink('')}`);
    });

    app.get('/reset-password', { schema: { hide: true } }, async (req, reply) => {
      const token = queryToken(req.query);
      if (!token) return incompleteLink(reply);
      return sendPage(reply, 200, 'New password', (nonce) => resetForm(token, nonce));
    });

    app.post('/reset-password', { schema: { hide: true } }, async (req, reply) => {
      const token = bodyField(req.body, 'token');
      const newPassword = bodyField(req.body, 'newPassword');
      if (!token || token.length > MAX_TOKEN) return incompleteLink(reply);
      // Never echoed back: a re-rendered form is empty.
      if (newPassword !== bodyField(req.body, 'confirmPassword')) {
        return sendPage(reply, 422, 'New password', (nonce) => resetForm(token, nonce, 'The passwords do not match.'));
      }
      const parsed = resetFields.safeParse({ token, newPassword });
      if (!parsed.success) {
        const message = parsed.error.issues[0]?.message ?? 'Choose a different password.';
        return sendPage(reply, 422, 'New password', (nonce) => resetForm(token, nonce, message));
      }
      try {
        await service.resetPassword(parsed.data.token, parsed.data.newPassword);
      } catch (err) {
        if (!isExpired(err)) throw err;
        return sendPage(reply, 400, 'Link expired', () => `<h1>This link has expired</h1>
<p>Reset links work once, for an hour. Ask for a new one from the sign-in screen.</p>
<a class="app" href="${APP_SCHEME}auth?mode=forgot">Send a new link in the app</a>`);
      }
      return sendPage(reply, 200, 'Password changed', () => `<h1>Password changed</h1>
<p>You have been signed out on every device. Sign in again with your new password.</p>
<a class="app" href="${APP_SCHEME}auth?mode=login">Sign in in the app</a>`);
    });

    // ------------------------------------------------------------ well-known
    // Served as JSON at these exact paths with no redirect, as both platforms
    // require. 404 while unconfigured, so a half-set deploy fails visibly.

    app.get('/.well-known/assetlinks.json', { schema: { hide: true } }, async (_req, reply) => {
      if (!appLinks.android) throw ApiError.notFound();
      return reply.header('cache-control', 'public, max-age=3600').send([
        {
          relation: ['delegate_permission/common.handle_all_urls'],
          target: {
            namespace: 'android_app',
            package_name: appLinks.android.packageName,
            sha256_cert_fingerprints: appLinks.android.sha256Fingerprints,
          },
        },
      ]);
    });

    app.get('/.well-known/apple-app-site-association', { schema: { hide: true } }, async (_req, reply) => {
      if (!appLinks.ios) throw ApiError.notFound();
      return reply
        .header('cache-control', 'public, max-age=3600')
        .type('application/json')
        .send({
          applinks: {
            details: [
              {
                appIDs: [appLinks.ios.appId],
                components: [{ '/': '/verify-email' }, { '/': '/reset-password' }],
              },
            ],
          },
        });
    });
  };
}
