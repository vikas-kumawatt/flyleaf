// Outbound HTTP (FN-30, FN-31).
//
// ONE limiter and ONE breaker, shared by every caller that leaves the
// process: gap-fill, import, admin lookups. architecture.md §5.2 is blunt
// about why -- two independent limiters set to "3 per second" exceed the
// limit together, and the failure mode is Open Library blocking our IP, at
// which point the catalog stops improving and nobody notices for a week.

export interface OutboundLimiter {
  /** Resolves when a token is available. For background work. */
  wait(): Promise<void>;
  /** Takes a token if one is free, otherwise returns false immediately. */
  tryAcquire(): boolean;
}

/**
 * Token bucket: 3 requests/second sustained, burst of 5.
 *
 * Those are Open Library's numbers for an identified client, which is why
 * every request carries a real User-Agent with a contact address. An
 * anonymous client gets far less.
 */
export class TokenBucket implements OutboundLimiter {
  #tokens: number;
  #last = Date.now();

  constructor(private ratePerSecond = 3, private burst = 5) {
    this.#tokens = burst;
  }

  #refill(): void {
    const now = Date.now();
    this.#tokens = Math.min(
      this.burst,
      this.#tokens + ((now - this.#last) / 1000) * this.ratePerSecond,
    );
    this.#last = now;
  }

  tryAcquire(): boolean {
    this.#refill();
    if (this.#tokens < 1) return false;
    this.#tokens -= 1;
    return true;
  }

  async wait(): Promise<void> {
    for (;;) {
      this.#refill();
      if (this.#tokens >= 1) {
        this.#tokens -= 1;
        return;
      }
      const deficit = 1 - this.#tokens;
      await new Promise((r) => setTimeout(r, Math.ceil((deficit / this.ratePerSecond) * 1000)));
    }
  }
}

type BreakerState = 'closed' | 'open' | 'half-open';

/**
 * Circuit breaker: 5 consecutive failures opens it for 60 seconds.
 *
 * The point is not to protect us, it is to stop hammering a service that is
 * already unwell -- and to fail fast while it is down, so a search that would
 * time out anyway returns local results in milliseconds instead.
 *
 * After the cooldown one trial request is allowed through. If it succeeds the
 * circuit closes; if it fails the cooldown restarts. Without the half-open
 * state a brief outage becomes a permanent one.
 */
export class CircuitBreaker {
  #failures = 0;
  #openedAt = 0;
  #state: BreakerState = 'closed';

  constructor(private threshold = 5, private cooldownMs = 60_000) {}

  get state(): BreakerState {
    if (this.#state === 'open' && Date.now() - this.#openedAt >= this.cooldownMs) {
      this.#state = 'half-open';
    }
    return this.#state;
  }

  /** False when the circuit is open and the cooldown has not elapsed. */
  allow(): boolean {
    return this.state !== 'open';
  }

  succeed(): void {
    this.#failures = 0;
    this.#state = 'closed';
  }

  fail(): void {
    // A failure while half-open re-opens immediately: the trial told us the
    // service is still down, so the other four failures are not needed again.
    if (this.#state === 'half-open') {
      this.#openedAt = Date.now();
      this.#state = 'open';
      return;
    }
    this.#failures++;
    if (this.#failures >= this.threshold) {
      this.#openedAt = Date.now();
      this.#state = 'open';
    }
  }
}

export type OutboundResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'limited' | 'open-circuit' | 'timeout' | 'http' | 'parse' };

/**
 * A JSON GET that can never hang, never stampede, and never throw.
 *
 * Returning a reason rather than throwing is deliberate: every caller here is
 * on a path where the correct response to "the internet is unavailable" is to
 * carry on with what we have locally, not to fail the user's request.
 */
export class OutboundClient {
  constructor(
    private limiter: OutboundLimiter,
    private breaker: CircuitBreaker,
    private userAgent: string,
  ) {}

  async getJson<T>(
    url: string,
    opts: { timeoutMs?: number; blocking?: boolean } = {},
  ): Promise<OutboundResult<T>> {
    const timeoutMs = opts.timeoutMs ?? 3_000;

    if (!this.breaker.allow()) return { ok: false, reason: 'open-circuit' };

    // On a user's request path, queueing behind the limiter just spends their
    // latency budget on a request that will arrive too late to matter.
    if (opts.blocking) await this.limiter.wait();
    else if (!this.limiter.tryAcquire()) return { ok: false, reason: 'limited' };

    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': this.userAgent, Accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!res.ok) {
        // 4xx is our fault and says nothing about the service's health, so it
        // must not trip the breaker. 429 and 5xx must.
        if (res.status === 429 || res.status >= 500) this.breaker.fail();
        return { ok: false, reason: 'http' };
      }

      const data = (await res.json()) as T;
      this.breaker.succeed();
      return { ok: true, data };
    } catch (err) {
      this.breaker.fail();
      return { ok: false, reason: err instanceof Error && err.name === 'TimeoutError' ? 'timeout' : 'http' };
    }
  }
}

/** The single shared instances. Import these, never construct your own. */
export const outboundLimiter = new TokenBucket(3, 5);
export const outboundBreaker = new CircuitBreaker(5, 60_000);
export const outbound = new OutboundClient(
  outboundLimiter,
  outboundBreaker,
  // Identified, with a contact address, because that is what buys the higher
  // rate limit and what lets them mail us instead of blocking us.
  process.env.OUTBOUND_USER_AGENT ??
    'Flyleaf/1.0 (+https://flyleaf.app; contact@flyleaf.app)',
);
