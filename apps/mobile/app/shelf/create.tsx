// Create Shelf Screen (SH-02, PRD §15.2).
//
// Allows creating a user-defined shelf or reading list with:
// - Name (1–60 chars, trimmed)
// - Description (optional, max 2000 chars)
// - Privacy: public, followers, private
// - Ranked list toggle

import React, { useEffect, useState } from 'react';
import {
  View,
  ScrollView,
  Pressable,
  TextInput,
  StyleSheet,
  Alert,
  KeyboardAvoidingView,
} from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { api, type ShelfPrivacy } from '@/lib/api';
import { findNameCollision, validateShelfForm } from '@/lib/shelfValidation';
import { track } from '@/lib/events';
import { Button, Field, Screen, Txt, Toggle } from '@/ui/components';
import { familyFor, radius, space, useTheme } from '@/ui/tokens';

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
  // The viewer's shelf names, to warn on a duplicate (PRD §6.35, audit 11).
  const [existingNames, setExistingNames] = useState<string[]>([]);

  useEffect(() => {
    api.getMyShelves().then((res) => setExistingNames(res.shelves.map((s) => s.name))).catch(() => {});
  }, []);

  const validation = validateShelfForm({
    name,
    description,
    privacy,
    is_ranked: isRanked,
  });

  const handleCreate = () => {
    setNameTouched(true);
    if (!validation.isValid) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      return;
    }
    // Allowed but warned (PRD §6.35): the server gives it its own link.
    const clash = findNameCollision(name, existingNames);
    if (clash) {
      Alert.alert('You already have this shelf', `You already have a shelf called "${clash}". Create another one with the same name?`, [
        { text: 'Cancel', style: 'cancel' },
        { text: 'Create anyway', onPress: () => void createShelf() },
      ]);
      return;
    }
    void createShelf();
  };

  const createShelf = async () => {
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
        'Failed to create shelf',
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
      label: 'Followers only',
      description: 'Only your approved followers can view',
    },
    {
      id: 'private',
      label: 'Private',
      description: 'Only you can see this shelf',
    },
  ];

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
          <Txt variant="displayL">New shelf</Txt>

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
            autoFocus
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
            <Toggle
              accessibilityLabel="Ranked"
              value={isRanked}
              onValueChange={(val) => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                setIsRanked(val);
              }}
            />
          </View>

          {/* The one primary action */}
          <Button
            label="Save"
            onPress={handleCreate}
            disabled={submitting || (nameTouched && !validation.isValid)}
            loading={submitting}
          />
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
});
