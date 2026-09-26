// Push port (PV-05). Nothing sends push yet: SO-30 (notifications) builds on
// this. What SO-30 must decide -- categories, quiet hours, the 5-per-day cap
// (PRD §21) -- stays in app code; an adapter only delivers.
//
//   memory  tests and development
//   expo    Expo's push service (architecture §12: Expo Notifications ->
//           FCM / APNs), over plain HTTPS: no vendor SDK needed

export interface PushMessage {
  /** The device's Expo push token: ExponentPushToken[...] */
  to: string;
  title: string;
  body: string;
  /** Delivered to the app with the notification (deep-link target, ids). */
  data?: Record<string, unknown>;
}

export type PushFailure =
  /** The app was uninstalled or the token revoked: delete the token. */
  | 'device_not_registered'
  | 'invalid_token'
  | 'message_too_big'
  | 'rate_limited'
  | 'provider_error';

export type PushResult = { ok: true; id: string | null } | { ok: false; error: PushFailure; message?: string };

export interface PushSender {
  /** One result per message, in the same order. Never throws for a single bad message. */
  send(messages: PushMessage[]): Promise<PushResult[]>;
}

const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[^\]\s]+\]$/;

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN.test(token);
}

export class MemoryPushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  readonly #unregistered = new Set<string>();
  #next = 0;

  /** Test helper: this token now behaves like an uninstalled app. */
  unregister(token: string): void {
    this.#unregistered.add(token);
  }

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    return messages.map((m) => {
      if (!isExpoPushToken(m.to)) return { ok: false, error: 'invalid_token' };
      if (this.#unregistered.has(m.to)) return { ok: false, error: 'device_not_registered' };
      this.sent.push(m);
      return { ok: true, id: `memory-${++this.#next}` };
    });
  }
}

type ExpoTicket =
  | { status: 'ok'; id: string }
  | { status: 'error'; message?: string; details?: { error?: string } };

const EXPO_ERRORS: Record<string, PushFailure> = {
  DeviceNotRegistered: 'device_not_registered',
  MessageTooBig: 'message_too_big',
  MessageRateExceeded: 'rate_limited',
};

export class ExpoPushSender implements PushSender {
  static readonly ENDPOINT = 'https://exp.host/--/api/v2/push/send';
  /** Expo accepts at most 100 messages per request. */
  static readonly BATCH = 100;

  constructor(
    private readonly accessToken?: string,
    private readonly fetchFn: typeof fetch = fetch,
    private readonly timeoutMs = 10_000,
  ) {}

  async send(messages: PushMessage[]): Promise<PushResult[]> {
    const results: PushResult[] = new Array(messages.length);
    const valid: number[] = [];
    messages.forEach((m, i) => {
      if (isExpoPushToken(m.to)) valid.push(i);
      else results[i] = { ok: false, error: 'invalid_token' };
    });

    for (let start = 0; start < valid.length; start += ExpoPushSender.BATCH) {
      const batch = valid.slice(start, start + ExpoPushSender.BATCH);
      const tickets = await this.#post(batch.map((i) => messages[i]!));
      batch.forEach((i, k) => {
        const t = typeof tickets === 'string' ? undefined : tickets[k];
        if (!t) results[i] = { ok: false, error: typeof tickets === 'string' ? tickets : 'provider_error' };
        else if (t.status === 'ok') results[i] = { ok: true, id: t.id };
        else results[i] = { ok: false, error: EXPO_ERRORS[t.details?.error ?? ''] ?? 'provider_error', message: t.message };
      });
    }
    return results;
  }

  /** The batch's tickets, or why the request failed as a whole. */
  async #post(batch: PushMessage[]): Promise<ExpoTicket[] | PushFailure> {
    try {
      const res = await this.fetchFn(ExpoPushSender.ENDPOINT, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
        },
        body: JSON.stringify(batch.map((m) => ({ to: m.to, title: m.title, body: m.body, data: m.data }))),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (res.status === 429) return 'rate_limited';
      if (!res.ok) return 'provider_error';
      const json = (await res.json()) as { data?: ExpoTicket[] };
      return Array.isArray(json.data) ? json.data : 'provider_error';
    } catch {
      return 'provider_error';
    }
  }
}
