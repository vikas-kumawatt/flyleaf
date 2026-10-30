// What every server-rendered admin page shares (Audit 06, PRD §27.5, §42 #9):
// escaping, a per-response script nonce, and the session cookie.
//
// Script runs only from <script nonce="…"> blocks; no inline event handlers.
// Style attributes are everywhere in these pages, so style-src keeps
// 'unsafe-inline': CSS cannot run script, and every value is escaped anyway.

import { randomBytes } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';

import { ADMIN_SESSION_COOKIE } from '../http.js';
import { config } from '../platform/index.js';

/** Escapes text for an HTML text node or a quoted attribute value. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function adminCsp(nonce: string): string {
  return (
    `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'unsafe-inline'; ` +
    "img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
  );
}

/** Renders a page with a fresh nonce, sends it with the matching CSP, never cached. */
export function sendAdminHtml(reply: FastifyReply, render: (nonce: string) => string, status = 200) {
  const nonce = randomBytes(16).toString('base64');
  return reply
    .status(status)
    .header('content-security-policy', adminCsp(nonce))
    .header('cache-control', 'no-store')
    .type('text/html; charset=utf-8')
    .send(render(nonce));
}

/** Same lifetime as the admin JWT. */
const SESSION_MAX_AGE = 2 * 60 * 60;

/**
 * Secure everywhere except plain http on localhost outside production, where
 * a browser would drop a Secure cookie and local development could not log in.
 */
function secureCookie(req: FastifyRequest): boolean {
  if (config.env === 'production') return true;
  const local = ['localhost', '127.0.0.1', '[::1]', '::1'].includes(req.hostname);
  return !(req.protocol === 'http' && local);
}

/**
 * One cookie per admin path: `/admin` for the console pages, `/v1/admin` for
 * the API their buttons call. Nothing else ever receives it. HttpOnly, so page
 * script can never read it; SameSite=Strict, so no other site can send it.
 */
function sessionCookies(req: FastifyRequest, value: string, maxAge: number): string[] {
  const secure = secureCookie(req) ? '; Secure' : '';
  return ['/admin', '/v1/admin'].map(
    (path) => `${ADMIN_SESSION_COOKIE}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly${secure}; SameSite=Strict`,
  );
}

export function setAdminSession(reply: FastifyReply, req: FastifyRequest, token: string) {
  reply.header('set-cookie', sessionCookies(req, encodeURIComponent(token), SESSION_MAX_AGE));
}

export function clearAdminSession(reply: FastifyReply, req: FastifyRequest) {
  reply.header('set-cookie', sessionCookies(req, '', 0));
}

// ---------------------------------------------------------------- Look
// One stylesheet for every console page: graphite surfaces, hairlines, one
// accent, Instrument Sans with a mono for ids and timestamps. The CSP has no
// font-src, so the faces come from the reader's machine or the fallbacks.

export const ADMIN_CSS = `
  :root {
    color-scheme: dark;
    --deep: #0f0f10; --bg: #141415; --card: #19191B; --raised: #232325;
    --ink: #EDEDED; --ink2: #A1A1A6; --muted: #85858B; --line: rgba(237, 237, 237, .08);
    --accent: #8DA6EE; --on-accent: #141415; --positive: #4CC38A; --warning: #E0AF45; --critical: #E5484D;
    --ease: cubic-bezier(0.22, 1, 0.36, 1);
  }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { background: var(--bg); color: var(--ink); font: 14px/1.5 "Instrument Sans", system-ui, -apple-system, "Segoe UI", sans-serif; min-height: 100vh; }
  a { color: var(--accent); text-decoration: none; }
  a:hover { text-decoration: underline; text-underline-offset: 2px; }
  :focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  code, pre, .mono { font-family: "JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
  code { color: var(--ink2); }
  pre { white-space: pre-wrap; word-break: break-word; color: var(--ink2); }
  strong { font-weight: 500; color: var(--ink); }

  .shell { display: grid; grid-template-columns: 240px minmax(0, 1fr); min-height: 100vh; }
  .sidebar { position: sticky; top: 0; height: 100vh; display: flex; flex-direction: column; gap: 24px; padding: 16px 12px; background: var(--deep); border-right: 1px solid var(--line); }
  .brand { display: flex; align-items: baseline; gap: 8px; padding: 4px 8px; font-size: 16px; font-weight: 500; color: var(--ink); }
  .brand span { font-size: 13px; font-weight: 400; color: var(--muted); }
  .nav { display: flex; flex-direction: column; gap: 2px; }
  .nav a { display: flex; align-items: center; height: 32px; padding: 0 8px; border: 1px solid transparent; border-radius: 8px; color: var(--ink2); transition: color 140ms var(--ease), background-color 140ms var(--ease), border-color 140ms var(--ease); }
  .nav a:hover { background: var(--card); color: var(--ink); text-decoration: none; }
  .nav a[aria-current="page"] { background: var(--raised); border-color: var(--line); color: var(--ink); }
  .account { margin-top: auto; display: flex; flex-direction: column; gap: 8px; padding: 12px 8px 0; border-top: 1px solid var(--line); font-size: 13px; }
  .account .email { color: var(--ink2); overflow-wrap: anywhere; }
  .account .role { color: var(--muted); }
  .main { min-width: 0; padding: 32px; }
  .content { max-width: 1440px; margin: 0 auto; display: flex; flex-direction: column; gap: 24px; }

  h1 { font-size: 28px; line-height: 1.15; font-weight: 500; }
  h2 { font-size: 16px; line-height: 1.4; font-weight: 500; }
  h3 { font-size: 15px; line-height: 1.4; font-weight: 500; }
  .page-head { display: flex; justify-content: space-between; align-items: flex-end; gap: 16px; flex-wrap: wrap; }
  .page-head .sub { margin-top: 4px; }
  .sub, .meta { color: var(--muted); font-size: 13px; }
  .stack { display: flex; flex-direction: column; gap: 16px; }
  .row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .between { display: flex; justify-content: space-between; align-items: center; gap: 12px; flex-wrap: wrap; }

  .card { background: var(--card); border: 1px solid var(--line); border-radius: 12px; padding: 20px; }
  .card.flush { padding: 0; overflow: hidden; }
  .card-head { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 16px 20px; border-bottom: 1px solid var(--line); }
  .card > h2 { margin-bottom: 12px; }
  .table-wrap { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 13px; }
  th { text-align: left; font-weight: 400; color: var(--muted); padding: 8px 12px; border-bottom: 1px solid var(--line); white-space: nowrap; }
  td { padding: 12px; border-bottom: 1px solid var(--line); vertical-align: top; }
  tbody tr:last-child td { border-bottom: 0; }
  tbody tr:hover td { background: rgba(237, 237, 237, .02); }
  th.num, td.num { text-align: right; font-variant-numeric: tabular-nums; }
  td.nowrap { white-space: nowrap; }
  .empty { text-align: center; color: var(--muted); padding: 40px 12px; }
  .snip { max-width: 420px; white-space: pre-wrap; word-break: break-word; }
  dl { display: grid; grid-template-columns: 180px 1fr; gap: 4px 12px; font-size: 13px; }
  dt { color: var(--muted); }
  dd { white-space: pre-wrap; word-break: break-word; }

  button, .btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; height: 36px; padding: 0 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--raised); color: var(--ink); font: 500 13px/1 "Instrument Sans", system-ui, sans-serif; cursor: pointer; white-space: nowrap; transition: color 140ms var(--ease), background-color 140ms var(--ease), border-color 140ms var(--ease), opacity 140ms var(--ease); }
  button:hover:not(:disabled), .btn:hover { border-color: rgba(237, 237, 237, .16); text-decoration: none; }
  button.primary { background: var(--ink); color: var(--bg); border-color: transparent; }
  button.primary:hover:not(:disabled) { opacity: .9; }
  button.danger { background: transparent; color: var(--critical); }
  button.danger:hover:not(:disabled) { border-color: var(--critical); }
  button.ghost { background: transparent; border-color: transparent; color: var(--ink2); }
  button.ghost:hover:not(:disabled) { color: var(--ink); border-color: var(--line); }
  button.sm { height: 28px; padding: 0 10px; font-size: 12px; }
  button.block { width: 100%; }
  button:disabled { opacity: .4; cursor: not-allowed; }

  label { display: flex; flex-direction: column; gap: 4px; font-size: 13px; color: var(--ink2); }
  input, select, textarea { width: 100%; padding: 8px 12px; border: 1px solid var(--line); border-radius: 8px; background: var(--raised); color: var(--ink); font: inherit; transition: border-color 140ms var(--ease); }
  input, select { height: 36px; }
  input:focus, select:focus, textarea:focus { outline: none; border-color: var(--accent); }
  textarea { resize: vertical; }

  .chips { display: flex; gap: 4px; flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; height: 32px; padding: 0 12px; border: 1px solid transparent; border-radius: 8px; color: var(--ink2); font-size: 13px; transition: color 140ms var(--ease), background-color 140ms var(--ease), border-color 140ms var(--ease); }
  .chip:hover { background: var(--card); color: var(--ink); text-decoration: none; }
  .chip.active { background: var(--raised); border-color: var(--line); color: var(--ink); }
  .status { display: inline-flex; align-items: center; gap: 6px; font-size: 13px; color: var(--ink2); white-space: nowrap; }
  .status::before { content: ""; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--muted); }
  .status.positive::before { background: var(--positive); }
  .status.warning::before { background: var(--warning); }
  .status.critical::before { background: var(--critical); }
  .status.accent::before { background: var(--accent); }
  .tag { font-size: 12px; color: var(--muted); }
  .notice { padding: 12px 16px; border: 1px solid var(--line); border-radius: 8px; background: var(--card); color: var(--ink2); font-size: 13px; }
  .notice.critical { color: var(--critical); border-color: rgba(229, 72, 77, .32); }

  .kpis { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 12px; }
  .kpi .label { font-size: 13px; color: var(--muted); }
  .kpi .value { margin-top: 8px; font-size: 28px; line-height: 1.1; font-weight: 500; font-variant-numeric: tabular-nums; }
  .kpi .note { margin-top: 8px; font-size: 12px; color: var(--muted); }

  .modal { position: fixed; inset: 0; z-index: 100; align-items: center; justify-content: center; padding: 16px; background: rgba(0, 0, 0, .6); }
  .modal-panel { width: 100%; max-width: 480px; display: flex; flex-direction: column; gap: 16px; padding: 24px; background: var(--card); border: 1px solid var(--line); border-radius: 16px; box-shadow: 0 8px 24px rgba(0, 0, 0, .4); }

  @media (max-width: 800px) {
    .shell { grid-template-columns: 1fr; }
    .sidebar { position: static; height: auto; gap: 12px; border-right: 0; border-bottom: 1px solid var(--line); }
    .nav { flex-direction: row; flex-wrap: wrap; }
    .account { flex-direction: row; align-items: center; justify-content: space-between; margin-top: 0; }
    .main { padding: 24px 16px; }
  }
`;

const NAV = [
  { path: '/admin/reports', label: 'Reports' },
  { path: '/admin/appeals', label: 'Appeals' },
  { path: '/admin/merges', label: 'Merge review' },
  { path: '/admin/catalog/maturity', label: 'Maturity' },
  { path: '/admin/ingest', label: 'Ingestion' },
  { path: '/admin/audit-log', label: 'Audit trail' },
];

/**
 * A whole console page: the sidebar, the account and sign out, and `body` in
 * the content column. `body` is trusted markup the caller has escaped,
 * nonced script blocks included.
 */
export function adminPage(opts: {
  title: string;
  path: string;
  admin: { email: string; role: string };
  body: string;
  css?: string;
}): string {
  const { title, path, admin, body, css } = opts;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${escapeHtml(title)} — Flyleaf admin</title>
  <style>${ADMIN_CSS}${css ?? ''}</style>
</head>
<body>
  <div class="shell">
    <aside class="sidebar">
      <div class="brand">Flyleaf <span>admin</span></div>
      <nav class="nav" aria-label="Console">
        ${NAV.map(
          (l) => `<a href="${escapeHtml(l.path)}"${path === l.path ? ' aria-current="page"' : ''}>${escapeHtml(l.label)}</a>`,
        ).join('\n        ')}
      </nav>
      <div class="account">
        <div>
          <div class="email">${escapeHtml(admin.email)}</div>
          <div class="role">${escapeHtml(admin.role)}</div>
        </div>
        <form method="POST" action="/admin/logout">
          <button type="submit" class="ghost sm">Sign out</button>
        </form>
      </div>
    </aside>
    <main class="main"><div class="content">
${body}
    </div></main>
  </div>
</body>
</html>`;
}
