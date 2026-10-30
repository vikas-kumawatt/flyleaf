// Reading Diary standalone screen (SL-70, PRD §6.18, §6.39).
//
// Accessible from Profile, Reading tab shortcut, or deep-link.

import React, { useState, useEffect, useCallback } from 'react';
import { View, ScrollView, RefreshControl, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import type { LocalRead } from '@/offline/schema';
import { api } from '@/lib/api';
import { DiaryView } from '@/ui/DiaryView';
import { Screen, Txt, sheet, SkeletonList } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';

export default function DiaryScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const db = useDatabase();

  const [reads, setReads] = useState<LocalRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadReads = useCallback(async () => {
    if (!user || !db) return;
    try {
      const repo = new OfflineRepository(db, user.id);
      const local = await repo.getLocalReads();
      setReads(local);

      // Background network sync
      void (async () => {
        try {
          const serverReads = await api.reads();
          await repo.cacheServerReads(serverReads);
          const updated = await repo.getLocalReads();
          setReads(updated);
        } catch {
          // offline
        }
      })();
    } finally {
      setLoading(false);
    }
  }, [user, db]);

  useEffect(() => {
    loadReads();
  }, [loadReads]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await loadReads();
    setRefreshing(false);
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Navigation Header */}
      <View
        style={{
          paddingTop: insets.top + space[2],
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <View style={sheet.rowBetween}>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.back();
            }}
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
          >
            <Ionicons name="chevron-back" size={24} color={c.ink} />
          </Pressable>

          <Txt variant="title">Diary</Txt>

          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.push('/stats' as any);
            }}
            accessibilityRole="button"
            accessibilityLabel="Reading Stats"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
          >
            <Txt variant="body" color="ink2" style={{ fontWeight: '500' }}>
              Stats
            </Txt>
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space[4],
          paddingTop: space[4],
          paddingBottom: insets.bottom + space[8],
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />
        }
      >
        {loading && reads.length === 0 ? (
          <SkeletonList lead="cover" style={{ paddingHorizontal: 0, paddingTop: 0 }} />
        ) : (
          <DiaryView reads={reads} />
        )}
      </ScrollView>
    </Screen>
  );
}
