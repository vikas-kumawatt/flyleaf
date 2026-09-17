// Minimal auth context (PRD §4.2, SL-04).
// A null user is a GUEST, which is a legitimate state and not an error.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, loadAccessToken, clearAllTokens, subscribeAuthChange, type User } from './api';
import { guestManager } from './guest';

type Ctx = {
  user: User | null;
  ready: boolean;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (email: string, username: string, password: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const SessionContext = createContext<Ctx | null>(null);

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const token = await loadAccessToken();
        if (token) {
          const me = await api.me();
          setUser(me);
          void guestManager.migrateToServer(api);
        }
      } catch {
        await clearAllTokens();
      } finally {
        setReady(true);
      }
    })();

    // Listen to token refresh expiration / logout events from api client
    const unsubscribe = subscribeAuthChange((updatedUser) => {
      setUser(updatedUser);
      if (updatedUser) {
        void guestManager.migrateToServer(api);
      }
    });

    return () => unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setUser(res.user);
    await guestManager.migrateToServer(api);
  }, []);

  const signUp = useCallback(async (email: string, username: string, password: string) => {
    const res = await api.register(email, username, password);
    setUser(res.user);
    await guestManager.migrateToServer(api);
  }, []);

  const signOut = useCallback(async () => {
    await api.logout();
    setUser(null);
  }, []);

  return (
    <SessionContext.Provider value={{ user, ready, signIn, signUp, signOut }}>
      {children}
    </SessionContext.Provider>
  );
}

export function useSession() {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error('useSession must be used inside SessionProvider');
  return ctx;
}
