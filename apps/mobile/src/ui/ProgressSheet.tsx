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
  Text,
  TextStyle,
} from 'react-native';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { BottomSheet, Button, Chip, Txt, sheet } from './components';
import { radius, space, useTheme, type as t, fontFamilies } from './tokens';

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
    <BottomSheet visible={visible} onClose={onClose} title="Update progress">
      <View>
        <ScrollView
          showsVerticalScrollIndicator={false}
          contentContainerStyle={{ gap: space[4], paddingBottom: space[4] }}
        >
          <Txt variant="body" color="ink2" numberOfLines={1}>
            {title}
          </Txt>
          {/* Page Number Entry & Quick Delta Chips */}
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                Current page{pageCount ? ` of ${pageCount}` : ''}
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
                fontFamily: fontFamilies.uiMedium,
                fontSize: 28,
                fontWeight: 'normal',
                fontVariant: ['tabular-nums'],
                paddingHorizontal: space[3],
                paddingVertical: space[2],
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: error ? c.critical : c.lineStrong,
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
                    accessibilityRole="button"
                    style={[sheet.row, { gap: space[1], minHeight: 44 }]}
                  >
                    <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
                      Finish this book
                    </Txt>
                    <Ionicons name="chevron-forward" size={16} color={c.accent} />
                  </Pressable>
                )}
              </View>
            )}

            {/* Quick increment chips */}
            <View style={[sheet.row, { gap: space[2], flexWrap: 'wrap' }]}>
              {[10, 25, 50].map((delta) => (
                <Chip
                  key={delta}
                  label={`+${delta}`}
                  selected={false}
                  accessibilityLabel={`Add ${delta} pages`}
                  onPress={() => handleAddDelta(delta)}
                />
              ))}
            </View>
          </View>

          {/* Optional Session Minutes (PRD §8.4) */}
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                Time spent (optional)
              </Txt>
              <Txt variant="micro" color="muted">
                Unlocks reading speed
              </Txt>
            </View>

            <View style={[sheet.row, { gap: space[2], flexWrap: 'wrap' }]}>
              {[15, 30, 45, 60].map((m) => (
                <Chip
                  key={m}
                  label={`${m}m`}
                  selected={minutesInput === String(m)}
                  accessibilityLabel={`${m} minutes`}
                  onPress={() => handleSelectMinutes(m)}
                />
              ))}
            </View>

            <TextInput
              value={minutesInput}
              onChangeText={(txt) => setMinutesInput(txt.replace(/[^0-9]/g, ''))}
              placeholder="Or enter custom minutes"
              keyboardType="number-pad"
              placeholderTextColor={c.muted}
              accessibilityLabel="Custom reading session minutes"
              style={{
                minHeight: 44,
                paddingHorizontal: space[3],
                fontFamily: fontFamilies.uiRegular,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.lineStrong,
                backgroundColor: c.surface2,
                color: c.ink,
                fontSize: 15,
              }}
            />
          </View>

          {/* Note Field (280 char limit) */}
          <View style={{ gap: space[1] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="caption" color="muted">
                Private note (optional)
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
              placeholder="Where you stopped, what you thought"
              placeholderTextColor={c.muted}
              multiline
              numberOfLines={3}
              accessibilityLabel="Private progress note"
              style={{
                minHeight: 70,
                paddingHorizontal: space[3],
                paddingVertical: space[2],
                fontFamily: fontFamilies.uiRegular,
                borderRadius: radius.md,
                borderWidth: 1,
                borderColor: c.lineStrong,
                backgroundColor: c.surface2,
                color: c.ink,
                fontSize: 15,
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
                style={[sheet.row, { gap: space[1], minHeight: 44 }]}
              >
                <Ionicons name="add" size={16} color={c.accent} />
                <Txt variant="caption" color="accent">
                  Save a quote from this section
                </Txt>
              </Pressable>
            ) : (
              <View style={{ gap: space[1] }}>
                <Txt variant="caption" color="muted">
                  Quote
                </Txt>
                <TextInput
                  value={quoteInput}
                  onChangeText={setQuoteInput}
                  placeholder="Quote"
                  placeholderTextColor={c.muted}
                  multiline
                  numberOfLines={2}
                  accessibilityLabel="Transcribe quote"
                  style={{
                    minHeight: 72,
                    paddingHorizontal: space[3],
                    paddingVertical: space[2],
                    ...t.bodyL,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    borderColor: c.lineStrong,
                    backgroundColor: c.surface2,
                    color: c.ink,
                    textAlignVertical: 'top',
                  }}
                />
              </View>
            )}
          </View>

          {/* Action Buttons */}
          <View style={{ gap: space[2], marginTop: space[2] }}>
            <Button label="Save" variant="primary" onPress={handleSave} />
            <Button
              label="Finish"
              variant="tertiary"
              onPress={() => {
                onClose();
                onFinishShortcut();
              }}
            />
          </View>
        </ScrollView>
      </View>
    </BottomSheet>
  );
}
