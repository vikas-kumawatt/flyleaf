// Where the app sends its requests (docs/mobile-release.md).
//
// The address is never written in code. app.config.ts puts the build
// profile's FLYLEAF_API_URL (eas.json) into extra.apiUrl: preview and
// production builds carry the server's address. A development build has none
// and talks to the laptop running Metro, on the API's port.

export const DEV_API_PORT = 3000;

export interface ApiBaseInput {
  /** extra.apiUrl from the app config. */
  apiUrl?: string | null;
  /** Metro's address as the dev client saw it ("192.168.1.5:8081"). */
  hostUri?: string | null;
  /** __DEV__: a JavaScript bundle served by Metro. */
  isDev: boolean;
}

export function resolveApiBase({ apiUrl, hostUri, isDev }: ApiBaseInput): string {
  const configured = apiUrl?.trim();
  if (configured) return configured.replace(/\/+$/, '');

  const host = hostUri?.split(':')[0];
  if (isDev && host) return `http://${host}:${DEV_API_PORT}`;
  if (isDev) return `http://10.0.2.2:${DEV_API_PORT}`; // Android emulator alias for the host

  // A release bundle without an address (an update published without the
  // profile's environment) would quietly talk to nothing.
  throw new Error('No API address in this build: extra.apiUrl is empty (FLYLEAF_API_URL in eas.json)');
}

/**
 * The base of the links the app shares (/@name, /book/:id, shelf pages). The
 * API server renders those pages itself (identity/link-pages.ts), so a build
 * that names a server shares links to it; a development build shares the
 * production address.
 */
export function resolvePublicBase(apiUrl: string | null | undefined, productionBase: string): string {
  const configured = apiUrl?.trim();
  return configured ? configured.replace(/\/+$/, '') : productionBase;
}
