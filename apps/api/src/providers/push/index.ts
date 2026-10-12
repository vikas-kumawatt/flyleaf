// Push port (PV-05). SO-30 (notifications, src/notify/) sends through it.
// What SO-30 decides -- categories, quiet hours, the 5-per-day cap (PRD §19)
// -- stays in app code; an adapter only delivers, and reads receipts.
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
  /**
   * The app-registered category whose action buttons the notification shows
   * (the reading reminder's "Turn off", PRD §19.2 item 14 bound 6).
   */
  categoryId?: string;
  /** Android notification channel; the app creates it. */
  channelId?: string;
}

export type PushFailure =
  /** The app was uninstalled or the token revoked: delete the token. */
  | 'device_not_registered'
  | 'invalid_token'
  | 'message_too_big'
  | 'rate_limited'
  | 'provider_error';

export type PushResult = { ok: true; id: string | null } | { ok: false; error: PushFailure; message?: string };

/**
 * What became of a ticket (Expo's delivery receipt, read minutes after the
 * send). `pending`: no receipt yet; ask again later (Expo keeps them 24 h).
 */
export type PushReceipt = { status: 'ok' } | { status: 'error'; error: PushFailure; message?: string } | { status: 'pending' };

export interface PushSender {
  /** One result per message, in the same order. Never throws for a single bad message. */
  send(messages: PushMessage[]): Promise<PushResult[]>;
  /**
   * Receipts for ticket ids returned by send(). Every id gets an entry; an id
   * the provider has no receipt for yet, or a failed request, is `pending`.
   * Never throws.
   */
  receipts(ids: string[]): Promise<Map<string, PushReceipt>>;
}

const EXPO_TOKEN = /^Expo(?:nent)?PushToken\[[^\]\s]+\]$/;

export function isExpoPushToken(token: string): boolean {
  return EXPO_TOKEN.test(token);
}

export class MemoryPushSender implements PushSender {
  readonly sent: PushMessage[] = [];
  readonly #unregistered = new Set<string>();
  readonly #receipts = new Map<string, PushReceipt>();
  #next = 0;

  /** Test helper: this token now behaves like an uninstalled app. */
  unregister(token: string): void {
    this.#unregistered.add(token);
  }

  /** Test helper: the receipt the provider will report for this ticket. */
  setReceipt(id: string, receipt: PushReceipt): void {
    this.#receipts.set(id, receipt);
  }

  async receipts(ids: string[]): Promise<Map<string, PushReceipt>> {
    return new Map(ids.map((id) => [id, this.#receipts.get(id) ?? { status: 'ok' as const }]));
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

type ExpoReceipt = { status: 'ok' } | { status: 'error'; message?: string; details?: { error?: string } };

const EXPO_ERRORS: Record<string, PushFailure> = {
  DeviceNotRegistered: 'device_not_registered',
  MessageTooBig: 'message_too_big',
  MessageRateExceeded: 'rate_limited',
  // Receipt-only errors: credentials are ours to fix, not the token's fault.
  InvalidCredentials: 'provider_error',
};

export class ExpoPushSender implements PushSender {
  static readonly ENDPOINT = 'https://exp.host/--/api/v2/push/send';
  static readonly RECEIPTS_ENDPOINT = 'https://exp.host/--/api/v2/push/getReceipts';
  /** Expo accepts at most 100 messages per request. */
  static readonly BATCH = 100;
  /** ...and at most 1,000 receipt ids. */
  static readonly RECEIPT_BATCH = 1000;

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

  async receipts(ids: string[]): Promise<Map<string, PushReceipt>> {
    const out = new Map<string, PushReceipt>();
    for (let start = 0; start < ids.length; start += ExpoPushSender.RECEIPT_BATCH) {
      const batch = ids.slice(start, start + ExpoPushSender.RECEIPT_BATCH);
      let data: Record<string, ExpoReceipt> | null = null;
      try {
        const res = await this.fetchFn(ExpoPushSender.RECEIPTS_ENDPOINT, {
          method: 'POST',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
            ...(this.accessToken ? { authorization: `Bearer ${this.accessToken}` } : {}),
          },
          body: JSON.stringify({ ids: batch }),
          signal: AbortSignal.timeout(this.timeoutMs),
        });
        if (res.ok) {
          const json = (await res.json()) as { data?: Record<string, ExpoReceipt> };
          if (json.data && typeof json.data === 'object') data = json.data;
        }
      } catch {
        data = null;
      }
      for (const id of batch) {
        const r = data?.[id];
        if (!r) out.set(id, { status: 'pending' });
        else if (r.status === 'ok') out.set(id, { status: 'ok' });
        else out.set(id, { status: 'error', error: EXPO_ERRORS[r.details?.error ?? ''] ?? 'provider_error', message: r.message });
      }
    }
    return out;
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
        body: JSON.stringify(batch.map((m) => ({
          to: m.to,
          title: m.title,
          body: m.body,
          data: m.data,
          ...(m.categoryId ? { categoryId: m.categoryId } : {}),
          ...(m.channelId ? { channelId: m.channelId } : {}),
        }))),
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
