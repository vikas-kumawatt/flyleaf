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
  Chip,
  Cover,
  EmptyState,
  HeartMark,
  RatingMark,
  Screen,
  Txt,
  sheet,
  SkeletonCoverGrid,
} from '@/ui/components';
import { Ionicons } from '@expo/vector-icons';
import { palette, radius, space, useTheme } from '@/ui/tokens';

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
        // Another user's Wall: THEIR finished reads, through the privacy-checked
        // route (audit 10: this called the viewer's own /reads and showed the
        // viewer's books on everyone's Wall).
        try {
          const server = await api.userReads(targetUserId, 'finished');
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
            <Ionicons name="chevron-back" size={24} color={c.ink} />
          </Pressable>

          <View style={{ alignItems: 'center' }}>
            <Txt variant="displayM">The Wall</Txt>
            <Txt variant="caption" color="muted" tabular>
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
            <Txt variant="caption" color="ink2" style={{ fontWeight: '500' }}>
              {sortBy === 'date_desc' ? 'Recent' : sortBy === 'rating_desc' ? 'Rating' : 'A–Z'}
            </Txt>
          </Pressable>
        </View>

        {/* Filter ScrollBar */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space[2], marginTop: space[3] }}
        >
          <Chip
            selected={heartedOnly}
            onPress={() => setHeartedOnly(!heartedOnly)}
            label="Hearted"
            icon={heartedOnly ? 'heart' : 'heart-outline'}
          />

          <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: space[1] }} />

          <Chip selected={selectedYear === 'all'} onPress={() => setSelectedYear('all')} label="All time" />
          {availableYears.map((yr) => (
            <Chip key={yr} selected={selectedYear === yr} onPress={() => setSelectedYear(yr)} label={yr} />
          ))}

          <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: space[1] }} />

          {(['all', '5', '4', '3'] as const).map((rKey) => (
            <Chip
              key={rKey}
              selected={ratingFilter === rKey}
              onPress={() => setRatingFilter(rKey)}
              label={rKey === 'all' ? 'All ratings' : `${rKey}+ stars`}
            />
          ))}

          <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: space[1] }} />

          {(['all', 'print', 'ebook', 'audiobook'] as const).map((fmt) => (
            <Chip
              key={fmt}
              selected={formatFilter === fmt}
              onPress={() => setFormatFilter(fmt)}
              label={fmt === 'all' ? 'All formats' : fmt.charAt(0).toUpperCase() + fmt.slice(1)}
            />
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
        {loading && reads.length === 0 ? (
          <SkeletonCoverGrid count={12} columns={3} style={{ padding: 0 }} />
        ) : processedReads.length === 0 ? (
          <EmptyState
            title="No covers to display"
            subtitle={
              reads.length === 0
                ? 'Every book you finish adds its cover here'
                : 'No books match these filters'
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
                <View style={[styles.coverFrame, { backgroundColor: c.surface2 }]}>
                  <Cover coverId={r.cover_id} title={r.title ?? ''} size="fluid" />
                  {(r.rating !== null || Boolean(r.hearted)) && (
                    <View style={styles.bottomOverlay}>
                      {r.rating !== null && r.rating !== undefined ? (
                        <RatingMark value={Number(r.rating)} size={11} onCover />
                      ) : (
                        <View />
                      )}
                      {Boolean(r.hearted) && <HeartMark size={11} />}
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
    borderRadius: radius.xs,
    overflow: 'hidden',
    position: 'relative',
  },
  bottomOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: palette.scrim.dark,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[2],
    paddingVertical: space[1],
  },
});
