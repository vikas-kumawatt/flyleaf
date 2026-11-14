// Favourites Picker Screen (SL-73, PRD §6.18, §6.39).
//
// 4 ordered slots, drag / reorder controls, catalog search, haptics.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  ActivityIndicator,
  StyleSheet,
  Alert,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, type ProfileFavourite, type Work } from '@/lib/api';
import {
  Button,
  Cover,
  Screen,
  Txt,
  sheet, SkeletonList} from '@/ui/components';
import { Ionicons } from '@expo/vector-icons';
import { familyFor, radius, space, useTheme } from '@/ui/tokens';

// Small square control for reordering and removing a favourite.
function IconButton({
  icon,
  label,
  disabled,
  onPress,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  disabled?: boolean;
  onPress: () => void;
}) {
  const c = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled: Boolean(disabled) }}
      style={({ pressed }) => ({
        width: 44,
        height: 44,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: c.lineStrong,
        backgroundColor: pressed ? c.surface2 : 'transparent',
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1,
      })}
    >
      <Ionicons name={icon} size={18} color={c.ink2} />
    </Pressable>
  );
}

export default function FavouritesPickerScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [favourites, setFavourites] = useState<ProfileFavourite[]>([]);

  // Search sheet state
  const [searchTargetSlot, setSearchTargetSlot] = useState<number | null>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState<Work[]>([]);

  // Load existing favourites from profile
  const loadFavourites = useCallback(async () => {
    try {
      setLoading(true);
      const profile = await api.myProfile();
      setFavourites(profile.favourites || []);
    } catch {
      // Fallback
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadFavourites();
  }, [loadFavourites]);

  // Reorder slot up
  const moveUp = (index: number) => {
    if (index <= 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const updated = [...favourites];
    const temp = updated[index - 1];
    updated[index - 1] = updated[index]!;
    updated[index] = temp!;
    setFavourites(updated);
  };

  // Reorder slot down
  const moveDown = (index: number) => {
    if (index >= favourites.length - 1) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const updated = [...favourites];
    const temp = updated[index + 1];
    updated[index + 1] = updated[index]!;
    updated[index] = temp!;
    setFavourites(updated);
  };

  // Remove book from slot
  const removeSlot = (index: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const updated = favourites.filter((_, i) => i !== index);
    setFavourites(updated);
  };

  // Search catalog
  const handleSearch = async (query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setSearching(true);
    try {
      const results = await api.search(query.trim());
      setSearchResults(results);
    } catch {
      setSearchResults([]);
    } finally {
      setSearching(false);
    }
  };

  // Select a book from search
  const selectBook = (book: Work) => {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    const newFav: ProfileFavourite = {
      id: book.id,
      title: book.title,
      author_name: book.author_name,
      cover_id: book.cover_id,
    };

    // Check if already in favourites
    const existingIndex = favourites.findIndex((f) => f.id === book.id);
    if (existingIndex !== -1 && existingIndex !== searchTargetSlot) {
      Alert.alert('Already selected', 'This book is already in your favourites.');
      return;
    }

    const updated = [...favourites];
    if (searchTargetSlot !== null && searchTargetSlot < updated.length) {
      // Replace existing slot
      updated[searchTargetSlot] = newFav;
    } else {
      // Add to next slot (up to 4)
      if (updated.length < 4) {
        updated.push(newFav);
      }
    }

    setFavourites(updated);
    setSearchTargetSlot(null);
    setSearchQuery('');
    setSearchResults([]);
  };

  // Save favourites
  const handleSave = async () => {
    try {
      setSaving(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const favouriteWorkIds = favourites.map((f) => f.id);
      await api.updateProfile({ favouriteWorkIds });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      Alert.alert('Error', 'Unable to save favourites. Please try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Header */}
      <View
        style={{
          paddingTop: insets.top + space[2],
          paddingHorizontal: space[4],
          paddingBottom: space[3],
          backgroundColor: c.ground,
          borderBottomWidth: 1,
          borderBottomColor: c.line,
        }}
      >
        <View style={sheet.rowBetween}>
          <Pressable
            onPress={() => {
              void Haptics.selectionAsync();
              router.back();
            }}
            accessibilityRole="button"
            accessibilityLabel="Cancel"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
          >
            <Txt variant="body" color="muted">
              Cancel
            </Txt>
          </Pressable>

          <Txt variant="title">
            Favourite books
          </Txt>

          <Pressable
            onPress={handleSave}
            disabled={saving}
            accessibilityRole="button"
            accessibilityLabel="Save favourites"
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ minWidth: 44, minHeight: 44, justifyContent: 'center', alignItems: 'flex-end' }}
          >
            {saving ? (
              <ActivityIndicator size="small" color={c.muted} />
            ) : (
              <Txt variant="body" color="accent" style={{ fontWeight: '500' }}>
                Save
              </Txt>
            )}
          </Pressable>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{
          paddingHorizontal: space[4],
          paddingTop: space[4],
          paddingBottom: insets.bottom + space[8],
          gap: space[4],
        }}
      >
        <View style={{ gap: space[1] }}>
          <Txt variant="displayM">Your four favourites</Txt>
          <Txt variant="caption" color="muted">
            These four books come first on your profile. Use the arrows to set their order.
          </Txt>
        </View>

        {loading ? (
          <SkeletonList lead="cover" rows={4} style={{ paddingHorizontal: 0, paddingTop: 0 }} />
        ) : (
          <View>
            {/* Render 4 slots */}
            {[0, 1, 2, 3].map((slotIndex) => {
              const book = favourites[slotIndex];

              if (book) {
                return (
                  <View key={book.id} style={[styles.slotRow, { borderTopColor: c.line, borderTopWidth: slotIndex ? 1 : 0 }]}>
                    <View style={[sheet.rowTop, { gap: space[3] }]}>
                      {/* Slot number badge */}
                      <View style={styles.slotBadge}>
                        <Txt variant="body" color="muted" tabular>
                          {slotIndex + 1}
                        </Txt>
                      </View>

                      {/* Cover */}
                      <Cover coverId={book.cover_id} title={book.title} size="s" />

                      {/* Details & actions */}
                      <View style={{ flex: 1, gap: space[1] }}>
                        <Txt variant="title" numberOfLines={2}>
                          {book.title}
                        </Txt>
                        <Txt variant="caption" color="muted" numberOfLines={1}>
                          {book.author_name}
                        </Txt>

                        {/* Controls: wrap rather than run off a narrow screen. */}
                        <View style={[sheet.row, { gap: space[2], marginTop: space[2], flexWrap: 'wrap' }]}>
                          <IconButton
                            icon="chevron-up"
                            label="Move up"
                            disabled={slotIndex === 0}
                            onPress={() => moveUp(slotIndex)}
                          />
                          <IconButton
                            icon="chevron-down"
                            label="Move down"
                            disabled={slotIndex === favourites.length - 1}
                            onPress={() => moveDown(slotIndex)}
                          />
                          <Button
                            label="Change"
                            variant="secondary"
                            size="sm"
                            onPress={() => {
                              void Haptics.selectionAsync();
                              setSearchTargetSlot(slotIndex);
                            }}
                          />
                          <IconButton
                            icon="close"
                            label="Remove"
                            onPress={() => removeSlot(slotIndex)}
                          />
                        </View>
                      </View>
                    </View>
                  </View>
                );
              }

              // Empty slot placeholder
              return (
                <Pressable
                  key={`empty-${slotIndex}`}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    setSearchTargetSlot(slotIndex);
                  }}
                  accessibilityRole="button"
                  accessibilityLabel={`Add favourite book ${slotIndex + 1}`}
                  style={[styles.emptySlot, { borderTopColor: c.line, borderTopWidth: slotIndex ? 1 : 0 }]}
                >
                  <View style={styles.slotBadge}>
                    <Txt variant="body" color="muted" tabular>
                      {slotIndex + 1}
                    </Txt>
                  </View>
                  <Ionicons name="add-outline" size={20} color={c.accent} />
                  <Txt variant="body" color="accent">
                    Choose a book
                  </Txt>
                </Pressable>
              );
            })}
          </View>
        )}

        {/* Catalog Search Panel (when a slot is being picked) */}
        {searchTargetSlot !== null && (
          <View
            style={[styles.searchPanel, { backgroundColor: c.surface }]}
          >
            <View style={[sheet.rowBetween, { marginBottom: space[2] }]}>
              <Txt variant="title">
                Pick a book for slot {searchTargetSlot + 1}
              </Txt>
              <Button
                label="Cancel"
                variant="tertiary"
                size="sm"
                onPress={() => {
                  void Haptics.selectionAsync();
                  setSearchTargetSlot(null);
                  setSearchQuery('');
                  setSearchResults([]);
                }}
                style={{ minHeight: 44 }}
              />
            </View>

            {/* Search Input */}
            <View
              style={[
                styles.searchInputContainer,
                { backgroundColor: c.ground, borderColor: c.lineStrong },
              ]}
            >
              <TextInput
                placeholder="Title, author or series"
                placeholderTextColor={c.muted}
                value={searchQuery}
                onChangeText={handleSearch}
                autoFocus
                accessibilityLabel="Search for a book"
                style={[styles.searchInput, { color: c.ink, fontFamily: familyFor(false, '400') }]}
              />
              {searchQuery.length > 0 && (
                <Pressable
                  onPress={() => handleSearch('')}
                  accessibilityRole="button"
                  accessibilityLabel="Clear search"
                  hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
                  style={{ minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' }}
                >
                  <Ionicons name="close-circle" size={18} color={c.muted} />
                </Pressable>
              )}
            </View>

            {searching && (
              <SkeletonList lead="cover" rows={3} style={{ paddingHorizontal: 0, paddingTop: 0 }} />
            )}

            {/* Search Results */}
            <View style={{ marginTop: space[2] }}>
              {searchResults.slice(0, 6).map((book, index) => (
                <Pressable
                  key={book.id}
                  onPress={() => selectBook(book)}
                  accessibilityRole="button"
                  style={[
                    styles.searchResultItem,
                    { borderTopColor: c.line, borderTopWidth: index ? 1 : 0 },
                  ]}
                >
                  <Cover coverId={book.cover_id} title={book.title} size="s" />
                  <View style={{ flex: 1, gap: space[1] }}>
                    <Txt variant="title" numberOfLines={2}>
                      {book.title}
                    </Txt>
                    <Txt variant="caption" color="muted" numberOfLines={1}>
                      {book.author_name}
                    </Txt>
                  </View>
                  <Button
                    label="Select"
                    variant="secondary"
                    size="sm"
                    onPress={() => selectBook(book)}
                  />
                </Pressable>
              ))}
            </View>
          </View>
        )}
      </ScrollView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  slotRow: {
    paddingVertical: space[3],
  },
  slotBadge: {
    width: 24,
    alignItems: 'center',
  },
  emptySlot: {
    minHeight: 96,
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: space[3],
    gap: space[3],
  },
  searchPanel: {
    padding: space[4],
    borderRadius: radius.lg,
    marginTop: space[2],
  },
  searchInputContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderRadius: radius.md,
    paddingLeft: space[3],
    minHeight: 48,
  },
  searchInput: {
    flex: 1,
    fontSize: 15,
    paddingVertical: 0,
    minHeight: 44,
  },
  searchResultItem: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingVertical: space[3],
  },
});
