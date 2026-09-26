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

/** Login and register return a user without emailVerified; /v1/me has it (A-05-011). */
async function currentUser(fallback: User): Promise<User> {
  try {
    return await api.me();
  } catch {
    return fallback;
  }
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  const startSession = useCallback(async (next: User) => {
    // Nothing cached for the previous account may show for this one (A-07-003).
    queryClient.clear();
    setUser(next);
    await saveSessionUser(next).catch(() => {});
    await guestManager.migrateToServer(api);
  }, []);

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
    const unsubscribe = subscribeAuthChange((updatedUser) => {
      if (!updatedUser) queryClient.clear();
      setUser(updatedUser);
    });

    return () => unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    await startSession(await currentUser(res.user));
  }, [startSession]);

  const signUp = useCallback(async (email: string, username: string, password: string, dateOfBirth: string) => {
    const res = await api.register(email, username, password, dateOfBirth);
    await startSession(await currentUser(res.user));
  }, [startSession]);

  const signOut = useCallback(async () => {
    await api.logout();
    queryClient.clear();
    setUser(null);
  }, []);

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
