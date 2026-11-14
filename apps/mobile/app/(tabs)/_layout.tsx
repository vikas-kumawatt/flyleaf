// Five-tab navigation shell with a central Log action (PRD §5.2, design.md §5, SL-01).
//
// 1. Home (House)
// 2. Reading (Bookmark) -- the daily hook
// 3. Central FAB (+) -- Log a book
// 4. Discover (Search) -- search + browse
// 5. Shelves (Library) -- lists & collections
// 6. Profile (Person) -- identity & diary

import React from 'react';
import { View, Text, Pressable, StyleSheet } from 'react-native';
import { Tabs, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import * as Haptics from 'expo-haptics';
import { useSession } from '@/lib/session';
import { budgetTracker } from '@/lib/budgetTracker';
import { useActionGate } from '@/ui/ActionGate';
import { useTheme, fontFamilies, space, type as t } from '@/ui/tokens';

function TabBarItem({
  title,
  icon,
  activeIcon,
  focused,
  onPress,
}: {
  title: string;
  icon: keyof typeof Ionicons.glyphMap;
  activeIcon: keyof typeof Ionicons.glyphMap;
  focused: boolean;
  onPress: () => void;
}) {
  const c = useTheme();

  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="tab"
      accessibilityState={{ selected: focused }}
      accessibilityLabel={title}
      style={styles.tabItem}
    >
      <Ionicons
        name={focused ? activeIcon : icon}
        size={22}
        color={focused ? c.ink : c.muted}
      />
      <Text
        numberOfLines={1}
        // A tab label that truncates is worse than one that stops growing.
        maxFontSizeMultiplier={1.3}
        style={[
          t.micro as object,
          {
            fontSize: 11,
            lineHeight: 14,
            fontFamily: focused ? fontFamilies.uiMedium : fontFamilies.uiRegular,
            fontWeight: 'normal',
            color: focused ? c.ink : c.muted,
            marginTop: space[1] / 2,
            // The label takes the cell's width, so it never depends on its own
            // measured width (seen clipped on Android after a remount).
            alignSelf: 'stretch',
            textAlign: 'center',
          },
        ]}
      >
        {title}
      </Text>
    </Pressable>
  );
}

export default function TabLayout() {
  const c = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { user } = useSession();
  const { promptAuth } = useActionGate();

  return (
    <Tabs
      screenOptions={{
        headerShown: false,
        tabBarStyle: {
          backgroundColor: c.surface,
          borderTopColor: c.line,
          borderTopWidth: 1,
          height: 60 + insets.bottom,
          paddingBottom: Math.max(insets.bottom, space[2]),
          paddingTop: space[2],
        },
      }}
      tabBar={({ state, navigation }) => {
        const routes = state.routes;
        const currentRoute = routes[state.index]?.name;

        return (
          <View
            style={[
              styles.tabBarContainer,
              {
                backgroundColor: c.surface,
                borderTopColor: c.line,
                paddingBottom: Math.max(insets.bottom, space[2]),
              },
            ]}
          >
            {/* 1. Home */}
            <TabBarItem
              title="Home"
              icon="home-outline"
              activeIcon="home"
              focused={currentRoute === 'index'}
              onPress={() => navigation.navigate('index')}
            />

            {/* 2. Reading */}
            <TabBarItem
              title="Reading"
              icon="bookmark-outline"
              activeIcon="bookmark"
              focused={currentRoute === 'reading'}
              onPress={() => navigation.navigate('reading')}
            />

            {/* Central Log action: a labelled peer of the tabs, in the accent */}
            <View style={styles.tabItem}>
              <Pressable
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  if (!user) {
                    promptAuth({
                      title: 'Sign up to log a book',
                      subtitle:
                        'Record what you read, track your progress, and build your private library.',
                    });
                    return;
                  }
                  budgetTracker.startLogSheet();
                  router.push('/log');
                }}
                accessibilityRole="button"
                accessibilityLabel="Log a book"
                style={styles.logButton}
              >
                <Ionicons name="add-circle-outline" size={24} color={c.accent} />
                <Text
                  numberOfLines={1}
                  maxFontSizeMultiplier={1.3}
                  style={[
                    t.micro as object,
                    {
                      fontSize: 11,
                      lineHeight: 14,
                      fontFamily: fontFamilies.uiMedium,
                      fontWeight: 'normal',
                      color: c.accent,
                      marginTop: space[1] / 2,
                      alignSelf: 'stretch',
                      textAlign: 'center',
                    },
                  ]}
                >
                  Log
                </Text>
              </Pressable>
            </View>

            {/* 3. Discover */}
            <TabBarItem
              title="Discover"
              icon="search-outline"
              activeIcon="search"
              focused={currentRoute === 'discover'}
              onPress={() => navigation.navigate('discover')}
            />

            {/* 4. Shelves */}
            <TabBarItem
              title="Shelves"
              icon="library-outline"
              activeIcon="library"
              focused={currentRoute === 'shelves'}
              onPress={() => navigation.navigate('shelves')}
            />

            {/* 5. Profile */}
            <TabBarItem
              title="Profile"
              icon="person-outline"
              activeIcon="person"
              focused={currentRoute === 'profile'}
              onPress={() => navigation.navigate('profile')}
            />
          </View>
        );
      }}
    >
      <Tabs.Screen name="index" options={{ title: 'Home' }} />
      <Tabs.Screen name="reading" options={{ title: 'Reading' }} />
      <Tabs.Screen name="discover" options={{ title: 'Discover' }} />
      <Tabs.Screen name="shelves" options={{ title: 'Shelves' }} />
      <Tabs.Screen name="profile" options={{ title: 'Profile' }} />
    </Tabs>
  );
}

const styles = StyleSheet.create({
  tabBarContainer: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-around',
    borderTopWidth: 1,
    minHeight: 60,
    paddingTop: space[2],
  },
  tabItem: {
    flex: 1,
    minHeight: 48,
    minWidth: 48,
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: space[1] / 2,
  },
  logButton: {
    minHeight: 48,
    minWidth: 48,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
  },
});
