// Updates that could not sync (PRD §35.2, audit 07 A-07-001).
//
// Dead-lettered queue rows, with the reason the server gave, a Retry and a
// Discard. Before this screen they were counted by the indicator and nothing
// more: the data silently rotted.

import React, { useCallback, useEffect, useState } from 'react';
import { View, ScrollView, Pressable, Alert } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { useOfflineSync } from '@/offline/sync';
import { describeSyncIssue, type SyncIssue } from '@/offline/syncIssues';
import { Button, Card, EmptyState, Screen, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function SyncIssuesScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { repository, syncNow, refreshCounts } = useOfflineSync();
  const [issues, setIssues] = useState<(SyncIssue & { title: string | null })[]>([]);

  const load = useCallback(async () => {
    if (!repository) {
      setIssues([]);
      return;
    }
    const rows = await repository.getQueue().getDeadLetters();
    const reads = await repository.getLocalReads();
    const titles = new Map(reads.map((r) => [r.id, r.title]));
    setIssues(rows.map((m) => ({ ...describeSyncIssue(m), title: titles.get(m.entity_id) ?? null })));
  }, [repository]);

  useEffect(() => {
    void load();
  }, [load]);

  const retry = async (id: string) => {
    if (!repository) return;
    await repository.getQueue().retryDeadLetter(id);
    await syncNow();
    await load();
  };

  const discard = (issue: SyncIssue) => {
    Alert.alert('Discard this update?', 'It will not be sent. This cannot be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Discard',
        style: 'destructive',
        onPress: async () => {
          if (!repository) return;
          await repository.getQueue().dismissDeadLetter(issue.id);
          await refreshCounts();
          await load();
        },
      },
    ]);
  };

  return (
    <Screen>
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <View style={sheet.rowBetween}>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Back"
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
          >
            <Ionicons name="arrow-back" size={24} color={c.ink} />
          </Pressable>
          <Txt variant="title">Couldn't sync</Txt>
          <View style={{ minWidth: 44 }} />
        </View>
      </View>

      <ScrollView contentContainerStyle={{ padding: space[4], gap: space[3] }}>
        {issues.length === 0 ? (
          <EmptyState title="Everything is synced" subtitle="Updates you make offline are sent when you are back online." />
        ) : (
          issues.map((issue) => (
            <Card key={issue.id}>
              <View style={{ gap: space[2] }}>
                <Txt variant="micro" color="muted">
                  {issue.label.toUpperCase()}
                </Txt>
                {issue.title ? <Txt variant="title">{issue.title}</Txt> : null}
                <Txt variant="body" color="ink2">
                  {issue.reason}
                </Txt>
                <View style={[sheet.row, { gap: space[2], marginTop: space[1] }]}>
                  {issue.canRetry ? (
                    <Button label="Retry" size="sm" variant="primary" onPress={() => void retry(issue.id)} />
                  ) : null}
                  <Button label="Discard" size="sm" variant="tertiary" onPress={() => discard(issue)} />
                </View>
              </View>
            </Card>
          ))
        )}
      </ScrollView>
    </Screen>
  );
}
