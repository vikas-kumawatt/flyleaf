// Tab 4 — Shelves (PRD §5.2, design.md §10).
//
// Lists and collections: Mine / Saved / Discover.
// Cover mosaic thumbnails, count, and shelf privacy indicators.

import React, { useState } from 'react';
import { View, ScrollView } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import {
  Button,
  Card,
  EmptyState,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function ShelvesScreen() {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const [shelfFilter, setShelfFilter] = useState<'mine' | 'saved' | 'discover'>('mine');

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
            onPress={() => {}}
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
