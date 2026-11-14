// DNF (Did Not Finish) Flow Screen (SL-55, PRD §6.18).
//
// Governed by:
//   1. "Stopped reading" heading (never "Failed" or "Gave up").
//   2. Neutral-to-warm copy: "Not every book is for every reader."
//   3. Pre-filled page reached.
//   4. Reason chips (Pacing, Writing style, Not the right time, Content, Lost interest, Other).
//   5. Optional note, optional rating, visibility selector.

import React, { useState, useEffect } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import { useSession } from '@/lib/session';
import type { LocalRead } from '@/offline/schema';
import { Button, Chip, Cover, Screen, Skeleton, Stars, Txt, sheet } from '@/ui/components';
import { radius, space, type, useTheme } from '@/ui/tokens';

const DNF_REASONS = [
  'Pacing',
  'Writing style',
  'Not the right time',
  'Content',
  'Lost interest',
  'Other',
];

export default function DnfScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const db = useDatabase();
  const { user } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [read, setRead] = useState<LocalRead | null>(null);
  const [loading, setLoading] = useState(true);

  // Form State
  const [pageInput, setPageInput] = useState('');
  const [selectedReason, setSelectedReason] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [visibility, setVisibility] = useState<'public' | 'followers' | 'private'>('public');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function load() {
      if (!db || !user) return;
      try {
        const repo = new OfflineRepository(db, user.id);
        const reads = await repo.getLocalReads();
        const found = reads.find((r) => r.id === id || r.work_id === id);
        if (mounted && found) {
          setRead(found);
          if (found.page) setPageInput(String(found.page));
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, [id, db]);

  const handleSaveDnf = async () => {
    if (submitting || !db || !user) return;
    setSubmitting(true);

    try {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const repo = new OfflineRepository(db, user.id);
      const readId = read?.id ?? (id as string);
      const abandonedPage = pageInput ? parseInt(pageInput, 10) : null;

      await repo.dnfRead(readId, {
        abandonedPage,
        dnfReason: selectedReason,
        note: note.trim() || null,
        rating,
        visibility,
      });

      router.back();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not update status.');
    } finally {
      setSubmitting(false);
    }
  };

  // Inputs: surface fill, strong hairline, radius.md (design.md §5).
  const inputStyle = {
    minHeight: 48,
    paddingHorizontal: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: c.lineStrong,
    backgroundColor: c.surface,
    color: c.ink,
    ...type.body,
  } as const;

  return (
    <Screen>
      {/* Header bar */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          backgroundColor: c.ground,
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <Pressable
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          style={{ minHeight: 44, minWidth: 64, justifyContent: 'center' }}
        >
          <Txt variant="body" color="ink2">
            Cancel
          </Txt>
        </Pressable>

        <Txt variant="title">Stopped reading</Txt>

        {/* Balances Cancel so the title stays centred. */}
        <View style={{ minWidth: 64 }} />
      </View>

      <KeyboardAvoidingView
        behavior="padding"
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            padding: space[4],
            paddingBottom: space[8],
            gap: space[6],
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Cover and a warm line */}
          <View style={{ alignItems: 'center', gap: space[3], marginTop: space[2] }}>
            <Cover
              coverId={read?.cover_id}
              title={read?.title ?? 'Book'}
              author={read?.author_name ?? ''}
              size="m"
            />
            {loading ? (
              <View
                style={{ alignItems: 'center', gap: space[2] }}
                accessible
                accessibilityLabel="Loading"
                accessibilityState={{ busy: true }}
              >
                <Skeleton width={200} height={24} />
              </View>
            ) : (
              <Txt variant="displayM" style={{ textAlign: 'center' }}>
                {read?.title ?? 'This book'}
              </Txt>
            )}
            <Txt variant="body" color="ink2" style={{ textAlign: 'center', maxWidth: 280 }}>
              Not every book is for every reader, and that's okay.
            </Txt>
          </View>

          {/* Page reached */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="ink2">
              Page reached
            </Txt>
            <TextInput
              value={pageInput}
              onChangeText={(txt) => setPageInput(txt.replace(/[^0-9]/g, ''))}
              placeholder="e.g. 84"
              keyboardType="number-pad"
              placeholderTextColor={c.muted}
              accessibilityLabel="Page reached"
              style={inputStyle}
            />
          </View>

          {/* Reason chips */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="ink2">
              Reason, if you want one
            </Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {DNF_REASONS.map((reason) => (
                <Chip
                  key={reason}
                  label={reason}
                  selected={selectedReason === reason}
                  role="checkbox"
                  onPress={() => setSelectedReason(selectedReason === reason ? null : reason)}
                />
              ))}
            </View>
          </View>

          {/* Optional note */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="ink2">
              Private note
            </Txt>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Why you put it down, or what didn't work"
              placeholderTextColor={c.muted}
              multiline
              numberOfLines={3}
              accessibilityLabel="Private DNF note"
              style={[
                inputStyle,
                { minHeight: 96, paddingVertical: space[3], textAlignVertical: 'top' },
              ]}
            />
          </View>

          {/* Optional rating */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="ink2">
              Rate what you read, if you like
            </Txt>
            <View style={{ alignSelf: 'flex-start' }}>
              <Stars value={rating} onChange={(val) => setRating(val)} size={32} />
            </View>
          </View>

          {/* Visibility */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="ink2">
              Visibility
            </Txt>
            <View style={[sheet.row, { gap: space[2], flexWrap: 'wrap' }]}>
              {(['public', 'followers', 'private'] as const).map((v) => (
                <Chip
                  key={v}
                  label={v.charAt(0).toUpperCase() + v.slice(1)}
                  selected={visibility === v}
                  accessibilityLabel={`Visibility: ${v}`}
                  role="radio"
                  onPress={() => setVisibility(v)}
                />
              ))}
            </View>
          </View>
        </ScrollView>

        {/* The one primary action, pinned so it is always in reach */}
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: c.line,
            backgroundColor: c.ground,
            paddingHorizontal: space[4],
            paddingTop: space[3],
            paddingBottom: Math.max(insets.bottom, space[4]),
          }}
        >
          <Button
            label={submitting ? 'Saving…' : 'Save'}
            variant="primary"
            onPress={handleSaveDnf}
            disabled={submitting}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
