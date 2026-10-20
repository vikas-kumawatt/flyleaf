// Minimal auth context (PRD §4.2, SL-04).
// A null user is a GUEST, which is a legitimate state and not an error.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import {
  api,
  loadAccessToken,
  loadRefreshToken,
  loadSessionUser,
  saveSessionUser,
  subscribeAuthChange,
  type User,
} from './api';
import { queryClient } from './query';
import { guestManager } from './guest';
import { resetTelemetry } from './events';
import { createSessionFlow } from './sessionFlow';

type Ctx = {
  user: User | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, username: string, password: string, dateOfBirth: string) => Promise<void>;
  signOut: () => Promise<void>;
  /** Re-read /v1/me, e.g. after the email is verified. */
  refreshUser: () => Promise<User>;
};

const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  // Only the credentials call can fail a sign-in; see sessionFlow.ts.
  const [flow] = useState(() =>
    createSessionFlow<User>({
      login: api.login,
      register: api.register,
      logout: api.logout,
      me: api.me,
      saveSessionUser,
      clearCache: () => queryClient.clear(),
      setUser,
      migrateGuest: async () => {
        const { count } = await guestManager.migrateToServer(api);
        // The library screens fetched before the books arrived.
        if (count > 0) await queryClient.invalidateQueries();
      },
      cancelGuestMigration: () => guestManager.cancelMigration(),
      resetTelemetry,
      onStepError: (step, err) => {
        if (__DEV__) console.warn(`[session] ${step} failed after sign-in`, err);
      },
    }),
  );

  useEffect(() => {
    (async () => {
      try {
        if (!(await loadAccessToken())) return;
        try {
          const me = await api.me();
          setUser(me);
          void saveSessionUser(me).catch(() => {});
          void guestManager.migrateToServer(api);
        } catch {
          // Offline, server down, or a refresh that could not complete: keep
          // the session with the last known user (PRD §6.1). Only a refused
          // refresh token clears the tokens (authFetch.ts), and then we are a guest.
          if (await loadRefreshToken()) {
            setUser(await loadSessionUser());
          }
        }
      } finally {
        setReady(true);
      }
    })();

    // The refresh token was refused (reuse, reset on another device, expiry).
    // That is a sign-out too: nothing of the session may outlive it.
    const unsubscribe = subscribeAuthChange((updatedUser) => {
      if (!updatedUser) {
        queryClient.clear();
        guestManager.cancelMigration();
        resetTelemetry();
      }
      setUser(updatedUser);
    });

    return () => unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    await flow.signIn(email, password);
  }, [flow]);

  const signUp = useCallback(async (email: string, username: string, password: string, dateOfBirth: string) => {
    await flow.signUp(email, username, password, dateOfBirth);
  }, [flow]);

  const signOut = useCallback(() => flow.signOut(), [flow]);

  const refreshUser = useCallback(async () => {
    const me = await api.me();
    setUser(me);
    await saveSessionUser(me).catch(() => {});
    return me;
  }, []);

  return (
    <SessionContext.Provider value={{ user, ready, signIn, signUp, signOut, refreshUser }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
