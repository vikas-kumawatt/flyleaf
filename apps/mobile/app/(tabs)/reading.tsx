// Tab 2 — Reading (the daily hook, PRD §5.2, §6.15–§6.19, SL-52–SL-57).
//
// Segmented: Currently reading / Want to read / Diary.
// Features:
//   - Fast local SQLite render (<200ms) with background reconciliation.
//   - ProgressSlider with 5% haptic ticks and auto-save on touch release.
//   - +10 pages quick button with instant optimistic feedback.
//   - Dynamic predicted finish date from reading slope (SL-52).
//   - ProgressSheet modal with numeric entry, optional minutes, note, quote (SL-53).
//   - Shortcut to Finish flow (SL-54) and DNF flow (SL-55).
//   - Re-read attempt tracking badge (SL-56).
//   - Want-to-read queue with sort, filter, grid/list toggle, and bulk actions (SL-57).

import React, { useState, useCallback, useMemo } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  RefreshControl,
  Alert,
} from 'react-native';
import { useRouter, useFocusEffect } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import type { LocalRead } from '@/offline/schema';
import { api, type Read } from '@/lib/api';
import { predictFinishDate } from '@/lib/readingVelocity';
import { budgetTracker } from '@/lib/budgetTracker';
import { ProgressSlider } from '@/ui/ProgressSlider';
import { ProgressSheet } from '@/ui/ProgressSheet';
import { DiaryView } from '@/ui/DiaryView';
import {
  Button,
  Card,
  Chip,
  Cover,
  EmptyState,
  ProgressBar,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
  BottomSheet,
} from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';

export default function ReadingScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const db = useDatabase();

  const [section, setSection] = useState<'reading' | 'want_to_read' | 'diary'>('reading');
  const [reads, setReads] = useState<LocalRead[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // Modals & Sheets State
  const [sheetRead, setSheetRead] = useState<LocalRead | null>(null);
  const [overflowRead, setOverflowRead] = useState<LocalRead | null>(null);

  // Want to Read Queue Controls (SL-57)
  const [viewMode, setViewMode] = useState<'list' | 'grid'>('list');
  const [formatFilter, setFormatFilter] = useState<'all' | 'print' | 'ebook' | 'audiobook'>('all');
  const [sortBy, setSortBy] = useState<'added' | 'title' | 'author' | 'shortest'>('added');
  const [bulkMode, setBulkMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());

  // Track Reading tab focus for §4.4 progress budget measurement
  useFocusEffect(
    useCallback(() => {
      budgetTracker.startReadingTab();
    }, [])
  );

  // Load local reads immediately, then reconcile with server
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
          // Offline or network error: local SQLite remains source of truth
        }
      })();
    } finally {
      setLoading(false);
    }
  }, [user, db]);

  // On every focus, not only on mount: a book finished, stopped or started on
  // another screen has to have left (or joined) these lists on the way back.
  useFocusEffect(
    useCallback(() => {
      void loadReads();
    }, [loadReads]),
  );

  const onRefresh = async () => {
    setRefreshing(true);
    await loadReads();
    setRefreshing(false);
  };

  // Filtered lists
  const currentlyReading = useMemo(
    () => reads.filter((r) => r.status === 'reading'),
    [reads],
  );

  const wantToRead = useMemo(() => {
    let list = reads.filter((r) => r.status === 'want');

    // Filter by format
    if (formatFilter !== 'all') {
      list = list.filter((r) => r.format_override === formatFilter);
    }

    // Sort
    return [...list].sort((a, b) => {
      if (sortBy === 'title') {
        return (a.title || '').localeCompare(b.title || '');
      }
      if (sortBy === 'author') {
        return (a.author_name || '').localeCompare(b.author_name || '');
      }
      if (sortBy === 'shortest') {
        return (a.page_count || 9999) - (b.page_count || 9999);
      }
      // 'added'
      return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
    });
  }, [reads, formatFilter, sortBy]);

  // Handlers for active reading
  const handleSliderRelease = async (read: LocalRead, newPage: number, newPercent: number) => {
    if (!db || !user) return;
    const repo = new OfflineRepository(db, user.id);
    budgetTracker.recordProgressSaved({ method: 'slider', deltaPages: Math.max(0, newPage - (read.page ?? 0)) });
    // Optimistically update local state immediately
    setReads((prev) =>
      prev.map((r) =>
        r.id === read.id
          ? { ...r, page: newPage, percent: newPercent, synced: 0 }
          : r,
      ),
    );
    await repo.saveProgress(read.id, newPage, newPercent);
  };

  const handleAddTenPages = async (read: LocalRead) => {
    if (!db || !user) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    budgetTracker.recordProgressSaved({ method: 'quick_add', deltaPages: 10 });
    const repo = new OfflineRepository(db, user.id);
    const currentPage = read.page ?? 0;
    const pageCount = read.page_count;
    const targetPage = pageCount ? Math.min(pageCount, currentPage + 10) : currentPage + 10;
    const targetPercent = pageCount && pageCount > 0 ? Math.round((targetPage / pageCount) * 100) : null;

    setReads((prev) =>
      prev.map((r) =>
        r.id === read.id
          ? { ...r, page: targetPage, percent: targetPercent, synced: 0 }
          : r,
      ),
    );
    await repo.saveProgress(read.id, targetPage, targetPercent);
  };

  const handleStartReading = async (read: LocalRead) => {
    if (!db || !user) return;
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    // Taps are not counted yet, so no book_logged (audit 10); a save ends a running "+" clock.
    budgetTracker.recordLogSheetCompleted({ targetStatus: 'reading' });
    const repo = new OfflineRepository(db, user.id);
    await repo.saveReadStatus(read.work_id, 'reading', null, null, {
      title: read.title ?? undefined,
      author_name: read.author_name ?? undefined,
      cover_id: read.cover_id,
      page_count: read.page_count,
      format_override: read.format_override,
    });
    setSection('reading');
    await loadReads();
  };

  const handleSaveProgressSheet = async (data: {
    page: number | null;
    percent: number | null;
    minutes: number | null;
    note: string | null;
    quote: string | null;
  }) => {
    if (!sheetRead || !db || !user) return;
    budgetTracker.recordProgressSaved({
      method: 'sheet',
      deltaPages: data.page != null && sheetRead.page != null ? Math.max(0, data.page - sheetRead.page) : 0,
    });
    budgetTracker.recordLogSheetCompleted(sheetRead.id, {
      deltaPages: data.page != null && sheetRead.page != null ? Math.max(0, data.page - sheetRead.page) : 0,
      hadNote: Boolean(data.note),
      hadMinutes: Boolean(data.minutes),
    });
    const repo = new OfflineRepository(db, user.id);
    setReads((prev) =>
      prev.map((r) =>
        r.id === sheetRead.id
          ? { ...r, page: data.page, percent: data.percent, synced: 0 }
          : r,
      ),
    );
    await repo.saveProgress(sheetRead.id, data.page, data.percent, data.minutes, data.note);
    setSheetRead(null);
  };

  const handleStartReread = async (read: LocalRead) => {
    if (!db || !user) return;
    setOverflowRead(null);
    void Haptics.selectionAsync();
    const repo = new OfflineRepository(db, user.id);
    await repo.saveReadStatus(read.work_id, 'reading', null, null, {
      title: read.title ?? undefined,
      author_name: read.author_name ?? undefined,
      cover_id: read.cover_id,
      page_count: read.page_count,
    });
    await loadReads();
  };

  // Bulk actions in Want-to-Read queue
  const toggleSelectBook = (readId: string) => {
    void Haptics.selectionAsync();
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(readId)) next.delete(readId);
      else next.add(readId);
      return next;
    });
  };

  const handleBulkDelete = async () => {
    if (!db || !user) return;
    Alert.alert(
      'Remove books',
      `Remove ${selectedIds.size} books from your Want-to-read list?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: async () => {
            // Removed, not paused: "remove" used to move the books to the
            // paused section (audit 08). Each delete is queued, so this works
            // offline and survives a failure part-way through.
            const repo = new OfflineRepository(db, user.id);
            for (const readId of selectedIds) {
              if (reads.some((r) => r.id === readId)) {
                await repo.deleteRead(readId);
              }
            }
            setSelectedIds(new Set());
            setBulkMode(false);
            await loadReads();
          },
        },
      ],
    );
  };

  // ---------------------------------------------------------------- GUEST MODE
  if (!user) {
    return (
      <Screen>
        <View
          style={{
            paddingTop: Math.max(insets.top, space[4]),
            paddingHorizontal: space[4],
            paddingBottom: space[3],
            backgroundColor: c.ground,
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          }}
        >
          <Txt variant="displayL">Reading</Txt>
        </View>

        <ScrollView
          contentContainerStyle={{
            padding: space[4],
            paddingBottom: space[12],
            gap: space[6],
          }}
        >
          {/* Upsell Header & Value Prop */}
          <View style={{ gap: space[2], marginTop: space[2] }}>
            <Txt variant="displayM">Keep your place in every book</Txt>
            <Txt variant="body" color="muted" style={{ lineHeight: 22 }}>
              Log pages as you go, see when you will finish, and keep private notes and a diary
              of every book.
            </Txt>
          </View>

          {/* Interactive Preview of What Reading Tab Looks Like */}
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="micro" color="muted">
                Sample reading log
              </Txt>
              <Txt variant="micro" color="muted">
                Preview
              </Txt>
            </View>

            <Card style={{ opacity: 0.95 }}>
              <View style={sheet.rowTop}>
                <Cover coverId={8231856} title="Piranesi" author="Susanna Clarke" size="l" />
                <View style={{ flex: 1, gap: space[2], justifyContent: 'space-between' }}>
                  <View style={{ gap: space[1] }}>
                    <Txt variant="title" numberOfLines={1}>
                      Piranesi
                    </Txt>
                    <Txt variant="caption" color="muted">
                      Susanna Clarke
                    </Txt>
                  </View>

                  <View style={{ gap: space[2] }}>
                    <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
                      <Txt variant="caption" color="ink2" tabular>
                        Page 168 of 245
                      </Txt>
                      <Txt variant="caption" color="muted" tabular>
                        68%
                      </Txt>
                    </View>
                    <ProgressBar percent={68} />
                    <Txt variant="caption" color="muted">
                      Done in about 2 days
                    </Txt>
                  </View>
                </View>
              </View>

              <View
                style={[
                  sheet.row,
                  { justifyContent: 'flex-end', gap: space[2], marginTop: space[3] },
                ]}
              >
                <Button
                  label="+10 pages"
                  variant="secondary"
                  disabled
                  onPress={() => {}}
                  size="sm"
                />
                <Button
                  label="Update"
                  variant="primary"
                  disabled
                  onPress={() => {}}
                  size="sm"
                />
              </View>
            </Card>
          </View>

          {/* Call to action */}
          <View style={{ gap: space[3], marginTop: space[3] }}>
            <Button
              label="Create account"
              variant="primary"
              onPress={() => router.push('/auth')}
            />
            <Button
              label="Sign in"
              variant="secondary"
              onPress={() => router.push('/auth')}
            />
            <Button
              label="Explore books first"
              variant="tertiary"
              onPress={() => router.push('/discover')}
            />
          </View>
        </ScrollView>
      </Screen>
    );
  }

  // ---------------------------------------------------------------- AUTHENTICATED USER
  return (
    <Screen>
      {/* Header with Segmented Navigation */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          backgroundColor: c.ground,
          gap: space[2],
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayL">Reading</Txt>
          <Pressable
            onPress={() => router.push('/discover')}
            accessibilityRole="button"
            accessibilityLabel="Find and add books"
            style={{ minHeight: 44, justifyContent: 'center', paddingLeft: space[2] }}
          >
            <Txt variant="body" color="accent" style={{ fontWeight: '500' }}>
              Add a book
            </Txt>
          </Pressable>
        </View>

        <SegmentedControl
          values={['reading', 'want_to_read', 'diary'] as const}
          selected={section}
          onSelect={setSection}
          labels={{
            reading: 'Now',
            want_to_read: 'Want to read',
            diary: 'Diary',
          }}
        />
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[16],
          gap: space[4],
        }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} />}
      >
        {/* ========================================================================= */}
        {/* SECTION 1: CURRENTLY READING (SL-52)                                      */}
        {/* ========================================================================= */}
        {section === 'reading' && (
          <>
            {currentlyReading.length === 0 ? (
              <View style={{ gap: space[6], paddingTop: space[4] }}>
                <EmptyState
                  title="Nothing on the go"
                  subtitle="What are you reading? Search any title or pick one from Want to read."
                  action={
                    <Button
                      label="Find what you're reading"
                      variant="primary"
                      onPress={() => router.push('/discover')}
                    />
                  }
                />

                {/* Suggestions from Want-to-Read */}
                {wantToRead.length > 0 && (
                  <View style={{ gap: space[3] }}>
                    <Txt variant="micro" color="muted">
                      Or start one from Want to read
                    </Txt>
                    {wantToRead.slice(0, 3).map((item) => (
                      <Pressable
                        key={item.id}
                        onPress={() => router.push(`/work/${item.work_id}` as any)}
                        accessibilityRole="button"
                        style={({ pressed }) => [
                          sheet.row,
                          {
                            paddingVertical: space[3],
                            borderTopWidth: 1,
                            borderTopColor: c.line,
                            backgroundColor: pressed ? c.surface2 : 'transparent',
                          },
                        ]}
                      >
                        <Cover coverId={item.cover_id} title={item.title ?? ''} size="s" />
                        <View style={{ flex: 1, gap: 2 }}>
                          <Txt variant="title" numberOfLines={1}>
                            {item.title}
                          </Txt>
                          <Txt variant="caption" color="muted">
                            {item.author_name}
                          </Txt>
                        </View>
                        <Button
                          label="Start reading"
                          variant="secondary"
                          size="sm"
                          onPress={() => handleStartReading(item)}
                        />
                      </Pressable>
                    ))}
                  </View>
                )}
              </View>
            ) : (
              <View>
                {currentlyReading.map((read, index) => {
                  const page = read.page ?? 0;
                  const total = read.page_count ?? null;
                  const percent = total ? Math.min(100, Math.round((page / total) * 100)) : read.percent ?? 0;
                  const prediction = predictFinishDate({
                    currentPage: page,
                    pageCount: total,
                    percent,
                    startedAt: read.started_at,
                  });
                  const isComplete = (total && page >= total) || percent >= 100;

                  return (
                    <View
                      key={read.id}
                      style={{
                        gap: space[3],
                        paddingTop: index ? space[6] : space[2],
                        paddingBottom: space[6],
                        borderTopWidth: index ? 1 : 0,
                        borderTopColor: c.line,
                      }}
                    >
                      {/* Book header */}
                      <View style={[sheet.rowTop, { gap: space[4] }]}>
                        <Pressable
                          onPress={() => router.push(`/work/${read.work_id}` as any)}
                          accessibilityRole="button"
                          accessibilityLabel={`Open ${read.title ?? 'book'}`}
                        >
                          <Cover
                            coverId={read.cover_id}
                            title={read.title ?? 'Book'}
                            author={read.author_name ?? ''}
                            size="l"
                          />
                        </Pressable>
                        <View style={{ flex: 1, minHeight: 180, justifyContent: 'space-between' }}>
                          <View style={{ gap: 2 }}>
                            <View style={sheet.rowTop}>
                              <Pressable
                                onPress={() => router.push(`/work/${read.work_id}` as any)}
                                accessibilityRole="link"
                                style={{ flex: 1 }}
                              >
                                <Txt variant="displayM" numberOfLines={3}>
                                  {read.title}
                                </Txt>
                              </Pressable>
                              <Pressable
                                onPress={() => {
                                  void Haptics.selectionAsync();
                                  setOverflowRead(read);
                                }}
                                accessibilityRole="button"
                                accessibilityLabel="Reading actions"
                                hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
                                style={{ minWidth: 32, minHeight: 32, alignItems: 'flex-end', justifyContent: 'center' }}
                              >
                                <Ionicons name="ellipsis-horizontal" size={18} color={c.muted} />
                              </Pressable>
                            </View>

                            <Txt variant="body" color="ink2" numberOfLines={1}>
                              {read.author_name}
                            </Txt>

                            {read.attempt_no > 1 && (
                              <Txt variant="micro" color="muted" tabular style={{ marginTop: 2 }}>
                                Re-read {read.attempt_no}
                              </Txt>
                            )}
                          </View>

                          {/* Progress summary */}
                          <View style={{ gap: 2 }}>
                            <Txt variant="displayM" tabular>
                              {percent}%
                            </Txt>
                            <Txt variant="caption" color="ink2" tabular>
                              {total ? `Page ${page} of ${total}` : `Page ${page}`}
                            </Txt>
                            <Txt variant="caption" color="muted">
                              {prediction}
                            </Txt>
                          </View>
                        </View>
                      </View>

                      {/* Auto-saving Progress Slider (SL-52) */}
                      <ProgressSlider
                        currentPage={page}
                        pageCount={total || 100}
                        onRelease={(newPage, newPercent) =>
                          handleSliderRelease(read, newPage, newPercent)
                        }
                      />

                      {/* One primary action per entry: update while reading, finish at the end. */}
                      <View style={[sheet.row, { gap: space[2], flexWrap: 'wrap' }]}>
                        {isComplete ? (
                          <Button
                            label="Rate and finish"
                            variant="primary"
                            size="sm"
                            onPress={() => router.push(`/finish/${read.id}` as any)}
                          />
                        ) : (
                          <Button
                            label="Update progress"
                            variant="primary"
                            size="sm"
                            onPress={() => {
                              void Haptics.selectionAsync();
                              setSheetRead(read);
                            }}
                          />
                        )}
                        <Button
                          label="+10 pages"
                          variant="secondary"
                          size="sm"
                          onPress={() => handleAddTenPages(read)}
                        />
                        <View style={{ flex: 1 }} />
                        {isComplete ? (
                          <Button
                            label="Update"
                            variant="tertiary"
                            size="sm"
                            onPress={() => {
                              void Haptics.selectionAsync();
                              setSheetRead(read);
                            }}
                          />
                        ) : (
                          <Button
                            label="Finish"
                            variant="tertiary"
                            size="sm"
                            onPress={() => router.push(`/finish/${read.id}` as any)}
                          />
                        )}
                      </View>
                    </View>
                  );
                })}
              </View>
            )}
          </>
        )}

        {/* ========================================================================= */}
        {/* SECTION 2: WANT TO READ QUEUE (SL-57)                                    */}
        {/* ========================================================================= */}
        {section === 'want_to_read' && (
          <View style={{ gap: space[4] }}>
            {/* Filter & Sort Strip */}
            <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap', rowGap: space[2] }]}>
              {/* Format filter */}
              <View style={[sheet.row, { gap: space[2], flexWrap: 'wrap' }]}>
                {(['all', 'print', 'ebook', 'audiobook'] as const).map((fmt) => (
                  <Chip
                    key={fmt}
                    label={fmt === 'audiobook' ? 'Audio' : fmt.charAt(0).toUpperCase() + fmt.slice(1)}
                    selected={formatFilter === fmt}
                    onPress={() => setFormatFilter(fmt)}
                  />
                ))}
              </View>

              {/* View Mode & Bulk Toggle */}
              <View style={[sheet.row, { gap: space[2] }]}>
                <Pressable
                  onPress={() => setViewMode(viewMode === 'list' ? 'grid' : 'list')}
                  accessibilityRole="button"
                  accessibilityLabel="Toggle grid or list view"
                  style={[sheet.row, { gap: space[1], minHeight: 44, paddingHorizontal: space[1] }]}
                >
                  <Ionicons name={viewMode === 'list' ? 'grid-outline' : 'list-outline'} size={16} color={c.ink2} />
                  <Txt variant="caption" color="ink2">
                    {viewMode === 'list' ? 'Grid' : 'List'}
                  </Txt>
                </Pressable>

                <Pressable
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setBulkMode(!bulkMode);
                    setSelectedIds(new Set());
                  }}
                  accessibilityRole="button"
                  accessibilityLabel="Bulk selection mode"
                  style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[1] }}
                >
                  <Txt variant="caption" color={bulkMode ? 'accent' : 'muted'}>
                    {bulkMode ? 'Cancel' : 'Select'}
                  </Txt>
                </Pressable>
              </View>
            </View>

            {/* Bulk Action Bar */}
            {bulkMode && selectedIds.size > 0 && (
              <View
                style={[
                  sheet.row,
                  {
                    backgroundColor: c.surface,
                    paddingVertical: space[2],
                    paddingHorizontal: space[4],
                    borderRadius: radius.lg,
                    justifyContent: 'space-between',
                  },
                ]}
              >
                <Txt variant="caption" color="ink">
                  {selectedIds.size} selected
                </Txt>
                <Button
                  label="Remove"
                  variant="destructive"
                  size="sm"
                  onPress={handleBulkDelete}
                />
              </View>
            )}

            {wantToRead.length === 0 ? (
              <EmptyState
                title="Your queue is clear"
                subtitle="Find books in Discover or scan a barcode to add them here."
                action={
                  <Button
                    label="Discover books"
                    variant="primary"
                    onPress={() => router.push('/discover')}
                  />
                }
              />
            ) : viewMode === 'list' ? (
              // List view: ruled rows
              <View>
                {wantToRead.map((item, index) => {
                  const isSelected = selectedIds.has(item.id);
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => {
                        if (bulkMode) toggleSelectBook(item.id);
                        else router.push(`/work/${item.work_id}` as any);
                      }}
                      accessibilityRole="button"
                      accessibilityState={bulkMode ? { selected: isSelected } : undefined}
                      style={({ pressed }) => [
                        sheet.rowTop,
                        {
                          gap: space[4],
                          paddingVertical: space[4],
                          borderTopWidth: index ? 1 : 0,
                          borderTopColor: c.line,
                          backgroundColor: pressed ? c.surface2 : 'transparent',
                        },
                      ]}
                    >
                      <Cover coverId={item.cover_id} title={item.title ?? ''} size="m" />
                      <View style={{ flex: 1, minHeight: 132, justifyContent: 'space-between' }}>
                        <View style={{ gap: 2 }}>
                          <Txt variant="title" numberOfLines={2}>
                            {item.title}
                          </Txt>
                          <Txt variant="caption" color="ink2" numberOfLines={1}>
                            {item.author_name}
                          </Txt>
                          {item.page_count ? (
                            <Txt variant="caption" color="muted" tabular>
                              {item.page_count} pages
                            </Txt>
                          ) : null}
                        </View>

                        {bulkMode ? (
                          <View style={[sheet.row, { gap: space[2] }]}>
                            <Ionicons
                              name={isSelected ? 'checkmark-circle' : 'ellipse-outline'}
                              size={22}
                              color={isSelected ? c.accent : c.muted}
                            />
                            <Txt variant="caption" color={isSelected ? 'ink' : 'muted'}>
                              {isSelected ? 'Selected' : 'Tap to select'}
                            </Txt>
                          </View>
                        ) : (
                          <View style={{ alignSelf: 'flex-start' }}>
                            <Button
                              label="Start reading"
                              variant="secondary"
                              size="sm"
                              onPress={() => handleStartReading(item)}
                            />
                          </View>
                        )}
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            ) : (
              // Grid View
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[3] }}>
                {wantToRead.map((item) => {
                  const isSelected = selectedIds.has(item.id);
                  return (
                    <Pressable
                      key={item.id}
                      onPress={() => {
                        if (bulkMode) toggleSelectBook(item.id);
                        else router.push(`/work/${item.work_id}` as any);
                      }}
                      style={{
                        width: '30%',
                        gap: space[1],
                        opacity: bulkMode && !isSelected ? 0.7 : 1,
                      }}
                    >
                      <Cover coverId={item.cover_id} title={item.title ?? ''} size="m" />
                      <Txt variant="caption" numberOfLines={1} style={{ fontWeight: '500' }}>
                        {item.title}
                      </Txt>
                      <Txt variant="micro" color="muted" numberOfLines={1}>
                        {item.author_name}
                      </Txt>
                    </Pressable>
                  );
                })}
              </View>
            )}
          </View>
        )}

        {/* ========================================================================= */}
        {/* SECTION 3: DIARY (SL-70 preview / Finished books)                          */}
        {/* ========================================================================= */}
        {section === 'diary' && (
          <DiaryView reads={reads} />
        )}
      </ScrollView>

      {/* Progress Entry Sheet Modal (SL-53) */}
      {sheetRead && (
        <ProgressSheet
          visible={!!sheetRead}
          onClose={() => setSheetRead(null)}
          title={sheetRead.title ?? 'Book'}
          currentPage={sheetRead.page}
          pageCount={sheetRead.page_count}
          onSave={handleSaveProgressSheet}
          onFinishShortcut={() => router.push(`/finish/${sheetRead.id}` as any)}
        />
      )}

      {/* Overflow Menu Bottom Sheet */}
      {overflowRead && (
        <BottomSheet
          visible={!!overflowRead}
          onClose={() => setOverflowRead(null)}
          title={overflowRead.title ?? 'Book'}
        >
          <View style={{ gap: space[3], paddingBottom: space[4] }}>
            <Button
              label="Stop reading (DNF)"
              variant="tertiary"
              onPress={() => {
                const r = overflowRead;
                setOverflowRead(null);
                router.push(`/dnf/${r.id}` as any);
              }}
            />
            <Button
              label="Start a re-read"
              variant="tertiary"
              onPress={() => handleStartReread(overflowRead)}
            />
            <Button
              label="Change edition"
              variant="tertiary"
              onPress={() => {
                const workId = overflowRead.work_id;
                setOverflowRead(null);
                router.push(`/work/${workId}/editions` as any);
              }}
            />
          </View>
        </BottomSheet>
      )}
    </Screen>
  );
}
