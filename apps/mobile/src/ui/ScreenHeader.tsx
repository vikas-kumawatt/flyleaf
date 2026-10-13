// A plain header for a pushed screen: back, title, an optional action.
import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Txt, sheet } from './components';
import { space, useTheme } from './tokens';

export function ScreenHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + space[2],
        paddingHorizontal: space[4],
        paddingBottom: space[3],
        borderBottomWidth: 1,
        borderBottomColor: c.line,
        backgroundColor: c.ground,
      }}
    >
      <View style={sheet.rowBetween}>
        <Pressable
          onPress={() => {
            void Haptics.selectionAsync();
            router.back();
          }}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
          style={{ minWidth: 44, minHeight: 44, justifyContent: 'center' }}
        >
          <Txt variant="body" color="accent" style={{ fontWeight: '600' }}>
            ← Back
          </Txt>
        </Pressable>
        <Txt variant="title" style={{ fontWeight: '700', fontSize: 18 }} numberOfLines={1}>
          {title}
        </Txt>
        <View style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>{right}</View>
      </View>
    </View>
  );
}
