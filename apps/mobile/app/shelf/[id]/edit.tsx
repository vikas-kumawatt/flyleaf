// Edit Shelf Screen (SH-02, PRD §15.2, §15.6).
//
// Features:
// - Pre-fill shelf details
// - Edit name, description, privacy, ranked toggle
// - Warning confirmation when unranking an already-ranked list
// - Soft-delete with 30-day recovery notification

import React, { useState, useEffect } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  Switch,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type Shelf, type ShelfPrivacy } from '@/lib/api';
import { validateShelfForm } from '@/lib/shelfValidation';
import { track } from '@/lib/events';
import { Button, Field, Screen, Txt, Skeleton } from '@/ui/components';
import { familyFor, radius, space, useTheme } from '@/ui/tokens';

export default function EditShelfScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [initialShelf, setInitialShelf] = useState<Shelf | null>(null);

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<ShelfPrivacy>('public');
  const [isRanked, setIsRanked] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);

  useEffect(() => {
    let mounted = true;
    async function loadShelf() {
      if (!id) return;
      try {
        setLoading(true);
        const res = await api.getShelf(id);
        if (mounted && res.shelf) {
          setInitialShelf(res.shelf);
          setName(res.shelf.name);
          setDescription(res.shelf.description || '');
          setPrivacy(res.shelf.privacy);
          setIsRanked(res.shelf.is_ranked);
        }
      } catch (err: any) {
        Alert.alert('Error', err?.message || 'Failed to load shelf details.');
        router.back();
      } finally {
        if (mounted) setLoading(false);
      }
    }
    loadShelf();
    return () => {
      mounted = false;
    };
  }, [id, router]);

  const validation = validateShelfForm({
    name,
    description,
    privacy,
    is_ranked: isRanked,
  });

  const handleRankedToggle = (nextVal: boolean) => {
    // If transitioning from ranked to unranked, prompt confirmation warning (PRD §15.2)
    if (initialShelf?.is_ranked && !nextVal) {
      Alert.alert(
        'Switch to unranked?',
        'Switching this shelf to an unranked list will clear custom ranking order. Are you sure you want to continue?',
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => setIsRanked(true),
          },
          {
            text: 'Make unranked',
            style: 'destructive',
            onPress: () => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              setIsRanked(false);
            },
          },
        ],
      );
    } else {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      setIsRanked(nextVal);
    }
  };

  const handleSave = async () => {
    if (!id) return;
    setNameTouched(true);
    if (!validation.isValid) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    try {
      setSaving(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const res = await api.updateShelf(id, {
        name: name.trim(),
        description: description.trim() || null,
        privacy,
        is_ranked: isRanked,
      });

      track('shelf_edited', {
        shelf_id: res.shelf.id,
        is_ranked: res.shelf.is_ranked,
        privacy: res.shelf.privacy,
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Failed to update shelf',
        err?.message || 'Something went wrong while updating your shelf. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!id) return;
    Alert.alert(
      'Delete shelf?',
      'This shelf will be hidden and scheduled for deletion. You can recover it within 30 days.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              setDeleting(true);
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy);
              await api.deleteShelf(id);

              track('shelf_deleted', { shelf_id: id });
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
              router.back();
            } catch (err: any) {
              void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
              Alert.alert('Failed to delete shelf', err?.message || 'Could not delete shelf.');
            } finally {
              setDeleting(false);
            }
          },
        },
      ],
    );
  };

  const privacyOptions: { id: ShelfPrivacy; label: string; description: string }[] = [
    {
      id: 'public',
      label: 'Public',
      description: 'Anyone on Flyleaf can view this shelf',
    },
    {
      id: 'followers',
      label: 'Followers only',
      description: 'Only your approved followers can view',
    },
    {
      id: 'private',
      label: 'Private',
      description: 'Only you can see this shelf',
    },
  ];

  if (loading) {
    return (
      <Screen style={{ backgroundColor: c.ground, paddingTop: Math.max(insets.top, space[3]) }}>
        {/* Loading shelf details: the shape of the screen, not a spinner (design.md §5) */}
        <View style={{ height: 44, paddingHorizontal: space[4], justifyContent: 'center' }}>
          <Skeleton width={24} height={24} borderRadius={radius.sm} />
        </View>
        <View
          style={{ padding: space[4], gap: space[6] }}
          accessible
          accessibilityLabel="Loading shelf details"
          accessibilityState={{ busy: true }}
        >
          {[44, 96, 44].map((h, k) => (
            <View key={k} style={{ gap: space[2] }}>
              <Skeleton width={80} height={12} />
              <Skeleton width="100%" height={h} borderRadius={radius.md} />
            </View>
          ))}
        </View>
      </Screen>
    );
  }

  return (
    <Screen>
      {/* Top bar: just the way out; the title is the page's first line */}
      <View style={[styles.topBar, { paddingTop: Math.max(insets.top, space[3]) }]}>
        <Button label="Cancel" variant="tertiary" onPress={() => router.back()} />
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior="padding"
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space[6] }]}
          keyboardShouldPersistTaps="handled"
        >
          <Txt variant="displayL">Edit shelf</Txt>

          <Field
            label="Name"
            value={name}
            onChangeText={(t) => {
              setName(t);
              if (!nameTouched) setNameTouched(true);
            }}
            autoCapitalize="sentences"
            placeholder="Comfort reads"
            maxLength={60}
            returnKeyType="next"
            error={nameTouched ? validation.errors.name : undefined}
          />

          {/* Description: Field has no multiline, so this matches its label and box */}
          <View style={{ gap: space[1] }}>
            <View style={styles.labelRow}>
              <Txt variant="micro" color="ink2">
                Description (optional)
              </Txt>
              <Txt variant="micro" color="muted" tabular>
                {description.length}/2000
              </Txt>
            </View>
            <TextInput
              style={[
                styles.textArea,
                {
                  backgroundColor: c.surface,
                  borderColor: validation.errors.description ? c.critical : c.lineStrong,
                  color: c.ink,
                  fontFamily: familyFor(false, '400'),
                },
              ]}
              accessibilityLabel="Description"
              placeholder="What ties these books together"
              placeholderTextColor={c.muted}
              value={description}
              maxLength={2000}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              onChangeText={setDescription}
            />
            {validation.errors.description ? (
              <Txt variant="caption" color="critical">
                {validation.errors.description}
              </Txt>
            ) : null}
          </View>

          {/* Privacy: ruled radio rows */}
          <View style={{ gap: space[1] }}>
            <Txt variant="micro" color="ink2">
              Privacy
            </Txt>
            <View
              accessibilityRole="radiogroup"
              style={{ borderTopWidth: 1, borderBottomWidth: 1, borderColor: c.line }}
            >
              {privacyOptions.map((opt, index) => {
                const selected = privacy === opt.id;
                return (
                  <Pressable
                    key={opt.id}
                    accessibilityRole="radio"
                    accessibilityState={{ selected }}
                    onPress={() => {
                      void Haptics.selectionAsync();
                      setPrivacy(opt.id);
                    }}
                    style={({ pressed }) => [
                      styles.optionRow,
                      {
                        borderTopWidth: index ? 1 : 0,
                        borderTopColor: c.line,
                        backgroundColor: pressed ? c.surface2 : 'transparent',
                      },
                    ]}
                  >
                    <View style={{ flex: 1, gap: space[1] }}>
                      <Txt variant="body" style={{ fontWeight: selected ? '500' : '400' }}>
                        {opt.label}
                      </Txt>
                      <Txt variant="caption" color="muted">
                        {opt.description}
                      </Txt>
                    </View>
                    <Ionicons
                      name={selected ? 'radio-button-on' : 'radio-button-off'}
                      size={22}
                      color={selected ? c.accent : c.muted}
                    />
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Ranked toggle */}
          <View style={[styles.switchRow, { borderColor: c.line }]}>
            <View style={{ flex: 1, gap: space[1] }}>
              <Txt variant="body">Ranked</Txt>
              <Txt variant="caption" color="muted">
                Books are numbered 1, 2, 3… and can be reordered.
              </Txt>
            </View>
            <Switch
              accessibilityLabel="Ranked"
              value={isRanked}
              onValueChange={handleRankedToggle}
              trackColor={{ false: c.lineStrong, true: c.accent }}
            />
          </View>

          {/* The one primary action */}
          <Button
            label="Save"
            onPress={handleSave}
            disabled={saving || (nameTouched && !validation.isValid)}
            loading={saving}
          />

          {/* Delete: a ruled section, outlined destructive action */}
          <View style={[styles.dangerZone, { borderTopColor: c.line }]}>
            <Txt variant="title">Delete shelf</Txt>
            <Txt variant="caption" color="muted">
              The shelf disappears from view straight away. You can restore it for 30 days, then it is deleted for good.
            </Txt>
            <Button
              variant="destructive"
              label="Delete shelf"
              onPress={handleDelete}
              disabled={deleting}
              loading={deleting}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  topBar: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: space[2],
  },
  content: {
    padding: space[4],
    gap: space[6],
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
  },
  textArea: {
    minHeight: 104,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space[3],
    paddingVertical: space[3],
    fontSize: 15,
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 48,
    paddingVertical: space[3],
  },
  switchRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: space[3],
    minHeight: 48,
    paddingVertical: space[3],
    borderTopWidth: 1,
    borderBottomWidth: 1,
  },
  dangerZone: {
    gap: space[2],
    paddingTop: space[6],
    borderTopWidth: 1,
  },
});
