// Sign-in, sign-up and sign-out, without React or Expo (beta bug, Oct 2026).
// session.tsx injects the real api, cache and guest shelf; the API's
// end-to-end test injects the same modules against a real server.
//
// Rules:
// - Only the credentials call can fail a sign-in. Everything after the
//   server said yes (/v1/me, the cache, saving the user, the guest shelf
//   migration) is best-effort: a failure there is reported, and the user is
//   signed in. It used to propagate, and the screen showed it as a wrong
//   password.
// - The guest shelf migration runs in the background: a slow or failing
//   network must not hold the sign-in, and its failures keep the books on
//   the device for next time (guest.ts).
// - Sign-out ends everything that belongs to the session, even when the
//   server cannot be reached: tokens, cache, an in-flight migration, the
//   telemetry queue and its retry timer. The telemetry retry loop outliving
//   the session is what spent the anonymous per-IP budget that the next
//   sign-in is checked against.

export interface SessionFlowDeps<U> {
  /** Throws on refusal. Stores the tokens. `restored`: the sign-in undid an account deletion (LA-01). */
  login: (email: string, password: string) => Promise<{ user: U; restored?: boolean }>;
  register: (email: string, username: string, password: string, dateOfBirth: string) => Promise<{ user: U }>;
  /** Best-effort server call, then the tokens are cleared whatever happened. */
  logout: () => Promise<void>;
  /** /v1/me: login and register return a user without emailVerified (A-05-011). */
  me: () => Promise<U>;
  saveSessionUser: (user: U) => Promise<void>;
  /** Nothing cached for the previous account may show for this one (A-07-003). */
  clearCache: () => void;
  setUser: (user: U | null) => void;
  migrateGuest: () => Promise<unknown>;
  cancelGuestMigration: () => void;
  resetTelemetry: () => void;
  /** A best-effort step failed. Default: ignored. */
  onStepError?: (step: string, err: unknown) => void;
}

export interface StartedSession<U> {
  user: U;
  /** This sign-in restored an account deleted within its 30-day grace (LA-01); the screen says so. */
  restored: boolean;
  /** Settles when the guest shelf migration has finished; never rejects. */
  guestMigration: Promise<void>;
}

export function createSessionFlow<U>(deps: SessionFlowDeps<U>) {
  const report = (step: string, err: unknown) => {
    try {
      deps.onStepError?.(step, err);
    } catch {
      // A reporter must not undo the sign-in either.
    }
  };

  async function step<T>(name: string, fn: () => T | Promise<T>): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      report(name, err);
      return undefined;
    }
  }

  async function startSession(fallback: U, restored = false): Promise<StartedSession<U>> {
    const user = (await step('me', deps.me)) ?? fallback;
    await step('clearCache', deps.clearCache);
    await step('setUser', () => deps.setUser(user));
    await step('saveSessionUser', () => deps.saveSessionUser(user));
    const guestMigration = step('migrateGuest', deps.migrateGuest).then(() => undefined);
    return { user, restored, guestMigration };
  }

  return {
    async signIn(email: string, password: string): Promise<StartedSession<U>> {
      const res = await deps.login(email, password);
      return startSession(res.user, res.restored === true);
    },

    async signUp(email: string, username: string, password: string, dateOfBirth: string): Promise<StartedSession<U>> {
      const res = await deps.register(email, username, password, dateOfBirth);
      return startSession(res.user);
    },

    async signOut(): Promise<void> {
      await step('cancelGuestMigration', deps.cancelGuestMigration);
      await step('logout', deps.logout);
      await step('clearCache', deps.clearCache);
      await step('resetTelemetry', deps.resetTelemetry);
      await step('setUser', () => deps.setUser(null));
    },
  };
}
