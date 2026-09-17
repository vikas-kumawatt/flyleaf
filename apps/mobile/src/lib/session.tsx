// Minimal auth context (PRD §4.2, SL-04).
// A null user is a GUEST, which is a legitimate state and not an error.

import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, loadAccessToken, clearAllTokens, subscribeAuthChange, type User } from './api';

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
          setUser(await api.me());
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
    });

    return () => unsubscribe();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const res = await api.login(email, password);
    setUser(res.user);
  }, []);

  const signUp = useCallback(async (email: string, username: string, password: string) => {
    const res = await api.register(email, username, password);
    setUser(res.user);
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
