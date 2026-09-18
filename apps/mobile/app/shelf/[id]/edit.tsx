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
  ActivityIndicator,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, type Shelf, type ShelfPrivacy } from '@/lib/api';
import { validateShelfForm } from '@/lib/shelfValidation';
import { track } from '@/lib/events';
import { Button, Screen, Txt } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

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
        'Switch to Unranked?',
        'Switching this shelf to an unranked list will clear custom ranking order. Are you sure you want to continue?',
        [
          {
            text: 'Cancel',
            style: 'cancel',
            onPress: () => setIsRanked(true),
          },
          {
            text: 'Make Unranked',
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
        'Failed to Update Shelf',
        err?.message || 'Something went wrong while updating your shelf. Please try again.',
      );
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = () => {
    if (!id) return;
    Alert.alert(
      'Delete Shelf?',
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
              Alert.alert('Failed to Delete Shelf', err?.message || 'Could not delete shelf.');
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
      label: 'Followers Only',
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
      <Screen style={[styles.center, { backgroundColor: c.ground }]}>
        <ActivityIndicator size="large" color={c.accent} />
        <Txt style={{ color: c.muted, marginTop: space[3] }}>Loading shelf details...</Txt>
      </Screen>
    );
  }

  return (
    <Screen style={{ flex: 1, backgroundColor: c.ground }}>
      {/* Top App Bar */}
      <View
        style={[
          styles.header,
          {
            paddingTop: Math.max(insets.top, space[3]),
            borderBottomColor: c.line,
          },
        ]}
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel"
          hitSlop={12}
          onPress={() => router.back()}
        >
          <Txt style={{ color: c.muted, fontSize: 16 }}>Cancel</Txt>
        </Pressable>

        <Txt style={{ fontSize: 17, fontWeight: '700', color: c.ink }}>Edit Shelf</Txt>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save changes"
          disabled={saving || (nameTouched && !validation.isValid)}
          hitSlop={12}
          onPress={handleSave}
        >
          {saving ? (
            <ActivityIndicator size="small" color={c.accent} />
          ) : (
            <Txt
              style={{
                color: nameTouched && !validation.isValid ? c.muted : c.accent,
                fontSize: 16,
                fontWeight: '700',
              }}
            >
              Save
            </Txt>
          )}
        </Pressable>
      </View>

      <KeyboardAvoidingView
        style={{ flex: 1 }}
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      >
        <ScrollView
          contentContainerStyle={[styles.content, { paddingBottom: insets.bottom + space[6] }]}
          keyboardShouldPersistTaps="handled"
        >
          {/* Name Field */}
          <View style={styles.section}>
            <View style={styles.labelRow}>
              <Txt style={[styles.label, { color: c.ink }]}>Shelf Name</Txt>
              <Txt style={[styles.counter, { color: c.muted }]}>
                {name.length}/60
              </Txt>
            </View>
            <TextInput
              style={[
                styles.input,
                {
                  backgroundColor: c.surface,
                  borderColor: nameTouched && validation.errors.name ? c.critical : c.line,
                  color: c.ink,
                },
              ]}
              placeholder="e.g. Best Sci-Fi 2026, Summer Reads..."
              placeholderTextColor={c.muted}
              value={name}
              maxLength={60}
              onChangeText={(t) => {
                setName(t);
                if (!nameTouched) setNameTouched(true);
              }}
              returnKeyType="next"
            />
            {nameTouched && validation.errors.name && (
              <Txt style={[styles.errorText, { color: c.critical }]}>
                {validation.errors.name}
              </Txt>
            )}
          </View>

          {/* Description Field */}
          <View style={styles.section}>
            <View style={styles.labelRow}>
              <Txt style={[styles.label, { color: c.ink }]}>Description (optional)</Txt>
              <Txt style={[styles.counter, { color: c.muted }]}>
                {description.length}/2000
              </Txt>
            </View>
            <TextInput
              style={[
                styles.textArea,
                {
                  backgroundColor: c.surface,
                  borderColor: c.line,
                  color: c.ink,
                },
              ]}
              placeholder="What makes this list special? Add notes, themes, or context."
              placeholderTextColor={c.muted}
              value={description}
              maxLength={2000}
              multiline
              numberOfLines={4}
              textAlignVertical="top"
              onChangeText={setDescription}
            />
          </View>

          {/* Privacy Selector */}
          <View style={styles.section}>
            <Txt style={[styles.label, { color: c.ink, marginBottom: space[2] }]}>Privacy</Txt>
            <View style={{ gap: space[2] }}>
              {privacyOptions.map((opt) => {
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
                    style={[
                      styles.optionCard,
                      {
                        backgroundColor: selected ? c.accentSoft : c.surface,
                        borderColor: selected ? c.accent : c.line,
                      },
                    ]}
                  >
                    <View style={styles.optionHeader}>
                      <Txt
                        style={[
                          styles.optionTitle,
                          { color: selected ? c.accent : c.ink, fontWeight: selected ? '700' : '600' },
                        ]}
                      >
                        {opt.label}
                      </Txt>
                      <View
                        style={[
                          styles.radioCircle,
                          {
                            borderColor: selected ? c.accent : c.line,
                            backgroundColor: selected ? c.accent : 'transparent',
                          },
                        ]}
                      >
                        {selected && <View style={styles.radioInner} />}
                      </View>
                    </View>
                    <Txt style={[styles.optionDesc, { color: c.muted }]}>
                      {opt.description}
                    </Txt>
                  </Pressable>
                );
              })}
            </View>
          </View>

          {/* Ranked Toggle */}
          <View style={styles.section}>
            <View
              style={[
                styles.switchCard,
                {
                  backgroundColor: c.surface,
                  borderColor: c.line,
                },
              ]}
            >
              <View style={{ flex: 1, paddingRight: space[3] }}>
                <Txt style={[styles.switchTitle, { color: c.ink }]}>Ranked List</Txt>
                <Txt style={[styles.switchDesc, { color: c.muted }]}>
                  Items are numbered sequentially (1, 2, 3...) and can be reordered.
                </Txt>
              </View>
              <Switch
                value={isRanked}
                onValueChange={handleRankedToggle}
                trackColor={{ false: c.line, true: c.accent }}
              />
            </View>
          </View>

          {/* Bottom Save Button */}
          <View style={{ marginTop: space[3] }}>
            <Button
              label={saving ? 'Saving Changes...' : 'Save Changes'}
              onPress={handleSave}
              disabled={saving || (nameTouched && !validation.isValid)}
              loading={saving}
              style={{ width: '100%' }}
            />
          </View>

          {/* Danger Zone: Delete Shelf */}
          <View style={[styles.dangerZone, { borderColor: c.critical }]}>
            <Txt style={[styles.dangerTitle, { color: c.critical }]}>
              Danger Zone
            </Txt>
            <Txt style={[styles.dangerDesc, { color: c.muted }]}>
              Deleting a shelf removes it from public view. You can restore deleted shelves within 30 days before they are permanently purged.
            </Txt>
            <Button
              variant="destructive"
              label={deleting ? 'Deleting Shelf...' : 'Delete Shelf'}
              onPress={handleDelete}
              disabled={deleting}
              loading={deleting}
              style={{ width: '100%', marginTop: space[2] }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: space[4],
    paddingBottom: space[3],
    borderBottomWidth: StyleSheet.hairlineWidth,
  },
  content: {
    padding: space[4],
    gap: space[4],
  },
  section: {
    gap: space[1],
  },
  labelRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'baseline',
    marginBottom: space[1],
  },
  label: {
    fontSize: 14,
    fontWeight: '600',
  },
  counter: {
    fontSize: 12,
  },
  input: {
    height: 48,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space[3],
    fontSize: 16,
  },
  textArea: {
    height: 100,
    borderRadius: radius.md,
    borderWidth: 1,
    paddingHorizontal: space[3],
    paddingVertical: space[2],
    fontSize: 15,
  },
  errorText: {
    fontSize: 12,
    marginTop: space[1],
  },
  optionCard: {
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1.5,
    gap: space[1],
  },
  optionHeader: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  optionTitle: {
    fontSize: 15,
  },
  optionDesc: {
    fontSize: 13,
  },
  radioCircle: {
    width: 20,
    height: 20,
    borderRadius: 10,
    borderWidth: 2,
    alignItems: 'center',
    justifyContent: 'center',
  },
  radioInner: {
    width: 8,
    height: 8,
    borderRadius: 4,
    backgroundColor: '#fff',
  },
  switchCard: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: space[3],
    borderRadius: radius.md,
    borderWidth: 1,
  },
  switchTitle: {
    fontSize: 15,
    fontWeight: '600',
    marginBottom: space[1],
  },
  switchDesc: {
    fontSize: 13,
    lineHeight: 18,
  },
  dangerZone: {
    marginTop: space[4],
    padding: space[4],
    borderRadius: radius.md,
    borderWidth: 1,
    gap: space[2],
  },
  dangerTitle: {
    fontSize: 15,
    fontWeight: '700',
  },
  dangerDesc: {
    fontSize: 13,
    lineHeight: 18,
  },
});
