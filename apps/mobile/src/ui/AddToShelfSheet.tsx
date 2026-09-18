// Add-to-Shelf Bottom Sheet (PRD §6.34, §15.2, SH-04).
//
// Allows readers to:
// 1. View all their shelves with current membership status for a specific book.
// 2. Add or remove a book with single-tap toggle and immediate haptics.
// 3. Attach/edit per-entry notes (up to 280 characters with counter).
// 4. Create a new shelf inline without leaving the book context.
// 5. Seamlessly handles guest state via ActionGate.

import React, { useState, useEffect, useCallback } from 'react';
import {
  View,
  Pressable,
  TextInput,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';

import { BottomSheet, Txt, Button, Cover, Skeleton } from './components';
import { useTheme, space, radius } from './tokens';
import { api, type ShelfWithWorkState } from '../lib/api';
import { validateShelfNote, validateShelfName } from '../lib/shelfValidation';

export interface AddToShelfWork {
  id: string;
  title: string;
  author_name: string;
  cover_id?: number | null;
}

export interface AddToShelfSheetProps {
  visible: boolean;
  onClose: () => void;
  work: AddToShelfWork | null;
  onShelfChanged?: (shelfId: string, added: boolean) => void;
}

export function AddToShelfSheet({
  visible,
  onClose,
  work,
  onShelfChanged,
}: AddToShelfSheetProps) {
  const c = useTheme();

  const [shelves, setShelves] = useState<ShelfWithWorkState[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-shelf editing notes: map of shelfId -> string
  const [activeNoteShelfId, setActiveNoteShelfId] = useState<string | null>(null);
  const [noteDraft, setNoteDraft] = useState('');
  const [savingNote, setSavingNote] = useState(false);
  const [noteError, setNoteError] = useState<string | null>(null);

  // Quick shelf creation
  const [showCreateInline, setShowCreateInline] = useState(false);
  const [newShelfName, setNewShelfName] = useState('');
  const [creatingShelf, setCreatingShelf] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);

  const loadShelves = useCallback(async () => {
    if (!work) return;
    setLoading(true);
    setError(null);
    try {
      const res = await api.getMyShelves({ work_id: work.id });
      setShelves(res.shelves);
    } catch (err: any) {
      setError(err?.message || 'Failed to load your shelves.');
    } finally {
      setLoading(false);
    }
  }, [work]);

  useEffect(() => {
    if (visible && work) {
      loadShelves().catch(() => {});
      setActiveNoteShelfId(null);
      setShowCreateInline(false);
      setNewShelfName('');
      setCreateError(null);
    }
  }, [visible, work, loadShelves]);

  const handleToggleShelf = async (shelf: ShelfWithWorkState) => {
    if (!work) return;
    void Haptics.selectionAsync();

    const currentlyIn = shelf.contains_work;
    const nextState = !currentlyIn;

    // Optimistic UI update
    setShelves((prev) =>
      prev.map((s) =>
        s.id === shelf.id
          ? {
              ...s,
              contains_work: nextState,
              item_count: nextState ? s.item_count + 1 : Math.max(0, s.item_count - 1),
            }
          : s,
      ),
    );

    try {
      if (nextState) {
        await api.addShelfItem(shelf.id, { work_id: work.id });
      } else {
        await api.removeShelfItem(shelf.id, work.id);
        if (activeNoteShelfId === shelf.id) {
          setActiveNoteShelfId(null);
        }
      }
      onShelfChanged?.(shelf.id, nextState);
    } catch (err: any) {
      // Revert on error
      setShelves((prev) =>
        prev.map((s) =>
          s.id === shelf.id
            ? {
                ...s,
                contains_work: currentlyIn,
                item_count: shelf.item_count,
              }
            : s,
        ),
      );
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    }
  };

  const handleOpenNoteEditor = (shelf: ShelfWithWorkState) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    setActiveNoteShelfId(shelf.id);
    setNoteDraft(shelf.item_note || '');
    setNoteError(null);
  };

  const handleSaveNote = async (shelfId: string) => {
    if (!work) return;
    const validation = validateShelfNote(noteDraft);
    if (!validation.isValid) {
      setNoteError(validation.error || 'Note too long');
      return;
    }

    setSavingNote(true);
    setNoteError(null);
    try {
      await api.updateShelfItem(shelfId, work.id, { note: noteDraft.trim() || null });
      setShelves((prev) =>
        prev.map((s) =>
          s.id === shelfId ? { ...s, item_note: noteDraft.trim() || null } : s,
        ),
      );
      setActiveNoteShelfId(null);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    } catch (err: any) {
      setNoteError(err?.message || 'Failed to save note');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setSavingNote(false);
    }
  };

  const handleCreateNewShelf = async () => {
    const trimmed = newShelfName.trim();
    const validation = validateShelfName(trimmed);
    if (!validation.isValid) {
      setCreateError(validation.error || 'Invalid shelf name');
      return;
    }

    setCreatingShelf(true);
    setCreateError(null);
    try {
      const res = await api.createShelf({ name: trimmed, privacy: 'public' });
      const newShelf = res.shelf;

      // Auto-add current work to new shelf
      if (work) {
        await api.addShelfItem(newShelf.id, { work_id: work.id });
      }

      setShelves((prev) => [
        {
          ...newShelf,
          contains_work: true,
          item_count: 1,
          item_note: null,
          position: 1,
        },
        ...prev,
      ]);

      setNewShelfName('');
      setShowCreateInline(false);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      onShelfChanged?.(newShelf.id, true);
    } catch (err: any) {
      setCreateError(err?.message || 'Failed to create shelf');
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
    } finally {
      setCreatingShelf(false);
    }
  };

  if (!work) return null;

  return (
    <BottomSheet visible={visible} onClose={onClose} title="Add to Shelf">
      <View style={{ gap: space[4] }}>
        {/* Book Preview Header */}
        <View style={styles.bookHeader}>
          <Cover coverId={work.cover_id} title={work.title} size="s" />
          <View style={{ flex: 1, gap: 2 }}>
            <Txt variant="title" numberOfLines={2}>
              {work.title}
            </Txt>
            <Txt variant="caption" color="muted" numberOfLines={1}>
              {work.author_name}
            </Txt>
          </View>
        </View>

        {/* Quick Inline Shelf Creator Trigger */}
        {!showCreateInline ? (
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              setShowCreateInline(true);
            }}
            accessibilityRole="button"
            accessibilityLabel="Create new shelf"
            style={[styles.createTrigger, { borderColor: c.line, backgroundColor: c.surface2 }]}
          >
            <Ionicons name="add-circle-outline" size={20} color={c.accent} />
            <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
              Create new shelf
            </Txt>
          </Pressable>
        ) : (
          <View style={[styles.inlineCreateBox, { backgroundColor: c.surface2, borderColor: c.line }]}>
            <Txt variant="micro" color="muted">
              NEW SHELF NAME
            </Txt>
            <TextInput
              value={newShelfName}
              onChangeText={(text) => {
                setNewShelfName(text);
                if (createError) setCreateError(null);
              }}
              placeholder="e.g. Best Sci-Fi of 2026"
              placeholderTextColor={c.muted}
              maxLength={60}
              autoFocus
              style={[
                styles.input,
                {
                  color: c.ink,
                  backgroundColor: c.surface,
                  borderColor: createError ? c.critical : c.line,
                },
              ]}
            />
            {createError ? (
              <Txt variant="micro" color="critical">
                {createError}
              </Txt>
            ) : null}
            <View style={styles.createActions}>
              <Button
                label="Cancel"
                variant="tertiary"
                size="sm"
                onPress={() => {
                  setShowCreateInline(false);
                  setNewShelfName('');
                  setCreateError(null);
                }}
              />
              <Button
                label="Create & Add"
                variant="primary"
                size="sm"
                loading={creatingShelf}
                disabled={!newShelfName.trim() || creatingShelf}
                onPress={handleCreateNewShelf}
              />
            </View>
          </View>
        )}

        {/* Shelves List */}
        {loading ? (
          <View style={{ gap: space[3], paddingVertical: space[2] }}>
            <Skeleton height={52} width="100%" />
            <Skeleton height={52} width="100%" />
            <Skeleton height={52} width="100%" />
          </View>
        ) : error ? (
          <View style={styles.errorBox}>
            <Txt variant="body" color="critical">
              {error}
            </Txt>
            <Button label="Retry" variant="secondary" size="sm" onPress={loadShelves} />
          </View>
        ) : shelves.length === 0 ? (
          <View style={styles.emptyShelves}>
            <Txt variant="body" color="muted" style={{ textAlign: 'center' }}>
              You don’t have any shelves yet. Create your first shelf above to organize your reading!
            </Txt>
          </View>
        ) : (
          <ScrollView
            style={{ maxHeight: 320 }}
            keyboardShouldPersistTaps="handled"
            showsVerticalScrollIndicator={false}
          >
            <View style={{ gap: space[2] }}>
              {shelves.map((shelf) => {
                const isSelected = shelf.contains_work;
                const isEditingThisNote = activeNoteShelfId === shelf.id;

                return (
                  <View
                    key={shelf.id}
                    style={[
                      styles.shelfCard,
                      {
                        backgroundColor: isSelected ? c.accentSoft : c.surface,
                        borderColor: isSelected ? c.accent : c.line,
                      },
                    ]}
                  >
                    <Pressable
                      onPress={() => handleToggleShelf(shelf)}
                      accessibilityRole="checkbox"
                      accessibilityState={{ checked: isSelected }}
                      accessibilityLabel={`${shelf.name}, ${isSelected ? 'Selected' : 'Unselected'}`}
                      style={styles.shelfRow}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <View style={styles.shelfNameRow}>
                          <Txt
                            variant="body"
                            style={{ fontWeight: isSelected ? '700' : '500' }}
                            numberOfLines={1}
                          >
                            {shelf.name}
                          </Txt>
                          {shelf.privacy !== 'public' && (
                            <View style={[styles.badge, { backgroundColor: c.surface2 }]}>
                              <Ionicons
                                name={shelf.privacy === 'private' ? 'lock-closed' : 'people'}
                                size={11}
                                color={c.muted}
                              />
                            </View>
                          )}
                          {shelf.is_ranked && (
                            <View style={[styles.badge, { backgroundColor: c.accentSoft }]}>
                              <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
                                Ranked
                              </Txt>
                            </View>
                          )}
                        </View>
                        <Txt variant="micro" color="muted">
                          {shelf.item_count} {shelf.item_count === 1 ? 'book' : 'books'}
                        </Txt>
                      </View>

                      {/* Checkbox Icon */}
                      <Ionicons
                        name={isSelected ? 'checkbox' : 'square-outline'}
                        size={24}
                        color={isSelected ? c.accent : c.lineStrong}
                      />
                    </Pressable>

                    {/* Per-Entry Note Display / Trigger */}
                    {isSelected && (
                      <View style={[styles.noteSection, { borderTopColor: c.line }]}>
                        {isEditingThisNote ? (
                          <View style={{ gap: space[2] }}>
                            <View style={styles.noteHeader}>
                              <Txt variant="micro" color="muted">
                                NOTE FOR THIS BOOK (OPTIONAL)
                              </Txt>
                              <Txt
                                variant="micro"
                                color={noteDraft.length > 280 ? 'critical' : 'muted'}
                                tabular
                              >
                                {noteDraft.length}/280
                              </Txt>
                            </View>
                            <TextInput
                              value={noteDraft}
                              onChangeText={(t) => {
                                setNoteDraft(t);
                                if (noteError) setNoteError(null);
                              }}
                              placeholder="e.g. Read this one first, stunning ending"
                              placeholderTextColor={c.muted}
                              maxLength={280}
                              multiline
                              style={[
                                styles.noteInput,
                                {
                                  color: c.ink,
                                  backgroundColor: c.surface,
                                  borderColor: noteError ? c.critical : c.line,
                                },
                              ]}
                            />
                            {noteError ? (
                              <Txt variant="micro" color="critical">
                                {noteError}
                              </Txt>
                            ) : null}
                            <View style={styles.createActions}>
                              <Button
                                label="Cancel"
                                variant="tertiary"
                                size="sm"
                                onPress={() => setActiveNoteShelfId(null)}
                              />
                              <Button
                                label="Save Note"
                                variant="primary"
                                size="sm"
                                loading={savingNote}
                                onPress={() => handleSaveNote(shelf.id)}
                              />
                            </View>
                          </View>
                        ) : (
                          <Pressable
                            onPress={() => handleOpenNoteEditor(shelf)}
                            accessibilityRole="button"
                            accessibilityLabel={shelf.item_note ? 'Edit note' : 'Add note'}
                            style={styles.noteTriggerRow}
                          >
                            <Ionicons name="chatbox-ellipses-outline" size={16} color={c.accent} />
                            <Txt
                              variant="caption"
                              color={shelf.item_note ? 'ink' : 'accent'}
                              numberOfLines={1}
                              style={{ flex: 1, fontStyle: shelf.item_note ? 'italic' : 'normal' }}
                            >
                              {shelf.item_note ? `"${shelf.item_note}"` : '+ Add note for this book'}
                            </Txt>
                            <Ionicons name="pencil-outline" size={14} color={c.muted} />
                          </Pressable>
                        )}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          </ScrollView>
        )}

        {/* Done Button */}
        <Button label="Done" variant="primary" onPress={onClose} style={{ marginTop: space[2] }} />
      </View>
    </BottomSheet>
  );
}

const styles = StyleSheet.create({
  bookHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    paddingBottom: space[2],
  },
  createTrigger: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingVertical: space[3],
    paddingHorizontal: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
    borderStyle: 'dashed',
    justifyContent: 'center',
  },
  inlineCreateBox: {
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
    gap: space[2],
  },
  input: {
    minHeight: 44,
    paddingHorizontal: space[3],
    borderRadius: radius.sm,
    borderWidth: 1,
    fontSize: 14,
  },
  createActions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    gap: space[2],
  },
  errorBox: {
    padding: space[3],
    alignItems: 'center',
    gap: space[2],
  },
  emptyShelves: {
    paddingVertical: space[4],
    alignItems: 'center',
  },
  shelfCard: {
    borderRadius: radius.md,
    borderWidth: 1,
    overflow: 'hidden',
  },
  shelfRow: {
    flexDirection: 'row',
    alignItems: 'center',
    padding: space[3],
    gap: space[3],
  },
  shelfNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
  },
  badge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: radius.pill,
    alignItems: 'center',
    justifyContent: 'center',
  },
  noteSection: {
    borderTopWidth: 1,
    padding: space[3],
    paddingTop: space[2],
  },
  noteHeader: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
  },
  noteInput: {
    minHeight: 56,
    padding: space[2],
    borderRadius: radius.sm,
    borderWidth: 1,
    fontSize: 13,
    textAlignVertical: 'top',
  },
  noteTriggerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[2],
    paddingVertical: 2,
  },
});
