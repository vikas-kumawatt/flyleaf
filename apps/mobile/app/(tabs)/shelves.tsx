// Tab 4 — Shelves (PRD §4.2, §5.2, design.md §10, SL-32).
//
// Lists and collections: Mine / Saved / Discover.
// For guests: Displays local Want-to-Read device shelf (capped at 20) with live items.

import React, { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { useGuestShelf } from '@/lib/guest';
import { useActionGate } from '@/ui/ActionGate';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { space, radius, useTheme } from '@/ui/tokens';

export default function ShelvesScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { promptAuth } = useActionGate();
  const { books: guestBooks, count: guestCount, maxCap, removeBook } = useGuestShelf();
  const [shelfFilter, setShelfFilter] = useState<'mine' | 'saved' | 'discover'>('mine');

  const handleNewList = () => {
    if (!user) {
      promptAuth({
        title: 'Sign up to create custom shelves',
        subtitle:
          'Organize your personal reading into custom shelves, series lists, and reading challenges.',
      });
      return;
    }
  };

  return (
    <Screen>
      {/* Header */}
      <View
        style={{
          paddingTop: Math.max(insets.top, space[4]),
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
          gap: space[3],
        }}
      >
        <View style={[sheet.row, { justifyContent: 'space-between' }]}>
          <Txt variant="displayM">Shelves</Txt>
          <Button
            label="New list"
            variant="secondary"
            onPress={handleNewList}
            style={{ minHeight: 36, paddingHorizontal: space[3] }}
          />
        </View>

        <SegmentedControl
          values={['mine', 'saved', 'discover'] as const}
          selected={shelfFilter}
          onSelect={setShelfFilter}
          labels={{
            mine: 'My shelves',
            saved: 'Saved',
            discover: 'Curated',
          }}
        />
      </View>

      <ScrollView
        contentContainerStyle={{
          padding: space[4],
          paddingBottom: space[12],
          gap: space[4],
        }}
      >
        {shelfFilter === 'mine' && (
          <>
            {!user ? (
              // Guest Device Shelf
              <View style={{ gap: space[4] }}>
                <Card style={{ backgroundColor: c.surface }}>
                  <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                    <Txt variant="title">Want to read (on this device)</Txt>
                    <View
                      style={{
                        backgroundColor: c.accentSoft,
                        paddingHorizontal: space[2],
                        paddingVertical: 2,
                        borderRadius: 4,
                      }}
                    >
                      <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
                        {guestCount} / {maxCap} saved
                      </Txt>
                    </View>
                  </View>
                  <Txt variant="caption" color="muted" style={{ marginTop: space[1] }}>
                    Books you save while browsing. Sign up anytime to sync them to your permanent library.
                  </Txt>
                </Card>

                {guestCount > 0 ? (
                  <View style={{ gap: space[3] }}>
                    {guestBooks.map((b) => (
                      <Card
                        key={b.id}
                        onPress={() => router.push(`/work/${b.id}`)}
                        style={{ padding: space[3] }}
                      >
                        <View style={sheet.rowTop}>
                          <Cover coverId={b.cover_id} title={b.title} size="m" />
                          <View
                            style={{
                              flex: 1,
                              marginLeft: space[3],
                              justifyContent: 'space-between',
                            }}
                          >
                            <View style={{ gap: 2 }}>
                              <Txt variant="title" numberOfLines={1}>
                                {b.title}
                              </Txt>
                              <Txt variant="caption" color="muted">
                                {b.author_name}
                              </Txt>
                            </View>

                            <View
                              style={[
                                sheet.row,
                                { justifyContent: 'space-between', marginTop: space[2] },
                              ]}
                            >
                              <Txt variant="micro" color="muted">
                                Saved {new Date(b.added_at).toLocaleDateString()}
                              </Txt>
                              <Pressable
                                onPress={async (e) => {
                                  e.stopPropagation();
                                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                                  await removeBook(b.id);
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={`Remove ${b.title} from device shelf`}
                                hitSlop={8}
                              >
                                <Txt variant="caption" color="muted">
                                  Remove
                                </Txt>
                              </Pressable>
                            </View>
                          </View>
                        </View>
                      </Card>
                    ))}
                  </View>
                ) : (
                  <EmptyState
                    title="Your local shelf is empty"
                    subtitle="Browse books in Discover or Search and tap 'Want to read' to save up to 20 books on this device."
                    action={
                      <Button
                        label="Discover books"
                        variant="primary"
                        onPress={() => router.push('/discover')}
                      />
                    }
                  />
                )}
              </View>
            ) : (
              // Authenticated user shelves
              <>
                <Card onPress={() => {}}>
                  <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                    <Txt variant="title">Favorites of All Time</Txt>
                    <Txt variant="caption" color="muted">
                      4 books
                    </Txt>
                  </View>
                  <Txt variant="caption" color="muted">
                    Books that changed how I see the world.
                  </Txt>
                </Card>

                <Card onPress={() => {}}>
                  <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                    <Txt variant="title">To Read in 2026</Txt>
                    <Txt variant="caption" color="muted">
                      12 books
                    </Txt>
                  </View>
                  <Txt variant="caption" color="muted">
                    Annual reading challenge queue.
                  </Txt>
                </Card>
              </>
            )}
          </>
        )}

        {shelfFilter === 'saved' && (
          <EmptyState
            title="No saved shelves yet"
            subtitle="Save collections curated by friends and authors to easily find them later."
          />
        )}

        {shelfFilter === 'discover' && (
          <EmptyState
            title="Curated reading lists"
            subtitle="Explore book club selections, award winners, and literary collections."
          />
        )}
      </ScrollView>
    </Screen>
  );
}
