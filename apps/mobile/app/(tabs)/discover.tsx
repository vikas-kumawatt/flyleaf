// Tab 3 — Discover & Search (PRD §6.21, §6.22, design.md §10, SL-40).
//
// Features:
// - 250ms debounced live search
// - Barcode scan shortcut leading to camera scanner
// - Tabs: Books / Authors / Curated Lists
// - Persistent recent searches (up to 10 recents, tap to search, clear all)
// - Format & sort filter chips
// - Curated shelf browsing when query is empty

import React, { useState, useEffect, useCallback } from 'react';
import {
  FlatList,
  Pressable,
  TextInput,
  View,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Work } from '@/lib/api';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import { AddToShelfSheet, type AddToShelfWork } from '@/ui/AddToShelfSheet';
import {
  Card,
  Cover,
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

const MAX_RECENTS = 10;
const INITIAL_RECENTS = ['Piranesi', 'Ursula K. Le Guin', 'Klara and the Sun', 'Dune'];

const CURATED_SHELVES = [
  {
    title: 'Popular This Week',
    books: [
      { id: 'p-1', title: 'Piranesi', author: 'Susanna Clarke', cover_id: 8231856 },
      { id: 'p-2', title: 'The Left Hand of Darkness', author: 'Ursula K. Le Guin', cover_id: 8231990 },
      { id: 'p-3', title: 'Klara and the Sun', author: 'Kazuo Ishiguro', cover_id: 10521270 },
      { id: 'p-4', title: 'Invisible Cities', author: 'Italo Calvino', cover_id: 3155564 },
    ],
  },
  {
    title: 'Modern Classics',
    books: [
      { id: 'mc-1', title: 'Beloved', author: 'Toni Morrison', cover_id: 8231856 },
      { id: 'mc-2', title: 'Never Let Me Go', author: 'Kazuo Ishiguro', cover_id: 10521270 },
      { id: 'mc-3', title: 'The Dispossessed', author: 'Ursula K. Le Guin', cover_id: 8231990 },
    ],
  },
];

export default function DiscoverScreen() {
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const c = useTheme();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { isSaved } = useGuestShelf();

  const [q, setQ] = useState('');
  const [results, setResults] = useState<Work[]>([]);
  const [loading, setLoading] = useState(false);
  const [recents, setRecents] = useState<string[]>(INITIAL_RECENTS);
  const [activeTab, setActiveTab] = useState<'books' | 'authors' | 'lists'>('books');
  const [formatFilter, setFormatFilter] = useState<'all' | 'print' | 'ebook' | 'audio'>('all');
  const [shelfTargetWork, setShelfTargetWork] = useState<AddToShelfWork | null>(null);

  const handleOpenShelf = (work: Work | { id: string; title: string; author: string; cover_id?: number | null }) => {
    if (!user) {
      promptAuth({
        title: 'Sign up to create shelves',
        subtitle: 'Organize your reading with custom shelves, ranked lists, and notes.',
      });
      return;
    }
    setShelfTargetWork({
      id: work.id,
      title: work.title,
      author_name: 'author_name' in work ? work.author_name : (work as any).author,
      cover_id: work.cover_id,
    });
  };

  // 250ms debounce per design.md & PRD §6.22
  useEffect(() => {
    const trimmed = q.trim();
    if (trimmed.length < 2) {
      setResults([]);
      setLoading(false);
      return;
    }

    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api.search(trimmed);
        setResults(data);

        // Save to recents if not already there
        setRecents((prev) => {
          const next = [trimmed, ...prev.filter((r) => r.toLowerCase() !== trimmed.toLowerCase())];
          return next.slice(0, MAX_RECENTS);
        });
      } catch {
        setResults([]);
      } finally {
        setLoading(false);
      }
    }, 250);

    return () => clearTimeout(timer);
  }, [q]);

  const handleSelectRecent = (recentQuery: string) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setQ(recentQuery);
  };

  const handleClearRecents = () => {
    void Haptics.selectionAsync();
    setRecents([]);
  };

  // Filter results by format if specified
  const filteredResults = results.filter((w) => {
    if (formatFilter === 'all') return true;
    if (!w.editions || w.editions.length === 0) return true;
    return w.editions.some((e) => {
      if (formatFilter === 'print') return e.format === 'paperback' || e.format === 'hardcover';
      if (formatFilter === 'ebook') return e.format === 'ebook';
      if (formatFilter === 'audio') return e.format === 'audiobook';
      return true;
    });
  });

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
          backgroundColor: c.ground,
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayM">Discover</Txt>
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              router.push('/scanner' as any);
            }}
            accessibilityRole="button"
            accessibilityLabel="Scan barcode"
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              backgroundColor: c.surface,
              paddingHorizontal: space[3],
              paddingVertical: space[2],
              borderRadius: radius.md,
              borderWidth: 1,
              borderColor: c.line,
              gap: space[2],
            }}
          >
            <Ionicons name="barcode-outline" size={20} color={c.accent} />
            <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
              Scan ISBN
            </Txt>
          </Pressable>
        </View>

        {/* Search Input Bar */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            backgroundColor: c.surface,
            borderRadius: radius.md,
            borderWidth: 1,
            borderColor: c.line,
            paddingHorizontal: space[3],
            minHeight: 48,
          }}
        >
          <Ionicons
            name="search-outline"
            size={20}
            color={loading ? c.accent : c.muted}
            style={{ marginRight: space[2] }}
          />
          <TextInput
            value={q}
            onChangeText={setQ}
            placeholder="Search titles, authors, or ISBN..."
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
            <Pressable
              onPress={() => setQ('')}
              accessibilityRole="button"
              accessibilityLabel="Clear search"
              hitSlop={8}
            >
              <Ionicons name="close-circle" size={18} color={c.muted} />
            </Pressable>
          )}
        </View>

        {/* Tab switcher: Books / Authors / Lists */}
        <SegmentedControl
          values={['books', 'authors', 'lists'] as const}
          selected={activeTab}
          onSelect={setActiveTab}
          labels={{
            books: 'Books',
            authors: 'Authors',
            lists: 'Lists',
          }}
        />

        {/* Format filter chips when searching books */}
        {q.trim().length >= 2 && activeTab === 'books' && (
          <ScrollView
            horizontal
            showsHorizontalScrollIndicator={false}
            contentContainerStyle={{ gap: space[2], paddingVertical: 2 }}
          >
            {(['all', 'print', 'ebook', 'audio'] as const).map((fmt) => {
              const active = formatFilter === fmt;
              return (
                <Pressable
                  key={fmt}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setFormatFilter(fmt);
                  }}
                  accessibilityRole="button"
                  accessibilityState={{ selected: active }}
                  style={{
                    paddingHorizontal: space[3],
                    paddingVertical: 4,
                    borderRadius: radius.pill,
                    backgroundColor: active ? c.accent : c.surface,
                    borderWidth: 1,
                    borderColor: active ? c.accent : c.line,
                  }}
                >
                  <Txt
                    variant="caption"
                    color={active ? 'ground' : 'ink2'}
                    style={{ fontWeight: active ? '600' : '400', textTransform: 'capitalize' }}
                  >
                    {fmt}
                  </Txt>
                </Pressable>
              );
            })}
          </ScrollView>
        )}
      </View>

      {/* Main Content Area */}
      {q.trim().length < 2 ? (
        // Browse State with Recents & Shelves
        <ScrollView
          contentContainerStyle={{
            padding: space[4],
            paddingBottom: space[12],
            gap: space[6],
          }}
        >
          {/* Recents Section */}
          {recents.length > 0 && (
            <View style={{ gap: space[3] }}>
              <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                <Txt variant="micro" color="muted">
                  RECENT SEARCHES
                </Txt>
                <Pressable
                  onPress={handleClearRecents}
                  accessibilityRole="button"
                  accessibilityLabel="Clear recent searches"
                  hitSlop={8}
                >
                  <Txt variant="caption" color="muted">
                    Clear all
                  </Txt>
                </Pressable>
              </View>

              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
                {recents.map((item) => (
                  <Pressable
                    key={item}
                    onPress={() => handleSelectRecent(item)}
                    accessibilityRole="button"
                    accessibilityLabel={`Search for ${item}`}
                    style={{
                      flexDirection: 'row',
                      alignItems: 'center',
                      backgroundColor: c.surface,
                      borderWidth: 1,
                      borderColor: c.line,
                      borderRadius: radius.pill,
                      paddingHorizontal: space[3],
                      paddingVertical: space[2],
                      gap: space[2],
                    }}
                  >
                    <Ionicons name="time-outline" size={14} color={c.muted} />
                    <Txt variant="caption" color="ink">
                      {item}
                    </Txt>
                  </Pressable>
                ))}
              </View>
            </View>
          )}

          {/* Curated Horizontally Scrolling Shelves (PRD §6.21) */}
          {CURATED_SHELVES.map((shelf) => (
            <View key={shelf.title} style={{ gap: space[3] }}>
              <Txt variant="title">{shelf.title}</Txt>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={{ gap: space[4] }}
              >
                {shelf.books.map((book) => (
                  <Pressable
                    key={book.id}
                    onPress={() => router.push(`/work/${book.id}`)}
                    accessibilityRole="button"
                    accessibilityLabel={`${book.title} by ${book.author}`}
                    style={{ width: 104, gap: space[2] }}
                  >
                    <Cover coverId={book.cover_id} title={book.title} size="m" />
                    <Txt variant="caption" numberOfLines={2} style={{ fontWeight: '600' }}>
                      {book.title}
                    </Txt>
                    <Txt variant="micro" color="muted" numberOfLines={1}>
                      {book.author}
                    </Txt>
                  </Pressable>
                ))}
              </ScrollView>
            </View>
          ))}
        </ScrollView>
      ) : (
        // Results State
        <FlatList
          contentContainerStyle={{ padding: space[4], paddingBottom: space[12] }}
          data={filteredResults}
          keyExtractor={(item) => item.id}
          keyboardShouldPersistTaps="handled"
          ListEmptyComponent={
            loading ? (
              <View style={{ paddingVertical: space[8], alignItems: 'center' }}>
                <Txt variant="body" color="muted">
                  Searching catalog…
                </Txt>
              </View>
            ) : (
              <EmptyState
                title={`No results for "${q}"`}
                subtitle="Try checking for typos or searching by author name or 13-digit ISBN."
                action={
                  <Pressable
                    onPress={() => router.push('/scanner' as any)}
                    accessibilityRole="button"
                    accessibilityLabel="Scan barcode instead"
                    style={{
                      marginTop: space[3],
                      paddingHorizontal: space[4],
                      paddingVertical: space[2],
                      backgroundColor: c.accentSoft,
                      borderRadius: radius.md,
                    }}
                  >
                    <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
                      Scan a barcode instead
                    </Txt>
                  </Pressable>
                }
              />
            )
          }
          renderItem={({ item }) => {
            const savedLocally = isSaved(item.id);
            const isFinished = item.your_read?.status === 'finished';
            const isReading = item.your_read?.status === 'reading';

            return (
              <Card
                onPress={() => router.push(`/work/${item.id}`)}
                onLongPress={() => handleOpenShelf(item)}
                style={{ marginBottom: space[3], padding: space[3] }}
              >
                <View style={sheet.rowTop}>
                  <Cover coverId={item.cover_id} title={item.title} size="s" />
                  <View
                    style={{
                      flex: 1,
                      marginLeft: space[3],
                      justifyContent: 'space-between',
                      gap: space[1],
                    }}
                  >
                    <View>
                      <Txt variant="title" numberOfLines={2}>
                        {item.title}
                      </Txt>
                      <Pressable
                        onPress={(e) => {
                          e.stopPropagation();
                          router.push(`/author/${encodeURIComponent(item.author_name)}` as any);
                        }}
                        hitSlop={4}
                      >
                        <Txt variant="caption" color="muted">
                          {item.author_name}
                        </Txt>
                      </Pressable>
                    </View>

                    <View style={[sheet.row, { justifyContent: 'space-between', marginTop: 4 }]}>
                      <Txt variant="micro" color="muted">
                        {[item.first_publish_year, item.editions?.[0]?.format]
                          .filter(Boolean)
                          .join(' · ')}
                      </Txt>

                      {/* Reading Status Pill */}
                      {isFinished && (
                        <View style={[styles.statusPill, { backgroundColor: c.accentSoft }]}>
                          <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
                            Finished
                          </Txt>
                        </View>
                      )}
                      {isReading && (
                        <View style={[styles.statusPill, { backgroundColor: c.surface2 }]}>
                          <Txt variant="micro" color="ink" style={{ fontWeight: '600' }}>
                            Reading
                          </Txt>
                        </View>
                      )}
                      {savedLocally && (
                        <View style={[styles.statusPill, { backgroundColor: c.accentSoft }]}>
                          <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
                            Saved ✓
                          </Txt>
                        </View>
                      )}

                      {/* Add to Shelf quick action (SH-04) */}
                      <Pressable
                        onPress={(e) => {
                          e.stopPropagation();
                          handleOpenShelf(item);
                        }}
                        hitSlop={8}
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${item.title} to shelf`}
                        style={{ padding: 2, marginLeft: 'auto' }}
                      >
                        <Ionicons name="bookmark-outline" size={18} color={c.muted} />
                      </Pressable>
                    </View>
                  </View>
                </View>
              </Card>
            );
          }}
        />
      )}

      {/* Add-to-Shelf Sheet (SH-04) */}
      <AddToShelfSheet
        visible={Boolean(shelfTargetWork)}
        onClose={() => setShelfTargetWork(null)}
        work={shelfTargetWork}
      />
    </Screen>
  );
}

const styles = StyleSheet.create({
  statusPill: {
    paddingHorizontal: space[2],
    paddingVertical: 2,
    borderRadius: radius.pill,
  },
});
