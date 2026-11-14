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
  Alert,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { requestMilestoneCheck } from '@/lib/milestones';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import { useSession } from '@/lib/session';
import type { LocalRead } from '@/offline/schema';
import { budgetTracker } from '@/lib/budgetTracker';
import { localDate } from '@/lib/readingRules';
import { Button, Chip, Cover, Heart, Screen, Skeleton, Stars, Txt, sheet } from '@/ui/components';
import { radius, space, type, useTheme } from '@/ui/tokens';
import { Ionicons } from '@expo/vector-icons';

export default function FinishScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const db = useDatabase();
  const { user } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [read, setRead] = useState<LocalRead | null>(null);
  const [loading, setLoading] = useState(true);

  // Form State
  const [rating, setRating] = useState<number | null>(null);
  const [hearted, setHearted] = useState(false);
  const [format, setFormat] = useState<'print' | 'ebook' | 'audiobook'>('print');
  // The reader's today, not UTC's (PRD §8.5, audit 08).
  const [finishedAt, setFinishedAt] = useState(() => localDate());
  const [review, setReview] = useState('');
  const [hasSpoilers, setHasSpoilers] = useState(false);
  const [visibility, setVisibility] = useState<'public' | 'followers' | 'private'>('public');
  const [reviewExpanded, setReviewExpanded] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const submittingRef = useRef(false);
  const reviewRef = useRef(review);
  reviewRef.current = review;

  const draftKey = `draft_review_${id}`;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // §4.4 Finish flow budget tracking: start timestamp and abandonment check
  useEffect(() => {
    if (id) {
      budgetTracker.startFinishFlow(id);
    }
    return () => {
      if (!submittingRef.current && id) {
        budgetTracker.recordFinishAbandoned(id, {
          stage: reviewRef.current.trim().length > 0 ? 'review' : 'rating',
        });
      }
    };
  }, [id]);

  // Load read record from SQLite
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
    if (submitting || !db || !user) return;

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
      const repo = new OfflineRepository(db, user.id);
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

      submittingRef.current = true;
      budgetTracker.recordFinishCompleted(readId, {
        hadRating: rating != null,
        hadReview: review.trim().length > 0,
        hearted,
        format,
        pageCount: read?.page_count,
      });

      // ST-10: a milestone, or "longest book yet", once this finish has synced.
      requestMilestoneCheck(readId);
      router.back();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not finish read.');
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
          accessibilityLabel="Close finish flow"
          style={{ minHeight: 44, minWidth: 64, justifyContent: 'center' }}
        >
          <Txt variant="body" color="ink2">
            Cancel
          </Txt>
        </Pressable>

        <Txt variant="title">Finished</Txt>

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
          {/* Cover and title */}
          <View style={{ alignItems: 'center', gap: space[3], marginTop: space[2] }}>
            <Cover
              coverId={read?.cover_id}
              title={read?.title ?? 'Book'}
              author={read?.author_name ?? ''}
              size="l"
            />
            {loading ? (
              <View
                style={{ alignItems: 'center', gap: space[2] }}
                accessible
                accessibilityLabel="Loading"
                accessibilityState={{ busy: true }}
              >
                <Skeleton width={200} height={24} />
                <Skeleton width={120} height={16} />
              </View>
            ) : (
              <View style={{ alignItems: 'center', gap: space[1] }}>
                <Txt variant="displayM" style={{ textAlign: 'center' }}>
                  {read?.title ?? 'This book'}
                </Txt>
                <Txt variant="caption" color="muted" style={{ textAlign: 'center' }}>
                  {read?.author_name ?? ''}
                  {read && read.attempt_no > 1 ? ` · Re-read ${read.attempt_no}` : ''}
                </Txt>
              </View>
            )}
          </View>

          {/* Rating and heart: visible and interactive straight away */}
          <View style={{ alignItems: 'center', gap: space[2] }}>
            <Txt variant="micro" color="muted">
              Tap to rate, if you like
            </Txt>

            <View style={[sheet.row, { gap: space[3], justifyContent: 'center' }]}>
              <Stars value={rating} onChange={(val) => setRating(val)} size={40} />
              <Heart hearted={hearted} onToggle={() => setHearted(!hearted)} size={32} />
            </View>

            {rating !== null && (
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  setRating(null);
                }}
                accessibilityRole="button"
                accessibilityLabel="Clear rating"
                style={{ minHeight: 44, justifyContent: 'center', paddingHorizontal: space[3] }}
              >
                <Txt variant="caption" color="ink2">
                  Clear rating
                </Txt>
              </Pressable>
            )}
          </View>

          {/* Format chips */}
          <View style={{ gap: space[2] }}>
            <Txt variant="micro" color="ink2">
              Format
            </Txt>
            <View style={[sheet.row, { gap: space[2], flexWrap: 'wrap' }]}>
              {(['print', 'ebook', 'audiobook'] as const).map((fmt) => {
                const label = fmt === 'audiobook' ? 'Audio' : fmt === 'ebook' ? 'Ebook' : 'Print';
                return (
                  <Chip
                    key={fmt}
                    label={label}
                    selected={format === fmt}
                    accessibilityLabel={`Format: ${label}`}
                    role="radio"
                    onPress={() => setFormat(fmt)}
                  />
                );
              })}
            </View>
          </View>

          {/* Finish date */}
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
              <Txt variant="micro" color="ink2">
                Finished on
              </Txt>
              {read?.started_at && (
                <Txt variant="micro" color="muted" tabular>
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
              style={inputStyle}
            />
          </View>

          {/* Review field: one tap away */}
          <View style={{ gap: space[2] }}>
            {!reviewExpanded ? (
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  setReviewExpanded(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Add a review"
                style={[inputStyle, { justifyContent: 'center' }]}
              >
                <View style={[sheet.row, { gap: space[2] }]}>
                  <Ionicons name="create-outline" size={18} color={c.muted} />
                  <Txt variant="body" color="muted">
                    Add a review or notes
                  </Txt>
                </View>
              </Pressable>
            ) : (
              <View style={{ gap: space[3] }}>
                <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
                  <Txt variant="micro" color="ink2">
                    Review, saved as you type
                  </Txt>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setHasSpoilers(!hasSpoilers);
                    }}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: hasSpoilers }}
                    accessibilityLabel="Contains spoilers"
                    style={[sheet.row, { gap: space[1], minHeight: 44 }]}
                  >
                    <Ionicons
                      name={hasSpoilers ? 'alert-circle' : 'alert-circle-outline'}
                      size={16}
                      color={hasSpoilers ? c.ink : c.muted}
                    />
                    <Txt variant="caption" color={hasSpoilers ? 'ink' : 'muted'}>
                      {hasSpoilers ? 'Contains spoilers' : 'Mark spoilers'}
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
                  style={[
                    inputStyle,
                    {
                      minHeight: 120,
                      paddingVertical: space[3],
                      ...type.bodyL,
                      textAlignVertical: 'top',
                    },
                  ]}
                />

                {/* Visibility selector */}
                <View style={{ gap: space[2] }}>
                  <Txt variant="micro" color="ink2">
                    Visible to
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
              </View>
            )}
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
            label={submitting ? 'Saving…' : 'Done'}
            variant="primary"
            onPress={handleFinish}
            disabled={submitting}
          />
        </View>
      </KeyboardAvoidingView>
    </Screen>
  );
}
