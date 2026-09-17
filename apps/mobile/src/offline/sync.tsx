// Sync Provider & Offline State Hook (SL-14).
//
// Triggers queue flush:
// 1. When app returns to foreground (AppState -> active).
// 2. On network reconnect.
// 3. Periodically when unsynced mutations are pending.

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import { getOfflineDb } from './db';
import { OfflineRepository } from './repository';

interface SyncContextValue {
  unsyncedCount: number;
  deadLetterCount: number;
  isSyncing: boolean;
  syncNow: () => Promise<void>;
  repository: OfflineRepository | null;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [deadLetterCount, setDeadLetterCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [repository, setRepository] = useState<OfflineRepository | null>(null);
  const repoRef = useRef<OfflineRepository | null>(null);

  const updateCounts = useCallback(async (repo: OfflineRepository) => {
    try {
      const pending = await repo.getUnsyncedCount();
      const deadLetters = await repo.getQueue().getDeadLetters();
      setUnsyncedCount(pending);
      setDeadLetterCount(deadLetters.length);
    } catch {
      // Non-fatal
    }
  }, []);

  const syncNow = useCallback(async () => {
    const repo = repoRef.current;
    if (!repo || isSyncing) return;

    setIsSyncing(true);
    try {
      await repo.getQueue().flush();
      await updateCounts(repo);
    } finally {
      setIsSyncing(false);
    }
  }, [isSyncing, updateCounts]);

  useEffect(() => {
    let interval: ReturnType<typeof setInterval>;

    (async () => {
      try {
        const db = await getOfflineDb();
        const repo = new OfflineRepository(db);
        repoRef.current = repo;
        setRepository(repo);
        await updateCounts(repo);
        void repo.getQueue().flush();

        // Poll counts / pending retries every 30 seconds
        interval = setInterval(() => {
          void updateCounts(repo);
          void repo.getQueue().flush();
        }, 30000);
      } catch {
        // Initialization failure
      }
    })();

    // Flush on foreground (AppState: active)
    const subscription = AppState.addEventListener('change', (nextState: AppStateStatus) => {
      if (nextState === 'active' && repoRef.current) {
        void repoRef.current.getQueue().flush();
        void updateCounts(repoRef.current);
      }
    });

    return () => {
      subscription.remove();
      if (interval) clearInterval(interval);
    };
  }, [updateCounts]);

  return (
    <SyncContext.Provider
      value={{
        unsyncedCount,
        deadLetterCount,
        isSyncing,
        syncNow,
        repository,
      }}
    >
      {children}
    </SyncContext.Provider>
  );
}

export function useOfflineSync(): SyncContextValue {
  const ctx = useContext(SyncContext);
  if (!ctx) {
    return {
      unsyncedCount: 0,
      deadLetterCount: 0,
      isSyncing: false,
      syncNow: async () => {},
      repository: null,
    };
  }
  return ctx;
}
