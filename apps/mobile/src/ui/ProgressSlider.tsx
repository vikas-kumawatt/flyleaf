// Auto-saving Progress Slider (SL-52, PRD §6.15).
//
// Governed by:
//   1. Drag the progress slider — auto-saves on release, no confirm button.
//   2. Haptic tick at each 5% increment.
//   3. Responsive, spring-tuned thumb with optimistic local updates.

import React, { useState, useRef } from 'react';
import { View, LayoutChangeEvent, StyleProp, ViewStyle, Text } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, {
  useSharedValue,
  useAnimatedStyle,
  withSpring,
  runOnJS,
} from 'react-native-reanimated';
import * as Haptics from 'expo-haptics';
import { radius, space, useTheme } from './tokens';

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
      progressRatio.value = withSpring(newRatio, { damping: 20 });
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
            height: 36,
            justifyContent: 'center',
            paddingVertical: 12,
          }}
        >
          {/* Background track */}
          <View
            style={{
              height: 8,
              borderRadius: radius.pill,
              backgroundColor: c.surface2,
              overflow: 'hidden',
            }}
          >
            {/* Filled progress bar */}
            <Animated.View
              style={[
                {
                  height: '100%',
                  backgroundColor: c.accent,
                  borderRadius: radius.pill,
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
                top: 8,
                width: 20,
                height: 20,
                marginLeft: -10,
                borderRadius: radius.pill,
                backgroundColor: c.ground,
                borderWidth: 2,
                borderColor: c.accent,
                shadowColor: '#000',
                shadowOffset: { width: 0, height: 1 },
                shadowOpacity: 0.2,
                shadowRadius: 2,
                elevation: 3,
              },
              thumbStyle,
            ]}
          />
        </View>
      </GestureDetector>
    </View>
  );
}
