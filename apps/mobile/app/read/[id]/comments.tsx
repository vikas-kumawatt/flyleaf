// Comment thread (SO-22, PRD §6.28).
//
// Comments attach to the READ (PRD §10.3), so this screen serves a review, a
// finish with no review, and a DNF alike. Flat by design: there is no reply
// button, because single-level threads produce conversation and nested ones
// produce arguments. Delete-own only; a removed review turns the thread
// read-only with a tombstone line instead of hiding what was said.

import React, { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  Alert,
  FlatList,
  KeyboardAvoidingView,
  Platform,
  Pressable,
  TextInput,
  View,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, FlyleafApiError, type ReadComment } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useActionGate } from '@/ui/ActionGate';
import { EmptyState, Screen, Txt, sheet } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';
import {
  COMMENT_COUNTER_THRESHOLD,
  COMMENT_MAX_LENGTH,
  commentErrorMessage,
  mergeCommentPages,
  validateCommentBody,
} from '@/lib/comments';

function relativeTime(iso: string): string {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return 'now';
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

export default function CommentThreadScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { id: readId } = useLocalSearchParams<{ id: string }>();

  const [comments, setComments] = useState<ReadComment[]>([]);
  const [count, setCount] = useState(0);
  const [locked, setLocked] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [missing, setMissing] = useState(false);
  const [draft, setDraft] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!readId) return;
    try {
      const res = await api.getReadComments(readId, { limit: 50 });
      setComments(res.comments);
      setCount(res.comment_count);
      setLocked(res.locked);
      setCursor(res.next_cursor);
    } catch {
      setMissing(true);
    } finally {
      setLoading(false);
    }
  }, [readId]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadMore = async () => {
    if (!readId || !cursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const res = await api.getReadComments(readId, { cursor, limit: 50 });
      setComments((prev) => mergeCommentPages(prev, res.comments));
      setCursor(res.next_cursor);
    } catch {
      // Keep what we have; the user can scroll again.
    } finally {
      setLoadingMore(false);
    }
  };

  const post = async () => {
    if (!readId) return;
    if (!user) {
      promptAuth({
        title: 'Sign up to join the conversation',
        subtitle: 'Create a free account to comment on what your friends are reading.',
      });
      return;
    }
    const v = validateCommentBody(draft);
    if (!v.ok) {
      setError(commentErrorMessage(v.reason === 'empty' ? 'empty_body' : 'body_too_long'));
      return;
    }
    setPosting(true);
    setError(null);
    try {
      const created = await api.addReadComment(readId, v.body);
      setComments((prev) => mergeCommentPages(prev, [created]));
      setCount((n) => n + 1);
      setDraft('');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err) {
      const code = err instanceof FlyleafApiError ? err.code : undefined;
      if (code === 'thread_locked') setLocked(true);
      setError(commentErrorMessage(code));
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
    } finally {
      setPosting(false);
    }
  };

  const remove = (comment: ReadComment) => {
    Alert.alert('Delete comment?', 'This can’t be undone.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: async () => {
          const before = comments;
          setComments((prev) => prev.filter((x) => x.id !== comment.id));
          setCount((n) => Math.max(0, n - 1));
          try {
            await api.deleteComment(comment.id);
          } catch {
            setComments(before);
            setCount((n) => n + 1);
            Alert.alert('Couldn’t delete', 'Please try again.');
          }
        },
      },
    ]);
  };

  const remaining = COMMENT_MAX_LENGTH - draft.trim().length;

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      <View
        style={{
          paddingTop: insets.top + space[2],
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
            hitSlop={12}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
          >
            <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
              ← Back
            </Txt>
          </Pressable>
          <View accessibilityRole="header">
            <Txt variant="title" style={{ fontWeight: '700', fontSize: 17 }}>
              {count > 0 ? `Comments · ${count}` : 'Comments'}
            </Txt>
          </View>
          <View style={{ minWidth: 44 }} />
        </View>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={insets.top}
      >
        {loading ? (
          <ActivityIndicator size="large" color={c.accent} style={{ marginTop: space[6] }} />
        ) : missing ? (
          <EmptyState title="Not available" subtitle="This post isn’t available." />
        ) : (
          <FlatList
            data={comments}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ padding: space[4], gap: space[3], flexGrow: 1 }}
            onEndReached={loadMore}
            onEndReachedThreshold={0.4}
            ListHeaderComponent={
              locked ? (
                <View
                  style={{ padding: space[3], borderRadius: radius.md, backgroundColor: c.surface2 }}
                  accessibilityRole="text"
                >
                  <Txt variant="caption" color="muted">
                    This review was removed. Comments are closed.
                  </Txt>
                </View>
              ) : null
            }
            ListEmptyComponent={
              <EmptyState
                title="No comments yet"
                subtitle={locked ? 'Comments are closed.' : 'Say something about this read.'}
              />
            }
            ListFooterComponent={
              loadingMore ? <ActivityIndicator color={c.accent} style={{ marginVertical: space[3] }} /> : null
            }
            renderItem={({ item }) => (
              <View style={{ gap: space[1] }}>
                <View style={sheet.rowBetween}>
                  <Pressable
                    onPress={() => router.push(`/user/${item.author.id}` as any)}
                    accessibilityRole="link"
                    accessibilityLabel={`@${item.author.username}`}
                    style={[sheet.row, { gap: space[2], minHeight: 44 }]}
                  >
                    <Txt variant="caption" style={{ fontWeight: '700' }}>
                      {item.author.display_name ?? item.author.username}
                    </Txt>
                    <Txt variant="micro" color="muted">
                      @{item.author.username} · {relativeTime(item.created_at)}
                    </Txt>
                  </Pressable>
                  {item.viewer_can_delete && (
                    <Pressable
                      onPress={() => remove(item)}
                      accessibilityRole="button"
                      accessibilityLabel="Delete your comment"
                      hitSlop={12}
                      style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}
                    >
                      <Txt variant="micro" color="muted">
                        Delete
                      </Txt>
                    </Pressable>
                  )}
                </View>
                <Txt variant="body">{item.body}</Txt>
              </View>
            )}
          />
        )}

        {!missing && !locked && (
          <View
            style={{
              borderTopWidth: 1,
              borderTopColor: c.line,
              padding: space[3],
              paddingBottom: insets.bottom + space[3],
              gap: space[2],
              backgroundColor: c.ground,
            }}
          >
            {error ? (
              <View accessibilityLiveRegion="polite">
                <Txt variant="caption" color="critical">
                  {error}
                </Txt>
              </View>
            ) : null}
            <View style={[sheet.row, { gap: space[2], alignItems: 'flex-end' }]}>
              <TextInput
                value={draft}
                onChangeText={(t) => {
                  setDraft(t);
                  if (error) setError(null);
                }}
                placeholder={user ? 'Add a comment…' : 'Sign up to comment'}
                placeholderTextColor={c.muted}
                multiline
                maxLength={COMMENT_MAX_LENGTH + 200}
                accessibilityLabel="Comment"
                style={{
                  flex: 1,
                  minHeight: 44,
                  maxHeight: 140,
                  paddingHorizontal: space[3],
                  paddingVertical: space[2],
                  borderRadius: radius.md,
                  borderWidth: 1,
                  borderColor: c.line,
                  backgroundColor: c.surface,
                  color: c.ink,
                  fontSize: 15,
                }}
              />
              <Pressable
                onPress={post}
                disabled={posting}
                accessibilityRole="button"
                accessibilityLabel="Post comment"
                style={{
                  minHeight: 44,
                  minWidth: 64,
                  paddingHorizontal: space[3],
                  borderRadius: radius.md,
                  backgroundColor: c.accent,
                  alignItems: 'center',
                  justifyContent: 'center',
                  opacity: posting || !draft.trim() ? 0.5 : 1,
                }}
              >
                {posting ? (
                  <ActivityIndicator color={c.ground} />
                ) : (
                  <Txt variant="caption" color="ground" style={{ fontWeight: '700' }}>
                    Post
                  </Txt>
                )}
              </Pressable>
            </View>
            {draft.trim().length >= COMMENT_COUNTER_THRESHOLD && (
              <Txt variant="micro" color={remaining < 0 ? 'critical' : 'muted'} tabular>
                {remaining.toLocaleString()} characters left
              </Txt>
            )}
          </View>
        )}
      </KeyboardAvoidingView>
    </Screen>
  );
}
