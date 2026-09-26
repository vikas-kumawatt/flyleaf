// Sync Provider & Offline State Hook (SL-14).
//
// The queue belongs to the signed-in user (audit 07): signing out or switching
// accounts swaps the repository, so nobody's writes replay under another
// account's token and the indicator counts only this user's writes.
//
// Triggers a flush:
// 1. When a user signs in (or the session is restored).
// 2. When the app returns to the foreground.
// 3. When the connection comes back (NetInfo, D-07-2).
// 4. Every 30 s, only while this user has writes waiting (backoff retries,
//    and a fallback should a reconnect event be missed).
//
// Likes and follows go through the queue too (setLiked, setFollowing).

import React, { createContext, useContext, useEffect, useState, useCallback, useRef } from 'react';
import { AppState, AppStateStatus } from 'react-native';
import NetInfo from '@react-native-community/netinfo';
import { api } from '@/lib/api';
import { useSession } from '@/lib/session';
import { getOfflineDb } from './db';
import { OfflineRepository } from './repository';
import { onQueueChange } from './queue';
import { isOnline, reconnectDetector } from './connectivity';

interface SyncContextValue {
  unsyncedCount: number;
  deadLetterCount: number;
  isSyncing: boolean;
  /** False only when NetInfo says there is definitely no connection. */
  isOnline: boolean;
  syncNow: () => Promise<void>;
  /** Re-count after a dead letter was retried or discarded. */
  refreshCounts: () => Promise<void>;
  repository: OfflineRepository | null;
  /** Like or unlike a read: queued as the wanted state (D-07-2). */
  setLiked: (readId: string, liked: boolean) => Promise<void>;
  /** Follow or unfollow: queued as the wanted state (D-07-2). */
  setFollowing: (userId: string, following: boolean) => Promise<void>;
}

const SyncContext = createContext<SyncContextValue | null>(null);

export function SyncProvider({ children }: { children: React.ReactNode }) {
  const { user } = useSession();
  const userId = user?.id ?? null;
  const [unsyncedCount, setUnsyncedCount] = useState(0);
  const [deadLetterCount, setDeadLetterCount] = useState(0);
  const [isSyncing, setIsSyncing] = useState(false);
  const [online, setOnline] = useState(true);
  const [repository, setRepository] = useState<OfflineRepository | null>(null);
  const repoRef = useRef<OfflineRepository | null>(null);

  const updateCounts = useCallback(async () => {
    const repo = repoRef.current;
    if (!repo) {
      setUnsyncedCount(0);
      setDeadLetterCount(0);
      return;
    }
    try {
      setUnsyncedCount(await repo.getUnsyncedCount());
      setDeadLetterCount((await repo.getQueue().getDeadLetters()).length);
    } catch {
      // Counts are advisory; the queue itself is unaffected.
    }
  }, []);

  const flush = useCallback(async (force = false) => {
    const repo = repoRef.current;
    if (!repo) return;
    setIsSyncing(true);
    try {
      await repo.getQueue().flush(force);
    } finally {
      setIsSyncing(false);
      await updateCounts();
    }
  }, [updateCounts]);

  // One repository per signed-in user.
  useEffect(() => {
    let cancelled = false;
    repoRef.current = null;
    setRepository(null);
    void updateCounts();
    if (!userId) return;

    (async () => {
      try {
        const db = await getOfflineDb();
        if (cancelled) return;
        const repo = new OfflineRepository(db, userId);
        repoRef.current = repo;
        setRepository(repo);
        await flush();
      } catch {
        // The local database failed to open; screens fall back to the network.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [userId, flush, updateCounts]);

  // Writes queued by screens, and flushes they start, update the counts.
  useEffect(() => onQueueChange(() => void updateCounts()), [updateCounts]);

  // Retry timer, only while something is waiting.
  useEffect(() => {
    if (unsyncedCount === 0) return;
    const interval = setInterval(() => void flush(), 30_000);
    return () => clearInterval(interval);
  }, [unsyncedCount, flush]);

  // Foreground.
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next: AppStateStatus) => {
      if (next === 'active') void flush();
    });
    return () => subscription.remove();
  }, [flush]);

  // Reconnect: skip the backoff wait, the reason for it has gone.
  useEffect(() => {
    const reconnected = reconnectDetector();
    return NetInfo.addEventListener((state) => {
      setOnline(isOnline(state));
      if (reconnected(state)) void flush(true);
    });
  }, [flush]);

  // "Sync now" skips the backoff wait.
  const syncNow = useCallback(() => flush(true), [flush]);

  // Without a local database (still opening, or it failed to open) the write
  // goes straight to the server, as it did before the queue took it, and a
  // failure reaches the screen.
  const setLiked = useCallback(async (readId: string, liked: boolean) => {
    const repo = repoRef.current;
    if (repo) return repo.setLiked(readId, liked);
    await api.client.setLiked(readId, liked);
  }, []);

  const setFollowing = useCallback(async (userId: string, following: boolean) => {
    const repo = repoRef.current;
    if (repo) return repo.setFollowing(userId, following);
    await (following ? api.client.followUser(userId) : api.client.unfollowUser(userId));
  }, []);

  return (
    <SyncContext.Provider
      value={{
        unsyncedCount,
        deadLetterCount,
        isSyncing,
        isOnline: online,
        syncNow,
        refreshCounts: updateCounts,
        repository,
        setLiked,
        setFollowing,
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
      isOnline: true,
      syncNow: async () => {},
      refreshCounts: async () => {},
      repository: null,
      setLiked: async (readId, liked) => {
        await api.client.setLiked(readId, liked);
      },
      setFollowing: async (userId, following) => {
        await (following ? api.client.followUser(userId) : api.client.unfollowUser(userId));
      },
    };
  }
  return ctx;
}
