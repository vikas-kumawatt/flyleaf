// Series Detail Screen (PRD §6.30, design.md §10, SL-43).
//
// Features:
// - Series title header
// - Reading progress indicator: "X of Y books read" with progress bar
// - "Next in series": the first entry the reader has not finished
// - Ordered book list with position numbers (#1, #2, #2.5 novella, #3)
//
// Audit 08: everything here was hard-coded (The Locked Tomb / Earthsea for
// every id). It now comes from GET /series/:id.

import React from 'react';
import {
  ScrollView,
  View,
  Pressable,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api } from '@/lib/api';
import { useRemote } from '@/lib/useRemote';
import { RemoteStatus } from '@/ui/RemoteStatus';
import {
  Card,
  Cover,
  ProgressBar,
  Screen,
  Txt,
  sheet,
} from '@/ui/components';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { space, useTheme } from '@/ui/tokens';

export default function SeriesScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const c = useTheme();
  const insets = useSafeAreaInsets();

  const remote = useRemote(id ? () => api.series(id) : null, [id]);
  if (remote.state !== 'ready') {
    return <RemoteStatus remote={remote} noun="series" onRetry={() => void remote.reload()} />;
  }
  const series = remote.data;

  const total = series.entries.length;
  const percent = total > 0 ? Math.round((series.read_books / total) * 100) : 0;
  // Up next: the first book in order not finished yet, once one has been.
  const next = series.read_books > 0 ? series.entries.find((e) => e.your_status !== 'finished') : undefined;

  return (
    <Screen>
      {/* Header bar with Back button */}
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'flex-start',
          paddingLeft: space[2],
          paddingRight: space[4],
          paddingTop: Math.max(insets.top, space[4]),
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          gap: space[1],
        }}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
        >
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </Pressable>
        <View style={{ flex: 1, paddingTop: space[2] }}>
          <Txt variant="displayM" numberOfLines={2}>
            {series.name}
          </Txt>
          {series.entries[0] ? (
            <Txt variant="caption" color="ink2" numberOfLines={1}>
              by {series.entries[0].author_name}
            </Txt>
          ) : null}
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[16],
          gap: space[6],
        }}
      >
        {/* Series Progress (PRD §6.30): a summary, so one card */}
        <Card style={{ gap: space[3] }}>
          <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap', gap: space[2] }]}>
            <Txt variant="micro" color="muted">
              Your progress
            </Txt>
            <Txt variant="caption" color="ink2" tabular>
              {series.read_books} of {total} read · {percent}%
            </Txt>
          </View>
          <ProgressBar percent={percent} />
        </Card>

        {/* Next In Series */}
        {next ? (
        <Card
          onPress={() => router.push(`/work/${next.work_id}`)}
          style={{ gap: space[3] }}
        >
          <Txt variant="micro" color="muted">
            Up next
          </Txt>
          <View style={[sheet.rowTop, { gap: space[3] }]}>
            <Cover coverId={next.cover_id} title={next.title} author={next.author_name} size="s" />
            <View style={{ flex: 1, gap: 2, justifyContent: 'center' }}>
              {next.position != null ? (
                <Txt variant="micro" color="muted" tabular>
                  Book {next.position}
                </Txt>
              ) : null}
              <Txt variant="title" numberOfLines={2}>
                {next.title}
              </Txt>
              <Txt variant="caption" color="ink2" numberOfLines={1}>
                {next.author_name}
              </Txt>
            </View>
          </View>
        </Card>
        ) : null}

        {/* Ordered Series Book List: ruled rows with the position as a numeral */}
        <View style={{ gap: space[2] }}>
          <Txt variant="title">Books in the series</Txt>
          <View>
            {series.entries.map((entry, index) => {
              const isFinished = entry.your_status === 'finished';
              const isReading = entry.your_status === 'reading';
              const isWant = entry.your_status === 'want';

              return (
                <Pressable
                  key={entry.work_id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push(`/work/${entry.work_id}`);
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    sheet.rowTop,
                    {
                      paddingVertical: space[3],
                      borderTopWidth: index ? 1 : 0,
                      borderTopColor: c.line,
                      backgroundColor: pressed ? c.surface2 : 'transparent',
                    },
                  ]}
                >
                  {/* Position number */}
                  <Txt variant="caption" color="ink2" tabular style={{ minWidth: 24, fontWeight: '500' }}>
                    {entry.position != null ? entry.position : '–'}
                  </Txt>

                  <Cover coverId={entry.cover_id} title={entry.title} author={entry.author_name} size="s" />

                  <View style={{ flex: 1, gap: space[1] }}>
                    <Txt variant="title" numberOfLines={2}>
                      {entry.title}
                    </Txt>
                    <Txt variant="caption" color="ink2" numberOfLines={1}>
                      {entry.author_name}
                    </Txt>

                    {/* Status label */}
                    <View style={[sheet.row, { gap: space[1] }]}>
                      {isFinished && (
                        <>
                          <Ionicons name="checkmark" size={14} color={c.ink2} />
                          <Txt variant="micro" color="ink2">
                            Finished
                          </Txt>
                        </>
                      )}
                      {isReading && (
                        <Txt variant="micro" color="ink2">
                          Reading
                        </Txt>
                      )}
                      {isWant && (
                        <Txt variant="micro" color="muted">
                          Want to read
                        </Txt>
                      )}
                    </View>
                  </View>
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>
    </Screen>
  );
}
