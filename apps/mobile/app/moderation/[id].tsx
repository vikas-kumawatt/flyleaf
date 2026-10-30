// A moderation decision about your content (PRD §27.6; SO-42): which rule
// applied, what it did, and one appeal, reviewed by a person. Opened from the
// notification (flyleaf://moderation/<id>) or from Your reports.

import React, { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, TextInput, View } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';

import { api, ApiError, type ModerationNotice } from '@/lib/api';
import { APPEAL_MAX, appealStatus } from '@/lib/moderation';
import { Button, Card, EmptyState, Screen, Txt, sheet } from '@/ui/components';
import { fontFamilies, radius, space, useTheme } from '@/ui/tokens';

export default function ModerationNoticeScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();
  const [notice, setNotice] = useState<ModerationNotice | null>(null);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!id) return;
    try {
      setNotice(await api.getModerationNotice(String(id)));
    } catch {
      setMissing(true);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  const appeal = async () => {
    if (!notice || !draft.trim() || sending) return;
    setSending(true);
    setError(null);
    try {
      setNotice(await api.appealModeration(notice.id, draft.trim()));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      setError(err instanceof ApiError && err.code === 'appeal_closed' ? 'This decision has already been appealed.' : 'Could not send the appeal. Try again.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Screen>
      <View style={{ paddingTop: insets.top + space[2], paddingHorizontal: space[4], paddingBottom: space[3], borderBottomWidth: 1, borderBottomColor: c.line }}>
        <View style={sheet.rowBetween}>
          <Pressable onPress={() => router.back()} accessibilityRole="button" accessibilityLabel="Back" style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}>
            <Ionicons name="arrow-back" size={24} color={c.ink} />
          </Pressable>
          <Txt variant="title">Moderation notice</Txt>
          <View style={{ minWidth: 44 }} />
        </View>
      </View>
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[3] }}>
        {missing ? (
          <EmptyState title="Not found" subtitle="This notice is no longer available." />
        ) : !notice ? (
          <ActivityIndicator color={c.accent} style={{ marginTop: space[6] }} />
        ) : (
          <>
            <Card style={{ padding: space[4], gap: space[2] }}>
              <Txt variant="micro" color="muted">Rule applied</Txt>
              <Txt variant="title">{notice.rule_label}</Txt>
              {notice.consequences.map((line) => (
                <Txt key={line} variant="body">{line}</Txt>
              ))}
              <Txt variant="caption" color="muted" tabular>{new Date(notice.created_at).toLocaleDateString()}</Txt>
            </Card>
            <Txt variant="body" color="ink2">{appealStatus(notice)}</Txt>
            {notice.appeal && (
              <Card style={{ padding: space[4], gap: space[2] }}>
                <Txt variant="micro" color="muted">Your appeal</Txt>
                <Txt variant="body">{notice.appeal.body}</Txt>
              </Card>
            )}
            {notice.can_appeal && (
              <View style={{ gap: space[2] }}>
                <TextInput
                  value={draft}
                  onChangeText={(t) => setDraft(t.slice(0, APPEAL_MAX))}
                  placeholder="Tell us why this decision is wrong"
                  placeholderTextColor={c.muted}
                  multiline
                  accessibilityLabel="Appeal"
                  style={{ minHeight: 120, borderRadius: radius.md, borderWidth: 1, borderColor: c.line, padding: space[3], color: c.ink, backgroundColor: c.surface2, fontSize: 15, fontFamily: fontFamilies.uiRegular, textAlignVertical: 'top' }}
                />
                {error && <Txt variant="caption" color="critical">{error}</Txt>}
                <Button label="Send appeal" onPress={appeal} disabled={!draft.trim()} loading={sending} />
              </View>
            )}
          </>
        )}
      </ScrollView>
    </Screen>
  );
}
