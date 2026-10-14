// Public pages (SO-50, SO-51; PRD §16.5, §29.1 loops 1 and 3, AC-18, §4.2,
// §7.8): the book, profile and shelf pages a shared link opens for someone
// without the app, server-rendered with Open Graph, Twitter and App Links tags.
//
//   GET /book/:id                    a book (a merged id 301s to its survivor)
//   GET /@:username                  a reader's profile, the canonical address
//   GET /u/:username                 the old profile address: 301 to /@username
//   GET /u/:username/shelves/:slug   a shelf, the canonical address
//   GET /shelf/:id                   a shelf by id (canonical link to the above)
//
// PRIVACY. An HTML page is rendered for a GUEST, always: a browser sends no
// bearer token, and a page that depended on who asked could not be cached.
// So a page shows what canView() lets a guest see and nothing else, through
// the same authorization layer as the API (Part 05's matrix covers these
// routes too): a private account, a private or followers-only shelf, a
// deleted or banned account (a ban is a soft delete), hidden or deleted
// content, an unverified author's review (D-05-3) and a provisional book all
// answer one 404 page, byte for byte the page a random id gets, with no title,
// name or description in any tag. Blocks need no rule here: a guest has no
// relationship to block. PRD §7.8: reviews of an explicit book never appear on
// a logged-out page; the book itself resolves (a direct link always does) with
// no cover, description or reviews, and is not indexed.
//
// RENAMES. An old username or shelf slug 301s to the current one (D-11-2,
// 0037's claims tables), decided only after the visibility check, so a
// redirect never reveals what the 404 would hide. Redirects are no-store (a
// cached a → b would loop once the name goes back to a).
//
// HEADERS. Every page: a CSP that allows no script at all, Referrer-Policy,
// and a canonical link. 200: `public, max-age=300` (safe, because nothing
// depends on the viewer; five minutes bounds how long something made private
// stays in a shared cache, PRD §34.3, A-11-022). 404 and 301: no-store.
// Every interpolated value goes through escapeHtml, URLs included.
//
// The shelf routes keep one API behaviour from SH-10: `Accept:
// application/json` answers the shelf as JSON for the signed-in viewer
// (slug-history.test.ts uses it). That branch is unchanged.

import type { FastifyInstance, FastifyReply } from 'fastify';
import { sql } from 'drizzle-orm';

import { escapeHtml } from '../admin/html.js';
import { ApiError } from '../http.js';
import { config, type Cache, type Db } from '../platform/index.js';
import { canViewSql, canViewWith, loadRelationship, mostRestrictiveSql } from '../authorization/index.js';
import { resolveWorkId } from '../catalog/resolve.js';
import { ReviewService, type ReviewItem } from '../reviews/index.js';
import { ShelvesService, type ShelfDetail } from '../shelves/index.js';
import { avatarUrl } from '../uploads/index.js';

/** Pages run no script: their own inline style, and images from https (covers) or this host (avatars). */
export const PUBLIC_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' https: data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export const PUBLIC_PAGE_CACHE = 'public, max-age=300';

const APP_SCHEME = 'flyleaf://';
const ANDROID_PACKAGE = 'app.flyleaf';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Wider than usernameSchema on purpose (old names, any case); anything else cannot be a username. */
const USERNAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
/** Generous bound for a slug in a URL: anything longer is not one. */
const MAX_SLUG = 200;

const BOOK_REVIEWS = 5;
const PROFILE_REVIEWS = 5;
const PROFILE_SHELVES = 6;
const SHELF_ITEMS = 24;

type Row = Record<string, unknown>;

// ---------------------------------------------------------------------------
// Shared shell
// ---------------------------------------------------------------------------

export const coverUrl = (coverId: number | string | null | undefined, size: 'M' | 'L' = 'L') =>
  coverId === null || coverId === undefined ? null : `https://covers.openlibrary.org/b/id/${encodeURIComponent(String(coverId))}-${size}.jpg`;

/** Whitespace collapsed, cut to `max` characters (code points) with an ellipsis. */
export function excerpt(text: string | null | undefined, max: number): string {
  const flat = (text ?? '').replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length <= max ? flat : `${chars.slice(0, max - 1).join('').trimEnd()}…`;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-GB')} ${n === 1 ? one : many}`;

export const urls = {
  book: (id: string) => `/book/${encodeURIComponent(id)}`,
  profile: (username: string) => `/@${encodeURIComponent(username)}`,
  shelf: (username: string, slug: string) => `/u/${encodeURIComponent(username)}/shelves/${encodeURIComponent(slug)}`,
};

interface PageMeta {
  title: string;
  description: string;
  /** Path on the app's host, e.g. /book/<id>. */
  path: string;
  ogType: 'books.book' | 'profile' | 'books.book_list';
  image?: string | null;
  /** The app screen, without the scheme: user/<id>, work/<id>, shelf/<id>. */
  appPath: string;
  noindex?: boolean;
  /** Extra og:/profile: properties, already chosen; escaped here. */
  extra?: Array<[string, string]>;
}

function shell(meta: PageMeta, main: string): string {
  const canonical = `${config.appBaseUrl}${meta.path}`;
  const appUrl = `${APP_SCHEME}${meta.appPath}`;
  const e = escapeHtml;
  const image = meta.image ?? null;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${e(meta.title)} · Flyleaf</title>
<meta name="description" content="${e(meta.description)}">
${meta.noindex ? '<meta name="robots" content="noindex">\n' : ''}<link rel="canonical" href="${e(canonical)}">
<meta property="og:site_name" content="Flyleaf">
<meta property="og:type" content="${e(meta.ogType)}">
<meta property="og:url" content="${e(canonical)}">
<meta property="og:title" content="${e(meta.title)}">
<meta property="og:description" content="${e(meta.description)}">
${image ? `<meta property="og:image" content="${e(image)}">\n` : ''}${(meta.extra ?? []).map(([k, v]) => `<meta property="${e(k)}" content="${e(v)}">\n`).join('')}<meta name="twitter:card" content="${image ? 'summary_large_image' : 'summary'}">
<meta name="twitter:title" content="${e(meta.title)}">
<meta name="twitter:description" content="${e(meta.description)}">
${image ? `<meta name="twitter:image" content="${e(image)}">\n` : ''}<meta property="al:ios:url" content="${e(appUrl)}">
<meta property="al:ios:app_name" content="Flyleaf">
<meta property="al:android:url" content="${e(appUrl)}">
<meta property="al:android:package" content="${ANDROID_PACKAGE}">
<meta property="al:android:app_name" content="Flyleaf">
<style>
  :root { color-scheme: light dark; --ground: #FAF7F2; --card: #FFFFFF; --ink: #1F1B16; --muted: #6E747C; --accent: #7A4E2D; --line: #E4DED4; }
  @media (prefers-color-scheme: dark) { :root { --ground: #16181B; --card: #1E2125; --ink: #ECE7DF; --muted: #868D96; --accent: #D9A574; --line: #2C3036; } }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--ground); color: var(--ink); font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { max-width: 40rem; margin: 0 auto; padding: 2rem 1rem 3rem; }
  a { color: var(--accent); }
  h1 { font: 600 1.75rem/1.25 Georgia, serif; margin: 0 0 .25rem; overflow-wrap: anywhere; }
  h2 { font: 600 1.15rem/1.3 Georgia, serif; margin: 2rem 0 .75rem; }
  .muted { color: var(--muted); font-size: .92rem; }
  .head { display: flex; gap: 1.25rem; align-items: flex-start; }
  .cover { width: 7.5rem; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 6px; border: 1px solid var(--line); background: var(--card); flex: none; }
  .avatar { width: 5rem; height: 5rem; border-radius: 50%; object-fit: cover; border: 1px solid var(--line); flex: none; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(5.5rem, 1fr)); gap: .75rem; padding: 0; list-style: none; margin: 0; }
  .grid img { width: 100%; aspect-ratio: 2 / 3; object-fit: cover; border-radius: 4px; border: 1px solid var(--line); background: var(--card); }
  .grid span { display: block; font-size: .8rem; line-height: 1.3; margin-top: .25rem; overflow-wrap: anywhere; }
  .placeholder { display: flex; align-items: center; justify-content: center; aspect-ratio: 2 / 3; border-radius: 4px; border: 1px solid var(--line); background: var(--card); color: var(--muted); font-size: .75rem; padding: .25rem; text-align: center; }
  .list { list-style: none; padding: 0; margin: 0; }
  .list li { background: var(--card); border: 1px solid var(--line); border-radius: 10px; padding: .9rem 1rem; margin: 0 0 .75rem; }
  .list p { margin: .35rem 0 0; overflow-wrap: anywhere; }
  .desc { white-space: pre-line; overflow-wrap: anywhere; }
  .app { display: inline-block; margin-top: 1.5rem; padding: .8rem 1.4rem; border-radius: 10px; background: var(--accent); color: var(--ground); font-weight: 600; text-decoration: none; }
  footer { margin-top: 2.5rem; font-size: .85rem; color: var(--muted); }
</style>
</head>
<body><main>
${main}
<a class="app" href="${e(appUrl)}">Open in the Flyleaf app</a>
<footer>Flyleaf · a social reading tracker</footer>
</main></body>
</html>`;
}

/** The one 404 page: the same bytes whatever the reason (PRD §11.4, §25.3). */
export const NOT_FOUND_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Not found · Flyleaf</title>
<style>
  :root { color-scheme: light dark; }
  body { margin: 0; font: 16px/1.5 system-ui, sans-serif; }
  main { max-width: 26rem; margin: 0 auto; padding: 3rem 1rem; }
  h1 { font: 600 1.5rem/1.3 Georgia, serif; }
</style>
</head>
<body><main>
<h1>This page isn’t here</h1>
<p>It may have been removed, made private, or the link may be wrong.</p>
<p><a href="${escapeHtml(config.appBaseUrl)}/">Flyleaf</a></p>
</main></body>
</html>`;

function sendHtml(reply: FastifyReply, html: string, opts: { noindex?: boolean } = {}) {
  reply
    .code(200)
    .type('text/html; charset=utf-8')
    .header('content-security-policy', PUBLIC_PAGE_CSP)
    .header('referrer-policy', 'strict-origin-when-cross-origin')
    .header('cache-control', PUBLIC_PAGE_CACHE);
  if (opts.noindex) reply.header('x-robots-tag', 'noindex');
  return reply.send(html);
}

export function sendNotFound(reply: FastifyReply) {
  return reply
    .code(404)
    .type('text/html; charset=utf-8')
    .header('content-security-policy', PUBLIC_PAGE_CSP)
    .header('referrer-policy', 'strict-origin-when-cross-origin')
    .header('cache-control', 'no-store')
    .header('x-robots-tag', 'noindex')
    .send(NOT_FOUND_PAGE);
}

function sendRedirect(reply: FastifyReply, location: string) {
  return reply.code(301).header('location', location).header('cache-control', 'no-store').send();
}

const isNotFound = (err: unknown) => err instanceof ApiError && err.status === 404;

function stars(rating: number | null | undefined): string {
  if (rating === null || rating === undefined) return '';
  return `★ ${Number(rating).toFixed(Number(rating) % 1 === 0 ? 0 : 1)}`;
}

function bookTile(w: { id: string; title: string; cover_id: number | string | null }): string {
  const img = coverUrl(w.cover_id, 'M');
  return `<li><a href="${escapeHtml(urls.book(w.id))}">${img
    ? `<img src="${escapeHtml(img)}" alt="" loading="lazy">`
    : `<div class="placeholder">${escapeHtml(excerpt(w.title, 40))}</div>`}<span>${escapeHtml(excerpt(w.title, 60))}</span></a></li>`;
}

// ---------------------------------------------------------------------------
// Data: everything below reads as a guest (viewer null).
// ---------------------------------------------------------------------------

export interface PublicBook {
  id: string;
  title: string;
  subtitle: string | null;
  first_publish_year: number | null;
  maturity: string;
  description: string | null;
  cover_id: number | null;
  authors: { id: string; name: string }[];
  avg_rating: number | null;
  rating_count: number;
  reviews: ReviewItem[];
}

export class PublicPagesService {
  readonly #shelves: ShelvesService;
  readonly #reviews: ReviewService;

  constructor(private readonly db: Db, cache?: Cache) {
    this.#shelves = new ShelvesService(db);
    this.#reviews = new ReviewService(db, cache);
  }

  /** A book, as a guest sees it. `moved`: a merged id's survivor (D3). null: the 404. */
  async book(id: string): Promise<PublicBook | { moved: string } | null> {
    if (!UUID_RE.test(id)) return null;
    const workId = await resolveWorkId(this.db, id);
    if (!workId) return null;
    if (workId !== id) return { moved: workId };
    const [w] = await this.db.execute<{
      id: string; title: string; subtitle: string | null; first_publish_year: number | null; maturity: string;
      is_provisional: boolean; description: string | null; cover_id: number | null;
      authors: { id: string; name: string }[] | null; avg_rating: string | null; rating_count: string | number | null;
    }>(sql`
      SELECT w.id, w.title, w.subtitle, w.first_publish_year, w.maturity, w.is_provisional, w.description,
        COALESCE(w.ol_cover_id, (SELECT e.ol_cover_id FROM editions e
          WHERE e.work_id = w.id AND e.ol_cover_id IS NOT NULL ORDER BY e.page_count NULLS LAST LIMIT 1)) AS cover_id,
        (SELECT json_agg(json_build_object('id', a.id, 'name', a.name) ORDER BY wa.position, a.name)
           FROM work_authors wa JOIN authors a ON a.id = wa.author_id WHERE wa.work_id = w.id) AS authors,
        ws.avg_rating, ws.rating_count
      FROM works w LEFT JOIN work_stats ws ON ws.work_id = w.id
      WHERE w.id = ${workId}::uuid AND w.merged_into_id IS NULL`);
    // A provisional work is a reader's own unreviewed entry, not catalog: no public page.
    if (!w || w.is_provisional) return null;
    const explicit = w.maturity === 'explicit';
    // PRD §7.8: reviews of explicit works are suppressed from logged-out pages.
    const reviews = explicit ? [] : (await this.#reviews.listWorkReviews(workId, { sort: 'friends', limit: BOOK_REVIEWS }, null)).data;
    return {
      id: w.id,
      title: w.title,
      subtitle: w.subtitle,
      first_publish_year: w.first_publish_year,
      maturity: w.maturity,
      description: explicit ? null : w.description,
      cover_id: explicit ? null : w.cover_id,
      authors: w.authors ?? [],
      avg_rating: w.avg_rating === null ? null : Number(w.avg_rating),
      rating_count: Number(w.rating_count ?? 0),
      reviews,
    };
  }

  /**
   * The account behind a username: its current name, or one it used to have
   * (0037). Visible to a guest only: a public, live account. `moved` only
   * after that check (D-11-2).
   */
  async #account(raw: string): Promise<{ userId: string; username: string; moved: boolean } | null> {
    const name = raw.trim().toLowerCase();
    if (!USERNAME_RE.test(name)) return null;
    const [row] = await this.db.execute<{ user_id: string; username: string; current: boolean }>(sql`
      SELECT p.user_id, p.username, true AS current FROM profiles p WHERE lower(p.username) = ${name}
      UNION ALL
      SELECT p.user_id, p.username, false FROM username_claims c JOIN profiles p ON p.user_id = c.user_id
      WHERE c.username = ${name}
      ORDER BY current DESC LIMIT 1`);
    if (!row) return null;
    const rel = await loadRelationship(this.db, null, row.user_id);
    if (!canViewWith(null, row.user_id, rel)) return null;
    return { userId: row.user_id, username: row.username, moved: !row.current || row.username !== raw };
  }

  async profileAddress(raw: string): Promise<{ username: string; moved: boolean } | null> {
    const a = await this.#account(raw);
    return a && { username: a.username, moved: a.moved };
  }

  async profile(raw: string) {
    const a = await this.#account(raw);
    if (!a) return null;
    if (a.moved) return { moved: a.username };
    const [p] = await this.db.execute<{
      display_name: string | null; bio: string | null; avatar_key: string | null;
      follower_count: number; following_count: number; favourite_work_ids: string[] | string | null;
    }>(sql`
      SELECT display_name, bio, avatar_key, follower_count, following_count, favourite_work_ids
      FROM profiles WHERE user_id = ${a.userId}::uuid`);
    if (!p) return null;
    const favIds = pgUuidArray(p.favourite_work_ids);
    const [favRows, reviewRows, shelves] = await Promise.all([
      favIds.length === 0
        ? Promise.resolve([] as Row[])
        : this.db.execute<Row>(sql`
            SELECT w.id, w.title, w.ol_cover_id AS cover_id FROM works w
            WHERE w.id IN (${sql.join(favIds.map((id) => sql`${id}::uuid`), sql`, `)})
              AND w.merged_into_id IS NULL AND w.maturity <> 'explicit'`),
      // The profile's recent reviews a guest may read: canView() as SQL
      // (Part 05's predicate, authored: an unverified author's are hidden),
      // the stricter of review and read visibility, never an explicit book.
      this.db.execute<Row>(sql`
        SELECT rv.id, rv.body, rv.has_spoilers, rv.published_at, r.rating, w.id AS work_id, w.title, w.ol_cover_id AS cover_id
        FROM reviews rv
        JOIN reads r ON r.id = rv.read_id
        JOIN works w ON w.id = rv.work_id
        LEFT JOIN profiles pp ON pp.user_id = rv.user_id
        WHERE rv.user_id = ${a.userId}::uuid AND rv.deleted_at IS NULL
          AND w.merged_into_id IS NULL AND w.maturity <> 'explicit'
          AND ${canViewSql(null, {
            ownerId: sql`rv.user_id`,
            visibility: mostRestrictiveSql(sql`rv.visibility`, sql`r.visibility`),
            ownerIsPrivate: sql`COALESCE(pp.is_private, true)`,
            authored: true,
          })}
        ORDER BY rv.published_at DESC, rv.id DESC
        LIMIT ${PROFILE_REVIEWS}`),
      this.#shelves.getUserShelves(null, a.userId).then((r) => r.shelves),
    ]);
    const favById = new Map(favRows.map((r) => [String(r.id), r]));
    return {
      id: a.userId,
      username: a.username,
      display_name: p.display_name,
      bio: p.bio,
      avatar_url: avatarUrl(p.avatar_key),
      follower_count: Number(p.follower_count),
      following_count: Number(p.following_count),
      favourites: favIds.flatMap((id) => {
        const r = favById.get(id);
        return r ? [{ id, title: String(r.title), cover_id: (r.cover_id as number | null) ?? null }] : [];
      }),
      reviews: reviewRows.map((r) => ({
        id: String(r.id),
        body: String(r.body),
        has_spoilers: Boolean(r.has_spoilers),
        rating: r.rating === null || r.rating === undefined ? null : Number(r.rating),
        work: { id: String(r.work_id), title: String(r.title), cover_id: (r.cover_id as number | null) ?? null },
      })),
      shelves: shelves.slice(0, PROFILE_SHELVES),
      shelf_count: shelves.length,
    };
  }

  /** The shelf a guest may see, by address (renames 301, D-11-2) or by id. */
  async shelfByAddress(username: string, slug: string): Promise<{ shelf: ShelfDetail } | { moved: { username: string; slug: string } } | null> {
    if (!USERNAME_RE.test(username.trim()) || slug.length === 0 || slug.length > MAX_SLUG) return null;
    try {
      return await this.#shelves.resolveSlug(null, username, slug);
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async shelfById(id: string): Promise<ShelfDetail | null> {
    if (!UUID_RE.test(id)) return null;
    try {
      const shelf = await this.#shelves.getById(null, id);
      return shelf;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  /** The first books of a shelf the guest may already see; explicit books left out (PRD §7.8). */
  async shelfBooks(shelfId: string) {
    const rows = await this.db.execute<Row>(sql`
      SELECT w.id, w.title, w.ol_cover_id AS cover_id, w.maturity = 'explicit' AS explicit
      FROM shelf_items si JOIN works w ON w.id = si.work_id
      WHERE si.shelf_id = ${shelfId}::uuid AND w.merged_into_id IS NULL
      ORDER BY si.position, si.work_id
      LIMIT ${SHELF_ITEMS}`);
    return rows
      .filter((r) => !r.explicit)
      .map((r) => ({ id: String(r.id), title: String(r.title), cover_id: (r.cover_id as number | null) ?? null }));
  }
}

function pgUuidArray(v: unknown): string[] {
  if (!v) return [];
  if (Array.isArray(v)) return v.map(String);
  return String(v).replace(/^\{|\}$/g, '').split(',').filter(Boolean);
}

// ---------------------------------------------------------------------------
// Pages
// ---------------------------------------------------------------------------

export function renderBook(b: PublicBook): string {
  const e = escapeHtml;
  const explicit = b.maturity === 'explicit';
  const authorLine = b.authors.length ? b.authors.map((a) => a.name).join(', ') : 'Unknown author';
  const title = `${b.title} by ${authorLine}`;
  const ratingLine = b.rating_count > 0 && b.avg_rating !== null
    ? `${stars(b.avg_rating)} · ${plural(b.rating_count, 'rating')}`
    : '';
  const description = explicit
    ? `${b.title} by ${authorLine} on Flyleaf.`
    : excerpt(b.description, 200) || `${b.title} by ${authorLine}. ${ratingLine ? `${ratingLine} on Flyleaf.` : 'Track it on Flyleaf.'}`;
  const cover = coverUrl(b.cover_id);
  const reviews = b.reviews.map((r) => `<li>
<a href="${e(urls.profile(r.author.username))}"><strong>${e(r.author.display_name || r.author.username)}</strong></a> <span class="muted">@${e(r.author.username)}${r.rating !== null ? ` · ${e(stars(r.rating))}` : ''}</span>
<p>${r.has_spoilers ? '<em class="muted">Contains spoilers. Open it in the app to read it.</em>' : e(excerpt(r.body, 600))}</p>
</li>`).join('\n');
  const main = `<div class="head">
${cover ? `<img class="cover" src="${e(cover)}" alt="Cover of ${e(b.title)}">` : ''}
<div>
<h1>${e(b.title)}</h1>
${b.subtitle && !explicit ? `<p class="muted">${e(b.subtitle)}</p>` : ''}
<p>${e(authorLine)}${b.first_publish_year ? ` <span class="muted">· ${e(b.first_publish_year)}</span>` : ''}</p>
${ratingLine ? `<p class="muted">${e(ratingLine)}</p>` : ''}
</div>
</div>
${explicit ? '<p class="muted">This book is for adult readers. Open it in the app to see more.</p>' : ''}
${b.description && !explicit ? `<h2>About this book</h2>\n<p class="desc">${e(excerpt(b.description, 1500))}</p>` : ''}
${reviews ? `<h2>Reviews</h2>\n<ul class="list">\n${reviews}\n</ul>` : ''}`;
  return shell({
    title,
    description,
    path: urls.book(b.id),
    ogType: 'books.book',
    image: cover,
    appPath: `work/${b.id}`,
    noindex: explicit,
    extra: b.authors.length ? [['books:author', authorLine]] : [],
  }, main);
}

type PublicProfile = NonNullable<Exclude<Awaited<ReturnType<PublicPagesService['profile']>>, { moved: string }>>;

export function renderProfile(p: PublicProfile): string {
  const e = escapeHtml;
  const name = p.display_name || p.username;
  const title = `${name} (@${p.username})`;
  const description = p.bio
    ? excerpt(p.bio, 200)
    : `${name} is on Flyleaf. ${plural(p.follower_count, 'follower')}.`;
  const avatar = p.avatar_url ? `${config.appBaseUrl}${p.avatar_url}` : null;
  const favourites = p.favourites.map(bookTile).join('');
  const reviews = p.reviews.map((r) => `<li>
<a href="${e(urls.book(r.work.id))}"><strong>${e(r.work.title)}</strong></a>${r.rating !== null ? ` <span class="muted">· ${e(stars(r.rating))}</span>` : ''}
<p>${r.has_spoilers ? '<em class="muted">Contains spoilers. Open it in the app to read it.</em>' : e(excerpt(r.body, 400))}</p>
</li>`).join('\n');
  const shelves = p.shelves.map((s) => `<li><a href="${e(urls.shelf(p.username, s.slug))}"><strong>${e(s.name)}</strong></a> <span class="muted">· ${e(plural(s.item_count, 'book'))}</span></li>`).join('\n');
  const main = `<div class="head">
${avatar ? `<img class="avatar" src="${e(avatar)}" alt="">` : ''}
<div>
<h1>${e(name)}</h1>
<p class="muted">@${e(p.username)} · ${e(plural(p.follower_count, 'follower'))} · ${e(p.following_count.toLocaleString('en-GB'))} following</p>
${p.bio ? `<p class="desc">${e(p.bio)}</p>` : ''}
</div>
</div>
${favourites ? `<h2>Favourites</h2>\n<ul class="grid">${favourites}</ul>` : ''}
${reviews ? `<h2>Recent reviews</h2>\n<ul class="list">\n${reviews}\n</ul>` : ''}
${shelves ? `<h2>Shelves</h2>\n<ul class="list">\n${shelves}\n</ul>${p.shelf_count > p.shelves.length ? `\n<p class="muted">${e(plural(p.shelf_count - p.shelves.length, 'more shelf', 'more shelves'))} in the app.</p>` : ''}` : ''}`;
  return shell({
    title,
    description,
    path: urls.profile(p.username),
    ogType: 'profile',
    image: avatar ?? coverUrl(p.favourites[0]?.cover_id),
    appPath: `user/${p.id}`,
    extra: [['profile:username', p.username]],
  }, main);
}

export function renderShelf(shelf: ShelfDetail, books: { id: string; title: string; cover_id: number | null }[]): string {
  const e = escapeHtml;
  const curator = shelf.owner.displayName || shelf.owner.username;
  const title = `${shelf.name} — Curated by @${shelf.owner.username}`;
  const description = shelf.description
    ? excerpt(shelf.description, 200)
    : `${plural(shelf.item_count, 'book')} on Flyleaf, curated by ${curator}.`;
  const more = shelf.item_count - books.length;
  const main = `<p class="muted">A reading list${shelf.is_ranked ? ' · ranked' : ''}</p>
<h1>${e(shelf.name)}</h1>
<p class="muted">by <a href="${e(urls.profile(shelf.owner.username))}">@${e(shelf.owner.username)}</a> · ${e(plural(shelf.item_count, 'book'))}</p>
${shelf.description ? `<p class="desc">${e(shelf.description)}</p>` : ''}
${books.length ? `<ul class="grid">${books.map(bookTile).join('')}</ul>` : ''}
${more > 0 ? `<p class="muted">${e(plural(more, 'more book'))} in the app.</p>` : ''}`;
  return shell({
    title,
    description,
    path: urls.shelf(shelf.owner.username, shelf.slug),
    ogType: 'books.book_list',
    image: coverUrl(books[0]?.cover_id),
    appPath: `shelf/${shelf.id}`,
  }, main);
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

const wantsJson = (accept: string | undefined) => Boolean(accept?.includes('application/json'));

export interface PublicPagesOptions {
  db: Db;
  cache?: Cache;
}

export function publicPagesPlugin(opts: PublicPagesOptions) {
  return async (app: FastifyInstance) => {
    const pages = new PublicPagesService(opts.db, opts.cache);
    const shelvesApi = new ShelvesService(opts.db);
    // Server-rendered pages, not API: kept out of openapi.yaml.
    const hidden = { schema: { hide: true } };

    app.get<{ Params: { id: string } }>('/book/:id', hidden, async (req, reply) => {
      const b = await pages.book(req.params.id);
      if (!b) return sendNotFound(reply);
      if ('moved' in b) return sendRedirect(reply, urls.book(b.moved));
      return sendHtml(reply, renderBook(b), { noindex: b.maturity === 'explicit' });
    });

    // flyleaf.app/@username (PRD §16.5, SO-51).
    app.get<{ Params: { username: string } }>('/@:username', hidden, async (req, reply) => {
      const p = await pages.profile(req.params.username);
      if (!p) return sendNotFound(reply);
      if ('moved' in p) return sendRedirect(reply, urls.profile(p.moved as string));
      return sendHtml(reply, renderProfile(p));
    });

    // The address the app shared before /@username existed.
    app.get<{ Params: { username: string } }>('/u/:username', hidden, async (req, reply) => {
      const a = await pages.profileAddress(req.params.username);
      if (!a) return sendNotFound(reply);
      return sendRedirect(reply, urls.profile(a.username));
    });

    app.get<{ Params: { username: string; slug: string } }>('/u/:username/shelves/:slug', hidden, async (req, reply) => {
      const { username, slug } = req.params;
      if (wantsJson(req.headers.accept)) {
        // SH-10's JSON answer for the signed-in viewer, unchanged.
        const found = await shelvesApi.resolveSlug(req.viewer, username, slug);
        if ('moved' in found) return sendRedirect(reply, urls.shelf(found.moved.username, found.moved.slug));
        return reply.header('cache-control', jsonCache(req.viewer, found.shelf)).send({ shelf: found.shelf });
      }
      const found = await pages.shelfByAddress(username, slug);
      if (!found) return sendNotFound(reply);
      if ('moved' in found) return sendRedirect(reply, urls.shelf(found.moved.username, found.moved.slug));
      return sendHtml(reply, renderShelf(found.shelf, await pages.shelfBooks(found.shelf.id)));
    });

    app.get<{ Params: { id: string } }>('/shelf/:id', hidden, async (req, reply) => {
      if (wantsJson(req.headers.accept)) {
        const shelf = await shelvesApi.getById(req.viewer, req.params.id);
        return reply.header('cache-control', jsonCache(req.viewer, shelf)).send({ shelf });
      }
      const shelf = await pages.shelfById(req.params.id);
      if (!shelf) return sendNotFound(reply);
      return sendHtml(reply, renderShelf(shelf, await pages.shelfBooks(shelf.id)));
    });
  };
}

/** A-11-022, for the JSON branch: what depended on who asked is never shared-cached. */
function jsonCache(viewer: string | null, shelf: ShelfDetail): string {
  return viewer === null && shelf.privacy === 'public' ? PUBLIC_PAGE_CACHE : 'private, no-store';
}
