// Deep Link Resolver for Canonical Shelf URLs: /u/:username/shelves/:slug (SH-10, PRD §15.2, §29.1, §35).
// Governed by:
// 1. Resolves human-readable username and shelf slug via API.
// 2. Synthesizes back stack and redirects to canonical shelf detail (/shelf/:id).
// 3. Gracefully handles 404 / private accounts with clear error state.

import React, { useEffect, useState } from 'react';
import { View, ActivityIndicator, StyleSheet, Pressable } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import { api } from '@/lib/api';
import { Screen, Txt, Button } from '@/ui/components';
import { useTheme, space, radius } from '@/ui/tokens';

export default function UserShelfDeepLinkScreen() {
  const c = useTheme();
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
              ? 'This shelf could not be found or is private.'
              : err?.message || 'Unable to open shelf.',
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
      <Screen style={[styles.center, { backgroundColor: c.ground }]}>
        <ActivityIndicator size="large" color={c.accent} />
        <Txt style={{ color: c.muted, marginTop: space[3] }}>Opening shelf...</Txt>
      </Screen>
    );
  }

  return (
    <Screen style={[styles.center, { backgroundColor: c.ground, padding: space[4] }]}>
      <View style={[styles.errorCard, { backgroundColor: c.surface, borderColor: c.line }]}>
        <Ionicons name="book-outline" size={48} color={c.muted} style={{ marginBottom: space[2] }} />
        <Txt variant="title" style={{ color: c.ink, textAlign: 'center', marginBottom: space[2] }}>
          Shelf Not Available
        </Txt>
        <Txt style={{ color: c.muted, textAlign: 'center', marginBottom: space[4] }}>
          {error}
        </Txt>
        <Button
          variant="primary"
          label="Explore Shelves"
          onPress={() => router.replace('/(tabs)/shelves' as any)}
          style={{ width: '100%' }}
        />
      </View>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  errorCard: {
    width: '100%',
    maxWidth: 400,
    padding: space[6],
    borderRadius: radius.lg,
    borderWidth: 1,
    alignItems: 'center',
  },
});
