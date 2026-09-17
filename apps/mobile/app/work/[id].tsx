// Book Detail Screen (PRD §6.24, design.md §10, SL-41).
//
// Features:
// - Hero: cover, title, tappable author, series indicator, publication year
// - Status control: Want to read / Reading / Finished / Stopped (with guest mode & Action Gate)
// - Rating & 5-bar distribution histogram
// - Expandable description
// - Edition metadata strip
// - Tabs: Reviews / Editions / Reading History

import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  View,
  TextInput,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Work } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  ProgressBar,
  Screen,
  SegmentedControl,
  Stars,
  Txt,
  sheet,
} from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

const STATUSES: { key: string; label: string }[] = [
  { key: 'want', label: 'Want to read' },
  { key: 'reading', label: 'Reading' },
  { key: 'finished', label: 'Finished' },
  { key: 'dnf', label: 'Stopped' },
];

const formatLabel = (f?: string | null) =>
  f ? f.charAt(0).toUpperCase() + f.slice(1) : null;

export default function WorkScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { isSaved, addBook, removeBook } = useGuestShelf();
  const router = useRouter();
  const c = useTheme();

  const [work, setWork] = useState<Work | null>(null);
  const [busy, setBusy] = useState(false);
  const [pageInput, setPageInput] = useState('');
  const [descExpanded, setDescExpanded] = useState(false);
  const [activeTab, setActiveTab] = useState<'reviews' | 'editions' | 'history'>('reviews');

  const load = async () => {
    if (id) {
      setWork(await api.work(id));
    }
  };

  useEffect(() => {
    load().catch(() => {});
  }, [id, user?.id]);

  if (!work) {
    return (
      <Screen>
        <View style={sheet.pad}>
          <Txt color="muted">Loading book…</Txt>
        </View>
      </Screen>
    );
  }

  const edition = work.editions?.[0];
  const total = edition?.page_count ?? null;
  const page = work.your_read?.page ?? null;
  const percent =
    total && page
      ? Math.round((page / total) * 100)
      : work.your_read?.percent ?? null;
  const savedInGuestShelf = !user && isSaved(work.id);

  // Status control handler (SL-31, SL-32, SL-41)
  const setStatus = async (status: string) => {
    if (!user) {
      if (status === 'want') {
        if (savedInGuestShelf) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
          await removeBook(work.id);
        } else {
          const res = await addBook({
            id: work.id,
            title: work.title,
            author_name: work.author_name,
            cover_id: work.cover_id,
            first_publish_year: work.first_publish_year,
            format: edition?.format,
          });
          if (!res.success && res.reason === 'cap_reached') {
            promptAuth({
              title: 'Sign up to save more than 20 books',
              subtitle:
                'Your device shelf is full. Create an account to save unlimited books across all your devices.',
            });
          } else {
            void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
          }
        }
        return;
      }

      // Guest logging reading, finished, or stopped
      promptAuth({
        title: `Sign up to log ${work.title}`,
        subtitle: `Keep track of ${work.title}, record your daily progress, and build your private reading history.`,
      });
      return;
    }

    setBusy(true);
    try {
      await api.setStatus(work.id, status);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const rate = async (rating: number) => {
    if (!user) {
      promptAuth({
        title: `Sign up to rate ${work.title}`,
        subtitle: 'Share your ratings with half-star precision and build your personal taste profile.',
      });
      return;
    }
    setBusy(true);
    try {
      await api.setStatus(work.id, work.your_read?.status ?? 'finished', rating);
      await load();
    } finally {
      setBusy(false);
    }
  };

  const submitProgress = async () => {
    const n = parseInt(pageInput, 10);
    if (!work.your_read || Number.isNaN(n)) return;
    setBusy(true);
    try {
      await api.addProgress(work.your_read.id, n, total ? (n / total) * 100 : null);
      setPageInput('');
      await load();
    } finally {
      setBusy(false);
    }
  };

  // Mock histogram ratings distribution (PRD §6.24)
  const ratingsDistribution = [
    { stars: 5, pct: 64, count: 912 },
    { stars: 4, pct: 24, count: 341 },
    { stars: 3, pct: 8, count: 114 },
    { stars: 2, pct: 3, count: 42 },
    { stars: 1, pct: 1, count: 14 },
  ];

  const defaultDescription =
    'Piranesi lives in the House. Perhaps he always has. In his notebooks, day after day, he makes a clear and careful record of its wonders: the labyrinth of halls, the thousands upon thousands of statues, the tides that surge up staircases, the clouds that move in slow procession through the upper halls. A singular, spellbinding work of the imagination.';

  return (
    <Screen>
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: space[16], gap: space[6] }}>
        {/* 1. Hero Header */}
        <View style={{ alignItems: 'center', gap: space[3] }}>
          <Cover coverId={work.cover_id} size="xl" />
          <View style={{ alignItems: 'center', gap: space[1] }}>
            <Txt variant="displayM" style={{ textAlign: 'center' }}>
              {work.title}
            </Txt>

            {/* Author Link */}
            <Pressable
              onPress={() => router.push(`/author/${encodeURIComponent(work.author_name)}` as any)}
              accessibilityRole="link"
              accessibilityLabel={`Author ${work.author_name}`}
              hitSlop={8}
            >
              <Txt variant="bodyL" color="accent" style={{ fontWeight: '500' }}>
                {work.author_name}
              </Txt>
            </Pressable>

            {/* Series Link */}
            <Pressable
              onPress={() => router.push('/series/earthsea' as any)}
              accessibilityRole="link"
              accessibilityLabel="Series Earthsea Cycle Book 1"
              hitSlop={8}
            >
              <Txt variant="caption" color="muted">
                Earthsea Cycle · Book 1
              </Txt>
            </Pressable>

            {/* Metadata line */}
            <Txt variant="caption" color="muted">
              {[work.first_publish_year, formatLabel(edition?.format), total ? `${total} pages` : null]
                .filter(Boolean)
                .join(' · ')}
            </Txt>
          </View>
        </View>

        {/* 2. Primary Status Control (Largest element after cover) */}
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {STATUSES.map((s) => {
            const active =
              s.key === 'want'
                ? user
                  ? work.your_read?.status === 'want'
                  : savedInGuestShelf
                : work.your_read?.status === s.key;
            const label =
              !user && s.key === 'want' && savedInGuestShelf
                ? 'Saved to Want to read ✓'
                : s.label;
            return (
              <Button
                key={s.key}
                label={label}
                variant={active ? 'primary' : 'secondary'}
                disabled={busy}
                onPress={() => setStatus(s.key)}
                style={{ flex: 1, minWidth: 140 }}
              />
            );
          })}
        </View>

        {/* 3. Rating & 5-Bar Distribution Histogram */}
        <Card style={{ gap: space[3] }}>
          <View style={[sheet.row, { justifyContent: 'space-between' }]}>
            <Txt variant="micro" color="muted">
              YOUR RATING
            </Txt>
            <Txt variant="caption" color="muted">
              Optional
            </Txt>
          </View>

          <View style={[sheet.row, { justifyContent: 'space-between', alignItems: 'center' }]}>
            <Stars value={work.your_read?.rating ?? null} onChange={rate} size={28} />
            {work.your_read?.rating ? (
              <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                {work.your_read.rating} ★
              </Txt>
            ) : null}
          </View>

          {/* Histogram Divider */}
          <View style={{ height: 1, backgroundColor: c.line, marginVertical: space[1] }} />

          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <View style={sheet.row}>
                <Txt variant="displayM" tabular style={{ marginRight: space[2] }}>
                  4.4
                </Txt>
                <View>
                  <Stars value={4.4} size={14} />
                  <Txt variant="micro" color="muted">
                    1,423 ratings
                  </Txt>
                </View>
              </View>
            </View>

            {/* 5-Bar Distribution */}
            {ratingsDistribution.map((item) => (
              <View key={item.stars} style={[sheet.row, { gap: space[2] }]}>
                <Txt variant="caption" color="muted" tabular style={{ width: 22 }}>
                  {item.stars}★
                </Txt>
                <View
                  style={{
                    flex: 1,
                    height: 8,
                    borderRadius: 4,
                    backgroundColor: c.surface2,
                    overflow: 'hidden',
                  }}
                >
                  <View
                    style={{
                      height: '100%',
                      width: `${item.pct}%`,
                      backgroundColor: c.accent,
                      borderRadius: 4,
                    }}
                  />
                </View>
                <Txt variant="micro" color="muted" tabular style={{ width: 34, textAlign: 'right' }}>
                  {item.pct}%
                </Txt>
              </View>
            ))}
          </View>
        </Card>

        {/* 4. Active Progress Card (when reading) */}
        {work.your_read?.status === 'reading' && (
          <Card style={{ gap: space[3] }}>
            <Txt variant="micro" color="muted">
              CURRENT READING PROGRESS
            </Txt>
            <ProgressBar percent={percent ?? 0} />
            <Txt variant="caption" color="ink2">
              {page && total
                ? `Page ${page} of ${total} (${percent}%)`
                : percent
                ? `${percent}% complete`
                : 'Reading started'}
            </Txt>
            <View style={sheet.row}>
              <TextInput
                value={pageInput}
                onChangeText={setPageInput}
                keyboardType="number-pad"
                placeholder="Current page"
                placeholderTextColor={c.muted}
                accessibilityLabel="Enter current page"
                style={{
                  flex: 1,
                  minHeight: 48,
                  paddingHorizontal: space[3],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: c.line,
                  backgroundColor: c.surface,
                  color: c.ink,
                }}
              />
              <Button
                label="Save progress"
                variant="primary"
                onPress={submitProgress}
                disabled={busy || !pageInput}
              />
            </View>
          </Card>
        )}

        {/* 5. Description (Expandable) */}
        <Card style={{ gap: space[2] }}>
          <Txt variant="micro" color="muted">
            ABOUT THIS BOOK
          </Txt>
          <Txt
            variant="body"
            color="ink"
            numberOfLines={descExpanded ? undefined : 3}
            style={{ lineHeight: 22 }}
          >
            {defaultDescription}
          </Txt>
          <Pressable
            onPress={() => setDescExpanded(!descExpanded)}
            accessibilityRole="button"
            accessibilityLabel={descExpanded ? 'Show less description' : 'Read full description'}
            hitSlop={8}
          >
            <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
              {descExpanded ? 'Show less' : 'Read more'}
            </Txt>
          </Pressable>
        </Card>

        {/* 6. Metadata Strip */}
        <Card style={{ gap: space[2] }}>
          <Txt variant="micro" color="muted">
            EDITION DETAILS
          </Txt>
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                Format
              </Txt>
              <Txt variant="caption" color="ink" style={{ textTransform: 'capitalize' }}>
                {edition?.format ?? 'Paperback'}
              </Txt>
            </View>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                Pages
              </Txt>
              <Txt variant="caption" color="ink" tabular>
                {total ?? '245'} pages
              </Txt>
            </View>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                First Published
              </Txt>
              <Txt variant="caption" color="ink" tabular>
                {work.first_publish_year ?? '2020'}
              </Txt>
            </View>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                ISBN-13
              </Txt>
              <Txt variant="caption" color="ink" tabular>
                {edition?.isbn13 ?? '9780571353408'}
              </Txt>
            </View>
          </View>
        </Card>

        {/* 7. Tabs: Reviews / Editions / History */}
        <View style={{ gap: space[3], marginTop: space[2] }}>
          <SegmentedControl
            values={['reviews', 'editions', 'history'] as const}
            selected={activeTab}
            onSelect={setActiveTab}
            labels={{
              reviews: 'Reviews',
              editions: 'Editions',
              history: 'My History',
            }}
          />

          {activeTab === 'reviews' && (
            <View style={{ gap: space[3] }}>
              <Card style={{ gap: space[2] }}>
                <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                  <View style={sheet.row}>
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        backgroundColor: c.surface2,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: space[2],
                      }}
                    >
                      <Txt variant="caption" style={{ fontWeight: '600' }}>
                        P
                      </Txt>
                    </View>
                    <Txt variant="caption" style={{ fontWeight: '600' }}>
                      paloma
                    </Txt>
                  </View>
                  <Stars value={5} size={16} />
                </View>
                <Txt variant="body" color="ink" style={{ lineHeight: 21 }}>
                  The Beauty of the House is immeasurable; its Kindness infinite. A quiet,
                  transformative puzzle box of a novel that lingers long after closing the back cover.
                </Txt>
                <Txt variant="micro" color="muted">
                  Finished · September 2026
                </Txt>
              </Card>

              <Card style={{ gap: space[2] }}>
                <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                  <View style={sheet.row}>
                    <View
                      style={{
                        width: 28,
                        height: 28,
                        borderRadius: 14,
                        backgroundColor: c.surface2,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: space[2],
                      }}
                    >
                      <Txt variant="caption" style={{ fontWeight: '600' }}>
                        J
                      </Txt>
                    </View>
                    <Txt variant="caption" style={{ fontWeight: '600' }}>
                      julian
                    </Txt>
                  </View>
                  <Stars value={4.5} size={16} />
                </View>
                <Txt variant="body" color="ink" style={{ lineHeight: 21 }}>
                  Hypnotic and meditative. Susanna Clarke builds an eerie, oceanic dreamscape.
                </Txt>
                <Txt variant="micro" color="muted">
                  Finished · August 2026
                </Txt>
              </Card>
            </View>
          )}

          {activeTab === 'editions' && (
            <View style={{ gap: space[3] }}>
              <Card style={{ gap: space[3] }}>
                <Txt variant="title">Editions of {work.title}</Txt>
                <Txt variant="caption" color="muted">
                  {work.editions?.length ?? 4} editions available in catalog.
                </Txt>
                <Button
                  label="Choose your edition (The copy I own)"
                  variant="primary"
                  onPress={() => router.push(`/work/${work.id}/editions` as any)}
                />
              </Card>
            </View>
          )}

          {activeTab === 'history' && (
            <View style={{ gap: space[3] }}>
              {work.your_read ? (
                <Card style={{ gap: space[2] }}>
                  <Txt variant="title">Attempt #1</Txt>
                  <Txt variant="caption" color="muted">
                    Status: {work.your_read.status.toUpperCase()}
                  </Txt>
                  {work.your_read.rating && (
                    <Txt variant="caption" color="accent">
                      Your rating: {work.your_read.rating} ★
                    </Txt>
                  )}
                </Card>
              ) : (
                <EmptyState
                  title="No reading history yet"
                  subtitle="When you log this book, your reading sessions, progress notes, and finish dates will appear here."
                />
              )}
            </View>
          )}
        </View>
      </ScrollView>
    </Screen>
  );
}
