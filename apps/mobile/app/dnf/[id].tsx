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
  Platform,
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import type { LocalRead } from '@/offline/schema';
import { Button, Card, Cover, Screen, Stars, Txt, sheet } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

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
      if (!db) return;
      try {
        const repo = new OfflineRepository(db);
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
    if (submitting || !db) return;
    setSubmitting(true);

    try {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const repo = new OfflineRepository(db);
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
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Txt variant="body" color="muted">
            Cancel
          </Txt>
        </Pressable>

        <Txt variant="title">Stopped reading</Txt>

        <Pressable
          onPress={handleSaveDnf}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Save"
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Txt variant="body" color="accent" style={{ fontWeight: '700' }}>
            Save
          </Txt>
        </Pressable>
      </View>

      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <ScrollView
          contentContainerStyle={{
            padding: space[4],
            paddingBottom: space[12],
            gap: space[6],
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* Header & Respectful Copy */}
          <View style={{ alignItems: 'center', gap: space[3], marginTop: space[2] }}>
            <Cover
              coverId={read?.cover_id}
              title={read?.title ?? 'Book'}
              author={read?.author_name ?? ''}
              size="m"
            />
            <View style={{ alignItems: 'center', gap: space[1] }}>
              <Txt variant="title" style={{ textAlign: 'center' }}>
                Stopped reading {read?.title ?? 'this book'}
              </Txt>
              <Txt variant="body" color="muted" style={{ textAlign: 'center', maxWidth: 280 }}>
                Not every book is for every reader, and that's okay.
              </Txt>
            </View>
          </View>

          {/* Page Reached Input */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="muted">
              PAGE REACHED
            </Txt>
            <TextInput
              value={pageInput}
              onChangeText={(txt) => setPageInput(txt.replace(/[^0-9]/g, ''))}
              placeholder="e.g. 84"
              keyboardType="number-pad"
              placeholderTextColor={c.muted}
              accessibilityLabel="Page reached"
              style={{
                minHeight: 44,
                paddingHorizontal: space[3],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.line,
                backgroundColor: c.surface2,
                color: c.ink,
                fontSize: 16,
              }}
            />
          </View>

          {/* Reason Chips */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="muted">
              REASON (OPTIONAL)
            </Txt>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
              {DNF_REASONS.map((reason) => {
                const selected = selectedReason === reason;
                return (
                  <Pressable
                    key={reason}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setSelectedReason(selected ? null : reason);
                    }}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: selected }}
                    accessibilityLabel={reason}
                    style={{
                      paddingHorizontal: space[3],
                      paddingVertical: space[2],
                      borderRadius: radius.pill,
                      backgroundColor: selected ? c.accentSoft : c.surface2,
                      borderWidth: 1,
                      borderColor: selected ? c.accent : c.line,
                    }}
                  >
                    <Txt
                      variant="caption"
                      color={selected ? 'accent' : 'ink'}
                      style={{ fontWeight: selected ? '600' : '400' }}
                    >
                      {reason}
                    </Txt>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Optional Note */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="muted">
              PRIVATE NOTE (OPTIONAL)
            </Txt>
            <TextInput
              value={note}
              onChangeText={setNote}
              placeholder="Why you put it down, or what didn't work..."
              placeholderTextColor={c.muted}
              multiline
              numberOfLines={3}
              accessibilityLabel="Private DNF note"
              style={{
                minHeight: 70,
                paddingHorizontal: space[3],
                paddingVertical: space[2],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.line,
                backgroundColor: c.surface2,
                color: c.ink,
                fontSize: 14,
                textAlignVertical: 'top',
              }}
            />
          </View>

          {/* Optional Rating */}
          <Card style={{ alignItems: 'center', gap: space[2], paddingVertical: space[3] }}>
            <Txt variant="caption" color="muted">
              RATE THIS READ? (OPTIONAL)
            </Txt>
            <Stars value={rating} onChange={(val) => setRating(val)} size={32} />
          </Card>

          {/* Visibility */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="muted">
              VISIBILITY
            </Txt>
            <View style={[sheet.row, { gap: space[2] }]}>
              {(['public', 'followers', 'private'] as const).map((v) => (
                <Pressable
                  key={v}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setVisibility(v);
                  }}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: visibility === v }}
                  accessibilityLabel={`Visibility: ${v}`}
                  style={{
                    flex: 1,
                    minHeight: 38,
                    borderRadius: radius.sm,
                    backgroundColor: visibility === v ? c.surface : c.surface2,
                    borderWidth: 1,
                    borderColor: visibility === v ? c.accent : c.line,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Txt
                    variant="caption"
                    color={visibility === v ? 'ink' : 'muted'}
                    style={{ fontWeight: visibility === v ? '600' : '400' }}
                  >
                    {v.charAt(0).toUpperCase() + v.slice(1)}
                  </Txt>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Primary Action Button */}
          <View style={{ marginTop: space[3] }}>
            <Button
              label={submitting ? 'Saving...' : 'Save & close'}
              variant="primary"
              onPress={handleSaveDnf}
              disabled={submitting}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
