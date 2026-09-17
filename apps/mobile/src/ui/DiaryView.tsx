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
import { LocalRead } from '@/offline/schema';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  SegmentedControl,
  Txt,
  sheet,
} from './components';
import { radius, space, useTheme } from './tokens';

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
    const totalPages = filteredReads.reduce((sum, r) => sum + (r.page || 0), 0);
    const rated = filteredReads.filter((r) => r.rating !== null && r.rating !== undefined);
    const avgRating =
      rated.length > 0
        ? (rated.reduce((sum, r) => sum + (r.rating || 0), 0) / rated.length).toFixed(1)
        : null;
    return { totalBooks, totalPages, avgRating };
  }, [filteredReads]);

  // Group reads by Month & Year for list & grid views
  const groupedReads = useMemo(() => {
    const groups: { monthKey: string; monthLabel: string; reads: LocalRead[] }[] = [];
    const map = new Map<string, LocalRead[]>();

    for (const r of filteredReads) {
      const dStr = r.finished_at || r.updated_at;
      let key = 'Earlier';
      let label = 'Earlier';
      if (dStr) {
        const d = new Date(dStr);
        if (!isNaN(d.getTime())) {
          key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          label = d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
        }
      }

      const list = map.get(key);
      if (list) {
        list.push(r);
      } else {
        const newList = [r];
        map.set(key, newList);
        groups.push({ monthKey: key, monthLabel: label, reads: newList });
      }
    }
    return groups;
  }, [filteredReads]);

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

            <Pressable
              onPress={() => {
                void Haptics.selectionAsync();
                setHeartedOnly(!heartedOnly);
              }}
              accessibilityRole="button"
              accessibilityLabel="Show hearted books only"
              style={[
                styles.iconFilterPill,
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
          </View>

          {/* Filter Bar: Year Jump & Format & Rating */}
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space[2], paddingVertical: 2 }}
          >
            {/* Year Selector */}
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
                {selectedYear === 'all' ? 'All-time volume' : `${selectedYear} volume`}
              </Txt>
              <Txt variant="caption" color="ink" style={{ fontWeight: '600' }}>
                {summaryStats.totalBooks} {summaryStats.totalBooks === 1 ? 'book' : 'books'}
                {summaryStats.totalPages > 0 ? ` • ${summaryStats.totalPages.toLocaleString()} pages` : ''}
                {summaryStats.avgRating ? ` • ★ ${summaryStats.avgRating} avg` : ''}
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
              ? 'Finished books will automatically appear here with your rating, finish date, and notes.'
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
                <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                  {group.monthLabel}
                </Txt>
                <Txt variant="caption" color="muted">
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
                        <View style={{ flex: 1, gap: 3, marginLeft: space[3] }}>
                          <View style={sheet.rowBetween}>
                            <Txt variant="title" numberOfLines={1} style={{ flex: 1 }}>
                              {r.title}
                            </Txt>
                            {Boolean(r.hearted) && (
                              <Txt variant="caption" style={{ color: '#e11d48', marginLeft: 4 }}>
                                ♥
                              </Txt>
                            )}
                          </View>

                          <Txt variant="caption" color="muted" numberOfLines={1}>
                            {r.author_name}
                          </Txt>

                          <View style={[sheet.row, { gap: space[2], marginTop: space[1] }]}>
                            {r.rating !== null && r.rating !== undefined && (
                              <Txt variant="caption" color="accent" style={{ fontWeight: '700' }}>
                                ★ {Number(r.rating).toFixed(1)}
                              </Txt>
                            )}
                            <Txt variant="caption" color="muted">
                              {finishFormatted}
                            </Txt>
                            {r.format_override && (
                              <View
                                style={[
                                  styles.badge,
                                  { backgroundColor: c.ground, borderColor: c.line },
                                ]}
                              >
                                <Txt variant="caption" color="muted" style={{ fontSize: 10 }}>
                                  {r.format_override}
                                </Txt>
                              </View>
                            )}
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
                <Txt variant="title" style={{ fontSize: 16, fontWeight: '700' }}>
                  {group.monthLabel}
                </Txt>
                <Txt variant="caption" color="muted">
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
                        <View style={styles.posterOverlay}>
                          {r.rating !== null && r.rating !== undefined && (
                            <Txt variant="caption" style={styles.overlayRating}>
                              ★ {Number(r.rating).toFixed(1)}
                            </Txt>
                          )}
                          {Boolean(r.hearted) && (
                            <Txt variant="caption" style={styles.overlayHeart}>
                              ♥
                            </Txt>
                          )}
                        </View>
                      )}
                    </View>
                    <Txt
                      variant="caption"
                      numberOfLines={1}
                      style={{ marginTop: 4, fontWeight: '600' }}
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
              <Button
                label="‹"
                variant="outline"
                size="sm"
                onPress={() => changeCalendarMonth(-1)}
              />
              <Txt variant="title" style={{ fontWeight: '700' }}>
                {calendarDate.toLocaleDateString(undefined, { month: 'long', year: 'numeric' })}
              </Txt>
              <Button
                label="›"
                variant="outline"
                size="sm"
                onPress={() => changeCalendarMonth(1)}
              />
            </View>

            {/* Days of the week header */}
            <View style={styles.calRow}>
              {['M', 'T', 'W', 'T', 'F', 'S', 'S'].map((dayName, idx) => (
                <View key={idx} style={styles.calHeaderCell}>
                  <Txt variant="caption" color="muted" style={{ fontWeight: '600', fontSize: 11 }}>
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
                        backgroundColor: c.accent,
                        borderRadius: radius.sm,
                      },
                      hasFinished && !isSelected && {
                        backgroundColor: c.surface,
                        borderColor: c.accent,
                        borderWidth: 1,
                        borderRadius: radius.sm,
                      },
                    ]}
                  >
                    <Txt
                      variant="caption"
                      style={{
                        fontSize: 12,
                        fontWeight: hasFinished || isSelected ? '700' : '400',
                        color: isSelected ? '#fff' : hasFinished ? c.accent : c.ink,
                      }}
                    >
                      {item.day}
                    </Txt>
                    {hasFinished && (
                      <View
                        style={[
                          styles.calDot,
                          {
                            backgroundColor: isSelected ? '#fff' : c.accent,
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
              <Txt variant="title" style={{ fontSize: 15, fontWeight: '700' }}>
                Completed on{' '}
                {new Date(selectedCalendarDay).toLocaleDateString(undefined, {
                  month: 'short',
                  day: 'numeric',
                  year: 'numeric',
                })}
              </Txt>

              {selectedDayReads.length === 0 ? (
                <Txt variant="caption" color="muted">
                  No books finished on this day.
                </Txt>
              ) : (
                selectedDayReads.map((r) => (
                  <Card
                    key={r.id}
                    onPress={() => handleSelectBook(r.work_id)}
                    style={{ padding: space[3] }}
                  >
                    <View style={sheet.rowTop}>
                      <Cover coverId={r.cover_id} title={r.title ?? ''} size="m" />
                      <View style={{ flex: 1, gap: 2, marginLeft: space[3] }}>
                        <Txt variant="title" numberOfLines={1}>
                          {r.title}
                        </Txt>
                        <Txt variant="caption" color="muted">
                          {r.author_name}
                        </Txt>
                        <View style={[sheet.row, { gap: space[2], marginTop: space[1] }]}>
                          {r.rating !== null && r.rating !== undefined && (
                            <Txt variant="caption" color="accent" style={{ fontWeight: '700' }}>
                              ★ {Number(r.rating).toFixed(1)}
                            </Txt>
                          )}
                          {Boolean(r.hearted) && (
                            <Txt variant="caption" style={{ color: '#e11d48' }}>
                              ♥ Hearted
                            </Txt>
                          )}
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
  filterPill: {
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  iconFilterPill: {
    paddingHorizontal: space[3],
    paddingVertical: space[1],
    borderRadius: radius.pill,
    borderWidth: 1,
    minHeight: 32,
    alignItems: 'center',
    justifyContent: 'center',
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 1,
    borderRadius: radius.sm,
    borderWidth: 1,
  },
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
    backgroundColor: 'rgba(0, 0, 0, 0.7)',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 6,
    paddingVertical: 3,
  },
  overlayRating: {
    color: '#fbbf24',
    fontSize: 10,
    fontWeight: '700',
  },
  overlayHeart: {
    color: '#f43f5e',
    fontSize: 10,
  },
  calRow: {
    flexDirection: 'row',
    justifyContent: 'space-around',
    marginBottom: space[1],
  },
  calHeaderCell: {
    width: '14.2%',
    alignItems: 'center',
    paddingVertical: 4,
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
    marginVertical: 1,
  },
  calDot: {
    width: 4,
    height: 4,
    borderRadius: 2,
    position: 'absolute',
    bottom: 4,
  },
});
