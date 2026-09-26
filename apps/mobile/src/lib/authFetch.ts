// 401 -> refresh interceptor (SL-04). No Expo imports, so the single-flight and
// logout rules are testable in Node; api.ts injects SecureStore and fetch.
//
// Rules (audit 07, A-04-005):
// - Every API call in the app goes through one instance, so concurrent 401s
//   (screens, the offline queue, app resume) share ONE refresh. The server
//   treats a second use of a refresh token as theft and revokes the family.
// - A request sent with a token that has since been replaced is retried with
//   the current token instead of refreshing again.
// - Only the server rejecting the refresh token ends the session. A network
//   error, 429 or 5xx on refresh keeps the tokens: the request fails, the user
//   stays signed in.

export interface AuthFetchDeps {
  fetch: typeof fetch;
  refreshUrl: string;
  loadAccessToken: () => Promise<string | null>;
  loadRefreshToken: () => Promise<string | null>;
  saveTokens: (accessToken: string, refreshToken: string) => Promise<void>;
  clearTokens: () => Promise<void>;
  /** The refresh token was refused (or is missing): the session is over. */
  onSessionEnded: () => void;
}

const AUTH_ENDPOINTS = ['/auth/login', '/auth/register', '/auth/refresh'];

/** Refresh statuses that mean "this refresh token will never work again". */
const isRejected = (status: number) => status === 400 || status === 401 || status === 403 || status === 422;

function bearerOf(init: RequestInit | undefined): string | null {
  const value = new Headers(init?.headers).get('Authorization');
  return value?.startsWith('Bearer ') ? value.slice(7) : null;
}

function withBearer(init: RequestInit | undefined, token: string): RequestInit {
  const headers = new Headers(init?.headers);
  headers.set('Authorization', `Bearer ${token}`);
  return { ...init, headers };
}

export function createAuthFetch(deps: AuthFetchDeps): typeof fetch {
  let refreshing: Promise<string | null> | null = null;

  async function endSession(): Promise<null> {
    await deps.clearTokens();
    deps.onSessionEnded();
    return null;
  }

  async function refresh(): Promise<string | null> {
    const refreshToken = await deps.loadRefreshToken();
    if (!refreshToken) return endSession();

    let res: Response;
    try {
      res = await deps.fetch(deps.refreshUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken }),
      });
    } catch {
      return null; // offline: keep the session
    }
    if (isRejected(res.status)) return endSession();
    if (!res.ok) return null; // 429 / 5xx: keep the session

    const data = (await res.json()) as { accessToken: string; refreshToken: string };
    await deps.saveTokens(data.accessToken, data.refreshToken);
    return data.accessToken;
  }

  function refreshOnce(): Promise<string | null> {
    refreshing ??= refresh().finally(() => {
      refreshing = null;
    });
    return refreshing;
  }

  return async function authFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = String(input);
    const res = await deps.fetch(input, init);
    if (res.status !== 401 || AUTH_ENDPOINTS.some((p) => url.includes(p))) return res;

    // A guest request has nothing to refresh.
    const sent = bearerOf(init);
    if (!sent) return res;

    const current = await deps.loadAccessToken();
    const token = current && current !== sent ? current : await refreshOnce();
    if (!token) return res;
    return deps.fetch(input, withBearer(init, token));
  } as typeof fetch;
}
