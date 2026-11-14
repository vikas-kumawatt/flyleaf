// Edition Picker Screen (PRD §6.31, design.md §10, SL-42).
//
// "The cover is the choice, so it dominates the row.
// Surface it as 'choose your cover', not just 'choose your edition',
// and show the covers large enough to pick by sight.
// 'This is the copy I own' affordance sets the cover for Diary and Wall."
//
// Audit 08: "the copy I own" was never saved (the button showed a tick and
// went back), and every edition was given an invented publisher and year,
// with three invented editions for a work that had none. The choice is now
// the edition of the reader's current attempt (reads.edition_id), through
// the offline queue; publisher and year come from the catalog.

import React, { useState, useEffect } from 'react';
import { Alert } from 'react-native';
import {
  ScrollView,
  View,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Work, type Edition } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useActionGate } from '@/ui/ActionGate';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Chip,
  Cover,
  EmptyState,
  Screen,
  Skeleton,
  Txt,
  sheet,
} from '@/ui/components';
import { cover, space, radius, useTheme } from '@/ui/tokens';

export interface DisplayEdition extends Edition {
  publisher?: string;
  publish_year?: number;
  is_canonical?: boolean;
}

export default function EditionPickerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useTheme();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const db = useDatabase();
  const insets = useSafeAreaInsets();

  const [work, setWork] = useState<Work | null>(null);
  const [selectedEditionId, setSelectedEditionId] = useState<string | null>(null);
  const [formatFilter, setFormatFilter] = useState<'all' | 'paperback' | 'hardcover' | 'ebook' | 'audiobook'>('all');
  const [savedSuccess, setSavedSuccess] = useState(false);
  // D-08-4: choosing a copy of a book not in the library adds it to Want to
  // read; say so rather than doing it silently.
  const [toast, setToast] = useState<string | null>(null);

  useEffect(() => {
    if (id) {
      api.work(id).then((w) => {
        setWork(w);
        const first = w.editions?.[0];
        if (first) {
          setSelectedEditionId(first.id);
        }
      }).catch(() => {});
    }
  }, [id]);

  if (!work) {
    // Shape-matched to the header and the edition rows below (design.md §5).
    return (
      <Screen>
        <View accessible accessibilityLabel="Loading editions" accessibilityState={{ busy: true }} style={{ padding: space[4], gap: space[4] }}>
          <Skeleton width="60%" height={30} />
          <Skeleton width="90%" height={14} />
          {[0, 1, 2].map((i) => (
            <View key={i} style={[sheet.rowTop, { gap: space[4], paddingTop: space[4] }]}>
              <Skeleton width={cover.l.width} height={cover.l.height} borderRadius={radius.xs} />
              <View style={{ flex: 1, gap: space[2] }}>
                <Skeleton width="40%" height={12} />
                <Skeleton width="80%" height={18} />
                <Skeleton width="50%" height={12} />
              </View>
            </View>
          ))}
        </View>
      </Screen>
    );
  }

  const sampleEditions: DisplayEdition[] = (work.editions ?? []).map((e) => ({
    ...e,
    publisher: e.publisher ?? undefined,
    publish_year: e.publish_year ?? undefined,
  }));

  const filteredEditions = sampleEditions.filter((e) => {
    if (formatFilter === 'all') return true;
    return e.format === formatFilter;
  });

  const handleSelectEdition = (editionId: string) => {
    void Haptics.selectionAsync();
    setSelectedEditionId(editionId);
    setSavedSuccess(false);
  };

  const handleConfirmCopy = async () => {
    if (!user) {
      promptAuth({ title: `Sign up to choose your copy of ${work.title}`, subtitle: 'Your copy sets the cover and page count in your library.' });
      return;
    }
    const chosen = work.editions?.find((e) => e.id === selectedEditionId);
    if (!chosen || !db) return;
    try {
      // The same status again edits the current attempt; with no read yet
      // the book goes on the want-to-read pile with this copy.
      await new OfflineRepository(db, user.id).saveReadStatus(
        work.id, work.your_read?.status ?? 'want', null, null,
        { title: work.title, author_name: work.author_name, cover_id: chosen.cover_id ?? work.cover_id, page_count: chosen.page_count, edition_id: chosen.id },
      );
    } catch {
      Alert.alert('Not saved', 'Your copy could not be saved on this phone. Please try again.');
      return;
    }
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSavedSuccess(true);
    const addedToWant = !work.your_read;
    if (addedToWant) setToast(`Added ${work.title} to Want to read`);
    setTimeout(() => {
      router.back();
    }, addedToWant ? 1800 : 600);
  };

  const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

  return (
    <Screen>
      {toast ? (
        <View
          accessibilityLiveRegion="polite"
          style={{
            position: 'absolute',
            top: space[4],
            left: space[4],
            right: space[4],
            zIndex: 999,
            backgroundColor: c.ink,
            paddingHorizontal: space[4],
            paddingVertical: space[3],
            borderRadius: radius.lg,
            borderCurve: 'continuous',
            flexDirection: 'row',
            alignItems: 'center',
            gap: space[2],
          }}
        >
          <Ionicons name="checkmark-circle-outline" size={18} color={c.ground} />
          <Txt variant="body" color="ground" style={{ fontWeight: '500', flex: 1 }}>
            {toast}
          </Txt>
        </View>
      ) : null}
      {/* Top Header */}
      <View
        style={{
          paddingHorizontal: space[4],
          paddingTop: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          gap: space[2],
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayM" style={{ flex: 1 }}>Choose your cover</Txt>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}
          >
            <Ionicons name="close" size={24} color={c.ink} />
          </Pressable>
        </View>
        <Txt variant="body" color="ink2">
          Pick the edition you own. Its cover stands for {work.title} in your diary, on your wall and in your reading.
        </Txt>

        {/* Format Filter Chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space[2], paddingTop: space[2] }}
        >
          {(['all', 'paperback', 'hardcover', 'ebook', 'audiobook'] as const).map((fmt) => (
            <Chip
              key={fmt}
              label={capitalize(fmt)}
              selected={formatFilter === fmt}
              onPress={() => setFormatFilter(fmt)}
            />
          ))}
        </ScrollView>
      </View>

      {/* Editions List: ruled rows, the cover dominant */}
      <ScrollView
        style={{ flex: 1 }}
        contentContainerStyle={{
          paddingHorizontal: space[4],
          paddingBottom: space[6],
        }}
      >
        {filteredEditions.map((ed, index) => {
          const isSelected = selectedEditionId === ed.id;
          const year = ed.publish_year ?? work.first_publish_year;

          return (
            <Pressable
              key={ed.id}
              onPress={() => handleSelectEdition(ed.id)}
              accessibilityRole="radio"
              accessibilityState={{ selected: isSelected }}
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
              {/* Large Cover Image (dominant per PRD §6.31) */}
              <Cover coverId={ed.cover_id} title={work.title} author={work.author_name} size="l" />

              <View style={{ flex: 1, minHeight: 180, justifyContent: 'space-between', gap: space[2] }}>
                <View style={{ gap: space[1] }}>
                  <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap', gap: space[2] }]}>
                    <Txt variant="micro" color="muted">
                      {capitalize(ed.format)}
                    </Txt>
                    {ed.is_canonical && (
                      <Txt variant="micro" color="muted">
                        Most common
                      </Txt>
                    )}
                  </View>

                  <Txt variant="title" numberOfLines={2}>
                    {ed.publisher ?? 'Standard edition'}
                  </Txt>
                  {year ? (
                    <Txt variant="caption" color="ink2" tabular>
                      Published {year}
                    </Txt>
                  ) : null}
                  <Txt variant="caption" color="ink2" tabular>
                    {ed.page_count ? `${ed.page_count} pages` : 'Page count not set'}
                  </Txt>
                  {ed.isbn13 && (
                    <Txt variant="micro" color="muted" tabular>
                      ISBN {ed.isbn13}
                    </Txt>
                  )}
                </View>

                {/* Selection Indicator */}
                <View style={[sheet.row, { gap: space[2] }]}>
                  <Ionicons
                    name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                    size={20}
                    color={isSelected ? c.accent : c.muted}
                  />
                  <Txt
                    variant="caption"
                    color={isSelected ? 'ink' : 'muted'}
                    style={{ fontWeight: isSelected ? '500' : '400' }}
                  >
                    {isSelected ? 'Selected cover' : 'Tap to choose'}
                  </Txt>
                </View>
              </View>
            </Pressable>
          );
        })}

        {filteredEditions.length === 0 && (
          <EmptyState
            title="No editions found in this format"
            subtitle="Choose All to see every hardcover, paperback and digital edition."
          />
        )}
      </ScrollView>

      {/* Bottom bar: confirm "The copy I own". In the layout, not floating, so it never covers a row. */}
      <View
        style={{
          backgroundColor: c.ground,
          borderTopWidth: 1,
          borderTopColor: c.line,
          paddingHorizontal: space[4],
          paddingTop: space[3],
          paddingBottom: Math.max(insets.bottom, space[6]),
        }}
      >
        <Button
          label={savedSuccess ? 'Saved as your copy' : 'This is the copy I own'}
          variant="primary"
          onPress={handleConfirmCopy}
        />
      </View>
    </Screen>
  );
}
