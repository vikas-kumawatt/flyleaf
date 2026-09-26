// Review Composer Modal Screen (SL-63, PRD §6.27, §10.6).
//
// Governed by:
//   1. Local draft autosaved every 3 seconds to expo-secure-store and restored on mount.
//   2. Spoiler toggle with optional "spoilers after page N".
//   3. Visibility selector (Public · Followers · Private).
//   4. Soft character limit warning at 5,000, hard cap at 10,000.
//   5. Post error never loses text — inline retry and draft preserved.
//   6. Independent Heart affection and Half-star Rating row.

import React, { useState, useEffect, useRef } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  KeyboardAvoidingView,
  Platform,
  Alert,
  Switch,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as SecureStore from 'expo-secure-store';
import * as Haptics from 'expo-haptics';
import { api, type Work } from '@/lib/api';
import { useDatabase } from '@/offline/db';
import { OfflineRepository } from '@/offline/repository';
import { useSession } from '@/lib/session';
import type { LocalRead } from '@/offline/schema';
import { budgetTracker } from '@/lib/budgetTracker';
import { Button, Card, Cover, Heart, Screen, SegmentedControl, Stars, Txt, sheet } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function ReviewComposerScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const db = useDatabase();
  const { user } = useSession();
  const { id } = useLocalSearchParams<{ id: string }>(); // read_id or work_id

  const [read, setRead] = useState<LocalRead | null>(null);
  const [work, setWork] = useState<Work | null>(null);
  const [loading, setLoading] = useState(true);

  // Form State
  const [body, setBody] = useState('');
  const [rating, setRating] = useState<number | null>(null);
  const [hearted, setHearted] = useState(false);
  const [hasSpoilers, setHasSpoilers] = useState(false);
  const [spoilerAfterPage, setSpoilerAfterPage] = useState('');
  const [visibility, setVisibility] = useState<'public' | 'followers' | 'private'>('public');
  const [submitting, setSubmitting] = useState(false);
  const [draftSavedToast, setDraftSavedToast] = useState(false);
  const submittingRef = useRef(false);
  const bodyRef = useRef(body);
  bodyRef.current = body;

  const draftKey = `review_draft_${id}`;
  const autosaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // §4.4 Finish & review budget tracking
  useEffect(() => {
    if (id) {
      budgetTracker.startFinishFlow(id);
    }
    return () => {
      if (!submittingRef.current && id) {
        budgetTracker.recordFinishAbandoned(id, {
          stage: bodyRef.current.trim().length > 0 ? 'review' : 'rating',
        });
      }
    };
  }, [id]);

  // 1. Load book & read info
  useEffect(() => {
    let mounted = true;
    async function loadData() {
      try {
        if (db && id && user) {
          const repo = new OfflineRepository(db, user.id);
          const reads = await repo.getLocalReads();
          const found = reads.find((r) => r.id === id || r.work_id === id);
          if (found && mounted) {
            setRead(found);
            if (found.rating) setRating(found.rating);
            if (found.hearted) setHearted(true);
          }
        }

        // Fetch work metadata for cover & title if not in local read
        if (id) {
          const w = await api.work(read?.work_id ?? id).catch(() => null);
          if (w && mounted) {
            setWork(w);
            if (!read && w.your_read) {
              if (w.your_read.rating) setRating(w.your_read.rating);
              if (w.your_read.hearted) setHearted(true);
            }
          }
        }

        // Restore draft from secure store (PRD §6.27, §10.6)
        try {
          const savedDraft = await SecureStore.getItemAsync(draftKey);
          if (savedDraft && mounted) {
            const parsed = JSON.parse(savedDraft);
            if (typeof parsed === 'string') {
              setBody(parsed);
            } else if (parsed && typeof parsed === 'object') {
              if (parsed.body) setBody(parsed.body);
              if (parsed.hasSpoilers !== undefined) setHasSpoilers(parsed.hasSpoilers);
              if (parsed.spoilerAfterPage) setSpoilerAfterPage(String(parsed.spoilerAfterPage));
              if (parsed.visibility) setVisibility(parsed.visibility);
              if (parsed.rating !== undefined) setRating(parsed.rating);
              if (parsed.hearted !== undefined) setHearted(parsed.hearted);
            }
          }
        } catch {
          // Ignore secure store errors
        }
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadData();
    return () => {
      mounted = false;
    };
  }, [id, db, draftKey]);

  // 2. Autosave draft every 3 seconds (PRD §6.27, §10.6)
  useEffect(() => {
    if (!body && !rating && !hearted && !hasSpoilers) return;
    if (autosaveTimer.current) clearTimeout(autosaveTimer.current);

    autosaveTimer.current = setTimeout(async () => {
      try {
        const payload = JSON.stringify({
          body,
          hasSpoilers,
          spoilerAfterPage: spoilerAfterPage ? parseInt(spoilerAfterPage, 10) : null,
          visibility,
          rating,
          hearted,
        });
        await SecureStore.setItemAsync(draftKey, payload);
        setDraftSavedToast(true);
        setTimeout(() => setDraftSavedToast(false), 1500);
      } catch {
        // Ignore autosave failure
      }
    }, 3000);

    return () => {
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
    };
  }, [body, hasSpoilers, spoilerAfterPage, visibility, rating, hearted, draftKey]);

  // 3. Post review handler
  const handlePost = async () => {
    const trimmed = body.trim();
    if (!trimmed) {
      Alert.alert('Review needed', 'Please write a few thoughts before posting.');
      return;
    }
    if (trimmed.length > 10000) {
      Alert.alert('Too long', 'Reviews are capped at 10,000 characters.');
      return;
    }

    setSubmitting(true);
    try {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);

      const targetReadId = read?.id ?? id;
      const reviewPayload = {
        body: trimmed,
        has_spoilers: hasSpoilers,
        spoiler_after_page: spoilerAfterPage ? parseInt(spoilerAfterPage, 10) : null,
        visibility,
        rating,
        hearted,
      };

      if (db && user) {
        // Save via offline repository with persistent mutation queue replay
        const repo = new OfflineRepository(db, user.id);
        await repo.saveReview(targetReadId, reviewPayload);
      } else {
        await api.client.createReview(targetReadId, reviewPayload);
      }

      // Clear draft on successful post
      await SecureStore.deleteItemAsync(draftKey).catch(() => {});

      submittingRef.current = true;
      budgetTracker.recordFinishCompleted(targetReadId, {
        hadRating: rating != null,
        hadReview: trimmed.length > 0,
        hearted,
        format: read?.format_override,
        pageCount: read?.page_count,
      });

      router.back();
    } catch (err: any) {
      Alert.alert('Error', err?.message || 'Could not post review. Your draft has been preserved.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleCancel = () => {
    if (body.trim().length > 0) {
      Alert.alert(
        'Save draft?',
        'Your draft is saved and will be restored when you come back.',
        [
          { text: 'Discard', style: 'destructive', onPress: async () => {
            await SecureStore.deleteItemAsync(draftKey).catch(() => {});
            router.back();
          }},
          { text: 'Keep Draft & Exit', onPress: () => router.back() },
          { text: 'Continue Writing', style: 'cancel' },
        ],
      );
    } else {
      router.back();
    }
  };

  const charCount = body.length;
  const isWarning = charCount >= 5000;
  const isOver = charCount > 10000;

  const displayTitle = read?.title ?? work?.title ?? 'Review';
  const displayAuthor = read?.author_name ?? work?.author_name ?? '';
  const displayCoverId = read?.cover_id ?? work?.cover_id;

  return (
    <Screen>
      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
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
            onPress={handleCancel}
            accessibilityRole="button"
            accessibilityLabel="Close composer"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          >
            <Txt variant="body" color="muted">
              Cancel
            </Txt>
          </Pressable>

          <View style={{ alignItems: 'center' }}>
            <Txt variant="body" style={{ fontWeight: '600' }}>
              Write Review
            </Txt>
            {draftSavedToast && (
              <Txt variant="micro" color="accent">
                Draft autosaved
              </Txt>
            )}
          </View>

          <Button
            label="Post"
            variant="primary"
            onPress={handlePost}
            loading={submitting}
            disabled={submitting || body.trim().length === 0 || isOver}
          />
        </View>

        <ScrollView
          contentContainerStyle={{
            padding: space[4],
            gap: space[4],
            paddingBottom: space[12],
          }}
          keyboardShouldPersistTaps="handled"
        >
          {/* 1. Book Context Strip */}
          <Card style={{ flexDirection: 'row', alignItems: 'center', gap: space[3] }}>
            <Cover
              coverId={displayCoverId}
              title={displayTitle}
              author={displayAuthor}
              size="s"
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="title" numberOfLines={2}>
                {displayTitle}
              </Txt>
              {displayAuthor ? (
                <Txt variant="caption" color="muted">
                  {displayAuthor}
                </Txt>
              ) : null}
            </View>
          </Card>

          {/* 2. Rating & Heart Row (SL-60, SL-61) */}
          <Card style={{ gap: space[2] }}>
            <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
              RATING & AFFECTION
            </Txt>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Stars
                value={rating}
                onChange={(val) => {
                  setRating(val);
                }}
                size={34}
              />
              <Heart
                hearted={hearted}
                onToggle={() => setHearted((h) => !h)}
                size={32}
              />
            </View>
          </Card>

          {/* 3. Review Body Input with character counter */}
          <Card style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
                YOUR REVIEW
              </Txt>
              <Txt
                variant="micro"
                color={isOver ? 'critical' : isWarning ? 'accent' : 'muted'}
                tabular
              >
                {charCount.toLocaleString()} / 10,000
              </Txt>
            </View>

            <TextInput
              value={body}
              onChangeText={setBody}
              placeholder="Write your thoughts... What resonated? What lingered?"
              placeholderTextColor={c.muted}
              multiline
              textAlignVertical="top"
              style={{
                minHeight: 180,
                fontSize: 16,
                lineHeight: 24,
                color: c.ink,
                fontFamily: Platform.OS === 'ios' ? 'System' : 'normal',
              }}
              accessibilityLabel="Review text body"
            />
          </Card>

          {/* 4. Spoiler Gate (PRD §6.27, §10.6) */}
          <Card style={{ gap: space[3] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <View style={{ flex: 1, gap: 2 }}>
                <Txt variant="body" style={{ fontWeight: '600' }}>
                  Contains spoilers
                </Txt>
                <Txt variant="caption" color="muted">
                  Hides review text behind a tap-to-reveal gate for readers.
                </Txt>
              </View>
              <Switch
                value={hasSpoilers}
                onValueChange={(val) => {
                  void Haptics.selectionAsync();
                  setHasSpoilers(val);
                }}
                trackColor={{ false: c.surface2, true: c.accent }}
              />
            </View>

            {hasSpoilers && (
              <View
                style={{
                  borderTopWidth: 1,
                  borderTopColor: c.line,
                  paddingTop: space[3],
                  flexDirection: 'row',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                }}
              >
                <Txt variant="caption" color="muted">
                  Spoilers start after page (optional):
                </Txt>
                <TextInput
                  value={spoilerAfterPage}
                  onChangeText={(txt) => setSpoilerAfterPage(txt.replace(/[^0-9]/g, ''))}
                  placeholder="e.g. 150"
                  placeholderTextColor={c.muted}
                  keyboardType="number-pad"
                  style={{
                    borderWidth: 1,
                    borderColor: c.line,
                    borderRadius: radius.sm,
                    paddingHorizontal: space[3],
                    paddingVertical: space[1],
                    color: c.ink,
                    width: 90,
                    textAlign: 'center',
                    backgroundColor: c.surface2,
                  }}
                />
              </View>
            )}
          </Card>

          {/* 5. Visibility Selector (PRD §10.5) */}
          <Card style={{ gap: space[3] }}>
            <Txt variant="caption" color="muted" style={{ fontWeight: '600' }}>
              VISIBILITY
            </Txt>
            <SegmentedControl
              values={['public', 'followers', 'private'] as const}
              selected={visibility}
              onSelect={setVisibility}
              labels={{
                public: 'Public',
                followers: 'Followers',
                private: 'Private',
              }}
            />
            <Txt variant="micro" color="muted">
              {visibility === 'public'
                ? 'Visible to anyone on book pages and reader feeds.'
                : visibility === 'followers'
                ? 'Visible only to accounts that follow you.'
                : 'Private to you. Never shown on feeds or public book pages.'}
            </Txt>
          </Card>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}
