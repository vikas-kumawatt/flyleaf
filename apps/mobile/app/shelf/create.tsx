// Create Shelf Screen (SH-02, PRD §15.2).
//
// Allows creating a user-defined shelf or reading list with:
// - Name (1–60 chars, trimmed)
// - Description (optional, max 2000 chars)
// - Privacy: public, followers, private
// - Ranked list toggle

import React, { useState } from 'react';
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
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { api, type ShelfPrivacy } from '@/lib/api';
import { validateShelfForm } from '@/lib/shelfValidation';
import { track } from '@/lib/events';
import { Button, Screen, Txt } from '@/ui/components';
import { radius, space, useTheme } from '@/ui/tokens';

export default function CreateShelfScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [privacy, setPrivacy] = useState<ShelfPrivacy>('public');
  const [isRanked, setIsRanked] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [nameTouched, setNameTouched] = useState(false);

  const validation = validateShelfForm({
    name,
    description,
    privacy,
    is_ranked: isRanked,
  });

  const handleCreate = async () => {
    setNameTouched(true);
    if (!validation.isValid) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }

    try {
      setSubmitting(true);
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

      const res = await api.createShelf({
        name: name.trim(),
        description: description.trim() || undefined,
        privacy,
        is_ranked: isRanked,
      });

      track('shelf_created', {
        shelf_id: res.shelf.id,
        is_ranked: res.shelf.is_ranked,
        privacy: res.shelf.privacy,
      });

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch (err: any) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        'Failed to Create Shelf',
        err?.message || 'Something went wrong while creating your shelf. Please try again.',
      );
    } finally {
      setSubmitting(false);
    }
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

        <Txt style={{ fontSize: 17, fontWeight: '700', color: c.ink }}>New Shelf</Txt>

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Create shelf"
          disabled={submitting || (nameTouched && !validation.isValid)}
          hitSlop={12}
          onPress={handleCreate}
        >
          {submitting ? (
            <ActivityIndicator size="small" color={c.accent} />
          ) : (
            <Txt
              style={{
                color: nameTouched && !validation.isValid ? c.muted : c.accent,
                fontSize: 16,
                fontWeight: '700',
              }}
            >
              Create
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
              autoFocus
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
                onValueChange={(val) => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                  setIsRanked(val);
                }}
                trackColor={{ false: c.line, true: c.accent }}
              />
            </View>
          </View>

          {/* Bottom Create Button */}
          <View style={{ marginTop: space[4] }}>
            <Button
              label={submitting ? 'Creating Shelf...' : 'Create Shelf'}
              onPress={handleCreate}
              disabled={submitting || (nameTouched && !validation.isValid)}
              loading={submitting}
              style={{ width: '100%' }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </Screen>
  );
}

const styles = StyleSheet.create({
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
});
