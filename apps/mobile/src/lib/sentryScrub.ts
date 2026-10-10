// What leaves the device in a crash report (SL-82, PRD §26.5, audit 10).
// Plain functions, so they are tested without React Native.

/**
 * Secrets that can appear inside an error message or a stack line: the
 * export download link's ?token= (A-05), any bearer token, refresh tokens
 * and passwords in a query string, and email addresses.
 */
export function scrubText(text: string): string {
  return text
    .replace(/([?&](?:token|refresh_token|refreshToken|access_token|code|password|secret)=)[^&\s#"']+/gi, '$1[REDACTED]')
    .replace(/(bearer\s+)[A-Za-z0-9._~+/-]+=*/gi, '$1[REDACTED]')
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
}

/** Sentry's event_id: 32 lowercase hex characters (a UUID without dashes). */
export function sentryEventId(uuid: string): string {
  return uuid.replace(/-/g, '').toLowerCase();
}
