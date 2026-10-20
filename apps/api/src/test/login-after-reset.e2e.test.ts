// Beta bug (Oct 2026): forgot password → reset from the emailed link → sign
// out → sign in with the new password said "Email or password is incorrect"
// every time.
//
// End to end: the API built as production builds it (server-wiring.ts, every
// rate limit on), driven by the mobile app's own modules: the refresh
// interceptor (authFetch.ts), the session flow (sessionFlow.ts), the guest
// shelf (guest.ts), telemetry (events.ts) and the sign-in messages
// (authErrors.ts), with the typed client from packages/api-client. Only
// api.ts's SecureStore and fetch are stood in for (a Map, app.inject).
//
// What it pins:
// - the whole path works by both reset routes: the web form the email links
//   to, and the in-app screen the same link opens (POST /v1/auth/reset-password);
// - the failure the beta hit: signed-out traffic spends the per-IP anonymous
//   Global tier (200/hour, PRD §24.4), and sign-in is checked against it. The
//   429 used to read as a wrong password; it now says when to try again;
// - an hour of guest use after sign-out leaves the budget for sign-in:
//   telemetry waits out a 429 instead of re-sending every 15 s;
// - a post-login step failing never fails the sign-in, and guest books
//   survive a failed migration.
//
// The mobile modules are loaded by path at run time: a static import would
// make this package's tsc compile them against the API's settings.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { PgBoss } from 'pg-boss';
import { fileURLToPath } from 'node:url';
import { eq, sql } from 'drizzle-orm';
import { FlyleafClient } from '../../../../packages/api-client/dist/index.js';
import { buildApp } from '../app.js';
import { serverDependencies } from '../server-wiring.js';
import { createProviders, MemoryEmailSender } from '../providers/index.js';
import { MemoryRateLimiter, RateLimits } from '../platform/rate-limits.js';
import { reads } from '../db/schema.js';
import type { Db } from '../platform/index.js';
import { freshDrizzle } from './pg.js';
import { makeWork } from './interaction-fixtures.js';

// ---------------------------------------------------------------- the mobile modules

type ApiErr = Error & { status?: number; code?: string; retryAfterSeconds?: number };
type User = { id: string; email: string; username: string };

interface GuestManagerLike {
  addBook(book: { id: string; title: string; author_name: string }): Promise<{ success: boolean }>;
  getCount(): number;
  migrateToServer(api: {
    reads: () => Promise<{ work_id: string }[]>;
    setStatus: (workId: string, status: string) => Promise<unknown>;
  }): Promise<{ count: number; message: string | null }>;
  cancelMigration(): void;
}

interface Mobile {
  createAuthFetch: (deps: Record<string, unknown>) => typeof fetch;
  createSessionFlow: <U>(deps: Record<string, unknown>) => {
    signIn(email: string, password: string): Promise<{ user: U; guestMigration: Promise<void> }>;
    signUp(email: string, username: string, password: string, dob: string): Promise<{ user: U; guestMigration: Promise<void> }>;
    signOut(): Promise<void>;
  };
  GuestManager: new () => GuestManagerLike;
  loginErrorMessage: (err: unknown) => string;
  INCORRECT_CREDENTIALS: string;
  appPathFor: (input: string, hosts?: readonly string[]) => string;
  events: {
    track(name: string, props?: Record<string, unknown>): void;
    flushEvents(): Promise<number>;
    resetTelemetry(): void;
    clearEventQueue(): void;
    setTelemetryTransport(t: ((batch: unknown[]) => Promise<{ accepted: number }>) | null): void;
    setTelemetryClock(c: (() => number) | null): void;
  };
}

const mobileLib = (file: string) => fileURLToPath(new URL(`../../../mobile/src/lib/${file}`, import.meta.url));

async function loadMobile(): Promise<Mobile> {
  const load = (file: string) => import(/* @vite-ignore */ mobileLib(file));
  const [authFetch, sessionFlow, guest, authErrors, appLinks, events] = await Promise.all([
    load('authFetch.ts'),
    load('sessionFlow.ts'),
    load('guest.ts'),
    load('authErrors.ts'),
    load('appLinks.ts'),
    load('events.ts'),
  ]);
  return {
    createAuthFetch: authFetch.createAuthFetch,
    createSessionFlow: sessionFlow.createSessionFlow,
    GuestManager: guest.GuestManager,
    loginErrorMessage: authErrors.loginErrorMessage,
    INCORRECT_CREDENTIALS: authErrors.INCORRECT_CREDENTIALS,
    appPathFor: appLinks.appPathFor,
    events,
  };
}

// ---------------------------------------------------------------- the server

let m: Mobile;
let db: Db;
let app: FastifyInstance;
let mailer: MemoryEmailSender;
/** The in-process limits' clock (Global, events): an hour passes in a test. */
let clock = Date.now();

beforeAll(async () => {
  m = await loadMobile();
  ({ db } = await freshDrizzle());
  const providers = createProviders({ STORAGE_DRIVER: 'memory', EMAIL_DRIVER: 'memory', ERROR_DRIVER: 'memory' });
  mailer = providers.mailer as MemoryEmailSender;
  const boss = { send: async () => 'job-1' } as unknown as PgBoss;
  const deps = serverDependencies(db, boss, providers);
  // Production: every limit on (server-wiring.ts says so outside tests).
  const rateLimits = new RateLimits({ exact: deps.limiter, fast: new MemoryRateLimiter(() => clock), enabled: 'all' });
  deps.identity.limits = rateLimits;
  app = await buildApp({ ...deps, rateLimits });
  await app.ready();
}, 60_000);

afterAll(async () => {
  m?.events.setTelemetryTransport(null);
  m?.events.setTelemetryClock(null);
  await app?.close();
});

beforeEach(async () => {
  // Each test is a fresh hour for the in-process limits, and the Postgres
  // ones (login, forgot, auth per IP) start empty.
  clock += 2 * 60 * 60 * 1000;
  await db.execute(sql`DELETE FROM rate_limits`);
  m.events.clearEventQueue();
});

// ---------------------------------------------------------------- the phone

/** fetch → app.inject. Every call is from the same address, like one phone. */
const toServer = (async (input: string | URL | Request, init: RequestInit = {}) => {
  const url = new URL(String(input));
  const res = await app.inject({
    method: (init.method ?? 'GET') as 'GET',
    url: `${url.pathname}${url.search}`,
    headers: Object.fromEntries(new Headers(init.headers).entries()),
    payload: init.body as string | undefined,
  });
  return new Response(res.rawPayload.length ? res.rawPayload : null, {
    status: res.statusCode,
    headers: res.headers as Record<string, string>,
  });
}) as typeof fetch;

/** The app on one phone: api.ts's wiring with a Map for SecureStore, and session.tsx's flow. */
function phone() {
  const store = new Map<string, string>();
  let user: User | null = null;
  const saveTokens = async (access: string, refresh?: string) => {
    store.set('access', access);
    if (refresh) store.set('refresh', refresh);
  };
  const clearTokens = async () => void store.clear();
  const authFetch = m.createAuthFetch({
    fetch: toServer,
    refreshUrl: 'http://localhost/v1/auth/refresh',
    loadAccessToken: async () => store.get('access') ?? null,
    loadRefreshToken: async () => store.get('refresh') ?? null,
    saveTokens,
    clearTokens,
    onSessionEnded: () => {
      user = null;
    },
  });
  const client = new FlyleafClient({ baseUrl: 'http://localhost/v1', getToken: async () => store.get('access') ?? null, fetch: authFetch });
  const guest = new m.GuestManager();
  const api = {
    reads: () => client.getReads(),
    setStatus: (workId: string, status: string) =>
      client.createRead({ work_id: workId, status: status as 'want', rating: null, hearted: null, edition_id: null, format_override: null, started_at: null }),
  };
  const stepErrors: string[] = [];
  const overrides: Record<string, unknown> = {};
  const flow = () =>
    m.createSessionFlow<User>({
      login: async (email: string, password: string) => {
        const r = await client.login({ email, password });
        await saveTokens(r.accessToken, r.refreshToken);
        return { user: r.user };
      },
      register: async (email: string, username: string, password: string, dateOfBirth: string) => {
        const r = await client.register({ email, username, password, dateOfBirth });
        await saveTokens(r.accessToken, r.refreshToken);
        return { user: r.user };
      },
      logout: async () => {
        try {
          const refreshToken = store.get('refresh');
          if (refreshToken) await client.logout({ refreshToken });
        } finally {
          await clearTokens();
        }
      },
      me: () => client.getMe(),
      saveSessionUser: async () => {},
      clearCache: () => {},
      setUser: (u: User | null) => {
        user = u;
      },
      migrateGuest: () => guest.migrateToServer(api),
      cancelGuestMigration: () => guest.cancelMigration(),
      resetTelemetry: () => m.events.resetTelemetry(),
      onStepError: (step: string) => stepErrors.push(step),
      ...overrides,
    });
  return {
    client,
    guest,
    stepErrors,
    overrides,
    get user() {
      return user;
    },
    get signedIn() {
      return store.has('access');
    },
    flow,
    /** What the sign-in screen does: the session flow, and the message on failure. */
    async signIn(email: string, password: string): Promise<{ ok: true; guestMigration: Promise<void> } | { ok: false; message: string; err: ApiErr }> {
      try {
        const { guestMigration } = await flow().signIn(email, password);
        return { ok: true, guestMigration };
      } catch (err) {
        return { ok: false, message: m.loginErrorMessage(err), err: err as ApiErr };
      }
    },
  };
}

// ---------------------------------------------------------------- the email

function resetLinkFromEmail(): string {
  const text = mailer.lastMessage()?.text ?? '';
  const link = /(https?:\/\/\S+\/reset-password\?token=[A-Za-z0-9_-]+)/.exec(text)?.[1];
  if (!link) throw new Error(`no reset link in: ${text}`);
  return link;
}

/** The emailed link opened in a browser: the server's page, its form posted. */
async function resetOnTheWeb(link: string, newPassword: string) {
  const url = new URL(link);
  const page = await app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
  expect(page.statusCode).toBe(200);
  const token = /name="token" value="([^"]+)"/.exec(page.body)?.[1];
  expect(token).toBe(url.searchParams.get('token'));
  const done = await app.inject({
    method: 'POST',
    url: '/reset-password',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    payload: new URLSearchParams({ token: token!, newPassword, confirmPassword: newPassword }).toString(),
  });
  expect(done.statusCode).toBe(200);
  expect(done.body).toContain('Password changed');
}

/** The emailed link opened in the app: +native-intent → app/reset-password.tsx → api.resetPassword. */
async function resetInTheApp(device: ReturnType<typeof phone>, link: string, newPassword: string) {
  const url = new URL(link);
  const route = m.appPathFor(link, [url.host]);
  const routed = new URL(route, 'flyleaf://app');
  expect(routed.pathname).toBe('/reset-password');
  const token = routed.searchParams.get('token');
  expect(token).toBe(url.searchParams.get('token'));
  await device.client.resetPassword({ token: token!, newPassword });
}

const FIRST = 'first password for flyleaf';
const SECOND = 'a brand new reading password';

let n = 0;
async function signedUpThenSignedOut(device: ReturnType<typeof phone>) {
  n++;
  const email = `Reader.${n}@Example.com`;
  await device.flow().signUp(email, `reader_${n}`, FIRST, '1990-04-01');
  expect(device.user?.username).toBe(`reader_${n}`);
  await device.flow().signOut();
  expect(device.signedIn).toBe(false);
  expect(device.user).toBeNull();
  return email.toLowerCase();
}

async function guestSaves(device: ReturnType<typeof phone>, count: number): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    const id = await makeWork(db, `Guest book ${n}.${i}`);
    expect((await device.guest.addBook({ id, title: `Guest book ${i}`, author_name: 'A. Writer' })).success).toBe(true);
    ids.push(id);
  }
  return ids;
}

async function libraryOf(userId: string): Promise<string[]> {
  return (await db.select({ workId: reads.workId }).from(reads).where(eq(reads.userId, userId))).map((r) => r.workId).sort();
}

// ---------------------------------------------------------------- tests

describe.each([
  ['the web form the email links to', 'web'],
  ['the in-app reset screen', 'app'],
] as const)('forgot → reset by %s → sign in', (_label, route) => {
  it('signs in with the new password, migrates the guest shelf, and refuses the old password as incorrect', async () => {
    const device = phone();
    const email = await signedUpThenSignedOut(device);
    const saved = await guestSaves(device, 3);

    await device.client.forgotPassword({ email: email.toUpperCase() }); // the app trims; case is the server's to fold
    const link = resetLinkFromEmail();
    if (route === 'web') await resetOnTheWeb(link, SECOND);
    else await resetInTheApp(device, link, SECOND);

    const old = await device.signIn(email, FIRST);
    expect(old.ok).toBe(false);
    if (!old.ok) {
      expect(old.err.status).toBe(401);
      expect(old.message).toBe(m.INCORRECT_CREDENTIALS);
    }

    const signIn = await device.signIn(email, SECOND);
    expect(signIn.ok).toBe(true);
    if (signIn.ok) await signIn.guestMigration;
    expect(device.user?.email).toBe(email);
    expect(device.stepErrors).toEqual([]);
    expect(await libraryOf(device.user!.id)).toEqual([...saved].sort());
    expect(device.guest.getCount()).toBe(0);

    // The token is spent: the same link cannot reset again.
    if (route === 'app') await expect(resetInTheApp(device, link, 'yet another long password')).rejects.toMatchObject({ status: 400 });
  });

  it('the reset signs out a phone that was still signed in, and that phone can sign in again', async () => {
    const device = phone();
    n++;
    const email = `still.signed.in.${n}@example.com`;
    await device.flow().signUp(email, `still_${n}`, FIRST, '1990-04-01');

    await device.client.forgotPassword({ email });
    const link = resetLinkFromEmail();
    if (route === 'web') await resetOnTheWeb(link, SECOND);
    else await resetInTheApp(device, link, SECOND);

    // The order the beta report gives: reset, then sign out, then sign in.
    await device.flow().signOut();
    expect(device.signedIn).toBe(false);
    const signIn = await device.signIn(email, SECOND);
    expect(signIn.ok).toBe(true);
    expect(device.user?.email).toBe(email);
  });
});

describe('the beta failure: the anonymous per-IP budget', () => {
  it('when signed-out traffic has spent it, the correct password gets a 429, and the message says when to try again', async () => {
    const device = phone();
    const email = await signedUpThenSignedOut(device);
    await device.client.forgotPassword({ email });
    await resetOnTheWeb(resetLinkFromEmail(), SECOND);

    // 200 anonymous requests in the hour from this address: browsing as a
    // guest, or the old telemetry loop re-sending a refused batch every 15 s.
    for (let i = 0; i < 200; i++) {
      await device.client.postEvents([{ name: 'app_opened', properties: {} } as never]).catch(() => {});
    }

    const signIn = await device.signIn(email, SECOND);
    expect(signIn.ok).toBe(false);
    if (signIn.ok) return;
    expect(signIn.err).toMatchObject({ status: 429, code: 'rate_limited' });
    expect(signIn.err.retryAfterSeconds).toBeGreaterThan(0);
    // It used to say "Email or password is incorrect".
    expect(signIn.message).not.toBe(m.INCORRECT_CREDENTIALS);
    expect(signIn.message).toMatch(/^Too many attempts\. Try again in \d+ minutes?\.$/);
  });

  it('an hour of guest use after sign-out (browsing, an event every 15 s) leaves sign-in working', async () => {
    const device = phone();
    const email = await signedUpThenSignedOut(device);
    await device.client.forgotPassword({ email });
    await resetOnTheWeb(resetLinkFromEmail(), SECOND);

    let posts = 0;
    let inFlight: Promise<unknown> = Promise.resolve();
    m.events.setTelemetryClock(() => clock);
    m.events.setTelemetryTransport((batch) => {
      posts++;
      const sent = device.client.postEvents(batch as never);
      inFlight = sent.catch(() => {});
      return sent;
    });
    try {
      for (let tick = 0; tick < 240; tick++) {
        m.events.track('app_opened', {});
        // Browsing as a guest: a page every 2 minutes.
        if (tick % 8 === 0) expect((await device.client.browseShelves()).shelves).toBeDefined();
        await m.events.flushEvents(); // the 15 s timer
        await inFlight; // 15 s is long enough for any send to settle
        clock += 15_000;
      }
    } finally {
      m.events.setTelemetryTransport(null);
      m.events.setTelemetryClock(null);
    }
    clock -= 15_000; // still inside the hour

    // events:ip refuses telemetry after 120 an hour. The client now waits for
    // Retry-After; it used to re-send every tick, and with the browsing that
    // took the address past the Global tier's 200 (190 sends here).
    expect(posts).toBeLessThanOrEqual(125);
    const signIn = await device.signIn(email, SECOND);
    expect(signIn.ok).toBe(true);
  });
});

describe('post-login steps cannot fail a sign-in', () => {
  it('a /v1/me failure and a guest migration that cannot reach the server: signed in, books kept', async () => {
    const device = phone();
    const email = await signedUpThenSignedOut(device);
    await guestSaves(device, 2);
    await device.client.forgotPassword({ email });
    await resetInTheApp(device, resetLinkFromEmail(), SECOND);

    device.overrides.me = async () => {
      throw Object.assign(new Error('Bad gateway'), { status: 502 });
    };
    device.overrides.migrateGuest = () =>
      device.guest.migrateToServer({
        reads: async () => [],
        setStatus: async () => {
          throw new TypeError('Network request failed');
        },
      });
    const signIn = await device.signIn(email, SECOND);
    expect(signIn.ok).toBe(true);
    if (signIn.ok) await signIn.guestMigration;
    expect(device.stepErrors).toEqual(['me']);
    expect(device.user?.email).toBe(email); // the login response's user
    expect(device.guest.getCount()).toBe(2); // kept for the next sign-in

    // Next sign-in on this phone, with the network back: the books arrive.
    await device.flow().signOut();
    delete device.overrides.me;
    delete device.overrides.migrateGuest;
    const again = await device.signIn(email, SECOND);
    expect(again.ok).toBe(true);
    if (again.ok) await again.guestMigration;
    expect(device.guest.getCount()).toBe(0);
    expect(await libraryOf(device.user!.id)).toHaveLength(2);
  });

  it('a migration that throws outright still leaves the user signed in', async () => {
    const device = phone();
    const email = await signedUpThenSignedOut(device);
    device.overrides.migrateGuest = async () => {
      throw new Error('guest shelf exploded');
    };
    const signIn = await device.signIn(email, FIRST);
    expect(signIn.ok).toBe(true);
    if (signIn.ok) await signIn.guestMigration;
    expect(device.stepErrors).toEqual(['migrateGuest']);
    expect(device.signedIn).toBe(true);
  });
});
