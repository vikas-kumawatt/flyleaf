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
