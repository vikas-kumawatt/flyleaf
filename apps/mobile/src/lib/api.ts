// Phase -1 API client, hand-written.
//
// FN-80/81 replace this with a client GENERATED from the Fastify route
// schemas, because those schemas and this file otherwise define every
// endpoint twice and drift silently until something is null in production.

import Constants from 'expo-constants';
import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';

// Resolve the API host without anyone editing a config file.
//
// Expo's dev server already knows the LAN address the phone reached it on
// (`hostUri` is e.g. "10.219.25.133:8081"), and the API runs on the same
// machine. Deriving the host from it means the app follows your laptop
// around — no editing app.json when the IP changes, which it will.
//
// Precedence: explicit override → Expo dev host → emulator alias.
const API_PORT = 3000;

function resolveBase(): string {
  const override = (Constants.expoConfig?.extra as { apiUrl?: string } | undefined)?.apiUrl;
  if (override) return override;

  const hostUri = Constants.expoConfig?.hostUri ?? Constants.expoGoConfig?.debuggerHost;
  const host = hostUri?.split(':')[0];
  if (host) return `http://${host}:${API_PORT}`;

  return `http://10.0.2.2:${API_PORT}`; // Android emulator alias for the host
}

const BASE: string = resolveBase();

const TOKEN_KEY = 'flyleaf.token';

// The refresh token lives in the OS keychain, never AsyncStorage.
// Phase -1 stores an opaque session token in the same place.
export async function saveToken(t: string) { await SecureStore.setItemAsync(TOKEN_KEY, t); }
export async function loadToken() { return SecureStore.getItemAsync(TOKEN_KEY); }
export async function clearToken() { await SecureStore.deleteItemAsync(TOKEN_KEY); }

export class ApiError extends Error {
  constructor(public code: string, message: string, public field?: string, public status?: number) {
    super(message);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const token = await loadToken();
  const res = await fetch(`${BASE}/v1${path}`, {
    ...init,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const e = body?.error ?? {};
    throw new ApiError(e.code ?? 'unknown', e.message ?? 'Something went wrong.', e.field, res.status);
  }
  return body as T;
}

// ---------------------------------------------------------------- types

export type User = { id: string; email: string; username: string };
export type Edition = {
  id: string; isbn13: string | null; page_count: number | null;
  format: string; cover_id: number | null;
};
export type YourRead = {
  id: string; status: string; rating: number | null; hearted: boolean;
  page: number | null; percent: number | null;
};
export type Work = {
  id: string; title: string; author_name: string;
  first_publish_year: number | null; cover_id: number | null; log_count: number;
  editions?: Edition[]; your_read?: YourRead;
};
export type Read = {
  id: string; work_id: string; status: string; attempt_no: number;
  rating: number | null; hearted: boolean;
  title?: string; author_name?: string; cover_id?: number | null;
  page?: number | null; percent?: number | null; page_count?: number | null;
};

// ---------------------------------------------------------------- calls

export const api = {
  register: (email: string, username: string, password: string) =>
    request<{ user: User; token: string }>('/auth/register', {
      method: 'POST', body: JSON.stringify({ email, username, password }),
    }),

  login: (email: string, password: string) =>
    request<{ user: User; token: string }>('/auth/login', {
      method: 'POST', body: JSON.stringify({ email, password }),
    }),

  me: () => request<User>('/me'),

  // Readable by guests — no token required (PRD §4.2).
  search: (q: string) =>
    request<{ data: Work[] }>(`/search?q=${encodeURIComponent(q)}`).then(r => r.data),

  work: (id: string) => request<Work>(`/works/${id}`),

  reads: (status?: string) =>
    request<{ data: Read[] }>(`/reads${status ? `?status=${status}` : ''}`).then(r => r.data),

  setStatus: (workId: string, status: string, rating?: number | null, hearted?: boolean) =>
    request<Read>('/reads', {
      method: 'POST',
      body: JSON.stringify({ work_id: workId, status, rating, hearted }),
    }),

  // client_event_id makes replay safe. This is the whole offline story in one
  // field, and it is here from day one (architecture.md §10).
  addProgress: (readId: string, page: number | null, percent: number | null, minutes?: number) =>
    request<Read>(`/reads/${readId}/progress`, {
      method: 'POST',
      body: JSON.stringify({
        client_event_id: Crypto.randomUUID(),
        page, percent, minutes,
      }),
    }),
};
