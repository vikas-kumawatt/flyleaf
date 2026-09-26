// The Wall Screen (SL-71, PRD §6.18, §6.39).
//
// 3-column poster grid at 2:3 aspect ratio (2-column below 340dp width).
// Multi-filter bar: Year, Rating, Hearted, Format, Sort.

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  useWindowDimensions,
  StyleSheet,
  RefreshControl,
} from 'react-native';
import { useRouter, useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import type { LocalRead } from '@/offline/schema';
import { api } from '@/lib/api';
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

export default function WallScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { width } = useWindowDimensions();
  const { user } = useSession();
  const db = useDatabase();
  const params = useLocalSearchParams<{ userId?: string; userName?: string }>();

  const isOtherUser = Boolean(params.userId && params.userId !== user?.id);
  const targetUserId = params.userId || user?.id;

  const [reads, setReads] = useState<LocalRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Filters
  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [formatFilter, setFormatFilter] = useState<'all' | 'print' | 'ebook' | 'audiobook'>('all');
  const [ratingFilter, setRatingFilter] = useState<'all' | '5' | '4' | '3'>('all');
  const [heartedOnly, setHeartedOnly] = useState(false);
  const [sortBy, setSortBy] = useState<'date_desc' | 'date_asc' | 'rating_desc' | 'title_asc'>('date_desc');

  // Responsive columns (SL-71: 3-col default, 2-col below 340dp)
  const numColumns = width < 340 ? 2 : 3;
  const colGap = space[2];
  const itemWidth = (width - space[4] * 2 - colGap * (numColumns - 1)) / numColumns;

  const loadReads = useCallback(async () => {
    if (!targetUserId) return;
    try {
      if (!isOtherUser && db && user) {
        // Load local SQLite for instant feel
        const repo = new OfflineRepository(db, user.id);
        const local = await repo.getLocalReads();
        setReads(local.filter((r) => r.status === 'finished'));

        void (async () => {
          try {
            const server = await api.reads('finished');
            await repo.cacheServerReads(server);
            const updated = await repo.getLocalReads();
            setReads(updated.filter((r) => r.status === 'finished'));
          } catch {
            // offline fallback
          }
        })();
      } else {
        // External user reads
        try {
          const server = await api.reads('finished');
          setReads(
            server.map((s) => ({
              id: s.id,
              user_id: s.user_id,
              work_id: s.work_id,
              edition_id: s.edition_id,
              status: s.status,
              attempt_no: s.attempt_no,
              started_at: s.started_at,
              finished_at: s.finished_at,
              abandoned_at: s.abandoned_at,
              abandoned_page: s.abandoned_page,
              dnf_reason: s.dnf_reason,
              rating: s.rating ? Number(s.rating) : null,
              hearted: s.hearted ? 1 : 0,
              format_override: s.format_override,
              visibility: s.visibility,
              title: s.title ?? null,
              author_name: s.author_name ?? null,
              cover_id: s.cover_id ?? null,
              page: s.page ?? null,
              percent: s.percent ? Number(s.percent) : null,
              page_count: s.page_count ?? null,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              is_local_only: 0,
              synced: 1,
            }))
          );
        } catch {
          // network error
        }
      }
    } finally {
      setLoading(false);
    }
  }, [targetUserId, isOtherUser, db]);

  useEffect(() => {
    loadReads();
  }, [loadReads]);

  const onRefresh = async () => {
    setRefreshing(true);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await loadReads();
    setRefreshing(false);
  };

  // Distinct available years
  const availableYears = useMemo(() => {
    const years = new Set<string>();
    for (const r of reads) {
      if (r.finished_at) {
        const y = r.finished_at.slice(0, 4);
        if (/^\d{4}$/.test(y)) years.add(y);
      }
    }
    return Array.from(years).sort().reverse();
  }, [reads]);

  // Filter and sort reads
  const processedReads = useMemo(() => {
    return reads
      .filter((r) => {
        if (selectedYear !== 'all') {
          const y = r.finished_at?.slice(0, 4);
          if (y !== selectedYear) return false;
        }
        if (formatFilter !== 'all') {
          const fmt = r.format_override ?? 'print';
          if (fmt !== formatFilter) return false;
        }
        if (ratingFilter !== 'all') {
          const min = Number(ratingFilter);
          if (r.rating === null || r.rating === undefined || r.rating < min) return false;
        }
        if (heartedOnly && !r.hearted) {
          return false;
        }
        return true;
      })
      .sort((a, b) => {
        if (sortBy === 'rating_desc') {
          return (b.rating ?? 0) - (a.rating ?? 0);
        }
        if (sortBy === 'title_asc') {
          return (a.title || '').localeCompare(b.title || '');
        }
        if (sortBy === 'date_asc') {
          return (a.finished_at || '').localeCompare(b.finished_at || '');
        }
        // default: date_desc
        return (b.finished_at || '').localeCompare(a.finished_at || '');
      });
  }, [reads, selectedYear, formatFilter, ratingFilter, heartedOnly, sortBy]);

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

          <View style={{ alignItems: 'center' }}>
            <Txt variant="title" style={{ fontWeight: '700', fontSize: 18 }}>
              The Wall
            </Txt>
            <Txt variant="caption" color="muted">
              {processedReads.length} {processedReads.length === 1 ? 'cover' : 'covers'}
            </Txt>
          </View>

          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              // Cycle sort
              setSortBy((prev) => {
                if (prev === 'date_desc') return 'rating_desc';
                if (prev === 'rating_desc') return 'title_asc';
                return 'date_desc';
              });
            }}
            accessibilityRole="button"
            accessibilityLabel="Sort"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
          >
            <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
              {sortBy === 'date_desc' ? 'Recent' : sortBy === 'rating_desc' ? 'Rating' : 'A-Z'}
            </Txt>
          </Pressable>
        </View>

        {/* Filter ScrollBar */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space[2], marginTop: space[3] }}
        >
          {/* Hearted Toggle */}
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              setHeartedOnly(!heartedOnly);
            }}
            style={[
              styles.filterPill,
              {
                backgroundColor: heartedOnly ? c.accent : c.surface,
                borderColor: heartedOnly ? c.accent : c.line,
              },
            ]}
          >
            <Txt variant="caption" style={{ color: heartedOnly ? '#fff' : c.ink, fontWeight: '600' }}>
              ♥ {heartedOnly ? 'Hearted' : 'All'}
            </Txt>
          </Pressable>

          {/* Year Pills */}
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              setSelectedYear('all');
            }}
            style={[
              styles.filterPill,
              {
                backgroundColor: selectedYear === 'all' ? c.ink : c.surface,
                borderColor: selectedYear === 'all' ? c.ink : c.line,
              },
            ]}
          >
            <Txt variant="caption" style={{ color: selectedYear === 'all' ? c.ground : c.ink, fontWeight: '600' }}>
              All Time
            </Txt>
          </Pressable>

          {availableYears.map((yr) => (
            <Pressable
              key={yr}
              onPress={() => {
                void Haptics.selectionAsync();
                setSelectedYear(yr);
              }}
              style={[
                styles.filterPill,
                {
                  backgroundColor: selectedYear === yr ? c.ink : c.surface,
                  borderColor: selectedYear === yr ? c.ink : c.line,
                },
              ]}
            >
              <Txt variant="caption" style={{ color: selectedYear === yr ? c.ground : c.ink, fontWeight: '600' }}>
                {yr}
              </Txt>
            </Pressable>
          ))}

          <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: space[1] }} />

          {/* Rating Pills */}
          {(['all', '5', '4', '3'] as const).map((rKey) => (
            <Pressable
              key={rKey}
              onPress={() => {
                void Haptics.selectionAsync();
                setRatingFilter(rKey);
              }}
              style={[
                styles.filterPill,
                {
                  backgroundColor: ratingFilter === rKey ? c.surface : 'transparent',
                  borderColor: ratingFilter === rKey ? c.accent : c.line,
                },
              ]}
            >
              <Txt
                variant="caption"
                style={{
                  color: ratingFilter === rKey ? c.accent : c.muted,
                  fontWeight: ratingFilter === rKey ? '700' : '500',
                }}
              >
                {rKey === 'all' ? 'All Ratings' : `${rKey}★+`}
              </Txt>
            </Pressable>
          ))}

          <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: space[1] }} />

          {/* Format Pills */}
          {(['all', 'print', 'ebook', 'audiobook'] as const).map((fmt) => (
            <Pressable
              key={fmt}
              onPress={() => {
                void Haptics.selectionAsync();
                setFormatFilter(fmt);
              }}
              style={[
                styles.filterPill,
                {
                  backgroundColor: formatFilter === fmt ? c.surface : 'transparent',
                  borderColor: formatFilter === fmt ? c.accent : c.line,
                },
              ]}
            >
              <Txt
                variant="caption"
                style={{
                  color: formatFilter === fmt ? c.accent : c.muted,
                  fontWeight: formatFilter === fmt ? '700' : '500',
                }}
              >
                {fmt === 'all' ? 'All Formats' : fmt.charAt(0).toUpperCase() + fmt.slice(1)}
              </Txt>
            </Pressable>
          ))}
        </ScrollView>
      </View>

      {/* Poster Grid */}
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
        {processedReads.length === 0 ? (
          <EmptyState
            title="No covers to display"
            subtitle={
              reads.length === 0
                ? "As you finish books, their cover art creates your Wall."
                : 'No books matched the selected filters.'
            }
            action={
              reads.length > 0 ? (
                <Button
                  label="Clear filters"
                  variant="outline"
                  onPress={() => {
                    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setSelectedYear('all');
                    setFormatFilter('all');
                    setRatingFilter('all');
                    setHeartedOnly(false);
                  }}
                />
              ) : undefined
            }
          />
        ) : (
          <View style={styles.gridWrap}>
            {processedReads.map((r) => (
              <Pressable
                key={r.id}
                onPress={() => {
                  void Haptics.selectionAsync();
                  router.push(`/work/${r.work_id}` as any);
                }}
                style={[styles.posterWrap, { width: itemWidth }]}
                accessibilityRole="button"
                accessibilityLabel={r.title ?? 'Book cover'}
              >
                <View style={styles.coverFrame}>
                  <Cover coverId={r.cover_id} title={r.title ?? ''} size="fluid" />
                  {(r.rating !== null || Boolean(r.hearted)) && (
                    <View style={styles.bottomOverlay}>
                      {r.rating !== null && r.rating !== undefined && (
                        <Txt variant="caption" style={styles.overlayText}>
                          ★ {Number(r.rating).toFixed(1)}
                        </Txt>
                      )}
                      {Boolean(r.hearted) && (
                        <Txt variant="caption" style={{ color: '#f43f5e', fontSize: 10 }}>
                          ♥
                        </Txt>
                      )}
                    </View>
                  )}
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  filterPill: {
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  gridWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
  },
  posterWrap: {
    marginBottom: space[2],
  },
  coverFrame: {
    aspectRatio: 2 / 3,
    borderRadius: radius.sm,
    overflow: 'hidden',
    position: 'relative',
    backgroundColor: '#262626',
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(0, 0, 0, 0.72)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  overlayText: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '700',
  },
});
