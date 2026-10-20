// https links into the app (owner decision on SO-5x, 13 Oct 2026). The
// public pages' addresses are not app routes, so an incoming link is
// rewritten before the router sees it:
//
//   /@username       → /u/username       (resolved to the account by the API)
//   /u/username      → unchanged          (app/u/[username]/index.tsx)
//   /book/:id        → /work/:id
//
// Everything else (verify-email, reset-password, shelf links, flyleaf://
// routes) passes through untouched.
//
// The hosts are the https hosts of app.json's intent filters (flyleaf.app and
// the beta server), which app.config.ts copies into extra.appLinkHosts.

export const DEFAULT_LINK_HOSTS: readonly string[] = ['flyleaf.app', 'www.flyleaf.app'];

/** The hosts to rewrite: extra.appLinkHosts from the app config, plus the defaults. */
export function linkHostsFrom(extra: unknown): string[] {
  const listed = (extra as { appLinkHosts?: unknown } | null | undefined)?.appLinkHosts;
  const hosts = Array.isArray(listed) ? listed.filter((h): h is string => typeof h === 'string').map((h) => h.toLowerCase()) : [];
  return [...new Set([...DEFAULT_LINK_HOSTS, ...hosts])];
}

/** The app route for an incoming URL or path; the input itself when nothing applies. */
export function appPathFor(input: string, hosts: readonly string[] = DEFAULT_LINK_HOSTS): string {
  let path = input;
  const m = /^https?:\/\/([^/?#]+)(.*)$/i.exec(input);
  if (m) {
    if (!hosts.includes(m[1]!.toLowerCase())) return input;
    path = m[2] || '/';
  }
  if (!path.startsWith('/')) return input;
  const [pathname, rest = ''] = splitPath(path);
  const decoded = safeDecode(pathname);
  if (decoded === null) return input;

  const at = /^\/@([^/]+)\/?$/.exec(decoded);
  if (at) return `/u/${encodeURIComponent(at[1]!)}${rest}`;
  const book = /^\/book\/([^/]+)\/?$/.exec(decoded);
  if (book) return `/work/${encodeURIComponent(book[1]!)}${rest}`;
  return input;
}

function splitPath(path: string): [string, string] {
  const i = path.search(/[?#]/);
  return i === -1 ? [path, ''] : [path.slice(0, i), path.slice(i)];
}

function safeDecode(s: string): string | null {
  try {
    return decodeURIComponent(s);
  } catch {
    return null;
  }
}

/**
 * An incoming link with every query parameter that decodeURIComponent cannot
 * decode removed (npm audit, GHSA-vcc3-ghjq-m6fr). expo-router parses the
 * query of each incoming link with query-string, whose decode-uri-component
 * (<= 0.4.2) falls back to an exponential-time decoder on malformed
 * percent-encoding: a link anyone can send would hang the app. The only
 * patched release (0.5.0) is ESM-only, which query-string 7 cannot require,
 * and the expo-router that drops it is SDK 58. Well-formed parameters never
 * reach the fallback and pass through unchanged.
 */
export function withoutMalformedQuery(input: string): string {
  const q = input.indexOf('?');
  if (q === -1) return input;
  const h = input.indexOf('#', q);
  const query = input.slice(q + 1, h === -1 ? undefined : h);
  const kept = query.split('&').filter((param) => {
    // As query-string reads it: '+' is a space, key and value split on the first '='.
    const plain = param.replace(/\+/g, ' ');
    const eq = plain.indexOf('=');
    try {
      decodeURIComponent(eq === -1 ? plain : plain.slice(0, eq));
      if (eq !== -1) decodeURIComponent(plain.slice(eq + 1));
      return true;
    } catch {
      return false;
    }
  });
  if (kept.length === query.split('&').length) return input;
  const head = input.slice(0, q);
  const tail = h === -1 ? '' : input.slice(h);
  return kept.length > 0 ? `${head}?${kept.join('&')}${tail}` : `${head}${tail}`;
}
