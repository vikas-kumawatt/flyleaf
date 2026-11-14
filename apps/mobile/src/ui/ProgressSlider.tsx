// Auto-saving Progress Slider (SL-52, PRD §6.15).
//
// Governed by:
//   1. Drag the progress slider — auto-saves on release, no confirm button.
//   2. Haptic tick at each 5% increment.
//   3. Responsive thumb with optimistic local updates, eased on tap.

import React, { useEffect, useState, useRef } from 'react';
import { View, LayoutChangeEvent, StyleProp, ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withTiming,
  Easing,
  runOnJS,
  useReducedMotion,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { motion, radius, space, useTheme } from './tokens';

interface ProgressSliderProps {
  currentPage: number;
  pageCount: number;
  onPageChange?: (newPage: number) => void;
  onRelease: (newPage: number, newPercent: number) => void;
  style?: StyleProp<ViewStyle>;
  disabled?: boolean;
}

export function ProgressSlider({
  currentPage,
  pageCount,
  onPageChange,
  onRelease,
  style,
  disabled = false,
}: ProgressSliderProps) {
  const c = useTheme();
  const [trackWidth, setTrackWidth] = useState(240);
  const trackRef = useRef<View>(null);

  const initialPercent = pageCount > 0 ? Math.min(100, Math.max(0, (currentPage / pageCount) * 100)) : 0;
  const progressRatio = useSharedValue(initialPercent / 100);
  const lastHapticStep = useRef(Math.floor(initialPercent / 5));
  const reduceMotion = useReducedMotion();

  // Progress also changes from outside the slider (+10 pages, the progress
  // sheet): the thumb follows, or it would sit where it was first drawn.
  useEffect(() => {
    progressRatio.value = reduceMotion
      ? initialPercent / 100
      : withTiming(initialPercent / 100, { duration: motion.menu, easing: Easing.bezier(...motion.easing) });
    lastHapticStep.current = Math.floor(initialPercent / 5);
  }, [initialPercent]);

  const handleLayout = (e: LayoutChangeEvent) => {
    const w = e.nativeEvent.layout.width;
    if (w > 0) {
      setTrackWidth(w);
    }
  };

  const triggerTick = (ratio: number) => {
    const percent = Math.round(ratio * 100);
    const step = Math.floor(percent / 5);
    if (step !== lastHapticStep.current) {
      lastHapticStep.current = step;
      void Haptics.selectionAsync();
    }
    if (onPageChange && pageCount > 0) {
      const page = Math.round(ratio * pageCount);
      onPageChange(page);
    }
  };

  const handleDragRelease = (ratio: number) => {
    const clamped = Math.max(0, Math.min(1, ratio));
    const newPage = pageCount > 0 ? Math.round(clamped * pageCount) : 0;
    const newPercent = Math.round(clamped * 100);
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    onRelease(newPage, newPercent);
  };

  const panGesture = Gesture.Pan()
    .enabled(!disabled)
    .onUpdate((e) => {
      if (trackWidth <= 0) return;
      const newRatio = Math.max(0, Math.min(1, e.x / trackWidth));
      progressRatio.value = newRatio;
      runOnJS(triggerTick)(newRatio);
    })
    .onEnd(() => {
      runOnJS(handleDragRelease)(progressRatio.value);
    });

  const tapGesture = Gesture.Tap()
    .enabled(!disabled)
    .onEnd((e) => {
      if (trackWidth <= 0) return;
      const newRatio = Math.max(0, Math.min(1, e.x / trackWidth));
      progressRatio.value = withTiming(newRatio, { duration: motion.menu, easing: Easing.bezier(...motion.easing) });
      runOnJS(handleDragRelease)(newRatio);
    });

  const gesture = Gesture.Exclusive(panGesture, tapGesture);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${progressRatio.value * 100}%`,
  }));

  const thumbStyle = useAnimatedStyle(() => ({
    left: `${progressRatio.value * 100}%`,
  }));

  return (
    <View style={[{ gap: space[1] }, style]}>
      <GestureDetector gesture={gesture}>
        <View
          ref={trackRef}
          onLayout={handleLayout}
          accessibilityRole="adjustable"
          accessibilityLabel="Reading progress slider"
          accessibilityValue={{
            min: 0,
            max: pageCount || 100,
            now: currentPage,
          }}
          style={{
            height: 28,
            paddingVertical: 12,
          }}
        >
          {/* Background track */}
          <View
            style={{
              height: 4,
              borderRadius: radius.xs,
              backgroundColor: c.line,
              overflow: 'hidden',
            }}
          >
            {/* Filled progress bar */}
            <Animated.View
              style={[
                {
                  height: '100%',
                  backgroundColor: c.accent,
                },
                fillStyle,
              ]}
            />
          </View>

          {/* Draggable thumb */}
          <Animated.View
            style={[
              {
                position: 'absolute',
                // Centres the 20pt thumb on the 4pt track (12 padding + 2 - 10).
                top: 4,
                width: 20,
                height: 20,
                marginLeft: -10,
                borderRadius: radius.pill,
                backgroundColor: c.surface,
                borderWidth: 2,
                borderColor: c.accent,
              },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
