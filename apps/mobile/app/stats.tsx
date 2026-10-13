// Reading Stats (SL-74, ST-04; PRD §6.40, §17.2–17.4).
//
// One statistic per card, vertically (§17.3), each with its own number, its
// ST-03 disclosure ("Based on 180 of your 247 books — …"), its method on tap
// and, on your own stats, a Share button that opens the preview of that
// stat's server-rendered card (§6.45). The cards come from statCards(), so
// a figure with nothing under it has no card rather than a made-up zero.
//
// From 1 December a banner opens your Year in Review (ST-09). No goal ring
// here: §8.6 [LOCKED] keeps it on the profile.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { YearInReview } from '@flyleaf/api-client';
import { useSession } from '@/lib/session';
import { api, type ReadingStats } from '@/lib/api';
import { track } from '@/lib/events';
import { deviceTimeZone } from '@/lib/statsView';
import { statCards, statsEmpty } from '@/lib/statCards';
import { encodeShareOptions, statShareOptions } from '@/lib/shareCard';
import { yirBanner } from '@/lib/yearInReview';
import { Button, Card, EmptyState, Screen, Txt, sheet } from '@/ui/components';
import { StatCard } from '@/ui/StatCard';
import { radius, space, useTheme } from '@/ui/tokens';

export default function StatsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const params = useLocalSearchParams<{ userId?: string; userName?: string }>();

  const isOtherUser = Boolean(params.userId && params.userId !== user?.id);
  const targetUserId = params.userId || user?.id;

  const currentYear = new Date().getFullYear();
  const [selectedYear, setSelectedYear] = useState<string>(String(currentYear));
  const [stats, setStats] = useState<ReadingStats | null>(null);
  const [yir, setYir] = useState<YearInReview | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadStats = useCallback(async () => {
    if (!targetUserId) return;
    try {
      setLoading(true);
      const res = isOtherUser
        ? await api.userStats(targetUserId, selectedYear, deviceTimeZone())
        : await api.myStats(selectedYear, deviceTimeZone());
      setStats(res);
      track('stats_viewed', { year: selectedYear });
    } catch {
      // Offline / error: keep what is shown.
    } finally {
      setLoading(false);
    }
  }, [targetUserId, isOtherUser, selectedYear]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  // Your own Year in Review, once it is open (ST-09).
  useEffect(() => {
    if (isOtherUser || !user) return;
    api.yearInReview(undefined, deviceTimeZone()).then(setYir).catch(() => setYir(null));
  }, [isOtherUser, user]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await loadStats();
    setRefreshing(false);
  };

  const cards = useMemo(() => (stats ? statCards(stats, isOtherUser ? 'their' : 'your') : []), [stats, isOtherUser]);
  const banner = yirBanner(yir);

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <View
        style={{
          paddingTop: insets.top + space[2], paddingHorizontal: space[4], paddingBottom: space[3],
          backgroundColor: c.ground, borderBottomWidth: 1, borderBottomColor: c.line,
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
            <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
              ← Back
            </Txt>
          </Pressable>
          <Txt variant="title" style={{ fontWeight: '700', fontSize: 18 }}>
            Reading Stats
          </Txt>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.push('/wall' as any);
            }}
            accessibilityRole="button"
            accessibilityLabel="The Wall"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
          >
            <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
              The Wall
            </Txt>
          </Pressable>
        </View>

        <ScrollView horizontal showsHorizontalScrollIndicator={false} contentContainerStyle={{ gap: space[2], marginTop: space[3] }}>
          {['all', String(currentYear), String(currentYear - 1), String(currentYear - 2)].map((yr) => (
            <Pressable
              key={yr}
              onPress={() => {
                void Haptics.selectionAsync();
                setSelectedYear(yr);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: selectedYear === yr }}
              style={[
                styles.yearPill,
                { backgroundColor: selectedYear === yr ? c.ink : c.surface, borderColor: selectedYear === yr ? c.ink : c.line },
              ]}
            >
              <Txt variant="caption" style={{ color: selectedYear === yr ? c.ground : c.ink, fontWeight: '600' }}>
                {yr === 'all' ? 'All-Time' : yr}
              </Txt>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={{ paddingHorizontal: space[4], paddingTop: space[4], paddingBottom: insets.bottom + space[8], gap: space[3] }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />}
      >
        {banner && (
          <Card
            onPress={() => router.push(`/year-in-review?year=${banner.year}` as any)}
            style={{ padding: space[4], backgroundColor: c.accentSoft, borderColor: c.accent }}
          >
            <Txt variant="title" style={{ fontWeight: '700' }}>
              {banner.title}
            </Txt>
            <Txt variant="caption" color="ink2">
              {banner.subtitle}
            </Txt>
          </Card>
        )}

        {loading && !stats ? (
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : statsEmpty(stats) ? (
          <EmptyState
            title="Finish a few books and your stats will appear"
            subtitle="Once three books are finished, this is where your year in reading takes shape."
            action={<Button label="Explore books" variant="primary" onPress={() => router.push('/(tabs)/discover' as any)} />}
          />
        ) : (
          cards.map((card) => (
            <StatCard
              key={card.kind}
              card={card}
              onOpenBook={(workId) => router.push(`/work/${workId}` as any)}
              onShare={
                isOtherUser || !targetUserId
                  ? undefined
                  : () => {
                      void Haptics.selectionAsync();
                      const options = statShareOptions(targetUserId, card.kind, selectedYear, deviceTimeZone());
                      router.push(`/share?options=${encodeURIComponent(encodeShareOptions(options))}` as any);
                    }
              }
            />
          ))
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  yearPill: {
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
