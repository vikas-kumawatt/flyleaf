// Benchmark social data set (audit Part 01).
//
//   npm run bench:seed              add the data set (no-op if it is present)
//   npm run bench:seed -- --clean   remove it, and nothing else
//
// Adds ~3,000 users and their follows, blocks, mutes, reads, progress,
// reviews, likes, comments, shelves, saves and activity ON TOP of the real
// catalog in the dev database. The catalog itself is only read.
//
// Removability. Every user has a username `bench_…` AND an email
// `…@bench.flyleaf.invalid`; --clean deletes exactly the users matching both,
// and everything else goes by ON DELETE CASCADE. It then verifies that no
// bench row survived and tidies the two things cascades cannot reach (derived
// work_stats rows and rate-limit buckets; see clean()).
//
// Idempotency. The whole data set is written in ONE transaction, so it is
// either entirely present or entirely absent. A second run sees the bench
// users and exits without writing.
//
// Deliberate choices, each visible in the numbers it produces:
//  - Bulk mode. With triggers on, the insert takes ~15 minutes: the follows
//    counter trigger rewrites two profiles per row (228 s for 186k follows)
//    and the work_stats trigger scans `reads` twice per row (630 s for 62k
//    reads, measured 2026-09-24). So by default the inserts run with
//    `SET LOCAL session_replication_role = replica` (superuser only; the dev
//    container's role is one), which skips triggers AND foreign-key checks
//    for this transaction only. Before commit the script then (1) checks
//    every single-column foreign key on the seeded tables with an anti-join,
//    and (2) derives every counter with the product's own functions:
//    reconcile_{read,shelf,follow}_counters() and recompute_work_stats_for_work()
//    per touched work. `--with-triggers` runs the slow, trigger-maintained
//    path instead. --clean always uses the triggers: cascades ARE triggers.
//  - works.log_count is NOT incremented, although ReadingService.setStatus
//    increments it for a new attempt. Nothing decrements it when reads are
//    deleted, so a seed that bumped it could never be cleaned: search ranking
//    on the real catalog would be permanently skewed.
//  - Data is spread over ~365 days; activity rows exist only for events in the
//    last 120 days, each written with the exact shape of the service that
//    emits it (see the `activity…` helpers). Private items and imported reads
//    produce no activity; private accounts' activity is 'followers'.
//  - Random, but deterministic: a seeded PRNG drives every choice, so two
//    seeds against the same catalog have the same shape. Row ids are random
//    UUIDs.

import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { hash as argonHash } from '@node-rs/argon2';
import type { TransactionSql } from 'postgres';
import { makeDb, closeDb } from '../platform/index.js';
import { signAccessToken } from '../identity/index.js';
import { slugify } from '../shelves/index.js';

type Sql = ReturnType<typeof makeDb>['$client'];
type Tx = TransactionSql<{}>;

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const TOKENS_PATH = path.join(HERE, 'tokens.json');

export const BENCH_EMAIL_DOMAIN = 'bench.flyleaf.invalid';
export const BENCH_PASSWORD = 'bench-password-not-secret-1';

const N_USERS = 3000;
const SEEDED_TABLES = ['users', 'profiles', 'follows', 'blocks', 'mutes', 'reads', 'progress_events', 'reviews',
  'read_likes', 'read_comments', 'shelves', 'shelf_items', 'shelf_saves', 'activity'];
const N_TOP_WORKS = 20_000;
const DAY = 86_400_000;
const NOW = Date.now();
const ACTIVITY_WINDOW_DAYS = 120;
const HISTORY_DAYS = 365;

// ------------------------------------------------------------------ PRNG

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = mulberry32(20260924);
const randInt = (lo: number, hi: number) => lo + Math.floor(rand() * (hi - lo + 1));
const chance = (p: number) => rand() < p;
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;
function gauss() {
  const u = 1 - rand();
  const v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
const logNormal = (median: number, sigma: number) => Math.exp(Math.log(median) + sigma * gauss());
function weighted<T>(entries: readonly (readonly [T, number])[]): T {
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rand() * total;
  for (const [v, w] of entries) if ((r -= w) <= 0) return v;
  return entries[entries.length - 1]![0];
}

/** Sampler over indices 0..n-1 with weight (i+1)^-alpha (Zipf). */
function zipfSampler(n: number, alpha: number) {
  const cum = new Float64Array(n);
  let s = 0;
  for (let i = 0; i < n; i++) cum[i] = s += Math.pow(i + 1, -alpha);
  return () => {
    const r = rand() * s;
    let lo = 0;
    let hi = n - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid]! < r) lo = mid + 1;
      else hi = mid;
    }
    return lo;
  };
}

/** Up to k distinct values from `draw`, giving up after a bounded number of tries. */
function distinct(k: number, draw: () => number, exclude?: Set<number>): number[] {
  const out = new Set<number>();
  let tries = 0;
  while (out.size < k && tries < k * 30 + 100) {
    tries++;
    const v = draw();
    if (!exclude?.has(v)) out.add(v);
  }
  return [...out];
}

const isoDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const between = (a: number, b: number) => a + rand() * Math.max(0, b - a);
const inWindow = (ms: number) => ms >= NOW - ACTIVITY_WINDOW_DAYS * DAY;

const WORDS = (
  'the a book story characters plot writing pacing ending chapter world author prose voice ' +
  'slow fast beautiful devastating clever funny dark hopeful strange quiet brilliant flawed ' +
  'loved hated finished couldnt stop reading again recommend friends everyone nobody ' +
  'middle part dragged first half second picked up really never expected twist heart ' +
  'memorable forgettable dense light perfect messy honest sharp long short years later'
).split(' ');
function sentence(minWords: number, maxWords: number) {
  const n = randInt(minWords, maxWords);
  const w = Array.from({ length: n }, () => pick(WORDS));
  w[0] = w[0]!.charAt(0).toUpperCase() + w[0]!.slice(1);
  return `${w.join(' ')}.`;
}
function paragraph(targetChars: number) {
  let s = '';
  while (s.length < targetChars) s += (s ? ' ' : '') + sentence(5, 18);
  return s.slice(0, 9_900);
}

const FIRST = ['Ada', 'Ben', 'Chioma', 'Dev', 'Elif', 'Farah', 'Gus', 'Hana', 'Ivo', 'Jun', 'Kofi', 'Lena', 'Mo', 'Nia', 'Omar', 'Pia', 'Quinn', 'Ravi', 'Sofia', 'Tariq', 'Uma', 'Vik', 'Wen', 'Yara', 'Zoe'];
const LAST = ['Adeyemi', 'Brown', 'Chen', 'Diaz', 'Evans', 'Fischer', 'García', 'Haddad', 'Ito', 'Jensen', 'Kumar', 'López', 'Müller', 'Nakamura', 'Okafor', 'Petrov', 'Rossi', 'Singh', 'Tanaka', 'Ward'];
const SHELF_NAMES = ['Favourites', 'To buy', 'Book club', 'Comfort reads', 'Summer 2026', 'Classics', 'Sci-fi', 'Non-fiction', 'Gave up', 'Re-read someday', 'Recommended by friends', 'Short books', 'Big books', 'Translated fiction', 'Holiday reading', 'Best of 2025', 'Audiobooks', 'For the kids', 'Poetry', 'Mysteries'];
const DNF_REASONS = ['lost_interest', 'too_slow', 'not_for_me', 'writing_style', 'content', 'no_time', null];

// ------------------------------------------------------------------ types

interface U {
  id: string; idx: number; username: string; email: string;
  isPrivate: boolean; createdAt: number; displayName: string;
}
interface W { id: string; editionId: string | null; pages: number }
interface R {
  id: string; userIdx: number; workIdx: number; attemptNo: number; status: string;
  source: 'app' | 'import'; visibility: 'public' | 'followers' | 'private';
  createdAt: number; startedAt: number | null; finishedAt: number | null;
  abandonedAt: number | null; abandonedPage: number | null; dnfReason: string | null;
  rating: number | null; hearted: boolean; updatedAt: number;
}

// ------------------------------------------------------------------ insert

async function insertRows(tx: Tx, table: string, rows: Record<string, unknown>[]) {
  if (!rows.length) return;
  const cols = Object.keys(rows[0]!);
  const per = Math.max(1, Math.floor(30_000 / cols.length));
  // postgres.js does not run its type serializers for the multi-row insert
  // helper here (a Date or an object reaches the wire as-is and throws), so
  // values are pre-serialised to text and Postgres casts them by column type.
  // Checked: jsonb round-trips as an object, timestamptz to the millisecond.
  const text = (v: unknown) =>
    v instanceof Date ? v.toISOString() : v !== null && typeof v === 'object' ? JSON.stringify(v) : v;
  for (let i = 0; i < rows.length; i += per) {
    const batch = rows.slice(i, i + per).map((r) => Object.fromEntries(cols.map((c) => [c, text(r[c])])));
    await tx`INSERT INTO ${tx(table)} ${tx(batch as never, cols as never)}`;
  }
}

function timer() {
  let t = Date.now();
  const start = t;
  return {
    lap(label: string, extra = '') {
      const now = Date.now();
      console.log(`  ${label.padEnd(28)} ${((now - t) / 1000).toFixed(1).padStart(6)}s ${extra}`);
      t = now;
    },
    total: () => (Date.now() - start) / 1000,
  };
}

// ------------------------------------------------------------------ seed

async function seed(sql: Sql) {
  const [existing] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users u JOIN profiles p ON p.user_id = u.id
    WHERE p.username LIKE 'bench\\_%' AND u.email LIKE ${'%@' + BENCH_EMAIL_DOMAIN}
  `;
  if (existing!.n > 0) {
    console.log(`bench data already present (${existing!.n} users). Nothing to do.`);
    console.log('To regenerate: npm run bench:seed -- --clean, then npm run bench:seed');
    if (!fs.existsSync(TOKENS_PATH)) console.log('WARNING: tokens.json is missing; --clean and re-seed to recreate it.');
    return;
  }

  const t = timer();
  console.log('seeding bench data set');

  // -------------------------------------------------------------- catalog
  const works: W[] = (
    await sql<{ id: string; edition_id: string | null; pages: number | null }[]>`
      SELECT w.id, e.id AS edition_id, e.page_count AS pages
      FROM (
        SELECT id, log_count FROM works
        WHERE merged_into_id IS NULL AND NOT is_provisional
        ORDER BY log_count DESC
        LIMIT ${N_TOP_WORKS}
      ) w
      LEFT JOIN LATERAL (
        SELECT id, page_count FROM editions
        WHERE work_id = w.id AND page_count BETWEEN 30 AND 3000
        ORDER BY page_count DESC LIMIT 1
      ) e ON true
      ORDER BY w.log_count DESC, w.id
    `
  ).map((r) => ({ id: r.id, editionId: r.edition_id, pages: r.pages ?? 320 }));
  if (works.length < 1000) throw new Error(`catalog has only ${works.length} works; is this the dev database?`);
  t.lap('read top works', `(${works.length})`);
  const HOT = 0;

  const passwordHash = await argonHash(BENCH_PASSWORD);

  // ------------------------------------------------------------ personas
  const P = {
    celebrities: [0, 1, 2, 3, 4],
    heavy: [5, 6, 7, 8, 9],
    new: 10,
    privateOwner: 11,
    blockedA: 12,
    blockedB: 13,
    hotReviewer: 14,
  };
  const special = new Set([...P.celebrities, ...P.heavy, P.new, P.privateOwner, P.blockedA, P.blockedB, P.hotReviewer]);

  // --------------------------------------------------------------- users
  const users: U[] = [];
  for (let i = 0; i < N_USERS; i++) {
    const n = String(i + 1).padStart(5, '0');
    users.push({
      id: randomUUID(),
      idx: i,
      username: `bench_u${n}`,
      email: `bench_u${n}@${BENCH_EMAIL_DOMAIN}`,
      isPrivate: i === P.privateOwner || (!special.has(i) && chance(0.1)),
      createdAt: i === P.new ? NOW - 60_000 : NOW - (HISTORY_DAYS + randInt(10, 400)) * DAY,
      displayName: `${pick(FIRST)} ${pick(LAST)}`,
    });
  }

  // ------------------------------------------------------------- follows
  // Popularity rank: celebrities first, everyone else shuffled. Targets are
  // drawn Zipf-weighted by rank, so in-degree is power-law too.
  const byRank = [...P.celebrities, ...users.map((u) => u.idx).filter((i) => !P.celebrities.includes(i)).sort(() => rand() - 0.5)]
    .filter((i) => i !== P.new);
  const drawTarget = zipfSampler(byRank.length, 0.85);

  const blockPairs = new Set<string>();
  const blocks: [number, number][] = [[P.blockedA, P.blockedB]];
  while (blocks.length < 150) {
    const a = randInt(15, N_USERS - 1);
    const b = randInt(15, N_USERS - 1);
    if (a === b || blockPairs.has(`${a}:${b}`) || blockPairs.has(`${b}:${a}`)) continue;
    blocks.push([a, b]);
    blockPairs.add(`${a}:${b}`);
  }
  blockPairs.add(`${P.blockedA}:${P.blockedB}`);
  const blocked = (a: number, b: number) => blockPairs.has(`${a}:${b}`) || blockPairs.has(`${b}:${a}`);

  const followEdges: { f: number; t: number; at: number }[] = [];
  for (const u of users) {
    if (u.idx === P.new) continue;
    const degree = P.heavy.includes(u.idx)
      ? randInt(1050, 1400)
      : Math.min(900, Math.round(logNormal(40, 0.9)));
    const targets = distinct(degree, () => byRank[drawTarget()]!, new Set([u.idx]));
    for (const tIdx of targets) {
      if (blocked(u.idx, tIdx)) continue;
      followEdges.push({ f: u.idx, t: tIdx, at: between(NOW - HISTORY_DAYS * DAY, NOW - 3_600_000) });
    }
  }
  const toPrivate = followEdges.filter((e) => users[e.t]!.isPrivate).length;
  const pPending = Math.min(1, (0.05 * followEdges.length) / Math.max(1, toPrivate));
  const follows = followEdges.map((e) => ({
    ...e,
    state: users[e.t]!.isPrivate && chance(pPending) ? 'pending' : 'accepted',
  }));
  const accepted = follows.filter((e) => e.state === 'accepted');
  const followersOf = new Map<number, number[]>();
  const followingOf = new Map<number, number[]>();
  for (const e of accepted) {
    (followersOf.get(e.t) ?? followersOf.set(e.t, []).get(e.t)!).push(e.f);
    (followingOf.get(e.f) ?? followingOf.set(e.f, []).get(e.f)!).push(e.t);
  }
  const followerCount = (i: number) => followersOf.get(i)?.length ?? 0;

  // --------------------------------------------------------------- mutes
  const mutes: { user_id: string; target_type: string; target_id: string; created_at: Date }[] = [];
  const muteKeys = new Set<string>();
  const addMute = (u: number, type: 'user' | 'work', target: string) => {
    const k = `${u}:${type}:${target}`;
    if (muteKeys.has(k)) return;
    muteKeys.add(k);
    mutes.push({ user_id: users[u]!.id, target_type: type, target_id: target, created_at: new Date(between(NOW - 200 * DAY, NOW)) });
  };
  // The heavy persona mutes a few people it follows and a few popular works,
  // so the feed's mute filtering has something to do.
  for (const tIdx of (followingOf.get(P.heavy[0]!) ?? []).slice(0, 8)) addMute(P.heavy[0]!, 'user', users[tIdx]!.id);
  for (let k = 1; k <= 5; k++) addMute(P.heavy[0]!, 'work', works[k]!.id);
  while (mutes.length < 200) {
    const a = randInt(15, N_USERS - 1);
    const b = randInt(0, N_USERS - 1);
    if (a !== b && b !== P.new) addMute(a, 'user', users[b]!.id);
  }
  while (mutes.length < 300) addMute(randInt(15, N_USERS - 1), 'work', works[randInt(0, 499)]!.id);

  // --------------------------------------------------------------- reads
  const drawWork = zipfSampler(works.length - 1, 0.9); // excludes HOT; +1 below
  const reads: R[] = [];
  const visibility = () => weighted([['public', 85], ['followers', 10], ['private', 5]] as const);

  function makeRead(userIdx: number, workIdx: number, attemptNo: number, status: string, source: 'app' | 'import', createdAt: number): R {
    const w = works[workIdx]!;
    let startedAt: number | null = null;
    let finishedAt: number | null = null;
    let abandonedAt: number | null = null;
    let abandonedPage: number | null = null;
    let dnfReason: string | null = null;
    let rating: number | null = null;
    if (source === 'import') {
      // Imported shelves carry old dates from the other service.
      const origin = createdAt - randInt(30, 3000) * DAY;
      if (status !== 'want') startedAt = origin;
      if (status === 'finished') finishedAt = origin + randInt(3, 60) * DAY;
      if (status === 'dnf') { abandonedAt = origin + randInt(1, 30) * DAY; abandonedPage = randInt(5, Math.max(6, w.pages - 1)); }
    } else if (status !== 'want') {
      startedAt = createdAt;
      if (status === 'finished') finishedAt = Math.min(NOW, createdAt + randInt(2, 45) * DAY);
      if (status === 'dnf') {
        abandonedAt = Math.min(NOW, createdAt + randInt(1, 30) * DAY);
        abandonedPage = randInt(5, Math.max(6, Math.floor(w.pages * 0.7)));
        dnfReason = pick(DNF_REASONS);
      }
    }
    if ((status === 'finished' && chance(0.7)) || (status === 'dnf' && chance(0.2))) {
      rating = weighted([[5, 18], [4.5, 14], [4, 22], [3.5, 14], [3, 12], [2.5, 6], [2, 6], [1.5, 3], [1, 3], [0.5, 2]] as const);
    }
    const end = finishedAt ?? abandonedAt ?? startedAt ?? createdAt;
    return {
      id: randomUUID(), userIdx, workIdx, attemptNo, status, source,
      visibility: visibility(), createdAt, startedAt, finishedAt, abandonedAt, abandonedPage, dnfReason,
      rating, hearted: status === 'finished' && chance(0.12),
      updatedAt: Math.min(NOW, Math.max(end, createdAt) + randInt(0, 3) * 3_600_000),
    };
  }
  const appCreated = () => between(NOW - HISTORY_DAYS * DAY, NOW - 3_600_000);
  const latestStatus = () => weighted([['want', 22], ['reading', 12], ['paused', 4], ['finished', 52], ['dnf', 10]] as const);

  // The hot work: every user except `new` finished it once, 2,400 re-read it.
  // Each of those reads gets a review below: the 5,000+ review case.
  const hotReads: R[] = [];
  for (const u of users) {
    if (u.idx === P.new) continue;
    const first = makeRead(u.idx, HOT, 1, 'finished', 'app', between(NOW - HISTORY_DAYS * DAY, NOW - 150 * DAY));
    hotReads.push(first);
  }
  const reReaders = hotReads.filter((r) => r.userIdx !== P.hotReviewer).sort(() => rand() - 0.5).slice(0, 2400);
  for (const r1 of reReaders) {
    const status = chance(0.96) ? 'finished' : 'reading';
    hotReads.push(makeRead(r1.userIdx, HOT, 2, status, 'app', between((r1.finishedAt ?? r1.createdAt) + DAY, NOW - 3_600_000)));
  }
  // Personas whose hot-work reads the bench (and the comment thread) rely on.
  const publicHot = new Set([P.hotReviewer, P.privateOwner, P.celebrities[0]!]);
  for (const r of hotReads) if (publicHot.has(r.userIdx)) r.visibility = 'public';
  reads.push(...hotReads);

  const otherTarget = 60_000 - reads.length;
  const perUser = users.map((u) => (u.idx === P.new ? 0 : logNormal(14, 1.0)));
  const scale = otherTarget / perUser.reduce((a, b) => a + b, 0);
  for (const u of users) {
    const n = Math.min(600, Math.round(perUser[u.idx]! * scale));
    if (!n) continue;
    const importer = chance(0.25); // a quarter of users imported a library
    const importAt = between(NOW - ACTIVITY_WINDOW_DAYS * DAY, NOW - DAY);
    for (const wi of distinct(n, () => drawWork() + 1)) {
      const source: 'app' | 'import' = importer && chance(0.6) ? 'import' : 'app';
      const attempts = chance(0.045) ? (chance(0.12) ? 3 : 2) : 1;
      let at = source === 'import' ? importAt : appCreated();
      for (let a = 1; a <= attempts; a++) {
        const last = a === attempts;
        const status = source === 'import'
          ? (last ? weighted([['finished', 70], ['want', 25], ['dnf', 5]] as const) : 'finished')
          : (last ? latestStatus() : (chance(0.85) ? 'finished' : 'dnf'));
        const r = makeRead(u.idx, wi, a, status, source, at);
        reads.push(r);
        at = Math.min(NOW - 3_600_000, (r.finishedAt ?? r.abandonedAt ?? at) + randInt(1, 60) * DAY);
      }
    }
  }
  const userRead = (r: R) => users[r.userIdx]!;

  // Private owner: make sure every visibility is represented on their reads.
  const ownReads = reads.filter((r) => r.userIdx === P.privateOwner && r.workIdx !== HOT);
  ownReads.forEach((r, i) => { r.visibility = (['public', 'followers', 'private'] as const)[i % 3]!; });

  // ------------------------------------------------------------- reviews
  const terminal = (r: R) => r.status === 'finished' || r.status === 'dnf';
  interface Rev { id: string; read: R; body: string; hasSpoilers: boolean; spoilerAfterPage: number | null; visibility: R['visibility']; publishedAt: number; editedAt: number | null; deletedAt: number | null }
  const reviews: Rev[] = [];
  const makeReview = (r: R): Rev => {
    const hasSpoilers = chance(0.15);
    const publishedAt = Math.min(NOW, (r.finishedAt ?? r.abandonedAt ?? r.createdAt) + randInt(0, 48) * 3_600_000);
    return {
      id: randomUUID(), read: r,
      body: paragraph(Math.min(9_000, Math.round(logNormal(350, 1.0)) + 20)),
      hasSpoilers,
      spoilerAfterPage: hasSpoilers && chance(0.5) ? randInt(10, works[r.workIdx]!.pages) : null,
      visibility: r.visibility === 'public' ? weighted([['public', 88], ['followers', 8], ['private', 4]] as const) : r.visibility,
      publishedAt,
      editedAt: chance(0.05) ? Math.min(NOW, publishedAt + randInt(1, 20) * DAY) : null,
      deletedAt: chance(0.02) ? Math.min(NOW, publishedAt + randInt(1, 30) * DAY) : null,
    };
  };
  for (const r of hotReads) if (r.status === 'finished') reviews.push(makeReview(r));
  for (const rv of reviews) if (rv.read.userIdx === P.hotReviewer) { rv.visibility = 'public'; rv.deletedAt = null; }
  const reviewable = reads.filter((r) => r.workIdx !== HOT && terminal(r));
  for (const r of distinct(12_000 - reviews.length, () => randInt(0, reviewable.length - 1)).map((i) => reviewable[i]!)) {
    reviews.push(makeReview(r));
  }

  // --------------------------------------------------- likes and comments
  // Only on terminal, non-private reads; always by an accepted follower of
  // the owner (so a followers-only read or a private account is legitimately
  // visible to them), never by a blocked party, never by the owner.
  const social = reads.filter((r) => terminal(r) && r.visibility !== 'private' && followerCount(r.userIdx) > 0);
  const socialWeight = zipfSampler(social.length, 0.6);
  social.sort((a, b) => followerCount(b.userIdx) - followerCount(a.userIdx));
  const likeKeys = new Set<string>();
  const likes: { read_id: string; user_id: string; created_at: Date }[] = [];
  const socialAfter = (r: R) => between(Math.max(r.finishedAt ?? r.abandonedAt ?? r.createdAt, r.createdAt), NOW);
  let guard = 0;
  while (likes.length < 40_000 && guard++ < 400_000) {
    const r = social[socialWeight()]!;
    const liker = pick(followersOf.get(r.userIdx)!);
    const k = `${r.id}:${liker}`;
    if (liker === r.userIdx || blocked(liker, r.userIdx) || likeKeys.has(k)) continue;
    likeKeys.add(k);
    likes.push({ read_id: r.id, user_id: users[liker]!.id, created_at: new Date(socialAfter(r)) });
  }
  const comments: { id: string; read_id: string; user_id: string; body: string; created_at: Date; deleted_at: Date | null }[] = [];
  const addComment = (r: R, by: number) => {
    const at = socialAfter(r);
    comments.push({
      id: randomUUID(), read_id: r.id, user_id: users[by]!.id,
      body: paragraph(Math.round(logNormal(90, 0.8)) + 1).slice(0, 2000),
      created_at: new Date(at),
      deleted_at: chance(0.03) ? new Date(between(at, NOW)) : null,
    });
  };
  // One read with a long thread, for comment pagination.
  const threadRead = social.find((r) => r.userIdx === P.celebrities[0] && r.visibility === 'public' && users[r.userIdx]!.isPrivate === false)!;
  for (let i = 0; i < 400; i++) {
    const by = pick(followersOf.get(threadRead.userIdx)!);
    if (!blocked(by, threadRead.userIdx)) addComment(threadRead, by);
  }
  guard = 0;
  while (comments.length < 8_000 && guard++ < 100_000) {
    const r = social[socialWeight()]!;
    const by = pick(followersOf.get(r.userIdx)!);
    if (by !== r.userIdx && !blocked(by, r.userIdx)) addComment(r, by);
  }

  // ------------------------------------------------------------- shelves
  interface Sh { id: string; userIdx: number; name: string; slug: string; privacy: string; isRanked: boolean; createdAt: number; deletedAt: number | null; items: number[] }
  const shelves: Sh[] = [];
  const makeShelf = (userIdx: number, name: string, privacy: string, size: number, used: Set<string>): Sh => {
    let slug = slugify(name);
    for (let k = 1; used.has(slug); k++) slug = `${slugify(name)}-${k}`;
    used.add(slug);
    return {
      id: randomUUID(), userIdx, name, slug, privacy, isRanked: chance(0.2),
      createdAt: between(NOW - 300 * DAY, NOW - 2 * DAY),
      deletedAt: null,
      items: distinct(size, () => drawWork() + 1),
    };
  };
  const slugsOf = new Map<number, Set<string>>();
  const slugSet = (i: number) => slugsOf.get(i) ?? slugsOf.set(i, new Set()).get(i)!;
  for (const u of users) {
    if (u.idx === P.new) continue;
    let n = 0;
    for (let x = rand(); x > Math.exp(-1.33); x *= rand()) n++; // Poisson(1.33)
    for (let k = 0; k < n; k++) {
      const privacy = weighted([['public', 80], ['followers', 10], ['private', 10]] as const);
      const s = makeShelf(u.idx, pick(SHELF_NAMES), privacy, Math.max(1, Math.min(200, Math.round(logNormal(12, 0.9)))), slugSet(u.idx));
      if (chance(0.04)) s.deletedAt = between(s.createdAt, NOW);
      shelves.push(s);
    }
  }
  // Big shelves (500+ items), the first owned by a celebrity.
  const bigOwners = [P.celebrities[0]!, ...distinct(9, () => randInt(15, N_USERS - 1)).filter((i) => !users[i]!.isPrivate)];
  const bigShelves = bigOwners.map((o, i) => makeShelf(o, i === 0 ? 'Every book I love' : `Big list ${i}`, 'public', randInt(500, 1200), slugSet(o)));
  shelves.push(...bigShelves);
  const privateShelf = makeShelf(P.privateOwner, 'Just for me', 'private', 30, slugSet(P.privateOwner));
  shelves.push(privateShelf);

  const liveShelves = shelves.filter((s) => !s.deletedAt);
  const saveable = liveShelves.filter((s) => s.privacy === 'public' && !users[s.userIdx]!.isPrivate);
  saveable.sort((a, b) => b.items.length - a.items.length);
  const drawShelf = zipfSampler(saveable.length, 0.8);
  const saveKeys = new Set<string>();
  const saves: { shelf_id: string; user_id: string; created_at: Date }[] = [];
  const addSave = (s: Sh, u: number) => {
    const k = `${s.id}:${u}`;
    if (u === s.userIdx || u === P.new || blocked(u, s.userIdx) || saveKeys.has(k)) return;
    saveKeys.add(k);
    saves.push({ shelf_id: s.id, user_id: users[u]!.id, created_at: new Date(between(s.createdAt, NOW)) });
  };
  for (let k = 0; k < 60; k++) addSave(saveable[drawShelf()]!, P.heavy[0]!);
  guard = 0;
  while (saves.length < 1_500 && guard++ < 50_000) addSave(saveable[drawShelf()]!, randInt(0, N_USERS - 1));

  // ------------------------------------------------------------ activity
  // Shapes copied from the emitting services; see the header comment.
  const activity: Record<string, unknown>[] = [];
  const act = (actor: number, verb: string, at: number, workId: string | null, objectType: string, objectId: string, metadata: object, vis: string) => {
    if (vis === 'private' || !inWindow(at)) return;
    activity.push({
      actor_id: users[actor]!.id, verb, work_id: workId, object_type: objectType, object_id: objectId,
      metadata, visibility: users[actor]!.isPrivate ? 'followers' : vis, created_at: new Date(Math.min(at, NOW)),
    });
  };
  const timeOn = (dayMs: number) => dayMs + randInt(8, 22) * 3_600_000; // dates have no time of day
  for (const r of reads) {
    if (r.source === 'import') continue;
    const w = works[r.workIdx]!;
    // ReadingService.setStatus creates the attempt (as want/reading) ...
    act(r.userIdx, 'started', r.createdAt, w.id, 'read', r.id,
      { rating: null, attemptNo: r.attemptNo, finishedAt: null }, r.visibility);
    // ... and finish() / dnf() emit the terminal card.
    if (r.status === 'finished' && r.finishedAt) {
      act(r.userIdx, 'finished', timeOn(r.finishedAt), w.id, 'read', r.id,
        { rating: r.rating, finishedAt: isoDate(r.finishedAt) }, r.visibility);
    }
    if (r.status === 'dnf' && r.abandonedAt) {
      act(r.userIdx, 'dnf', timeOn(r.abandonedAt), w.id, 'read', r.id,
        { abandonedPage: r.abandonedPage, dnfReason: r.dnfReason }, r.visibility);
    }
  }
  for (const rv of reviews) {
    if (rv.read.source === 'import' || rv.deletedAt) continue;
    act(rv.read.userIdx, 'reviewed', rv.publishedAt, works[rv.read.workIdx]!.id, 'review', rv.id,
      { readId: rv.read.id, hasSpoilers: rv.hasSpoilers, snippet: rv.body.trim().slice(0, 200) }, rv.visibility);
  }
  for (const e of accepted) {
    act(e.f, 'followed', e.at, null, 'user', users[e.t]!.id, { followeeId: users[e.t]!.id }, 'public');
  }
  const shelfItems: Record<string, unknown>[] = [];
  for (const s of shelves) {
    s.items.forEach((wi, pos) => {
      const addedAt = between(s.createdAt, s.deletedAt ?? NOW);
      const note = chance(0.05) ? sentence(3, 12) : null;
      shelfItems.push({
        shelf_id: s.id, work_id: works[wi]!.id, position: pos + 1, note,
        added_at: new Date(addedAt), added_by: users[s.userIdx]!.id,
      });
      if (!s.deletedAt) {
        act(s.userIdx, 'shelved', addedAt, works[wi]!.id, 'shelf_item', s.id,
          { shelfId: s.id, shelfName: s.name, shelfSlug: s.slug, note }, s.privacy);
      }
    });
  }

  // --------------------------------------------------------- progress
  const progress: Record<string, unknown>[] = [];
  for (const r of reads) {
    if (r.source === 'import' || !r.startedAt) continue;
    const n = r.status === 'finished' ? randInt(3, 8)
      : r.status === 'reading' ? randInt(2, 10)
      : r.status === 'paused' ? randInt(1, 5)
      : r.status === 'dnf' ? randInt(1, 4) : 0;
    if (!n) continue;
    const pages = works[r.workIdx]!.pages;
    const endPage = r.status === 'finished' ? pages : r.status === 'dnf' ? (r.abandonedPage ?? pages / 3) : randInt(10, pages - 1);
    const endAt = r.finishedAt ?? r.abandonedAt ?? Math.min(NOW - 60_000, r.startedAt + randInt(1, 40) * DAY);
    const stamps = Array.from({ length: n }, () => between(r.startedAt!, Math.max(r.startedAt! + 3_600_000, endAt))).sort((a, b) => a - b);
    stamps.forEach((at, i) => {
      const page = Math.max(1, Math.round((endPage * (i + 1)) / n));
      progress.push({
        read_id: r.id, at: new Date(Math.min(at, NOW)), page,
        percent: Math.min(100, Math.round((page / pages) * 10_000) / 100),
        minutes: randInt(10, 90), note: chance(0.05) ? sentence(3, 20) : null,
        client_event_id: randomUUID(),
      });
    });
  }
  t.lap('generate', `(${activity.length} activity rows planned)`);

  // ------------------------------------------------------------- write
  const [su] = await sql<{ superuser: boolean }[]>`SELECT current_setting('is_superuser') = 'on' AS superuser`;
  const superuser = su?.superuser === true;
  const bulk = superuser && !process.argv.includes('--with-triggers');
  console.log(bulk ? '  mode: bulk (triggers and FK checks off inside the transaction; verified below)' : '  mode: triggers on');
  await sql.begin(async (tx) => {
    if (bulk) await tx`SET LOCAL session_replication_role = replica`;
    await insertRows(tx, 'users', users.map((u) => ({
      id: u.id, email: u.email, email_verified_at: new Date(u.createdAt + 600_000), password_hash: passwordHash,
      date_of_birth: `${randInt(1955, 2008)}-0${randInt(1, 9)}-1${randInt(0, 9)}`, role: 'user', created_at: new Date(u.createdAt),
    })));
    await insertRows(tx, 'profiles', users.map((u) => ({
      user_id: u.id, username: u.username, display_name: u.displayName,
      bio: chance(0.6) ? sentence(4, 20).slice(0, 160) : null, is_private: u.isPrivate, created_at: new Date(u.createdAt),
    })));
    t.lap('users + profiles', `(${users.length})`);

    await insertRows(tx, 'follows', follows.map((e) => ({
      follower_id: users[e.f]!.id, followee_id: users[e.t]!.id, state: e.state, created_at: new Date(e.at),
    })));
    t.lap('follows', `(${follows.length}; ${follows.length - accepted.length} pending)`);

    await insertRows(tx, 'blocks', blocks.map(([a, b]) => ({
      blocker_id: users[a]!.id, blocked_id: users[b]!.id, created_at: new Date(between(NOW - 200 * DAY, NOW)),
    })));
    await insertRows(tx, 'mutes', mutes);
    t.lap('blocks + mutes', `(${blocks.length} + ${mutes.length})`);

    await insertRows(tx, 'reads', reads.map((r) => ({
      id: r.id, user_id: userRead(r).id, work_id: works[r.workIdx]!.id, edition_id: works[r.workIdx]!.editionId,
      status: r.status, attempt_no: r.attemptNo,
      started_at: r.startedAt ? isoDate(r.startedAt) : null, finished_at: r.finishedAt ? isoDate(r.finishedAt) : null,
      abandoned_at: r.abandonedAt ? isoDate(r.abandonedAt) : null, abandoned_page: r.abandonedPage, dnf_reason: r.dnfReason,
      rating: r.rating, hearted: r.hearted, source: r.source, visibility: r.visibility,
      created_at: new Date(r.createdAt), updated_at: new Date(r.updatedAt),
    })));
    t.lap('reads', `(${reads.length})`);

    await insertRows(tx, 'progress_events', progress);
    t.lap('progress_events', `(${progress.length})`);

    await insertRows(tx, 'reviews', reviews.map((rv) => ({
      id: rv.id, read_id: rv.read.id, user_id: userRead(rv.read).id, work_id: works[rv.read.workIdx]!.id,
      body: rv.body, has_spoilers: rv.hasSpoilers, spoiler_after_page: rv.spoilerAfterPage, visibility: rv.visibility,
      published_at: new Date(rv.publishedAt), edited_at: rv.editedAt ? new Date(rv.editedAt) : null,
      deleted_at: rv.deletedAt ? new Date(rv.deletedAt) : null,
    })));
    t.lap('reviews', `(${reviews.length})`);

    await insertRows(tx, 'read_likes', likes);
    await insertRows(tx, 'read_comments', comments);
    t.lap('likes + comments', `(${likes.length} + ${comments.length})`);

    await insertRows(tx, 'shelves', shelves.map((s) => ({
      id: s.id, user_id: users[s.userIdx]!.id, name: s.name, slug: s.slug,
      description: chance(0.3) ? sentence(5, 20) : null, is_ranked: s.isRanked, privacy: s.privacy,
      created_at: new Date(s.createdAt), deleted_at: s.deletedAt ? new Date(s.deletedAt) : null,
    })));
    await insertRows(tx, 'shelf_items', shelfItems);
    await insertRows(tx, 'shelf_saves', saves);
    t.lap('shelves + items + saves', `(${shelves.length} + ${shelfItems.length} + ${saves.length})`);

    await insertRows(tx, 'activity', activity);
    t.lap('activity', `(${activity.length})`);

    if (bulk) {
      await tx`SET LOCAL session_replication_role = origin`;
      // Replica mode skipped the RI triggers, so check every FK by hand.
      const fks = await tx<{ child: string; col: string; parent: string; pcol: string; name: string }[]>`
        SELECT c.conname AS name, c.conrelid::regclass::text AS child, a.attname AS col,
               c.confrelid::regclass::text AS parent, pa.attname AS pcol
        FROM pg_constraint c
        JOIN pg_attribute a  ON a.attrelid = c.conrelid  AND a.attnum = c.conkey[1]
        JOIN pg_attribute pa ON pa.attrelid = c.confrelid AND pa.attnum = c.confkey[1]
        WHERE c.contype = 'f' AND array_length(c.conkey, 1) = 1
          AND c.conrelid::regclass::text = ANY(${SEEDED_TABLES}::text[])
      `;
      const broken: string[] = [];
      for (const fk of fks) {
        const [row] = await tx.unsafe<{ n: number }[]>(
          `SELECT count(*)::int AS n FROM ${fk.child} c WHERE c.${fk.col} IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE p.${fk.pcol} = c.${fk.col})`,
        );
        if (row!.n) broken.push(`${fk.name}: ${row!.n}`);
      }
      if (broken.length) throw new Error(`foreign keys violated (rolled back): ${broken.join(', ')}`);
      t.lap('verify foreign keys', `(${fks.length} checked)`);

      // Counters, from the product's own definitions.
      await tx`SELECT reconcile_follow_counters()`;
      await tx`SELECT reconcile_shelf_counters()`;
      await tx`SELECT reconcile_read_counters()`;
      t.lap('derive counters');
      const touched = [...new Set(reads.map((r) => works[r.workIdx]!.id))];
      await tx`SELECT recompute_work_stats_for_work(w) FROM unnest(${touched}::uuid[]) AS w`;
      t.lap('recompute work_stats', `(${touched.length} works)`);
    }
  });

  // Counters are now either trigger-maintained or already reconciled, so the
  // reconcilers must find nothing to fix. They are run anyway (the brief asks
  // for it) and the read count is printed: non-zero means drift.
  const [rr] = await sql<{ n: number }[]>`SELECT reconcile_read_counters() AS n`;
  await sql`SELECT reconcile_shelf_counters()`;
  await sql`SELECT reconcile_follow_counters()`;
  t.lap('reconcile', `(reconcile_read_counters fixed ${rr!.n} reads)`);
  for (const table of ['users', 'profiles', 'follows', 'blocks', 'mutes', 'reads', 'progress_events', 'reviews', 'read_likes', 'read_comments', 'shelves', 'shelf_items', 'shelf_saves', 'activity', 'work_stats']) {
    await sql.unsafe(`ANALYZE ${table}`);
  }
  t.lap('analyze');

  // --------------------------------------------------------------- tokens
  const [followCounts] = await Promise.all([
    sql<{ user_id: string; follower_count: number; following_count: number }[]>`
      SELECT user_id, follower_count, following_count FROM profiles WHERE username LIKE 'bench\\_%'`,
  ]);
  const fc = new Map(followCounts.map((r) => [r.user_id, r]));
  const following = (i: number) => fc.get(users[i]!.id)!.following_count;
  const hasReadingRead = new Set(reads.filter((r) => r.status === 'reading' && r.source === 'app' && r.workIdx !== HOT).map((r) => r.userIdx));
  const typicalIdx = users
    .filter((u) => !special.has(u.idx) && !u.isPrivate && hasReadingRead.has(u.idx))
    .sort((a, b) => Math.abs(following(a.idx) - 40) - Math.abs(following(b.idx) - 40))[0]!.idx;

  const persona = async (i: number) => {
    const u = users[i]!;
    const c = fc.get(u.id)!;
    return {
      user_id: u.id, username: u.username, email: u.email, is_private: u.isPrivate,
      following: c.following_count, followers: c.follower_count,
      token: await signAccessToken(u.id),
    };
  };
  const readingRead = (i: number) => reads.find((r) => r.userIdx === i && r.status === 'reading' && r.source === 'app' && r.workIdx !== HOT)?.id ?? null;
  const hotReview = reviews.find((rv) => rv.read.userIdx === P.hotReviewer)!;
  const bigShelf = bigShelves.reduce((a, b) => (b.items.length > a.items.length ? b : a));
  const out = {
    generated_at: new Date().toISOString(),
    note: 'Access tokens expire 15 minutes after generated_at. run.ts re-mints them from user_id with the same JWT_SECRET, so a stale file is fine.',
    password: BENCH_PASSWORD,
    personas: {
      heavy: await persona(P.heavy[0]!),
      typical: await persona(typicalIdx),
      new: await persona(P.new),
      private_owner: await persona(P.privateOwner),
      blocked_pair_a: await persona(P.blockedA),
      blocked_pair_b: await persona(P.blockedB),
      celebrity: await persona(P.celebrities[0]!),
      reviewer_of_hot_work: await persona(P.hotReviewer),
    },
    ids: {
      hot_work_id: works[HOT]!.id,
      hot_work_review_count: reviews.filter((rv) => rv.read.workIdx === HOT).length,
      hot_review_id: hotReview.id,
      big_shelf_id: bigShelf.id,
      big_shelf_items: bigShelf.items.length,
      private_shelf_id: privateShelf.id,
      thread_read_id: threadRead.id,
      thread_comment_count: comments.filter((c) => c.read_id === threadRead.id).length,
      typical_reading_read_id: readingRead(typicalIdx),
      heavy_reading_read_id: readingRead(P.heavy[0]!),
    },
    counts: {
      users: users.length, private_users: users.filter((u) => u.isPrivate).length,
      follows: follows.length, pending_follows: follows.length - accepted.length,
      blocks: blocks.length, mutes: mutes.length, reads: reads.length,
      import_reads: reads.filter((r) => r.source === 'import').length,
      rereads: reads.filter((r) => r.attemptNo > 1).length,
      progress_events: progress.length, reviews: reviews.length, likes: likes.length, comments: comments.length,
      shelves: shelves.length, shelf_items: shelfItems.length, saves: saves.length, activity: activity.length,
    },
  };
  fs.writeFileSync(TOKENS_PATH, JSON.stringify(out, null, 2));
  console.log(`\nwrote ${path.relative(process.cwd(), TOKENS_PATH)}`);
  console.table(out.counts);
  console.log(`done in ${t.total().toFixed(0)}s`);
}

// ------------------------------------------------------------------ clean

/** Tables with a user-referencing column, checked for survivors after --clean. */
const USER_COLUMNS: [string, string][] = [
  ['profiles', 'user_id'], ['refresh_tokens', 'user_id'], ['email_verification_tokens', 'user_id'],
  ['password_reset_tokens', 'user_id'], ['reads', 'user_id'], ['reviews', 'user_id'],
  ['read_likes', 'user_id'], ['read_comments', 'user_id'], ['follows', 'follower_id'],
  ['follows', 'followee_id'], ['blocks', 'blocker_id'], ['blocks', 'blocked_id'], ['mutes', 'user_id'],
  ['mutes', 'target_id'], ['activity', 'actor_id'], ['activity', 'object_id'], ['shelves', 'user_id'],
  ['shelf_saves', 'user_id'], ['shelf_items', 'added_by'], ['imports', 'user_id'], ['exports', 'user_id'],
  ['events', 'user_id'], ['admin_credentials', 'user_id'],
];

async function clean(sql: Sql) {
  const t = timer();
  const ids = (
    await sql<{ id: string }[]>`
      SELECT u.id FROM users u JOIN profiles p ON p.user_id = u.id
      WHERE p.username LIKE 'bench\\_%' AND u.email LIKE ${'%@' + BENCH_EMAIL_DOMAIN}
    `
  ).map((r) => r.id);
  const [stray] = await sql<{ n: number }[]>`
    SELECT count(*)::int AS n FROM users u LEFT JOIN profiles p ON p.user_id = u.id
    WHERE (u.email LIKE ${'%@' + BENCH_EMAIL_DOMAIN}) <> (coalesce(p.username, '') LIKE 'bench\\_%')
  `;
  if (stray!.n > 0) {
    // Half-matching users were not created by this script. Refuse rather than guess.
    throw new Error(`${stray!.n} users match only one of the bench username/email patterns; not touching anything`);
  }
  if (!ids.length) {
    console.log('no bench users; nothing to clean');
    if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
    return;
  }
  console.log(`cleaning ${ids.length} bench users`);

  await sql.begin(async (tx) => {
    // work_stats rows are derived: the reads trigger upserts one per touched
    // work and, on delete, recomputes it to zeros instead of removing it.
    // Remember which works bench reads touched so that zero rows the seed
    // created can be removed below.
    const touched = (await tx<{ work_id: string }[]>`
      SELECT DISTINCT work_id FROM reads WHERE user_id = ANY(${ids}::uuid[])
    `).map((r) => r.work_id);
    t.lap('collect touched works', `(${touched.length})`);

    const deleted = await tx`DELETE FROM users WHERE id = ANY(${ids}::uuid[])`;
    t.lap('delete users (cascade)', `(${deleted.count})`);

    const [ws] = await tx<{ n: number }[]>`
      WITH d AS (
        DELETE FROM work_stats ws
        WHERE ws.work_id = ANY(${touched}::uuid[])
          AND NOT EXISTS (SELECT 1 FROM reads r WHERE r.work_id = ws.work_id)
          AND ws.rating_count = 0 AND ws.heart_count = 0 AND ws.read_count = 0 AND ws.dnf_count = 0
        RETURNING 1
      ) SELECT count(*)::int AS n FROM d
    `;
    t.lap('drop emptied work_stats', `(${ws!.n})`);

    // Buckets are keyed by email (login, forgot-password) or user id
    // (comments, resend-verification) and have no foreign key.
    const rl = await tx`
      DELETE FROM rate_limits
      WHERE bucket LIKE ${'%@' + BENCH_EMAIL_DOMAIN}
         OR substring(bucket from '[0-9a-f-]{36}$') = ANY(${ids}::text[])
    `;
    t.lap('rate-limit buckets', `(${rl.count})`);

    // Verify: no row anywhere still points at a bench user.
    const survivors: string[] = [];
    for (const [table, col] of USER_COLUMNS) {
      const [row] = await tx.unsafe<{ n: number }[]>(
        `SELECT count(*)::int AS n FROM ${table} WHERE ${col} = ANY($1::uuid[])`, [ids],
      );
      if (row!.n) survivors.push(`${table}.${col}: ${row!.n}`);
    }
    const [left] = await tx<{ n: number }[]>`
      SELECT count(*)::int AS n FROM users WHERE email LIKE ${'%@' + BENCH_EMAIL_DOMAIN}
    `;
    if (left!.n) survivors.push(`users: ${left!.n}`);
    if (survivors.length) throw new Error(`clean left bench rows behind (rolled back): ${survivors.join(', ')}`);
    t.lap('verify no survivors');
  });

  await sql`SELECT reconcile_shelf_counters()`;
  await sql`SELECT reconcile_follow_counters()`;
  for (const table of ['users', 'profiles', 'follows', 'reads', 'progress_events', 'reviews', 'read_likes', 'read_comments', 'shelves', 'shelf_items', 'shelf_saves', 'activity', 'work_stats']) {
    await sql.unsafe(`ANALYZE ${table}`);
  }
  if (fs.existsSync(TOKENS_PATH)) fs.unlinkSync(TOKENS_PATH);
  t.lap('reconcile + analyze');
  console.log(`clean done in ${t.total().toFixed(0)}s`);
}

// ------------------------------------------------------------------- main

// Run only when invoked directly: run.ts imports the constants above.
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = makeDb(undefined, { max: 2, quiet: true });
  try {
    if (process.argv.includes('--clean')) await clean(db.$client);
    else await seed(db.$client);
  } catch (err) {
    console.error(err);
    process.exitCode = 1;
  } finally {
    await closeDb(db);
  }
}
