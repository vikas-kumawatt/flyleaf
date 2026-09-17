// "Log a book" modal triggered by the central FAB (+) (PRD §5.2, SL-01).
//
// Allows quick search to log a read, update progress, or scan a barcode.

import React, { useState } from 'react';
import { View, TextInput, Pressable, FlatList } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import { api, type Work } from '@/lib/api';
import { Button, Cover, Screen, Txt, sheet } from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function LogScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Work[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (text: string) => {
    setQ(text);
    if (text.trim().length < 2) {
      setResults([]);
      return;
    }
    setLoading(true);
    try {
      setResults(await api.search(text));
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <Screen>
      {/* Modal Header */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          gap: space[3],
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayM">Log a book</Txt>
          <Pressable
            onPress={() => router.back()}
            accessibilityRole="button"
            accessibilityLabel="Close"
            style={{ width: 40, height: 40, alignItems: 'center', justifyContent: 'center' }}
          >
            <Ionicons name="close" size={24} color={c.ink} />
          </Pressable>
        </View>

        {/* Quick Search Input */}
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
          <Ionicons
            name="search-outline"
            size={20}
            color={c.muted}
            style={{ marginRight: space[2] }}
          />
          <TextInput
            value={q}
            onChangeText={handleSearch}
            placeholder="Search title, author, or ISBN"
            placeholderTextColor={c.muted}
            autoFocus
            autoCorrect={false}
            autoCapitalize="none"
            style={{ flex: 1, color: c.ink, fontSize: 15, minHeight: 44 }}
          />
        </View>
      </View>

      <FlatList
        contentContainerStyle={{ padding: space[4], paddingBottom: space[8] }}
        data={results}
        keyExtractor={(item) => item.id}
        keyboardShouldPersistTaps="handled"
        ItemSeparatorComponent={() => <View style={{ height: space[3] }} />}
        ListEmptyComponent={
          <View style={{ alignItems: 'center', paddingVertical: space[8], gap: space[3] }}>
            <Txt variant="body" color="muted">
              {q.trim().length < 2
                ? 'Type a book title to log progress or finish.'
                : loading
                ? 'Searching catalog...'
                : 'No matching books found.'}
            </Txt>
          </View>
        }
        renderItem={({ item }) => (
          <Pressable
            onPress={() => {
              router.replace(`/work/${item.id}`);
            }}
            style={sheet.rowTop}
            accessibilityRole="button"
            accessibilityLabel={`Log ${item.title}`}
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
            <Button
              label="Select"
              variant="secondary"
              onPress={() => router.replace(`/work/${item.id}`)}
              style={{ minHeight: 36, paddingHorizontal: space[3] }}
            />
          </Pressable>
        )}
      />
    </Screen>
  );
}
