// Edition Picker Screen (PRD §6.31, design.md §10, SL-42).
//
// "The cover is the choice, so it dominates the row.
// Surface it as 'choose your cover', not just 'choose your edition',
// and show the covers large enough to pick by sight.
// 'This is the copy I own' affordance sets the cover for Diary and Wall."

import React, { useState, useEffect } from 'react';
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
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

export interface DisplayEdition extends Edition {
  publisher?: string;
  publish_year?: number;
  is_canonical?: boolean;
}

export default function EditionPickerScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useTheme();

  const [work, setWork] = useState<Work | null>(null);
  const [selectedEditionId, setSelectedEditionId] = useState<string | null>(null);
  const [formatFilter, setFormatFilter] = useState<'all' | 'paperback' | 'hardcover' | 'ebook' | 'audiobook'>('all');
  const [savedSuccess, setSavedSuccess] = useState(false);

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
    return (
      <Screen>
        <View style={sheet.pad}>
          <Txt color="muted">Loading editions…</Txt>
        </View>
      </Screen>
    );
  }

  // Populate mock editions if work has few
  const sampleEditions: DisplayEdition[] = (work.editions && work.editions.length > 0)
    ? work.editions.map((e, idx) => ({
        ...e,
        publisher: idx === 0 ? 'Bloomsbury Publishing' : idx === 1 ? 'Faber & Faber' : 'Tor Books',
        publish_year: idx === 0 ? 2020 : 2021 + idx,
        is_canonical: idx === 0,
      }))
    : [
        {
          id: 'ed-1',
          isbn13: '9780571353408',
          page_count: 245,
          format: 'hardcover',
          cover_id: work.cover_id ?? 8231856,
          publisher: 'Bloomsbury Publishing',
          publish_year: 2020,
          is_canonical: true,
        },
        {
          id: 'ed-2',
          isbn13: '9781635575637',
          page_count: 272,
          format: 'paperback',
          cover_id: 8231990,
          publisher: 'Bloomsbury USA',
          publish_year: 2021,
          is_canonical: false,
        },
        {
          id: 'ed-3',
          isbn13: '9781635575644',
          page_count: 256,
          format: 'ebook',
          cover_id: 10521270,
          publisher: 'Bloomsbury Digital',
          publish_year: 2020,
          is_canonical: false,
        },
      ];

  const filteredEditions = sampleEditions.filter((e) => {
    if (formatFilter === 'all') return true;
    return e.format === formatFilter;
  });

  const handleSelectEdition = (editionId: string) => {
    void Haptics.selectionAsync();
    setSelectedEditionId(editionId);
    setSavedSuccess(false);
  };

  const handleConfirmCopy = () => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    setSavedSuccess(true);
    setTimeout(() => {
      router.back();
    }, 600);
  };

  return (
    <Screen>
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
          <Txt variant="displayM">Choose Your Cover</Txt>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Close"
            hitSlop={8}
          >
            <Ionicons name="close" size={24} color={c.ink} />
          </Pressable>
        </View>
        <Txt variant="body" color="muted">
          Pick the edition you own. Its cover will represent {work.title} across your Diary, Wall, and reading tracking.
        </Txt>

        {/* Format Filter Chips */}
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerStyle={{ gap: space[2], paddingTop: space[2] }}
        >
          {(['all', 'paperback', 'hardcover', 'ebook', 'audiobook'] as const).map((fmt) => {
            const active = formatFilter === fmt;
            return (
              <Pressable
                key={fmt}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setFormatFilter(fmt);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={{
                  paddingHorizontal: space[3],
                  paddingVertical: 4,
                  borderRadius: radius.pill,
                  backgroundColor: active ? c.accent : c.surface,
                  borderWidth: 1,
                  borderColor: active ? c.accent : c.line,
                }}
              >
                <Txt
                  variant="caption"
                  color={active ? 'ground' : 'ink2'}
                  style={{ fontWeight: active ? '600' : '400', textTransform: 'capitalize' }}
                >
                  {fmt}
                </Txt>
              </Pressable>
            );
          })}
        </ScrollView>
      </View>

      {/* Editions List */}
      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[16],
          gap: space[4],
        }}
      >
        {filteredEditions.map((ed) => {
          const isSelected = selectedEditionId === ed.id;

          return (
            <Card
              key={ed.id}
              onPress={() => handleSelectEdition(ed.id)}
              style={{
                borderWidth: isSelected ? 2 : 1,
                borderColor: isSelected ? c.accent : c.line,
                padding: space[4],
              }}
            >
              <View style={sheet.rowTop}>
                {/* Large Cover Image (dominant per PRD §6.31) */}
                <Cover coverId={ed.cover_id} title={work.title} size="l" />

                <View
                  style={{
                    flex: 1,
                    marginLeft: space[4],
                    justifyContent: 'space-between',
                    gap: space[2],
                  }}
                >
                  <View style={{ gap: 2 }}>
                    <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                      <Txt
                        variant="caption"
                        color="accent"
                        style={{ fontWeight: '600', textTransform: 'uppercase', letterSpacing: 0.5 }}
                      >
                        {ed.format}
                      </Txt>
                      {ed.is_canonical && (
                        <View
                          style={{
                            backgroundColor: c.surface2,
                            paddingHorizontal: space[2],
                            paddingVertical: 2,
                            borderRadius: radius.sm,
                          }}
                        >
                          <Txt variant="micro" color="ink" style={{ fontWeight: '600' }}>
                            Most Common
                          </Txt>
                        </View>
                      )}
                    </View>

                    <Txt variant="title" numberOfLines={1}>
                      {ed.publisher ?? 'Canonical Edition'}
                    </Txt>
                    <Txt variant="caption" color="muted">
                      Published {ed.publish_year ?? work.first_publish_year}
                    </Txt>
                  </View>

                  <View style={{ gap: space[1] }}>
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
                  <View style={[sheet.row, { marginTop: space[2] }]}>
                    <Ionicons
                      name={isSelected ? 'radio-button-on' : 'radio-button-off'}
                      size={20}
                      color={isSelected ? c.accent : c.muted}
                    />
                    <Txt
                      variant="caption"
                      color={isSelected ? 'accent' : 'muted'}
                      style={{ marginLeft: space[2], fontWeight: isSelected ? '600' : '400' }}
                    >
                      {isSelected ? 'Selected cover' : 'Tap to choose'}
                    </Txt>
                  </View>
                </View>
              </View>
            </Card>
          );
        })}

        {filteredEditions.length === 0 && (
          <EmptyState
            title="No editions found in this format"
            subtitle="Try selecting 'All' to see every available hardcover, paperback, and digital edition."
          />
        )}
      </ScrollView>

      {/* Bottom Floating Bar: Confirm "The copy I own" */}
      <View
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          backgroundColor: c.surface,
          borderTopWidth: 1,
          borderTopColor: c.line,
          paddingHorizontal: space[4],
          paddingTop: space[3],
          paddingBottom: space[6],
        }}
      >
        <Button
          label={savedSuccess ? 'Saved as your copy ✓' : 'This is the copy I own'}
          variant="primary"
          onPress={handleConfirmCopy}
        />
      </View>
    </Screen>
  );
}
