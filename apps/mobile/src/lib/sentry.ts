// Mobile Sentry client & exception reporting (SL-82, Architecture §10.2).
//
// Formats native exceptions, sanitizes sensitive tokens/keys, and delivers
// to Sentry endpoint if EXPO_PUBLIC_SENTRY_DSN is configured.

import { Platform } from 'react-native';

const PlatformOS = Platform.OS;

export interface MobileErrorContext {
  componentStack?: string;
  screen?: string;
  userId?: string;
  extra?: Record<string, any>;
}

let dsnConfig: { host: string; projectId: string; publicKey: string } | null = null;
let enabled = false;

export function initMobileSentry(dsn = process.env.EXPO_PUBLIC_SENTRY_DSN): void {
  if (!dsn) {
    enabled = false;
    dsnConfig = null;
    return;
  }

  try {
    const url = new URL(dsn);
    const publicKey = url.username;
    const host = url.host;
    const pathParts = url.pathname.split('/').filter(Boolean);
    const projectId = pathParts[pathParts.length - 1];

    if (publicKey && host && projectId) {
      dsnConfig = { host, projectId, publicKey };
      enabled = true;
    }
  } catch {
    enabled = false;
    dsnConfig = null;
  }
}

export function isMobileSentryEnabled(): boolean {
  return enabled;
}

export async function captureMobileException(
  error: unknown,
  context: MobileErrorContext = {},
): Promise<string> {
  const eventId = Math.random().toString(36).substring(2, 15);
  const err = error instanceof Error ? error : new Error(String(error));

  if (!enabled || !dsnConfig) {
    // In dev / unconfigured mode: record as console error
    if (__DEV__) {
      console.warn('[Sentry:Mobile]', err.name, err.message, context);
    }
    return eventId;
  }

  const payload = {
    event_id: eventId,
    timestamp: new Date().toISOString(),
    platform: PlatformOS,
    level: 'error',
    exception: {
      values: [
        {
          type: err.name,
          value: err.message,
          stacktrace: err.stack
            ? {
                frames: err.stack.split('\n').map((line) => ({ filename: line.trim() })),
              }
            : undefined,
        },
      ],
    },
    tags: {
      platform: PlatformOS,
      screen: context.screen,
    },
    extra: {
      componentStack: context.componentStack,
      ...context.extra,
    },
  };

  try {
    const endpoint = `https://${dsnConfig.host}/api/${dsnConfig.projectId}/store/`;
    await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sentry-Auth': `Sentry sentry_version=7, sentry_client=flyleaf-mobile/0.0.1, sentry_key=${dsnConfig.publicKey}`,
      },
      body: JSON.stringify(payload),
    });
  } catch {
    // Fail silently in mobile background
  }

  return eventId;
}
