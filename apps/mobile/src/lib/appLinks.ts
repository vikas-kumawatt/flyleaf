// https links into the app (owner decision on SO-5x, 13 Oct 2026). The
// public pages' addresses are not app routes, so an incoming link is
// rewritten before the router sees it:
//
//   /@username       → /u/username       (resolved to the account by the API)
//   /u/username      → unchanged          (app/u/[username]/index.tsx)
//   /book/:id        → /work/:id
//
// Everything else (verify-email, reset-password, shelf links, flyleaf://
// routes) passes through untouched. The intent filters and the AASA list
// that send these links to the app ship with the next native build.

const HOSTS = new Set(['flyleaf.app', 'www.flyleaf.app']);

/** The app route for an incoming URL or path; the input itself when nothing applies. */
export function appPathFor(input: string): string {
  let path = input;
  const m = /^https?:\/\/([^/?#]+)(.*)$/i.exec(input);
  if (m) {
    if (!HOSTS.has(m[1]!.toLowerCase())) return input;
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
