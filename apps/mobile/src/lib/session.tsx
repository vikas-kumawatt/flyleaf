// Minimal auth context. A null user is a GUEST, which is a legitimate state
// and not an error — the whole point of PRD §4.2.
import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { api, clearToken, loadToken, saveToken, User } from './api';

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
        if (await loadToken()) setUser(await api.me());
      } catch {
        await clearToken();
      } finally {
        setReady(true);
      }
    })();
  }, []);

  const signIn = useCallback(async (email: string, password: string) => {
    const { user, token } = await api.login(email, password);
    await saveToken(token);
    setUser(user);
  }, []);

  const signUp = useCallback(async (email: string, username: string, password: string) => {
    const { user, token } = await api.register(email, username, password);
    await saveToken(token);
    setUser(user);
  }, []);

  const signOut = useCallback(async () => {
    await clearToken();
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
