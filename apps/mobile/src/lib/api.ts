// Mobile API client backed by @flyleaf/api-client (FN-80, FN-81, Architecture §6).
//
// Types and requests are bound to the Fastify route schemas and openapi.yaml,
// preventing client/server contract drift.

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
} from '@flyleaf/api-client';

export type { User, Profile, Edition, YourRead, Work, Read, ReadStatus };
export { FlyleafApiError as ApiError };

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
export async function saveToken(t: string) { await SecureStore.setItemAsync(TOKEN_KEY, t); }
export async function loadToken() { return SecureStore.getItemAsync(TOKEN_KEY); }
export async function clearToken() { await SecureStore.deleteItemAsync(TOKEN_KEY); }

const client = new FlyleafClient({
  baseUrl: `${BASE}/v1`,
  getToken: loadToken,
});

export const api = {
  client,

  register: (email: string, username: string, password: string, dateOfBirth = '2000-01-01') =>
    client.register({ email, username, password, dateOfBirth }).then((r) => ({
      user: r.user,
      token: r.accessToken,
      refreshToken: r.refreshToken,
    })),

  login: (email: string, password: string) =>
    client.login({ email, password }).then((r) => ({
      user: r.user,
      token: r.accessToken,
      refreshToken: r.refreshToken,
    })),

  me: () => client.getMe(),

  // Readable by guests — no token required (PRD §4.2).
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

  // client_event_id makes replay safe. This is the whole offline story in one
  // field, and it is here from day one (architecture.md §10).
  addProgress: (readId: string, page: number | null, percent: number | null, minutes?: number) =>
    client.addProgress(readId, {
      client_event_id: Crypto.randomUUID(),
      page: page ?? null,
      percent: percent ?? null,
      minutes: minutes ?? null,
    }),
};
