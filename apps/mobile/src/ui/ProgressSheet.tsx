// Progress Update Sheet (SL-53, PRD §6.16, §8.4).
//
// Governed by:
//   1. Precise numeric entry for pages or percent.
//   2. Quick chips (+10, +25, +50).
//   3. Optional session minutes — never prompted, unlocks reading-speed metrics.
//   4. Optional note (max 280 chars) and quote capture.
//   5. Shortcut to Finish flow.

import React, { useState, useEffect } from 'react';
import {
  View,
  TextInput,
  Pressable,
  ScrollView,
  KeyboardAvoidingView,
  Platform,
  Text,
  TextStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { BottomSheet, Button, Txt, sheet } from './components';
import { radius, space, useTheme, type as t } from './tokens';

interface ProgressSheetProps {
  visible: boolean;
  onClose: () => void;
  title: string;
  currentPage: number | null;
  pageCount: number | null;
  onSave: (data: {
    page: number | null;
    percent: number | null;
    minutes: number | null;
    note: string | null;
    quote: string | null;
  }) => void;
  onFinishShortcut: () => void;
}

export function ProgressSheet({
  visible,
  onClose,
  title,
  currentPage,
  pageCount,
  onSave,
  onFinishShortcut,
}: ProgressSheetProps) {
  const c = useTheme();

  const [pageInput, setPageInput] = useState(currentPage ? String(currentPage) : '');
  const [minutesInput, setMinutesInput] = useState('');
  const [noteInput, setNoteInput] = useState('');
  const [quoteInput, setQuoteInput] = useState('');
  const [showQuote, setShowQuote] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (visible) {
      setPageInput(currentPage ? String(currentPage) : '');
      setMinutesInput('');
      setNoteInput('');
      setQuoteInput('');
      setShowQuote(false);
      setError(null);
    }
  }, [visible, currentPage]);

  const handleAddDelta = (delta: number) => {
    void Haptics.selectionAsync();
    const current = parseInt(pageInput, 10) || (currentPage ?? 0);
    const target = current + delta;
    setPageInput(String(target));
  };

  const handleSelectMinutes = (m: number) => {
    void Haptics.selectionAsync();
    setMinutesInput(String(m));
  };

  const handleSave = () => {
    const num = parseInt(pageInput, 10);
    if (isNaN(num) || num < 0) {
      setError('Please enter a valid page number.');
      return;
    }

    if (pageCount && num > pageCount) {
      setError(`Page exceeds total count (${pageCount}). Did you finish the book?`);
      return;
    }

    const minutes = minutesInput ? parseInt(minutesInput, 10) : null;
    const finalNote = quoteInput.trim()
      ? `“${quoteInput.trim()}”${noteInput.trim() ? ` — ${noteInput.trim()}` : ''}`
      : noteInput.trim() || null;

    const percent = pageCount && pageCount > 0 ? Math.round((num / pageCount) * 100) : null;

    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    onSave({
      page: num,
      percent,
      minutes: minutes && minutes > 0 ? minutes : null,
      note: finalNote,
      quote: quoteInput.trim() || null,
    });
    onClose();
  };

  return (
    <BottomSheet visible={visible} onClose={onClose} title={`Update — ${title}`}>
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        keyboardVerticalOffset={20}
      >
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: space[4], paddingBottom: space[4] }}
        >
          {/* Page Number Entry & Quick Delta Chips */}
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                CURRENT PAGE {pageCount ? `(OF ${pageCount})` : ''}
              </Txt>
              {pageCount && (
                <Txt variant="micro" color="ink2" tabular>
                  {pageInput && !isNaN(parseInt(pageInput, 10))
                    ? `${Math.min(100, Math.round((parseInt(pageInput, 10) / pageCount) * 100))}%`
                    : '0%'}
                </Txt>
              )}
            </View>

            <TextInput
              value={pageInput}
              onChangeText={(txt) => {
                setError(null);
                setPageInput(txt.replace(/[^0-9]/g, ''));
              }}
              placeholder="e.g. 142"
              keyboardType="number-pad"
              placeholderTextColor={c.muted}
              autoFocus
              accessibilityLabel="Current page number"
              style={{
                fontSize: 28,
                fontWeight: '700',
                paddingHorizontal: space[3],
                paddingVertical: space[2],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: error ? c.critical : c.line,
                backgroundColor: c.surface2,
                color: c.ink,
              }}
            />

            {error && (
              <View style={[sheet.row, { justifyContent: 'space-between', flexWrap: 'wrap' }]}>
                <Txt variant="caption" color="critical">
                  {error}
                </Txt>
                {pageCount && parseInt(pageInput, 10) >= pageCount && (
                  <Pressable
                    onPress={() => {
                      onClose();
                      onFinishShortcut();
                    }}
                  >
                    <Txt variant="caption" color="accent" style={{ fontWeight: '600' }}>
                      Finish book now →
                    </Txt>
                  </Pressable>
                )}
              </View>
            )}

            {/* Quick increment chips */}
            <View style={[sheet.row, { gap: space[2], marginTop: space[1] }]}>
              {[10, 25, 50].map((delta) => (
                <Pressable
                  key={delta}
                  onPress={() => handleAddDelta(delta)}
                  accessibilityRole="button"
                  accessibilityLabel={`Add ${delta} pages`}
                  style={{
                    flex: 1,
                    paddingVertical: space[2],
                    borderRadius: radius.sm,
                    backgroundColor: c.surface2,
                    borderWidth: 1,
                    borderColor: c.line,
                    alignItems: 'center',
                  }}
                >
                  <Txt variant="caption" color="ink" style={{ fontWeight: '600' }}>
                    +{delta}
                  </Txt>
                </Pressable>
              ))}
            </View>
          </View>

          {/* Optional Session Minutes (PRD §8.4) */}
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                TIME SPENT (OPTIONAL)
              </Txt>
              <Txt variant="micro" color="muted">
                Unlocks reading speed
              </Txt>
            </View>

            <View style={[sheet.row, { gap: space[2] }]}>
              {[15, 30, 45, 60].map((m) => {
                const isSelected = minutesInput === String(m);
                return (
                  <Pressable
                    key={m}
                    onPress={() => handleSelectMinutes(m)}
                    accessibilityRole="button"
                    accessibilityLabel={`${m} minutes`}
                    style={{
                      flex: 1,
                      paddingVertical: space[2],
                      borderRadius: radius.sm,
                      backgroundColor: isSelected ? c.accentSoft : c.surface2,
                      borderWidth: 1,
                      borderColor: isSelected ? c.accent : c.line,
                      alignItems: 'center',
                    }}
                  >
                    <Txt
                      variant="caption"
                      color={isSelected ? 'accent' : 'ink'}
                      style={{ fontWeight: isSelected ? '700' : '400' }}
                    >
                      {m}m
                    </Txt>
                  </Pressable>
                );
              })}
            </View>

            <TextInput
              value={minutesInput}
              onChangeText={(txt) => setMinutesInput(txt.replace(/[^0-9]/g, ''))}
              placeholder="Or enter custom minutes"
              keyboardType="number-pad"
              placeholderTextColor={c.muted}
              accessibilityLabel="Custom reading session minutes"
              style={{
                height: 42,
                paddingHorizontal: space[3],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.line,
                backgroundColor: c.surface2,
                color: c.ink,
                fontSize: 14,
              }}
            />
          </View>

          {/* Note Field (280 char limit) */}
          <View style={{ gap: space[1] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                PRIVATE NOTE (OPTIONAL)
              </Txt>
              <Txt
                variant="micro"
                color={noteInput.length > 260 ? 'critical' : 'muted'}
                tabular
              >
                {noteInput.length}/280
              </Txt>
            </View>

            <TextInput
              value={noteInput}
              onChangeText={(txt) => {
                if (txt.length <= 280) setNoteInput(txt);
              }}
              placeholder="Thoughts, reflections, or where you stopped..."
              placeholderTextColor={c.muted}
              multiline
              numberOfLines={3}
              accessibilityLabel="Private progress note"
              style={{
                minHeight: 70,
                paddingHorizontal: space[3],
                paddingVertical: space[2],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.line,
                backgroundColor: c.surface2,
                color: c.ink,
                fontSize: 14,
                textAlignVertical: 'top',
              }}
            />
          </View>

          {/* Save a Quote Toggle */}
          <View style={{ gap: space[2] }}>
            {!showQuote ? (
              <Pressable
                onPress={() => {
                  void Haptics.selectionAsync();
                  setShowQuote(true);
                }}
                accessibilityRole="button"
                accessibilityLabel="Save a quote from this section"
                style={{ paddingVertical: space[1] }}
              >
                <Txt variant="caption" color="accent">
                  + Save a quote from this section
                </Txt>
              </Pressable>
            ) : (
              <View style={{ gap: space[1] }}>
                <Txt variant="caption" color="muted">
                  QUOTE
                </Txt>
                <TextInput
                  value={quoteInput}
                  onChangeText={setQuoteInput}
                  placeholder="Paste or transcribe quote..."
                  placeholderTextColor={c.muted}
                  multiline
                  numberOfLines={2}
                  accessibilityLabel="Transcribe quote"
                  style={{
                    minHeight: 60,
                    paddingHorizontal: space[3],
                    paddingVertical: space[2],
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: c.accent,
                    backgroundColor: c.surface2,
                    color: c.ink,
                    fontSize: 14,
                    fontStyle: 'italic',
                    textAlignVertical: 'top',
                  }}
                />
              </View>
            )}
          </View>

          {/* Action Buttons */}
          <View style={{ gap: space[2], marginTop: space[2] }}>
            <Button label="Save progress" variant="primary" onPress={handleSave} />
            <Button
              label="I finished this book"
              variant="tertiary"
              onPress={() => {
                onClose();
                onFinishShortcut();
              }}
            />
          </View>
        </ScrollView>
      </KeyboardAvoidingView>
    </BottomSheet>
  );
}
