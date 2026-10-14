// Dynamic app config on top of app.json (docs/mobile-release.md).
//
// Three things depend on the EAS build profile, and none of them is written
// in code:
//
//   extra.apiUrl            FLYLEAF_API_URL from the profile's `env` in
//                           eas.json. development leaves it unset, so the app
//                           derives the laptop's address from Metro
//                           (src/lib/apiBase.ts); preview and production set
//                           the server.
//   googleServicesFile      GOOGLE_SERVICES_JSON, the path EAS gives a file
//                           variable on the build server; else a local
//                           ./google-services.json if one exists (git-ignored).
//                           Without either, the field is dropped, so a local
//                           development build without Firebase still builds
//                           (push is then simply absent).
//   extra.appLinkHosts      the https hosts in android.intentFilters, for the
//                           link rewrite (src/lib/appLinks.ts).
//
// On the EAS build server (EAS_BUILD=true), a preview or production build
// without the API address or without google-services.json stops here: a beta
// that talks to nothing, or cannot receive push, is worse than no build.

import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ConfigContext, ExpoConfig } from 'expo/config';

type Env = Record<string, string | undefined>;

/** Profiles that run against the server and must carry push credentials. */
const RELEASE_PROFILES = new Set(['preview', 'production']);

export function resolveApiUrl(env: Env): string | undefined {
  const raw = env.FLYLEAF_API_URL?.trim();
  if (!raw) return undefined;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`FLYLEAF_API_URL is not a URL: ${raw}`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`FLYLEAF_API_URL must be http(s): ${raw}`);
  if (url.pathname !== '/' || url.search || url.hash) throw new Error(`FLYLEAF_API_URL is the server's origin only, without /v1: ${raw}`);
  if (RELEASE_PROFILES.has(env.EAS_BUILD_PROFILE ?? '') && url.protocol !== 'https:') {
    throw new Error(`FLYLEAF_API_URL must be https for the ${env.EAS_BUILD_PROFILE} profile: ${raw}`);
  }
  return url.origin;
}

export function linkHosts(config: Pick<ExpoConfig, 'android'>): string[] {
  const hosts = (config.android?.intentFilters ?? [])
    .flatMap((f) => (Array.isArray(f.data) ? f.data : f.data ? [f.data] : []))
    .filter((d) => d.scheme === 'https' && d.host)
    .map((d) => d.host!.toLowerCase());
  return [...new Set(hosts)];
}

export function buildConfig(config: ExpoConfig, env: Env, fileExists: (p: string) => boolean, projectRoot: string): ExpoConfig {
  const onEas = env.EAS_BUILD === 'true';
  const profile = env.EAS_BUILD_PROFILE;
  const release = onEas && RELEASE_PROFILES.has(profile ?? '');

  const apiUrl = resolveApiUrl(env);
  if (release && !apiUrl) throw new Error(`FLYLEAF_API_URL is not set for the ${profile} profile (eas.json build.${profile}.env)`);

  const local = config.android?.googleServicesFile;
  const googleServicesFile = env.GOOGLE_SERVICES_JSON || (local && fileExists(join(projectRoot, local)) ? local : undefined);
  if (release && !googleServicesFile) {
    throw new Error(`google-services.json is missing for the ${profile} profile: add the GOOGLE_SERVICES_JSON file variable on EAS (docs/mobile-release.md)`);
  }

  const android = { ...config.android };
  if (googleServicesFile) android.googleServicesFile = googleServicesFile;
  else delete android.googleServicesFile;

  const extra: Record<string, unknown> = { ...config.extra, appLinkHosts: linkHosts(config) };
  if (apiUrl) extra.apiUrl = apiUrl;

  return { ...config, android, extra };
}

export default ({ config, projectRoot }: ConfigContext): ExpoConfig =>
  buildConfig(config as ExpoConfig, process.env, existsSync, projectRoot);
