// Deep Link Resolver for Canonical Shelf URLs: /u/:username/shelves/:slug (SH-10, PRD §15.2, §29.1, §35).
// Governed by:
// 1. Resolves human-readable username and shelf slug via API.
// 2. Synthesizes back stack and redirects to canonical shelf detail (/shelf/:id).
// 3. Gracefully handles 404 / private accounts with clear error state.

import React, { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { api } from '@/lib/api';
import { Screen, Button, EmptyState, SkeletonHeader, SkeletonList } from '@/ui/components';
import { useTheme, space } from '@/ui/tokens';

export default function UserShelfDeepLinkScreen() {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { username, slug } = useLocalSearchParams<{ username: string; slug: string }>();

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;

    async function resolveShelf() {
      if (!username || !slug) {
        setError('Invalid shelf link.');
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(null);
        const res = await api.getShelfBySlug(username, slug);
        if (active) {
          // Seamlessly redirect to the shelf detail view
          router.replace(`/shelf/${res.shelf.id}` as any);
        }
      } catch (err: any) {
        if (active) {
          setError(
            err?.status === 404 || err?.code === 'not_found'
              ? 'This shelf does not exist, or it is private'
              : err?.message || 'Could not open this shelf',
          );
          setLoading(false);
        }
      }
    }

    void resolveShelf();

    return () => {
      active = false;
    };
  }, [username, slug, router]);

  if (loading) {
    return (
      <Screen style={{ backgroundColor: c.ground, paddingTop: insets.top + space[3] }}>
        {/* Opening shelf: the shape of the screen, not a spinner (design.md §5) */}
        <SkeletonHeader lead="cover" />
        <SkeletonList rows={5} lead="cover" />
      </Screen>
    );
  }

  return (
    <Screen style={[styles.center, { backgroundColor: c.ground, padding: space[4] }]}>
      {/* What happened, and one way on: no card around it, the page is the frame */}
      <EmptyState
        title="Shelf not available"
        subtitle={error ?? undefined}
        action={
          <Button
            variant="primary"
            label="Browse shelves"
            onPress={() => router.replace('/(tabs)/shelves' as any)}
          />
        }
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
});
