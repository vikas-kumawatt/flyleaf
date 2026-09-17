// Unsynced / Offline Indicator (SL-14, PRD §35.1, design.md §5).
//
// Appears at the top of screens when updates are pending sync or in dead-letter state.
// Literary, restrained, non-blocking. Never an alarming red banner.

import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { useOfflineSync } from '@/offline/sync';
import { Txt } from './components';
import { space, radius, useTheme } from './tokens';

export function SyncIndicator() {
  const c = useTheme();
  const { unsyncedCount, deadLetterCount, isSyncing, syncNow } = useOfflineSync();

  if (unsyncedCount === 0 && deadLetterCount === 0) {
    return null;
  }

  const label = deadLetterCount > 0
    ? `${deadLetterCount} ${deadLetterCount === 1 ? 'update' : 'updates'} could not sync`
    : `${unsyncedCount} ${unsyncedCount === 1 ? 'update' : 'updates'} will sync`;

  return (
    <View style={[styles.container, { backgroundColor: c.surface2, borderColor: c.line }]}>
      <View style={styles.content}>
        {/* Subtle dot */}
        <View
          style={[
            styles.dot,
            { backgroundColor: deadLetterCount > 0 ? c.critical : c.accent },
          ]}
        />
        <Txt variant="caption" color="ink2">
          {label}
        </Txt>
      </View>

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
