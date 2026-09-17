// Mobile API client backed by @flyleaf/api-client (FN-80, FN-81, SL-03, SL-04).
//
// Features:
// 1. Dual-token storage in expo-secure-store (keychain/keystore).
// 2. 401 refresh interceptor with single-flight mutex.
// 3. client_event_id on all progress writes for offline idempotency.

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

import {
  FlyleafClient,
  FlyleafApiError,
  type User,
  type Profile,
  type Edition,
  type YourRead,
  type Work,
  type Read,
  type ReadStatus,
  type AuthResponse,
  type RefreshResponse,
} from '@flyleaf/api-client';

export type { User, Profile, Edition, YourRead, Work, Read, ReadStatus, AuthResponse, RefreshResponse };
export { FlyleafApiError, FlyleafApiError as ApiError };

const API_PORT = 3000;

function resolveBase(): string {
  const override = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (override) return override;

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri?.split(':')[0];
  if (host) return `http://${host}:${API_PORT}`;

  return `http://10.0.2.2:${API_PORT}`; // Android emulator alias for host
}

export const BASE_URL: string = resolveBase();
export const API_BASE = `${BASE_URL}/v1`;

const ACCESS_TOKEN_KEY = 'flyleaf.access_token';
const REFRESH_TOKEN_KEY = 'flyleaf.refresh_token';
// Legacy key for backwards compatibility
const LEGACY_TOKEN_KEY = 'flyleaf.token';

// ---------------------------------------------------------------- Storage
export async function saveTokens(accessToken: string, refreshToken?: string): Promise<void> {
  await SecureStore.setItemAsync(ACCESS_TOKEN_KEY, accessToken);
  await SecureStore.setItemAsync(LEGACY_TOKEN_KEY, accessToken);
  if (refreshToken) {
    await SecureStore.setItemAsync(REFRESH_TOKEN_KEY, refreshToken);
  }
}

export async function loadAccessToken(): Promise<string | null> {
  const token = await SecureStore.getItemAsync(ACCESS_TOKEN_KEY);
  if (token) return token;
  return SecureStore.getItemAsync(LEGACY_TOKEN_KEY);
}

export async function loadRefreshToken(): Promise<string | null> {
  return SecureStore.getItemAsync(REFRESH_TOKEN_KEY);
}

export async function clearAllTokens(): Promise<void> {
  await Promise.all([
    SecureStore.deleteItemAsync(ACCESS_TOKEN_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(REFRESH_TOKEN_KEY).catch(() => {}),
    SecureStore.deleteItemAsync(LEGACY_TOKEN_KEY).catch(() => {}),
  ]);
}

// Backwards-compatible aliases
export const saveToken = (t: string) => saveTokens(t);
export const loadToken = () => loadAccessToken();
export const clearToken = () => clearAllTokens();

// ---------------------------------------------------------------- 401 Refresh Interceptor
let refreshPromise: Promise<string | null> | null = null;
type AuthListener = (user: User | null) => void;
const authListeners = new Set<AuthListener>();

export function subscribeAuthChange(listener: AuthListener): () => void {
  authListeners.add(listener);
  return () => authListeners.delete(listener);
}

function notifyAuthFailed() {
  for (const listener of authListeners) {
    listener(null);
  }
}

async function executeRefresh(): Promise<string | null> {
  try {
    const refreshToken = await loadRefreshToken();
    if (!refreshToken) {
      await clearAllTokens();
      notifyAuthFailed();
      return null;
    }

    const res = await fetch(`${API_BASE}/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ refreshToken }),
    });

    if (!res.ok) {
      await clearAllTokens();
      notifyAuthFailed();
      return null;
    }

    const data = (await res.json()) as RefreshResponse;
    await saveTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  } catch {
    return null;
  } finally {
    refreshPromise = null;
  }
}

async function interceptedFetch(url: string, init?: RequestInit): Promise<Response> {
  const reqInit = init ?? {};
  const isAuthEndpoint =
    typeof url === 'string' &&
    (url.includes('/auth/login') ||
      url.includes('/auth/register') ||
      url.includes('/auth/refresh'));

  let res = await fetch(url, reqInit);

  if (res.status === 401 && !isAuthEndpoint) {
    // Single-flight lock: coalesce concurrent refreshes
    if (!refreshPromise) {
      refreshPromise = executeRefresh();
    }
    const newAccessToken = await refreshPromise;

    if (newAccessToken) {
      const headers = new Headers(reqInit.headers);
      headers.set('Authorization', `Bearer ${newAccessToken}`);
      res = await fetch(url, { ...reqInit, headers });
    }
  }

  return res;
}

// ---------------------------------------------------------------- FlyleafClient
export const client = new FlyleafClient({
  baseUrl: API_BASE,
  getToken: loadAccessToken,
  fetch: interceptedFetch as typeof fetch,
});

// ---------------------------------------------------------------- API Service
export const api = {
  client,

  register: async (
    email: string,
    username: string,
    password: string,
    dateOfBirth = '2000-01-01',
  ) => {
    const r = await client.register({ email, username, password, dateOfBirth });
    await saveTokens(r.accessToken, r.refreshToken);
    return { user: r.user, token: r.accessToken, refreshToken: r.refreshToken };
  },

  login: async (email: string, password: string) => {
    const r = await client.login({ email, password });
    await saveTokens(r.accessToken, r.refreshToken);
    return { user: r.user, token: r.accessToken, refreshToken: r.refreshToken };
  },

  logout: async () => {
    const refreshToken = await loadRefreshToken();
    if (refreshToken) {
      try {
        await client.logout({ refreshToken });
      } catch {
        // Best-effort server notification
      }
    }
    await clearAllTokens();
    notifyAuthFailed();
  },

  me: () => client.getMe(),

  search: (q: string) => client.search(q),

  work: (id: string) => client.getWork(id),

  reads: (status?: string) => client.getReads(status as ReadStatus | undefined),

  setStatus: (workId: string, status: string, rating?: number | null, hearted?: boolean) =>
    client.createRead({
      work_id: workId,
      status: status as ReadStatus,
      rating: rating ?? null,
      hearted: hearted ?? null,
    }),

  addProgress: (readId: string, page: number | null, percent: number | null, minutes?: number) =>
    client.addProgress(readId, {
      client_event_id: Crypto.randomUUID(),
      page: page ?? null,
      percent: percent ?? null,
      minutes: minutes ?? null,
    }),
};
