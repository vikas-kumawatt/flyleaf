// Finish Flow Modal Screen (SL-54, PRD §6.17, §9.3, §9.4).
//
// Governed by:
//   1. Under 20 seconds completion budget (p75 < 20s).
//   2. Stars already visible and interactive (half-step support).
//   3. Heart affection independent of rating.
//   4. Format chips (Print · Ebook · Audio).
//   5. Collapsible review composer with draft autosave every 3s.
//   6. Atomic single-call finish write to SQLite & sync queue.

import React, { useState, useEffect, useRef } from 'react';
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
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import type { LocalRead } from '@/offline/schema';
import { Button, Card, Cover, Heart, Screen, Stars, Txt, sheet } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function FinishScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const db = useDatabase();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [read, setRead] = useState<LocalRead | null>(null);
  const [loading, setLoading] = useState(true);

  // Form State
  const [rating, setRating] = useState<number | null>(null);
  const [hearted, setHearted] = useState(false);
  const [format, setFormat] = useState<'print' | 'ebook' | 'audiobook'>('print');
  const [finishedAt, setFinishedAt] = useState(() => new Date().toISOString().slice(0, 10));
  const [review, setReview] = useState('');
  const [hasSpoilers, setHasSpoilers] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'followers' | 'private'>('public');
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  const draftKey = `draft_review_${id}`;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Load read record from SQLite
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
          if (found.rating) setRating(found.rating);
          if (found.hearted) setHearted(true);
          if (found.format_override) setFormat(found.format_override as any);

          // Restore draft review if exists
          try {
            const draft = await SecureStore.getItemAsync(draftKey);
            if (draft && mounted) {
              setReview(draft);
              setReviewExpanded(true);
            }
          } catch {
            // Ignore secure store read failure
          }
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }
    load();
    return () => {
      mounted = false;
    };
  }, [id, db, draftKey]);

  // Autosave review draft every 3s (PRD §6.17)
  useEffect(() => {
    if (!review) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    autosaveTimer.current = setTimeout(() => {
      void SecureStore.setItemAsync(draftKey, review).catch(() => {});
    }, 3000);
    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [review, draftKey]);

  const handleFinish = async () => {
    if (submitting || !db) return;

    // Validate dates
    if (read?.started_at && finishedAt < read.started_at) {
      Alert.alert(
        'Check finish date',
        `Finish date (${finishedAt}) cannot be earlier than the started date (${read.started_at}).`,
      );
      return;
    }

    setSubmitting(true);
    try {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      const repo = new OfflineRepository(db);
      const readId = read?.id ?? (id as string);

      await repo.finishRead(readId, {
        finishedAt,
        rating,
        hearted,
        formatOverride: format,
        review: review.trim() || null,
        visibility,
      });

      // Clear draft
      await SecureStore.deleteItemAsync(draftKey).catch(() => {});

      router.back();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not finish read.');
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
          accessibilityLabel="Close finish flow"
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Txt variant="body" color="muted">
            Cancel
          </Txt>
        </Pressable>

        <Txt variant="title">Finished!</Txt>

        <Pressable
          onPress={handleFinish}
          disabled={submitting}
          accessibilityRole="button"
          accessibilityLabel="Done"
          style={{ minHeight: 44, justifyContent: 'center' }}
        >
          <Txt variant="body" color="accent" style={{ fontWeight: '700' }}>
            Done
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
          {/* Hero Celebration Card */}
          <View style={{ alignItems: 'center', gap: space[3], marginTop: space[2] }}>
            <Cover
              coverId={read?.cover_id}
              title={read?.title ?? 'Book'}
              author={read?.author_name ?? ''}
              size="l"
            />
            <View style={{ alignItems: 'center', gap: space[1] }}>
              <Txt variant="title" style={{ textAlign: 'center', fontSize: 22 }}>
                You finished {read?.title ?? 'this book'}!
              </Txt>
              <Txt variant="caption" color="muted">
                {read?.author_name ?? ''}
                {read && read.attempt_no > 1 ? ` · Re-read #${read.attempt_no}` : ''}
              </Txt>
            </View>
          </View>

          {/* Rating & Heart Row (Immediately visible and interactive) */}
          <Card style={{ alignItems: 'center', gap: space[3], paddingVertical: space[4] }}>
            <Txt variant="caption" color="muted">
              TAP TO RATE (OPTIONAL)
            </Txt>

            <View style={[sheet.row, { gap: space[4], alignItems: 'center' }]}>
              <Stars value={rating} onChange={(val) => setRating(val)} size={38} />
              <Heart hearted={hearted} onToggle={() => setHearted(!hearted)} size={34} />
            </View>

            {rating !== null && (
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  setRating(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Clear rating"
              >
                <Txt variant="caption" color="muted">
                  Clear rating
                </Txt>
              </Pressable>
            )}
          </Card>

          {/* Format Chips (Print · Ebook · Audio) */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="muted">
              FORMAT READ
            </Txt>
            <View style={[sheet.row, { gap: space[2] }]}>
              {(['print', 'ebook', 'audiobook'] as const).map((fmt) => {
                const selected = format === fmt;
                const label = fmt === 'audiobook' ? 'Audio' : fmt === 'ebook' ? 'Ebook' : 'Print';
                return (
                  <Pressable
                    key={fmt}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setFormat(fmt);
                    }}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    accessibilityLabel={`Format: ${label}`}
                    style={{
                      flex: 1,
                      minHeight: 40,
                      borderRadius: radius.sm,
                      backgroundColor: selected ? c.accentSoft : c.surface2,
                      borderWidth: 1,
                      borderColor: selected ? c.accent : c.line,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Txt
                      variant="caption"
                      color={selected ? 'accent' : 'ink'}
                      style={{ fontWeight: selected ? '700' : '400' }}
                    >
                      {label}
                    </Txt>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Finish Date */}
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="micro" color="muted">
                FINISH DATE
              </Txt>
              {read?.started_at && (
                <Txt variant="micro" color="muted">
                  Started {read.started_at}
                </Txt>
              )}
            </View>
            <TextInput
              value={finishedAt}
              onChangeText={setFinishedAt}
              placeholder="YYYY-MM-DD"
              placeholderTextColor={c.muted}
              accessibilityLabel="Finish date YYYY-MM-DD"
              style={{
                minHeight: 44,
                paddingHorizontal: space[3],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.line,
                backgroundColor: c.surface2,
                color: c.ink,
                fontSize: 15,
              }}
            />
          </View>

          {/* Review Field (Collapsed by default, expands on tap) */}
          <View style={{ gap: space[2] }}>
            {!reviewExpanded ? (
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  setReviewExpanded(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Add a review"
                style={{
                  minHeight: 48,
                  paddingHorizontal: space[3],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: c.line,
                  backgroundColor: c.surface2,
                  justifyContent: 'center',
                }}
              >
                <Txt variant="body" color="muted">
                  + Add a review or notes (optional)
                </Txt>
              </Pressable>
            ) : (
              <View style={{ gap: space[3] }}>
                <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                  <Txt variant="micro" color="muted">
                    REVIEW (AUTOSAVED)
                  </Txt>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setHasSpoilers(!hasSpoilers);
                    }}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: hasSpoilers }}
                    accessibilityLabel="Contains spoilers"
                  >
                    <Txt variant="caption" color={hasSpoilers ? 'critical' : 'muted'}>
                      {hasSpoilers ? '⚠ Contains spoilers' : 'Mark spoilers'}
                    </Txt>
                  </Pressable>
                </View>

                <TextInput
                  value={review}
                  onChangeText={setReview}
                  placeholder="What did you think? No pressure to be profound."
                  placeholderTextColor={c.muted}
                  multiline
                  numberOfLines={4}
                  autoFocus
                  accessibilityLabel="Review text"
                  style={{
                    minHeight: 90,
                    paddingHorizontal: space[3],
                    paddingVertical: space[2],
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: c.line,
                    backgroundColor: c.surface2,
                    color: c.ink,
                    fontSize: 15,
                    textAlignVertical: 'top',
                  }}
                />

                {/* Visibility selector */}
                <View style={[sheet.row, { gap: space[2] }]}>
                  <Txt variant="micro" color="muted">
                    VISIBILITY:
                  </Txt>
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
                        paddingHorizontal: space[2],
                        paddingVertical: 4,
                        borderRadius: radius.sm,
                        backgroundColor: visibility === v ? c.surface : 'transparent',
                        borderWidth: visibility === v ? 1 : 0,
                        borderColor: c.line,
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
            )}
          </View>

          {/* Primary Action Button */}
          <View style={{ marginTop: space[4], gap: space[2] }}>
            <Button
              label={submitting ? 'Saving...' : 'Done'}
              variant="primary"
              onPress={handleFinish}
              disabled={submitting}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
