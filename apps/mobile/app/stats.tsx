// Reading Stats Screen (SL-74, PRD §6.18, §6.40).
//
// Volume, temporal pace, taste profile, rating distribution, and extremes.

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { api, type ReadingStats } from '@/lib/api';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const loadStats = useCallback(async () => {
    if (!targetUserId) return;
    try {
      setLoading(true);
      const res = isOtherUser
        ? await api.userStats(targetUserId, selectedYear)
        : await api.myStats(selectedYear);
      setStats(res);
    } catch {
      // Offline / error
    } finally {
      setLoading(false);
    }
  }, [targetUserId, isOtherUser, selectedYear]);

  useEffect(() => {
    loadStats();
  }, [loadStats]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await loadStats();
    setRefreshing(false);
  };

  // Max books in a single month for pace bar scaling
  const maxMonthBooks = useMemo(() => {
    if (!stats?.monthly_pace) return 1;
    return Math.max(1, ...stats.monthly_pace.map((m) => m.books));
  }, [stats]);

  // Max rating count for histogram bar scaling
  const maxRatingCount = useMemo(() => {
    if (!stats?.rating_distribution) return 1;
    const values = Object.values(stats.rating_distribution);
    return Math.max(1, ...values);
  }, [stats]);

  // Total formats count for percentage calculation
  const totalFormats = useMemo(() => {
    if (!stats?.format_breakdown) return 0;
    return stats.format_breakdown.print + stats.format_breakdown.ebook + stats.format_breakdown.audiobook;
  }, [stats]);

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Header */}
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

        {/* Year Pills */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space[2], marginTop: space[3] }}
        >
          {['all', String(currentYear), String(currentYear - 1), String(currentYear - 2)].map((yr) => (
            <Pressable
              key={yr}
              onPress={() => {
                void Haptics.selectionAsync();
                setSelectedYear(yr);
              }}
              style={[
                styles.yearPill,
                {
                  backgroundColor: selectedYear === yr ? c.ink : c.surface,
                  borderColor: selectedYear === yr ? c.ink : c.line,
                },
              ]}
            >
              <Txt
                variant="caption"
                style={{
                  color: selectedYear === yr ? c.ground : c.ink,
                  fontWeight: '600',
                }}
              >
                {yr === 'all' ? 'All-Time' : yr}
              </Txt>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space[4],
          paddingTop: space[4],
          paddingBottom: insets.bottom + space[8],
          gap: space[4],
        }}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={c.accent} />
        }
      >
        {loading && !stats ? (
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : !stats || stats.books_count === 0 ? (
          <EmptyState
            title="No reading stats yet"
            subtitle="As you finish books and log reading activity, your annual volume, pace, and taste insights appear here."
            action={
              <Button
                label="Explore books"
                variant="primary"
                onPress={() => router.push('/(tabs)/discover' as any)}
              />
            }
          />
        ) : (
          <>
            {/* 1. VOLUME HERO CARDS */}
            <View style={{ gap: space[2] }}>
              <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                Volume & Habit
              </Txt>

              <View style={styles.metricsGrid}>
                {/* Books count */}
                <Card style={[styles.metricCard, { backgroundColor: c.surface }]}>
                  <Txt variant="caption" color="muted">
                    Books Finished
                  </Txt>
                  <Txt variant="title" style={styles.metricNumber}>
                    {stats.books_count}
                  </Txt>
                </Card>

                {/* Pages count */}
                <Card style={[styles.metricCard, { backgroundColor: c.surface }]}>
                  <Txt variant="caption" color="muted">
                    Pages Read
                  </Txt>
                  <Txt variant="title" style={styles.metricNumber}>
                    {stats.pages_count.toLocaleString()}
                  </Txt>
                </Card>

                {/* Audio hours */}
                <Card style={[styles.metricCard, { backgroundColor: c.surface }]}>
                  <Txt variant="caption" color="muted">
                    Audio Hours
                  </Txt>
                  <Txt variant="title" style={styles.metricNumber}>
                    {stats.audio_hours}h
                  </Txt>
                </Card>

                {/* Reading Habit Streak */}
                <Card style={[styles.metricCard, { backgroundColor: c.surface }]}>
                  <Txt variant="caption" color="muted">
                    Daily Streak
                  </Txt>
                  <View style={sheet.row}>
                    <Txt variant="title" style={[styles.metricNumber, { color: '#f59e0b' }]}>
                      {stats.current_streak}
                    </Txt>
                    <Txt variant="caption" color="muted" style={{ marginLeft: 4, marginTop: 6 }}>
                      (best {stats.longest_streak}d)
                    </Txt>
                  </View>
                </Card>
              </View>
            </View>

            {/* 2. TEMPORAL PACE CHART */}
            <Card style={{ padding: space[4], gap: space[3] }}>
              <View style={sheet.rowBetween}>
                <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                  Monthly Pace
                </Txt>
                <Txt variant="caption" color="muted">
                  Books per month
                </Txt>
              </View>

              <View style={styles.chartContainer}>
                {stats.monthly_pace.map((item, idx) => {
                  const heightPercent = maxMonthBooks > 0 ? (item.books / maxMonthBooks) * 100 : 0;
                  const isTopMonth = item.books === maxMonthBooks && item.books > 0;

                  return (
                    <View key={idx} style={styles.chartColumn}>
                      {item.books > 0 && (
                        <Txt variant="caption" style={{ fontSize: 10, color: c.accent, fontWeight: '700' }}>
                          {item.books}
                        </Txt>
                      )}
                      <View style={styles.barTrack}>
                        <View
                          style={[
                            styles.barFill,
                            {
                              height: `${Math.max(item.books > 0 ? 8 : 2, heightPercent)}%`,
                              backgroundColor: isTopMonth ? c.accent : c.line,
                            },
                          ]}
                        />
                      </View>
                      <Txt variant="caption" color="muted" style={{ fontSize: 10, marginTop: 4 }}>
                        {MONTH_NAMES[idx]}
                      </Txt>
                    </View>
                  );
                })}
              </View>
            </Card>

            {/* 3. TASTE PROFILE: RATINGS & FORMATS */}
            <View style={{ gap: space[3] }}>
              <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                Taste & Formats
              </Txt>

              <Card style={{ padding: space[4], gap: space[4] }}>
                {/* Average Rating Banner */}
                {stats.avg_rating !== null && (
                  <View style={[sheet.rowBetween, { borderBottomWidth: 1, borderBottomColor: c.line, paddingBottom: space[3] }]}>
                    <View>
                      <Txt variant="caption" color="muted">
                        Average Star Rating
                      </Txt>
                      <View style={[sheet.row, { gap: space[2], marginTop: 2 }]}>
                        <Txt variant="title" style={{ fontSize: 28, fontWeight: '800', color: c.accent }}>
                          ★ {typeof stats.avg_rating === 'number' ? stats.avg_rating.toFixed(2) : '—'}
                        </Txt>
                        <Txt variant="caption" color="muted" style={{ marginTop: 8 }}>
                          across {Object.values(stats.rating_distribution).reduce((a, b) => a + b, 0)} rated books
                        </Txt>
                      </View>
                    </View>
                  </View>
                )}

                {/* Rating Distribution Histogram */}
                <View style={{ gap: space[2] }}>
                  <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
                    Rating Distribution
                  </Txt>
                  {['5', '4', '3', '2', '1'].map((star) => {
                    const count = stats.rating_distribution[star as keyof typeof stats.rating_distribution] || 0;
                    const fillPercent = maxRatingCount > 0 ? (count / maxRatingCount) * 100 : 0;

                    return (
                      <View key={star} style={[sheet.row, { gap: space[2] }]}>
                        <Txt variant="caption" style={{ width: 24, fontWeight: '600' }}>
                          {star}★
                        </Txt>
                        <View style={[styles.histTrack, { backgroundColor: c.ground }]}>
                          <View
                            style={[
                              styles.histFill,
                              {
                                width: `${fillPercent}%`,
                                backgroundColor: count > 0 ? c.accent : 'transparent',
                              },
                            ]}
                          />
                        </View>
                        <Txt variant="caption" color="muted" style={{ width: 28, textAlign: 'right' }}>
                          {count}
                        </Txt>
                      </View>
                    );
                  })}
                </View>

                {/* Format Breakdown */}
                {totalFormats > 0 && (
                  <View style={{ gap: space[2], borderTopWidth: 1, borderTopColor: c.line, paddingTop: space[3] }}>
                    <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
                      Format Breakdown
                    </Txt>
                    <View style={[sheet.rowBetween, { gap: space[2] }]}>
                      {(['print', 'ebook', 'audiobook'] as const).map((fmt) => {
                        const count = stats.format_breakdown[fmt];
                        const pct = Math.round((count / totalFormats) * 100);
                        const label = fmt === 'print' ? 'Print' : fmt === 'ebook' ? 'eBook' : 'Audio';

                        return (
                          <View
                            key={fmt}
                            style={[
                              styles.formatBox,
                              { backgroundColor: c.ground, borderColor: c.line },
                            ]}
                          >
                            <Txt variant="title" style={{ fontSize: 18, fontWeight: '700' }}>
                              {count}
                            </Txt>
                            <Txt variant="caption" color="muted">
                              {label} ({pct}%)
                            </Txt>
                          </View>
                        );
                      })}
                    </View>
                  </View>
                )}

                {/* DNF Stats */}
                <View style={[sheet.rowBetween, { borderTopWidth: 1, borderTopColor: c.line, paddingTop: space[3] }]}>
                  <Txt variant="caption" color="muted">
                    Did Not Finish (DNF)
                  </Txt>
                  <Txt variant="caption" color="ink" style={{ fontWeight: '600' }}>
                    {stats.dnf_count} {stats.dnf_count === 1 ? 'book' : 'books'} ({stats.dnf_rate}% rate)
                  </Txt>
                </View>
              </Card>
            </View>

            {/* 4. READING EXTREMES */}
            <View style={{ gap: space[3] }}>
              <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                Reading Extremes
              </Txt>

              <View style={{ gap: space[3] }}>
                {/* Longest Book */}
                {stats.longest_book && (
                  <Card
                    onPress={() => router.push(`/work/${stats.longest_book?.work_id}` as any)}
                    style={{ padding: space[3] }}
                  >
                    <View style={sheet.rowTop}>
                      <Cover coverId={stats.longest_book.cover_id} title={stats.longest_book.title} size="m" />
                      <View style={{ flex: 1, marginLeft: space[3], gap: 2 }}>
                        <Txt variant="caption" color="accent" style={{ fontWeight: '700' }}>
                          LONGEST BOOK
                        </Txt>
                        <Txt variant="title" numberOfLines={1}>
                          {stats.longest_book.title}
                        </Txt>
                        <Txt variant="caption" color="muted" numberOfLines={1}>
                          {stats.longest_book.author_name}
                        </Txt>
                        <Txt variant="caption" style={{ fontWeight: '700', marginTop: 4 }}>
                          {stats.longest_book.page_count?.toLocaleString()} pages
                        </Txt>
                      </View>
                    </View>
                  </Card>
                )}

                {/* Shortest Book */}
                {stats.shortest_book && (
                  <Card
                    onPress={() => router.push(`/work/${stats.shortest_book?.work_id}` as any)}
                    style={{ padding: space[3] }}
                  >
                    <View style={sheet.rowTop}>
                      <Cover coverId={stats.shortest_book.cover_id} title={stats.shortest_book.title} size="m" />
                      <View style={{ flex: 1, marginLeft: space[3], gap: 2 }}>
                        <Txt variant="caption" color="accent" style={{ fontWeight: '700' }}>
                          SHORTEST BOOK
                        </Txt>
                        <Txt variant="title" numberOfLines={1}>
                          {stats.shortest_book.title}
                        </Txt>
                        <Txt variant="caption" color="muted" numberOfLines={1}>
                          {stats.shortest_book.author_name}
                        </Txt>
                        <Txt variant="caption" style={{ fontWeight: '700', marginTop: 4 }}>
                          {stats.shortest_book.page_count?.toLocaleString()} pages
                        </Txt>
                      </View>
                    </View>
                  </Card>
                )}

                {/* Most Read Author */}
                {stats.most_read_author && (
                  <Card style={{ padding: space[3] }}>
                    <View style={sheet.rowBetween}>
                      <View style={{ gap: 2 }}>
                        <Txt variant="caption" color="accent" style={{ fontWeight: '700' }}>
                          MOST READ AUTHOR
                        </Txt>
                        <Txt variant="title" style={{ fontSize: 16 }}>
                          {stats.most_read_author.name}
                        </Txt>
                      </View>
                      <View style={[styles.authorPill, { backgroundColor: c.ground, borderColor: c.line }]}>
                        <Txt variant="caption" color="ink" style={{ fontWeight: '700' }}>
                          {stats.most_read_author.count} {stats.most_read_author.count === 1 ? 'book' : 'books'}
                        </Txt>
                      </View>
                    </View>
                  </Card>
                )}
              </View>
            </View>
          </>
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
  metricsGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
  },
  metricCard: {
    width: '48.5%',
    padding: space[3],
    gap: 4,
  },
  metricNumber: {
    fontSize: 24,
    fontWeight: '800',
  },
  chartContainer: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    height: 120,
    gap: 4,
    paddingTop: space[3],
  },
  chartColumn: {
    flex: 1,
    height: '100%',
    alignItems: 'center',
    justifyContent: 'flex-end',
  },
  barTrack: {
    width: '100%',
    height: 80,
    justifyContent: 'flex-end',
    alignItems: 'center',
  },
  barFill: {
    width: 14,
    borderRadius: radius.sm,
  },
  histTrack: {
    flex: 1,
    height: 12,
    borderRadius: radius.pill,
    overflow: 'hidden',
  },
  histFill: {
    height: '100%',
    borderRadius: radius.pill,
  },
  formatBox: {
    flex: 1,
    padding: space[2],
    alignItems: 'center',
    borderRadius: radius.sm,
    borderWidth: 1,
    gap: 2,
  },
  authorPill: {
    paddingHorizontal: space[3],
    paddingVertical: 4,
    borderRadius: radius.pill,
    borderWidth: 1,
  },
});
