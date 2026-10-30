// A plain header for a pushed screen: back, title, an optional action.
import React from 'react';
import { Pressable, View } from 'react-native';
import { useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import { Ionicons } from '@expo/vector-icons';
import { Txt, sheet } from './components';
import { space, useTheme } from './tokens';

export function ScreenHeader({ title, right }: { title: string; right?: React.ReactNode }) {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  return (
    <View
      style={{
        paddingTop: insets.top + space[1],
        paddingHorizontal: space[4],
        paddingBottom: space[2],
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
          <Ionicons name="chevron-back" size={24} color={c.ink} />
        </Pressable>
        <Txt variant="title" numberOfLines={1} style={{ flex: 1, textAlign: 'center' }}>
          {title}
        </Txt>
        <View style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}>{right}</View>
      </View>
    </View>
  );
}
