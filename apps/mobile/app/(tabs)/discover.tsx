// Tab 3 — Discover (Search + Browse, PRD §5.2, design.md §10).
//
// Entry point for finding books, authors, and recommendations.
// Debounced 250ms query input, list rows at coverS.

import React, { useState, useEffect } from 'react';
import { FlatList, Pressable, TextInput, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api, type Work } from '@/lib/api';
import { Cover, EmptyState, Screen, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function DiscoverScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Work[]>([]);
  const [loading, setLoading] = useState(false);

  // 250ms debounce per design.md & PRD §14.4
  useEffect(() => {
    if (q.trim().length < 2) {
      setResults([]);
      return;
    }
    const timer = setTimeout(async () => {
      setLoading(true);
      try {
        setResults(await api.search(q));
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [q]);

  return (
    <Screen>
      {/* Search Header */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          gap: space[3],
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <Txt variant="displayM">Discover</Txt>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: c.surface,
            borderRadius: 12,
            borderWidth: 1,
            borderColor: c.line,
            paddingHorizontal: space[3],
            minHeight: 48,
          }}
        >
          <Ionicons name="search-outline" size={20} color={c.muted} style={{ marginRight: space[2] }} />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search books, authors, or ISBN"
            placeholderTextColor={c.muted}
            autoCorrect={false}
            autoCapitalize="none"
            returnKeyType="search"
            accessibilityLabel="Search books or authors"
            style={{
              flex: 1,
              color: c.ink,
              fontSize: 15,
              minHeight: 44,
            }}
          />
          {q.length > 0 && (
            <Pressable onPress={() => setQ('')} accessibilityLabel="Clear search">
              <Ionicons name="close-circle" size={18} color={c.muted} />
            </Pressable>
          )}
        </View>
      </View>

      {/* Results / Empty Browse State */}
      <FlatList
        contentContainerStyle={{ padding: space[4], paddingBottom: space[12] }}
        data={results}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ListEmptyComponent={
          loading ? null : q.trim().length < 2 ? (
            <View style={{ gap: space[6], paddingTop: space[4] }}>
              <Txt variant="micro" color="muted">
                BROWSE GENRES & THEMES
              </Txt>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                {['Fiction', 'Sci-Fi & Fantasy', 'Non-Fiction', 'Classics', 'Memoir', 'Mystery', 'Poetry'].map(
                  (genre) => (
                    <Pressable
                      key={genre}
                      onPress={() => setQ(genre)}
                      style={{
                        paddingHorizontal: space[4],
                        paddingVertical: space[2],
                        borderRadius: 999,
                        backgroundColor: c.surface2,
                        borderWidth: 1,
                        borderColor: c.line,
                      }}
                    >
                      <Txt variant="body" color="ink">
                        {genre}
                      </Txt>
                    </Pressable>
                  ),
                )}
              </View>
            </View>
          ) : (
            <EmptyState
              title={`Nothing for "${q}"`}
              subtitle="Try searching with a different spelling or author name."
            />
          )
        }
        ItemSeparatorComponent={() => <View style={{ height: space[3] }} />}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => router.push(`/work/${item.id}`)}
            style={sheet.rowTop}
            accessibilityRole="button"
            accessibilityLabel={`${item.title} by ${item.author_name}`}
          >
            <Cover
              coverId={item.cover_id}
              title={item.title}
              author={item.author_name}
              size="s"
            />
            <View style={{ flex: 1, gap: 2 }}>
              <Txt variant="title" numberOfLines={2}>
                {item.title}
              </Txt>
              <Txt variant="caption" color="muted">
                {item.author_name}
              </Txt>
              {item.first_publish_year ? (
                <Txt variant="caption" color="muted">
                  {item.first_publish_year}
                </Txt>
              ) : null}
            </View>
          </Pressable>
        )}
      />
    </Screen>
  );
}
