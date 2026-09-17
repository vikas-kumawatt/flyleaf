// Series Detail Screen (PRD §6.30, design.md §10, SL-43).
//
// Features:
// - Series title & author header
// - Reading progress indicator: "X of Y books read" with progress bar
// - "Next in series" recommendation card
// - Ordered book list with position numbers (#1, #2, #2.5 novella, #3)

import React, { useEffect, useState } from 'react';
import {
  ScrollView,
  View,
  Pressable,
  StyleSheet,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type SeriesDetail } from '@/lib/api';
import {
  Card,
  Cover,
  ProgressBar,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

export default function SeriesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useTheme();

  const [series, setSeries] = useState<SeriesDetail | null>(null);

  useEffect(() => {
    if (id) {
      api.series(id).then(setSeries).catch(() => {});
    }
  }, [id]);

  if (!series) {
    return (
      <Screen>
        <View style={sheet.pad}>
          <Txt color="muted">Loading series…</Txt>
        </View>
      </Screen>
    );
  }

  const percent = Math.round((series.read_books / series.total_books) * 100);

  return (
    <Screen>
      {/* Header bar with Back button */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          paddingHorizontal: space[4],
          paddingTop: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          gap: space[3],
        }}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={8}
        >
          <Ionicons name="arrow-back" size={24} color={c.ink} />
        </Pressable>
        <View style={{ flex: 1 }}>
          <Txt variant="displayM" numberOfLines={1}>
            {series.name}
          </Txt>
          <Txt variant="caption" color="muted">
            by {series.author_name}
          </Txt>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[16],
          gap: space[6],
        }}
      >
        {/* Series Progress Card (PRD §6.30) */}
        <Card style={{ gap: space[3] }}>
          <View style={[sheet.row, { justifyContent: 'space-between' }]}>
            <Txt variant="micro" color="muted">
              YOUR SERIES PROGRESS
            </Txt>
            <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
              {series.read_books} of {series.total_books} read ({percent}%)
            </Txt>
          </View>
          <ProgressBar percent={percent} />
        </Card>

        {/* Next In Series Card */}
        <Card
          onPress={() => router.push(`/work/${series.entries[1]?.work_id ?? 'next'}`)}
          style={{
            backgroundColor: c.surface,
            borderLeftWidth: 4,
            borderLeftColor: c.accent,
            gap: space[2],
          }}
        >
          <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
            UP NEXT IN SERIES
          </Txt>
          <View style={sheet.rowTop}>
            <Cover
              coverId={series.entries[1]?.cover_id}
              title={series.entries[1]?.title ?? 'Next Book'}
              size="s"
            />
            <View style={{ flex: 1, marginLeft: space[3], justifyContent: 'center' }}>
              <Txt variant="title">
                Book #{series.entries[1]?.position}: {series.entries[1]?.title}
              </Txt>
              <Txt variant="caption" color="muted">
                {series.entries[1]?.author_name}
              </Txt>
            </View>
          </View>
        </Card>

        {/* Ordered Series Book List */}
        <View style={{ gap: space[3] }}>
          <Txt variant="title">Books in Series</Txt>
          <View style={{ gap: space[3] }}>
            {series.entries.map((entry) => {
              const isFinished = entry.status === 'finished';
              const isReading = entry.status === 'reading';
              const isWant = entry.status === 'want';

              return (
                <Card
                  key={entry.work_id}
                  onPress={() => router.push(`/work/${entry.work_id}`)}
                  style={{ padding: space[3] }}
                >
                  <View style={sheet.rowTop}>
                    {/* Position Number Pill */}
                    <View
                      style={{
                        width: 32,
                        height: 32,
                        borderRadius: 16,
                        backgroundColor: c.surface2,
                        alignItems: 'center',
                        justifyContent: 'center',
                        marginRight: space[3],
                      }}
                    >
                      <Txt variant="caption" color="ink" style={{ fontWeight: '700' }}>
                        #{entry.position}
                      </Txt>
                    </View>

                    <Cover coverId={entry.cover_id} title={entry.title} size="s" />

                    <View
                      style={{
                        flex: 1,
                        marginLeft: space[3],
                        justifyContent: 'space-between',
                        gap: space[1],
                      }}
                    >
                      <View>
                        <Txt variant="title" numberOfLines={2}>
                          {entry.title}
                        </Txt>
                        <Txt variant="caption" color="muted">
                          {entry.author_name}
                        </Txt>
                      </View>

                      {/* Status Tag */}
                      <View style={{ alignSelf: 'flex-start', marginTop: 4 }}>
                        {isFinished && (
                          <View style={[styles.badge, { backgroundColor: c.accentSoft }]}>
                            <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
                              Finished ✓
                            </Txt>
                          </View>
                        )}
                        {isReading && (
                          <View style={[styles.badge, { backgroundColor: c.surface2 }]}>
                            <Txt variant="micro" color="ink" style={{ fontWeight: '600' }}>
                              Currently Reading
                            </Txt>
                          </View>
                        )}
                        {isWant && (
                          <View style={[styles.badge, { backgroundColor: c.surface2 }]}>
                            <Txt variant="micro" color="muted" style={{ fontWeight: '600' }}>
                              Want to Read
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
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
});
