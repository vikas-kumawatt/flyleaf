// Your reports and moderation notices (PRD §27.6; SO-40, SO-42). Reports show
// their status only, never what happened to someone else. Notices are
// decisions about your own content, each with its appeal.

import React, { useCallback, useState } from 'react';
import { Pressable, RefreshControl, ScrollView, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';

import { api, type ModerationNotice, type Report } from '@/lib/api';
import { REPORT_REASONS, appealStatus } from '@/lib/moderation';
import { Button, EmptyState, Screen, SkeletonList, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';

const NOUN: Record<string, string> = { review: 'Review', comment: 'Comment', user: 'Profile', shelf: 'Shelf', work: 'Book' };

export default function YourReportsScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [reports, setReports] = useState<Report[]>([]);
  const [notices, setNotices] = useState<ModerationNotice[]>([]);
  const [refreshing, setRefreshing] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [reportsFailed, setReportsFailed] = useState(false);

  const load = useCallback(async () => {
    const [r, n] = await Promise.allSettled([api.getMyReports(), api.getModerationNotices()]);
    if (r.status === 'fulfilled') setReports(r.value.reports);
    setReportsFailed(r.status === 'rejected');
    if (n.status === 'fulfilled') setNotices(n.value.notices);
    setLoaded(true);
  }, []);

  // On every focus: coming back from a notice after appealing has to show
  // the appeal's state, not the offer to appeal.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  return (
    <Screen>
      <View style={{ paddingTop: insets.top + space[2], paddingHorizontal: space[4], paddingBottom: space[3], borderBottomWidth: 1, borderBottomColor: c.line }}>
        <View style={sheet.rowBetween}>
          <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
            <Ionicons name="chevron-back" size={24} color={c.ink} />
          </Pressable>
          <Txt variant="title">Your reports</Txt>
          <View style={{ minWidth: 44 }} />
        </View>
      </View>
      <ScrollView
        contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[3] }}
        refreshControl={<RefreshControl refreshing={refreshing} tintColor={c.accent} onRefresh={async () => { setRefreshing(true); await load(); setRefreshing(false); }} />}
      >
        {notices.length > 0 && (
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="muted">Decisions about your content</Txt>
            <View>
              {notices.map((n, index) => (
                <Pressable
                  key={n.id}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push(`/moderation/${n.id}` as any);
                  }}
                  accessibilityRole="button"
                  style={({ pressed }) => [
                    {
                      flexDirection: 'row',
                      alignItems: 'center',
                      gap: space[3],
                      paddingVertical: space[3],
                      borderTopWidth: index ? 1 : 0,
                      borderTopColor: c.line,
                      backgroundColor: pressed ? c.surface2 : 'transparent',
                    },
                  ]}
                >
                  <View style={{ flex: 1, gap: 2 }}>
                    <Txt variant="body" style={{ fontWeight: '500' }}>{n.rule_label}</Txt>
                    <Txt variant="caption" color="muted">{appealStatus(n) || n.summary}</Txt>
                  </View>
                  <Ionicons name="chevron-forward" size={18} color={c.muted} />
                </Pressable>
              ))}
            </View>
          </View>
        )}
        <Txt variant="micro" color="muted">Reports you made</Txt>
        {!loaded ? (
          <SkeletonList lead="none" style={{ paddingHorizontal: 0, paddingTop: 0 }} />
        ) : reports.length === 0 && reportsFailed ? (
          <EmptyState
            title="Could not load your reports"
            subtitle="Check your connection and try again."
            action={<Button label="Try again" variant="primary" onPress={() => void load()} />}
          />
        ) : reports.length === 0 ? (
          <EmptyState title="No reports" subtitle="When you report something, its status shows here" />
        ) : (
          <View>
            {reports.map((r, index) => (
              <View
                key={r.id}
                style={{ paddingVertical: space[3], gap: 2, borderTopWidth: index ? 1 : 0, borderTopColor: c.line }}
              >
                <View style={sheet.rowBetween}>
                  <Txt variant="body" style={{ fontWeight: '500' }}>{NOUN[r.subject_type] ?? 'Content'}</Txt>
                  <Txt variant="caption" color={r.status === 'open' ? 'muted' : 'positive'}>{r.status === 'open' ? 'Waiting for review' : 'Reviewed'}</Txt>
                </View>
                <Txt variant="caption" color="muted">
                  {REPORT_REASONS.find((x) => x.key === r.reason)?.label ?? r.reason} · {new Date(r.created_at).toLocaleDateString()}
                </Txt>
              </View>
            ))}
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}
