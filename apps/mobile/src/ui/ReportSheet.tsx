// Report content (PRD §6.44; SO-40): reason picker, optional detail, submit,
// then a confirmation that promises no outcome. One sheet for every surface:
// a review, a comment, a profile, a shelf, a book.

import React, { useEffect, useState } from 'react';
import { Pressable, TextInput, View } from 'react-native';
import * as Haptics from 'expo-haptics';

import { BottomSheet, Button, Txt } from './components';
import { radius, space, useTheme } from './tokens';
import { api, ApiError, type ReportReason, type ReportSubjectType } from '../lib/api';
import { track } from '../lib/events';
import { REPORT_DETAIL_MAX, reasonsFor, reportConfirmation, reportErrorMessage, reportTitle } from '../lib/moderation';

export interface ReportTarget {
  type: ReportSubjectType;
  id: string;
}

export function ReportSheet({ target, onClose }: { target: ReportTarget | null; onClose: () => void }) {
  const c = useTheme();
  const [reason, setReason] = useState<ReportReason | null>(null);
  const [detail, setDetail] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  useEffect(() => {
    if (target) {
      setReason(null);
      setDetail('');
      setError(null);
      setSent(false);
    }
  }, [target?.type, target?.id]);

  const submit = async () => {
    if (!target || !reason || sending) return;
    setSending(true);
    setError(null);
    try {
      await api.createReport({ subject_type: target.type, subject_id: target.id, reason, detail: detail.trim() || null });
      track('content_reported', { type: target.type, reason });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setSent(true);
    } catch (err) {
      setError(err instanceof ApiError ? reportErrorMessage(err.code, err.message) : reportErrorMessage(undefined));
    } finally {
      setSending(false);
    }
  };

  return (
    <BottomSheet visible={target !== null} onClose={onClose} title={target ? reportTitle(target.type) : undefined}>
      {sent ? (
        <View style={{ gap: space[3], paddingBottom: space[4] }}>
          <Txt variant="body">{reportConfirmation()}</Txt>
          <Button label="Done" onPress={onClose} />
        </View>
      ) : (
        <View style={{ gap: space[2], paddingBottom: space[4] }}>
          <Txt variant="caption" color="muted">Why are you reporting this?</Txt>
          {target &&
            reasonsFor(target.type).map((r) => (
              <Pressable
                key={r.key}
                onPress={() => {
                  void Haptics.selectionAsync();
                  setReason(r.key);
                }}
                accessibilityRole="radio"
                accessibilityState={{ selected: reason === r.key }}
                style={{
                  paddingVertical: space[3],
                  paddingHorizontal: space[3],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: reason === r.key ? c.accent : c.line,
                  backgroundColor: reason === r.key ? c.accentSoft : c.surface,
                }}
              >
                <Txt variant="body">{r.label}</Txt>
              </Pressable>
            ))}
          <TextInput
            value={detail}
            onChangeText={(t) => setDetail(t.slice(0, REPORT_DETAIL_MAX))}
            placeholder="Anything else a moderator should know (optional)"
            placeholderTextColor={c.muted}
            multiline
            accessibilityLabel="Details"
            style={{
              minHeight: 72,
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: c.line,
              padding: space[3],
              color: c.ink,
              backgroundColor: c.surface,
              textAlignVertical: 'top',
            }}
          />
          {error && <Txt variant="caption" color="critical">{error}</Txt>}
          <Button label="Send report" onPress={submit} disabled={!reason} loading={sending} />
        </View>
      )}
    </BottomSheet>
  );
}
