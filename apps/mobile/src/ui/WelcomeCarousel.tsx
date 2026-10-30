// Welcome Carousel (SL-20, PRD §6.2).
//
// 3 paged cards communicating value before asking for credentials.
// Includes the critical "Look around first" action for guest mode exploration.

import React, { useState, useRef } from 'react';
import {
  View,
  Dimensions,
  FlatList,
  NativeSyntheticEvent,
  NativeScrollEvent,
  StyleSheet,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import { Button, Txt } from './components';
import { space, radius, useTheme } from './tokens';

const { width: SCREEN_WIDTH } = Dimensions.get('window');

interface Slide {
  id: string;
  title: string;
  subtitle: string;
  icon: keyof typeof Ionicons.glyphMap;
}

const SLIDES: Slide[] = [
  {
    id: '1',
    title: 'Track what you read, effortlessly',
    subtitle: 'Your reading life in one calm, personal place. Progress that saves in seconds.',
    icon: 'bookmark-outline',
  },
  {
    id: '2',
    title: 'Rate and review, half-stars included',
    subtitle: 'Half-star precision, spoiler protection, and reviews that look and feel like books.',
    icon: 'star-outline',
  },
  {
    id: '3',
    title: 'Follow readers whose taste you trust',
    subtitle: 'A social feed that treats reading as taste worth publishing, not algorithmic noise.',
    icon: 'people-outline',
  },
];

export function WelcomeCarousel({
  onGetStarted,
  onLogin,
  onLookAround,
}: {
  onGetStarted: () => void;
  onLogin: () => void;
  onLookAround: () => void;
}) {
  const c = useTheme();
  const [activeIndex, setActiveIndex] = useState(0);
  const flatListRef = useRef<FlatList>(null);

  const handleScroll = (e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const slideIndex = Math.round(e.nativeEvent.contentOffset.x / SCREEN_WIDTH);
    if (slideIndex !== activeIndex) {
      setActiveIndex(slideIndex);
    }
  };

  return (
    <View style={styles.container}>
      {/* Paged Carousel Cards */}
      <FlatList
        ref={flatListRef}
        data={SLIDES}
        keyExtractor={(item) => item.id}
        horizontal
        pagingEnabled
        showsHorizontalScrollIndicator={false}
        onScroll={handleScroll}
        scrollEventThrottle={16}
        renderItem={({ item }) => (
          <View style={[styles.slide, { width: SCREEN_WIDTH }]}>
            <Ionicons name={item.icon} size={24} color={c.ink2} style={styles.icon} />
            <Txt variant="displayL" style={styles.title}>
              {item.title}
            </Txt>
            <Txt variant="bodyL" color="ink2" style={styles.subtitle}>
              {item.subtitle}
            </Txt>
          </View>
        )}
      />

      {/* Dot Indicators */}
      <View style={styles.dotsRow}>
        {SLIDES.map((_, i) => (
          <View
            key={i}
            style={[
              styles.dot,
              {
                backgroundColor: i === activeIndex ? c.ink : c.lineStrong,
              },
            ]}
          />
        ))}
      </View>

      {/* Action Buttons */}
      <View style={styles.actionsContainer}>
        <Button label="Get started" variant="primary" onPress={onGetStarted} />
        <Button label="I have an account" variant="secondary" onPress={onLogin} />
        <Button
          label="Look around first"
          variant="tertiary"
          onPress={onLookAround}
        />
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    justifyContent: 'space-between',
    paddingBottom: space[8],
  },
  // Long headlines read left-aligned, set in the serif, on calm space.
  slide: {
    flex: 1,
    alignItems: 'flex-start',
    justifyContent: 'center',
    paddingHorizontal: space[6],
    paddingTop: space[12],
    gap: space[3],
  },
  icon: {
    marginBottom: space[2],
  },
  title: {
    maxWidth: 340,
  },
  subtitle: {
    maxWidth: 340,
  },
  dotsRow: {
    flexDirection: 'row',
    justifyContent: 'flex-start',
    alignItems: 'center',
    gap: space[2],
    paddingHorizontal: space[6],
    marginVertical: space[6],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: radius.pill,
  },
  actionsContainer: {
    paddingHorizontal: space[4],
    gap: space[2],
  },
});
