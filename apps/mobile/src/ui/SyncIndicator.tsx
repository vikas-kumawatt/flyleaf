// Unsynced / Offline Indicator (SL-14, PRD §35.1, design.md §5).
//
// Appears at the top of screens when updates are pending sync or in dead-letter
// state, and whenever the phone is offline (D-07-2).
// Literary, restrained, non-blocking. Never an alarming red banner.

import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useRouter } from 'expo-router';
import { useOfflineSync } from '@/offline/sync';
import { Txt } from './components';
import { space, radius, useTheme } from './tokens';

export function SyncIndicator() {
  const c = useTheme();
  const router = useRouter();
  const { unsyncedCount, deadLetterCount, isSyncing, isOnline, syncNow } = useOfflineSync();

  if (isOnline && unsyncedCount === 0 && deadLetterCount === 0) {
    return null;
  }

  const updates = (n: number) => `${n} ${n === 1 ? 'update' : 'updates'}`;
  const label = deadLetterCount > 0
    ? `${updates(deadLetterCount)} could not sync`
    : !isOnline
      ? unsyncedCount > 0
        ? `Offline · ${updates(unsyncedCount)} will sync when you reconnect`
        : "Offline · changes will sync when you're back"
      : `${updates(unsyncedCount)} will sync`;

  return (
    <View style={[styles.container, { backgroundColor: c.surface2, borderColor: c.line }]}>
      <Pressable
        style={styles.content}
        onPress={() => router.push('/sync-issues' as any)}
        disabled={deadLetterCount === 0}
        accessibilityRole={deadLetterCount > 0 ? 'link' : undefined}
        accessibilityHint={deadLetterCount > 0 ? 'Shows what could not sync, with retry and discard' : undefined}
      >
        {/* Subtle dot */}
        <View
          style={[
            styles.dot,
            { backgroundColor: deadLetterCount > 0 ? c.critical : isOnline ? c.accent : c.muted },
          ]}
        />
        <Txt variant="caption" color="ink2">
          {label}
        </Txt>
        {deadLetterCount > 0 ? <Ionicons name="chevron-forward" size={14} color={c.muted} /> : null}
      </Pressable>

      {/* Offline there is nowhere to send it. */}
      {isOnline ? (
        <Pressable
          onPress={syncNow}
          disabled={isSyncing}
          accessibilityRole="button"
          accessibilityLabel="Sync pending updates"
          style={styles.actionButton}
        >
          <Ionicons
            name={isSyncing ? 'refresh' : 'cloud-upload-outline'}
            size={16}
            color={c.accent}
          />
          <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
            {isSyncing ? 'Syncing…' : 'Sync now'}
          </Txt>
        </Pressable>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    paddingVertical: space[2],
    borderBottomWidth: 1,
  },
  content: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: radius.pill,
  },
  actionButton: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[1],
    paddingVertical: 4,
    paddingHorizontal: space[2],
  },
});
