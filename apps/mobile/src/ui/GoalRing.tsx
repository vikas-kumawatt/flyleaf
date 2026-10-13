// ST-05, PRD §8.6 [LOCKED]: the reading-goal ring. It appears on the profile
// stats strip and nowhere else (a mobile test fails if anything outside the
// two profile screens imports it). It shows "12/24" and says nothing more:
// no "behind", no schedule, no nudge.
//
// Drawn with two clipped half-circles (no SVG dependency): each half holds a
// circle whose top and right borders form a half arc, rotated into place.

import React from 'react';
import { Pressable, View } from 'react-native';
import { Txt } from './components';
import { useTheme } from './tokens';
import type { GoalRingModel } from '@/lib/statsView';

export function GoalRing({
  model,
  size = 56,
  stroke = 6,
  onPress,
  emptyLabel,
}: {
  model: GoalRingModel | null;
  size?: number;
  stroke?: number;
  onPress?: () => void;
  /** Own profile with no goal: the ring's place offers to set one. */
  emptyLabel?: string;
}) {
  const c = useTheme();
  const p = model?.progress ?? 0;
  const half = size / 2;
  const circle = { width: size, height: size, borderRadius: half, borderWidth: stroke } as const;
  const arc = (rotate: number, sides: 'right' | 'left') => (
    <View
      style={[
        circle,
        {
          position: 'absolute',
          left: sides === 'right' ? -half : 0,
          borderColor: 'transparent',
          ...(sides === 'right'
            ? { borderTopColor: c.accent, borderRightColor: c.accent }
            : { borderBottomColor: c.accent, borderLeftColor: c.accent }),
          transform: [{ rotate: `${rotate}deg` }],
        },
      ]}
    />
  );

  const ring = (
    <View
      style={{ width: size, height: size, alignItems: 'center', justifyContent: 'center' }}
      accessible
      accessibilityRole={onPress ? 'button' : 'image'}
      accessibilityLabel={model?.accessibilityLabel ?? emptyLabel ?? 'Reading goal'}
    >
      <View style={[circle, { position: 'absolute', borderColor: c.line }]} />
      {p > 0 && (
        <View style={{ position: 'absolute', left: half, width: half, height: size, overflow: 'hidden' }}>
          {arc(45 + Math.min(p, 0.5) * 360 - 180, 'right')}
        </View>
      )}
      {p > 0.5 && (
        <View style={{ position: 'absolute', left: 0, width: half, height: size, overflow: 'hidden' }}>
          {arc(45 + (p - 1) * 360, 'left')}
        </View>
      )}
      <Txt variant="caption" tabular style={{ fontSize: 11, fontWeight: '700' }}>
        {model ? model.label : emptyLabel ?? ''}
      </Txt>
    </View>
  );

  return onPress ? (
    <Pressable onPress={onPress} hitSlop={8}>
      {ring}
    </Pressable>
  ) : (
    ring
  );
}
