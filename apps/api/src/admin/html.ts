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
