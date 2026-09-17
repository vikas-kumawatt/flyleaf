// Tab 2 — Reading (the daily hook, PRD §5.2, design.md §10).
//
// Segmented: Reading / Want to read / Diary.
// Cards render at coverL with progress bar, page indicators, and quick updates.

import React, { useState } from 'react';
import { View, ScrollView, Pressable } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useSession } from '@/lib/session';
import {
  Button,
  Card,
  Cover,
  EmptyState,
  ProgressBar,
  Screen,
  SegmentedControl,
  Txt,
  sheet,
} from '@/ui/components';
import { space, useTheme } from '@/ui/tokens';

export default function ReadingScreen() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const [section, setSection] = useState<'reading' | 'want_to_read' | 'diary'>('reading');

  if (!user) {
    return (
      <Screen>
        <View
          style={{
            paddingTop: Math.max(insets.top, space[4]),
            paddingHorizontal: space[4],
            paddingBottom: space[3],
            backgroundColor: c.ground,
            borderBottomWidth: 1,
            borderBottomColor: c.line,
          }}
        >
          <Txt variant="displayM">Reading</Txt>
        </View>

        <ScrollView
          contentContainerStyle={{
            padding: space[4],
            paddingBottom: space[12],
            gap: space[6],
          }}
        >
          {/* Upsell Header & Value Prop */}
          <View style={{ gap: space[2], marginTop: space[2] }}>
            <Txt variant="title">Your quiet reading sanctuary</Txt>
            <Txt variant="body" color="muted" style={{ lineHeight: 22 }}>
              Track daily pages without social noise. Predict finish dates, log private reading
              notes, and keep your personal diary forever.
            </Txt>
          </View>

          {/* Interactive Preview of What Reading Tab Looks Like */}
          <View style={{ gap: space[2] }}>
            <View style={[sheet.row, { justifyContent: 'space-between' }]}>
              <Txt variant="micro" color="muted">
                SAMPLE READING LOG
              </Txt>
              <View
                style={{
                  backgroundColor: c.accentSoft,
                  paddingHorizontal: space[2],
                  paddingVertical: 2,
                  borderRadius: 4,
                }}
              >
                <Txt variant="micro" color="accent" style={{ fontWeight: '600' }}>
                  PREVIEW
                </Txt>
              </View>
            </View>

            <Card style={{ opacity: 0.95 }}>
              <View style={sheet.rowTop}>
                <Cover coverId={8231856} title="Piranesi" author="Susanna Clarke" size="l" />
                <View style={{ flex: 1, gap: space[2], justifyContent: 'space-between' }}>
                  <View style={{ gap: space[1] }}>
                    <Txt variant="title" numberOfLines={1}>
                      Piranesi
                    </Txt>
                    <Txt variant="caption" color="muted">
                      Susanna Clarke
                    </Txt>
                  </View>

                  <View style={{ gap: space[2] }}>
                    <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                      <Txt variant="caption" color="ink2" tabular>
                        Page 168 of 245
                      </Txt>
                      <Txt variant="caption" color="muted" tabular>
                        68%
                      </Txt>
                    </View>
                    <ProgressBar percent={68} />
                    <Txt variant="micro" color="muted">
                      Estimated finish: 2 days
                    </Txt>
                  </View>
                </View>
              </View>

              <View
                style={[
                  sheet.row,
                  { justifyContent: 'flex-end', gap: space[2], marginTop: space[3] },
                ]}
              >
                <Button
                  label="+10 pages"
                  variant="secondary"
                  disabled
                  onPress={() => {}}
                  style={{ minHeight: 36, paddingHorizontal: space[3], opacity: 0.7 }}
                />
                <Button
                  label="Update"
                  variant="primary"
                  disabled
                  onPress={() => {}}
                  style={{ minHeight: 36, paddingHorizontal: space[3], opacity: 0.7 }}
                />
              </View>
            </Card>
          </View>

          {/* Call to action */}
          <View style={{ gap: space[3], marginTop: space[3] }}>
            <Button
              label="Create an account to start tracking"
              variant="primary"
              onPress={() => router.push('/auth')}
            />
            <Button
              label="Sign in"
              variant="secondary"
              onPress={() => router.push('/auth')}
            />
            <Button
              label="Explore books first"
              variant="tertiary"
              onPress={() => router.push('/discover')}
            />
          </View>
        </ScrollView>
      </Screen>
    );
  }

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
        <Txt variant="displayM">Reading</Txt>
        <SegmentedControl
          values={['reading', 'want_to_read', 'diary'] as const}
          selected={section}
          onSelect={setSection}
          labels={{
            reading: 'Currently reading',
            want_to_read: 'Want to read',
            diary: 'Diary',
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
        {section === 'reading' && (
          <>
            {/* Active reading card */}
            <Card onPress={() => {}}>
              <View style={sheet.rowTop}>
                <Cover
                  coverId={8231856}
                  title="Piranesi"
                  author="Susanna Clarke"
                  size="l"
                />
                <View style={{ flex: 1, gap: space[2], justifyContent: 'space-between' }}>
                  <View style={{ gap: space[1] }}>
                    <Txt variant="title" numberOfLines={2}>
                      Piranesi
                    </Txt>
                    <Txt variant="caption" color="muted">
                      Susanna Clarke
                    </Txt>
                  </View>

                  <View style={{ gap: space[2] }}>
                    <View style={[sheet.row, { justifyContent: 'space-between' }]}>
                      <Txt variant="caption" color="ink2" tabular>
                        Page 168 of 245
                      </Txt>
                      <Txt variant="caption" color="muted" tabular>
                        68%
                      </Txt>
                    </View>
                    <ProgressBar percent={68} />
                    <Txt variant="micro" color="muted">
                      Estimated finish: 2 days
                    </Txt>
                  </View>
                </View>
              </View>

              <View style={[sheet.row, { justifyContent: 'flex-end', gap: space[2], marginTop: space[2] }]}>
                <Button
                  label="+10 pages"
                  variant="secondary"
                  onPress={() => {}}
                  style={{ minHeight: 36, paddingHorizontal: space[3] }}
                />
                <Button
                  label="Update"
                  variant="primary"
                  onPress={() => {}}
                  style={{ minHeight: 36, paddingHorizontal: space[3] }}
                />
              </View>
            </Card>

            {/* Empty state prompt for adding another read */}
            <View style={{ alignItems: 'center', paddingVertical: space[4] }}>
              <Button
                label="Log what you're reading"
                variant="tertiary"
                onPress={() => router.push('/log')}
              />
            </View>
          </>
        )}

        {section === 'want_to_read' && (
          <EmptyState
            title="Your queue is clear"
            subtitle="Search for books you want to read next and save them here."
            action={
              <Button
                label="Find books"
                variant="primary"
                onPress={() => router.push('/discover')}
              />
            }
          />
        )}

        {section === 'diary' && (
          <EmptyState
            title="Your diary starts with your first finished book"
            subtitle="When you finish a book, it will appear here with your rating, review, and finish date."
            action={
              <Button
                label="Log a book"
                variant="secondary"
                onPress={() => router.push('/log')}
              />
            }
          />
        )}
      </ScrollView>
    </Screen>
  );
}
