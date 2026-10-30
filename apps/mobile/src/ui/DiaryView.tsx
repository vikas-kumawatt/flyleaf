// DiaryView — List · Grid · Calendar with year jump and multi-dimensional filters (SL-70, PRD §6.18, §6.39).
//
// Governed by Flyleaf design principles:
// 1. "The interface recedes; covers advance."
// 2. Touch targets >= 44x44.
// 3. Haptic feedback on interactions.
// 4. Smooth theme adaptation (warm light & dark modes).

import React, { useState, useMemo } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  StyleSheet,
  StyleProp,
  ViewStyle,
} from 'react-native';
import { useRouter } from 'expo-router';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { LocalRead } from '@/offline/schema';
import {
  Button,
  Card,
  Chip,
  Cover,
  EmptyState,
  HeartMark,
  RatingMark,
  SegmentedControl,
  Txt,
  sheet,
} from './components';
import { fontFamilies, radius, space, useTheme } from './tokens';
import { diaryPages, groupDiary } from '@/lib/diaryGroups';

export type DiaryViewMode = 'list' | 'grid' | 'calendar';

export interface DiaryViewProps {
  reads: LocalRead[];
  initialViewMode?: DiaryViewMode;
  onSelectBook?: (workId: string) => void;
  style?: StyleProp<ViewStyle>;
  showHeaderControls?: boolean;
}

export function DiaryView({
  reads,
  initialViewMode = 'list',
  onSelectBook,
  style,
  showHeaderControls = true,
}: DiaryViewProps) {
  const c = useTheme();
  const router = useRouter();

  const [viewMode, setViewMode] = useState<DiaryViewMode>(initialViewMode);
  const [selectedYear, setSelectedYear] = useState<string>('all');
  const [formatFilter, setFormatFilter] = useState<'all' | 'print' | 'ebook' | 'audiobook'>('all');
  const [ratingFilter, setRatingFilter] = useState<'all' | '5' | '4' | '3'>('all');
  const [heartedOnly, setHeartedOnly] = useState(false);

  // Calendar month state
  const [calendarDate, setCalendarDate] = useState(() => new Date());
  const [selectedCalendarDay, setSelectedCalendarDay] = useState<string | null>(null);

  const handleSelectBook = (workId: string) => {
    void Haptics.selectionAsync();
    if (onSelectBook) {
      onSelectBook(workId);
    } else {
      router.push(`/work/${workId}` as any);
    }
  };

  // Only finished reads qualify for the diary
  const finishedReads = useMemo(() => {
    return reads.filter((r) => r.status === 'finished');
  }, [reads]);

  // Extract distinct available years
  const availableYears = useMemo(() => {
    const years = new Set<string>();
    for (const r of finishedReads) {
      if (r.finished_at) {
        const y = r.finished_at.slice(0, 4);
        if (/^\d{4}$/.test(y)) years.add(y);
      }
    }
    return Array.from(years).sort().reverse();
  }, [finishedReads]);

  // Apply filters
  const filteredReads = useMemo(() => {
    return finishedReads.filter((r) => {
      // Year filter
      if (selectedYear !== 'all') {
        const y = r.finished_at?.slice(0, 4);
        if (y !== selectedYear) return false;
      }

      // Format filter
      if (formatFilter !== 'all') {
        const fmt = r.format_override ?? 'print';
        if (fmt !== formatFilter) return false;
      }

      // Rating filter
      if (ratingFilter !== 'all') {
        const minRating = Number(ratingFilter);
        if (r.rating === null || r.rating === undefined || r.rating < minRating) return false;
      }

      // Hearted filter
      if (heartedOnly && !r.hearted) {
        return false;
      }

      return true;
    }).sort((a, b) => {
      const dateA = a.finished_at || a.updated_at || '';
      const dateB = b.finished_at || b.updated_at || '';
      return dateB.localeCompare(dateA);
    });
  }, [finishedReads, selectedYear, formatFilter, ratingFilter, heartedOnly]);

  // Summary stats for current view
  const summaryStats = useMemo(() => {
    const totalBooks = filteredReads.length;
    const totalPages = diaryPages(filteredReads);
    const rated = filteredReads.filter((r) => r.rating !== null && r.rating !== undefined);
    const avgRating =
      rated.length > 0
        ? (rated.reduce((sum, r) => sum + (r.rating || 0), 0) / rated.length).toFixed(1)
        : null;
    return { totalBooks, totalPages, avgRating };
  }, [filteredReads]);

  // Group reads by Month & Year for list & grid views
  // Undated finishes go under "Undated", last; never under the month they
  // were imported or edited (audit 10, §17.4).
  const groupedReads = useMemo(() => groupDiary(filteredReads), [filteredReads]);

  // Calendar dates lookup
  const calendarReadsMap = useMemo(() => {
    const map = new Map<string, LocalRead[]>();
    for (const r of finishedReads) {
      if (r.finished_at) {
        const dayStr = r.finished_at.slice(0, 10);
        const existing = map.get(dayStr) || [];
        existing.push(r);
        map.set(dayStr, existing);
      }
    }
    return map;
  }, [finishedReads]);

  // Calendar calculations
  const calYear = calendarDate.getFullYear();
  const calMonth = calendarDate.getMonth();
  const daysInMonth = new Date(calYear, calMonth + 1, 0).getDate();
  const firstDayIndex = new Date(calYear, calMonth, 1).getDay(); // 0 = Sun, 1 = Mon...
  const startOffset = (firstDayIndex + 6) % 7; // Convert to Mon = 0, Sun = 6

  const calendarDays = useMemo(() => {
    const days: { day: number | null; dateKey: string | null; reads: LocalRead[] }[] = [];
    for (let i = 0; i < startOffset; i++) {
      days.push({ day: null, dateKey: null, reads: [] });
    }
    for (let d = 1; d <= daysInMonth; d++) {
      const key = `${calYear}-${String(calMonth + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
      days.push({
        day: d,
        dateKey: key,
        reads: calendarReadsMap.get(key) || [],
      });
    }
    return days;
  }, [calYear, calMonth, daysInMonth, startOffset, calendarReadsMap]);

  const changeCalendarMonth = (delta: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setCalendarDate(new Date(calYear, calMonth + delta, 1));
    setSelectedCalendarDay(null);
  };

  const selectedDayReads = useMemo(() => {
    if (!selectedCalendarDay) return [];
    return calendarReadsMap.get(selectedCalendarDay) || [];
  }, [selectedCalendarDay, calendarReadsMap]);

  return (
    <View style={[{ gap: space[4] }, style]}>
      {showHeaderControls && (
        <View style={{ gap: space[3] }}>
          {/* Top Row: View Mode Switcher + Hearted Toggle */}
          <View style={[sheet.rowBetween, { gap: space[2] }]}>
            <View style={{ width: 220 }}>
              <SegmentedControl
                options={[
                  { value: 'list', label: 'List' },
                  { value: 'grid', label: 'Grid' },
                  { value: 'calendar', label: 'Calendar' },
                ]}
                value={viewMode}
                onChange={(val) => {
                  void Haptics.selectionAsync();
                  setViewMode(val as DiaryViewMode);
                }}
              />
            </View>

            <Chip
              label={heartedOnly ? 'Hearted' : 'All'}
              icon={heartedOnly ? 'heart' : 'heart-outline'}
              selected={heartedOnly}
              onPress={() => setHeartedOnly(!heartedOnly)}
              accessibilityLabel="Show hearted books only"
            />
          </View>

          {/* Filter Bar: Year Jump & Format & Rating */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space[2], paddingVertical: 2 }}
          >
            {/* Year Selector */}
            <Chip label="All time" selected={selectedYear === 'all'} onPress={() => setSelectedYear('all')} />

            {availableYears.map((yr) => (
              <Chip key={yr} label={String(yr)} selected={selectedYear === yr} onPress={() => setSelectedYear(yr)} />
            ))}

            <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: space[1] }} />

            {/* Format Pills */}
            {(['all', 'print', 'ebook', 'audiobook'] as const).map((fmt) => (
              <Chip
                key={fmt}
                label={fmt === 'all' ? 'All formats' : fmt.charAt(0).toUpperCase() + fmt.slice(1)}
                selected={formatFilter === fmt}
                onPress={() => setFormatFilter(fmt)}
              />
            ))}

            <View style={{ width: 1, backgroundColor: c.line, marginHorizontal: space[1] }} />

            {/* Rating Pills */}
            {(['all', '5', '4', '3'] as const).map((rKey) => (
              <Chip
                key={rKey}
                label={rKey === 'all' ? 'All ratings' : `${rKey}+ stars`}
                icon={rKey === 'all' ? undefined : 'star-outline'}
                selected={ratingFilter === rKey}
                onPress={() => setRatingFilter(rKey)}
              />
            ))}
          </ScrollView>

          {/* Quick Year / Filter Volume Summary Banner */}
          {summaryStats.totalBooks > 0 && (
            <View
              style={[
                sheet.rowBetween,
                {
                  backgroundColor: c.surface,
                  paddingHorizontal: space[3],
                  paddingVertical: space[2],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: c.line,
                },
              ]}
            >
              <Txt variant="caption" color="muted">
                {selectedYear === 'all' ? 'All time' : `${selectedYear}`}
              </Txt>
              <Txt variant="caption" color="ink" tabular style={{ fontWeight: '500' }}>
                {summaryStats.totalBooks} {summaryStats.totalBooks === 1 ? 'book' : 'books'}
                {summaryStats.totalPages > 0 ? ` · ${summaryStats.totalPages.toLocaleString()} pages` : ''}
                {summaryStats.avgRating ? ` · ${summaryStats.avgRating} average` : ''}
              </Txt>
            </View>
          )}
        </View>
      )}

      {/* EMPTY STATE */}
      {filteredReads.length === 0 && (
        <EmptyState
          title="No books match your filters"
          subtitle={
            finishedReads.length === 0
              ? 'Your diary starts with the first book you finish.'
              : 'Try clearing some of your filters to see more of your reading history.'
          }
          action={
            finishedReads.length > 0 && (
              <Button
                label="Reset filters"
                variant="outline"
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setSelectedYear('all');
                  setFormatFilter('all');
                  setRatingFilter('all');
                  setHeartedOnly(false);
                }}
              />
            )
          }
        />
      )}

      {/* ========================================================================= */}
      {/* 1. LIST VIEW                                                              */}
      {/* ========================================================================= */}
      {viewMode === 'list' && filteredReads.length > 0 && (
        <View style={{ gap: space[4] }}>
          {groupedReads.map((group) => (
            <View key={group.monthKey} style={{ gap: space[2] }}>
              <View style={[sheet.rowBetween, { paddingHorizontal: space[1] }]}>
                <Txt variant="displayM" style={{ fontSize: 20, lineHeight: 26 }}>
                  {group.monthLabel}
                </Txt>
                <Txt variant="caption" color="muted" tabular>
                  {group.reads.length} {group.reads.length === 1 ? 'book' : 'books'}
                </Txt>
              </View>

              <View style={{ gap: space[2] }}>
                {group.reads.map((r) => {
                  const finishFormatted = r.finished_at
                    ? new Date(r.finished_at).toLocaleDateString(undefined, {
                        month: 'short',
                        day: 'numeric',
                        year: 'numeric',
                      })
                    : 'Finished';

                  return (
                    <Card
                      key={r.id}
                      onPress={() => handleSelectBook(r.work_id)}
                      style={{ padding: space[3] }}
                    >
                      <View style={sheet.rowTop}>
                        <Cover coverId={r.cover_id} title={r.title ?? ''} size="m" />
                        <View style={{ flex: 1, gap: space[1] }}>
                          <View style={[sheet.rowBetween, { gap: space[2] }]}>
                            <Txt variant="title" numberOfLines={1} style={{ flex: 1, fontFamily: fontFamilies.displayMedium }}>
                              {r.title}
                            </Txt>
                            {Boolean(r.hearted) && <HeartMark size={14} />}
                          </View>

                          <Txt variant="caption" color="muted" numberOfLines={1}>
                            {r.author_name}
                          </Txt>

                          <View style={[sheet.row, { gap: space[2], marginTop: space[1] }]}>
                            {r.rating !== null && r.rating !== undefined && <RatingMark value={Number(r.rating)} />}
                            <Txt variant="caption" color="muted" tabular>
                              {finishFormatted}
                              {r.format_override ? ` · ${r.format_override}` : ''}
                            </Txt>
                          </View>
                        </View>
                      </View>
                    </Card>
                  );
                })}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ========================================================================= */}
      {/* 2. GRID VIEW (Monthly Poster Shelves)                                     */}
      {/* ========================================================================= */}
      {viewMode === 'grid' && filteredReads.length > 0 && (
        <View style={{ gap: space[4] }}>
          {groupedReads.map((group) => (
            <View key={group.monthKey} style={{ gap: space[2] }}>
              <View style={[sheet.rowBetween, { paddingHorizontal: space[1] }]}>
                <Txt variant="displayM" style={{ fontSize: 20, lineHeight: 26 }}>
                  {group.monthLabel}
                </Txt>
                <Txt variant="caption" color="muted" tabular>
                  {group.reads.length} {group.reads.length === 1 ? 'book' : 'books'}
                </Txt>
              </View>

              <View style={styles.posterGrid}>
                {group.reads.map((r) => (
                  <Pressable
                    key={r.id}
                    onPress={() => handleSelectBook(r.work_id)}
                    style={styles.gridItem}
                    accessibilityRole="button"
                    accessibilityLabel={`View ${r.title}`}
                  >
                    <View style={styles.posterContainer}>
                      <Cover coverId={r.cover_id} title={r.title ?? ''} size="fluid" />
                      {/* Rating & Heart overlay */}
                      {(r.rating !== null || Boolean(r.hearted)) && (
                        <View style={[styles.posterOverlay, { backgroundColor: c.scrim }]}>
                          {r.rating !== null && r.rating !== undefined && (
                            <RatingMark value={Number(r.rating)} size={11} onCover />
                          )}
                          {Boolean(r.hearted) && <HeartMark size={12} />}
                        </View>
                      )}
                    </View>
                    <Txt
                      variant="caption"
                      numberOfLines={1}
                      style={{ marginTop: space[1], fontFamily: fontFamilies.displayMedium }}
                    >
                      {r.title}
                    </Txt>
                  </Pressable>
                ))}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* ========================================================================= */}
      {/* 3. CALENDAR VIEW                                                          */}
      {/* ========================================================================= */}
      {viewMode === 'calendar' && (
        <View style={{ gap: space[3] }}>
          {/* Calendar Header Month Navigation */}
          <Card style={{ padding: space[3] }}>
            <View style={[sheet.rowBetween, { marginBottom: space[3] }]}>
              <Pressable
                onPress={() => changeCalendarMonth(-1)}
                accessibilityRole="button"
                accessibilityLabel="Previous month"
                style={styles.calNav}
              >
                <Ionicons name="chevron-back" size={18} color={c.ink2} />
              </Pressable>
              <Txt variant="title" tabular>
                {calendarDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </Txt>
              <Pressable
                onPress={() => changeCalendarMonth(1)}
                accessibilityRole="button"
                accessibilityLabel="Next month"
                style={styles.calNav}
              >
                <Ionicons name="chevron-forward" size={18} color={c.ink2} />
              </Pressable>
            </View>

            {/* Days of the week header */}
            <View style={styles.calRow}>
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((dayName, idx) => (
                <View key={idx} style={styles.calHeaderCell}>
                  <Txt variant="micro" color="muted">
                    {dayName}
                  </Txt>
                </View>
              ))}
            </View>

            {/* Calendar Days Matrix */}
            <View style={styles.calGrid}>
              {calendarDays.map((item, index) => {
                if (item.day === null) {
                  return <View key={`empty-${index}`} style={styles.calCell} />;
                }

                const hasFinished = item.reads.length > 0;
                const isSelected = selectedCalendarDay === item.dateKey;

                return (
                  <Pressable
                    key={item.dateKey}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setSelectedCalendarDay(isSelected ? null : item.dateKey);
                    }}
                    style={[
                      styles.calCell,
                      isSelected && {
                        backgroundColor: c.surface2,
                        borderColor: c.lineStrong,
                        borderWidth: 1,
                        borderRadius: radius.md,
                      },
                    ]}
                  >
                    <Txt
                      variant="caption"
                      style={{
                        fontWeight: hasFinished || isSelected ? '500' : '400',
                        color: hasFinished || isSelected ? c.ink : c.muted,
                      }}
                    >
                      {item.day}
                    </Txt>
                    {hasFinished && (
                      <View
                        style={[
                          styles.calDot,
                          {
                            backgroundColor: c.accent,
                          },
                        ]}
                      />
                    )}
                  </Pressable>
                );
              })}
            </View>
          </Card>

          {/* Selected Calendar Day Book Details */}
          {selectedCalendarDay && (
            <View style={{ gap: space[2] }}>
              <Txt variant="title">
                Finished{' '}
                {new Date(selectedCalendarDay).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </Txt>

              {selectedDayReads.length === 0 ? (
                <Txt variant="caption" color="muted">
                  No books finished this day
                </Txt>
              ) : (
                selectedDayReads.map((r) => (
                  <Card
                    key={r.id}
                    onPress={() => handleSelectBook(r.work_id)}
                    style={{ padding: space[3] }}
                  >
                    <View style={[sheet.rowTop, { gap: space[3] }]}>
                      <Cover coverId={r.cover_id} title={r.title ?? ''} size="m" />
                      <View style={{ flex: 1, gap: space[1] }}>
                        <Txt variant="title" numberOfLines={1} style={{ fontFamily: fontFamilies.displayMedium }}>
                          {r.title}
                        </Txt>
                        <Txt variant="caption" color="muted">
                          {r.author_name}
                        </Txt>
                        <View style={[sheet.row, { gap: space[2], marginTop: space[1] }]}>
                          {r.rating !== null && r.rating !== undefined && <RatingMark value={Number(r.rating)} />}
                          {Boolean(r.hearted) && <HeartMark />}
                        </View>
                      </View>
                    </View>
                  </Card>
                ))
              )}
            </View>
          )}
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  posterGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: space[2],
  },
  gridItem: {
    width: '31.3%',
    marginBottom: space[2],
  },
  posterContainer: {
    aspectRatio: 2 / 3,
    borderRadius: radius.sm,
    overflow: 'hidden',
    position: 'relative',
  },
  posterOverlay: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[2],
    paddingVertical: space[1],
  },
  calNav: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  calRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: space[1],
  },
  calHeaderCell: {
    width: '14.2%',
    alignItems: 'center',
    paddingVertical: space[1],
  },
  calGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
  },
  calCell: {
    width: '14.28%',
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    position: 'relative',
    marginVertical: space[1] / 2,
  },
  calDot: {
    width: 4,
    height: 4,
    borderRadius: radius.pill,
    position: 'absolute',
    bottom: space[1],
  },
});
