// Flyleaf Design System Components (design.md §5, PRD §36-38, SL-02).
//
// Governed by: "The interface recedes; covers advance."
// Near-monochrome with one accent. Every colour from tokens.
// Touch targets >= 44x44 everywhere. Full Reanimated + gesture-handler motion.

import React, { useEffect, useState, useRef } from 'react';
import {
  ActivityIndicator,
  DimensionValue,
  Modal,
  Pressable,
  StyleProp,
  StyleSheet,
  Text,
  TextInput,
  TextStyle,
  View,
  ViewStyle,
} from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  withRepeat,
  Easing,
  runOnJS,
} from 'react-native-reanimated';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import {
  ColorName,
  cover,
  coverUrl,
  motion,
  radius,
  space,
  type as t,
  useTheme,
} from './tokens';

// ---------------------------------------------------------------- Screen
export function Screen({
  children,
  style,
}: {
  children: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  return <View style={[{ flex: 1, backgroundColor: c.ground }, style]}>{children}</View>;
}

// ---------------------------------------------------------------- Txt
export function Txt({
  variant = 'body',
  color = 'ink',
  style,
  children,
  numberOfLines,
  tabular = false,
}: {
  variant?: keyof typeof t;
  color?: ColorName;
  style?: StyleProp<TextStyle>;
  children: React.ReactNode;
  numberOfLines?: number;
  tabular?: boolean;
}) {
  const c = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[
        t[variant] as TextStyle,
        { color: c[color] },
        tabular ? { fontVariant: ['tabular-nums'] } : null,
        style,
      ]}
    >
      {children}
    </Text>
  );
}

// ---------------------------------------------------------------- Button
export type ButtonVariant = 'primary' | 'secondary' | 'tertiary' | 'text' | 'destructive' | 'outline';

export function Button({
  label,
  onPress,
  variant = 'primary',
  size = 'md',
  disabled,
  loading,
  style,
}: {
  label: string;
  onPress: () => void;
  variant?: ButtonVariant;
  size?: 'sm' | 'md' | 'lg';
  disabled?: boolean;
  loading?: boolean;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();

  const baseStyle: ViewStyle = {
    minHeight: size === 'sm' ? 36 : 48,
    minWidth: 44,
    paddingHorizontal: size === 'sm' ? space[2] : space[4],
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    flexDirection: 'row',
    opacity: disabled || loading ? 0.5 : 1,
  };

  const variantStyles: Record<ButtonVariant, ViewStyle> = {
    primary: {
      ...baseStyle,
      backgroundColor: c.accent,
    },
    secondary: {
      ...baseStyle,
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: c.accent,
    },
    outline: {
      ...baseStyle,
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: c.accent,
    },
    tertiary: {
      ...baseStyle,
      backgroundColor: 'transparent',
      paddingHorizontal: space[2],
    },
    text: {
      ...baseStyle,
      backgroundColor: 'transparent',
      paddingHorizontal: space[2],
    },
    destructive: {
      ...baseStyle,
      backgroundColor: 'transparent',
      borderWidth: 1,
      borderColor: c.critical,
    },
  };

  const textColors: Record<ButtonVariant, string> = {
    primary: c.ground,
    secondary: c.accent,
    outline: c.accent,
    tertiary: c.accent,
    text: c.accent,
    destructive: c.critical,
  };

  const fg = textColors[variant];

  return (
    <Pressable
      onPress={() => {
        void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
        onPress();
      }}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={[variantStyles[variant], style]}
    >
      {loading ? (
        <ActivityIndicator color={fg} size="small" />
      ) : (
        <Text style={[t.body as TextStyle, { fontWeight: '600', color: fg }]}>{label}</Text>
      )}
    </Pressable>
  );
}

// ---------------------------------------------------------------- Card
export function Card({
  children,
  onPress,
  onLongPress,
  style,
}: {
  children: React.ReactNode;
  onPress?: () => void;
  onLongPress?: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const cardStyle: ViewStyle = {
    backgroundColor: c.surface,
    borderColor: c.line,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space[4],
    gap: space[3],
  };

  const isInteractive = Boolean(onPress || onLongPress);

  return isInteractive ? (
    <Pressable
      onPress={() => {
        if (onPress) {
          void Haptics.selectionAsync();
          onPress();
        }
      }}
      onLongPress={() => {
        if (onLongPress) {
          void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
          onLongPress();
        }
      }}
      accessibilityRole="button"
      style={[cardStyle, style]}
    >
      {children}
    </Pressable>
  ) : (
    <View style={[cardStyle, style]}>{children}</View>
  );
}

// ---------------------------------------------------------------- Cover
export function Cover({
  coverId,
  title,
  author,
  size = 'm',
  style,
}: {
  coverId?: number | null;
  title?: string;
  author?: string;
  size?: keyof typeof cover | 'fluid';
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const dims = size === 'fluid' ? { width: '100%' as DimensionValue, height: '100%' as DimensionValue } : cover[size];
  const remote = coverUrl(coverId, size === 'xl' || size === 'l' ? 'L' : size === 'm' || size === 'fluid' ? 'M' : 'S');

  return (
    <View
      style={[
        dims,
        {
          borderRadius: radius.sm,
          backgroundColor: c.surface2,
          borderWidth: 1,
          borderColor: c.line,
          overflow: 'hidden',
        },
        style,
      ]}
      accessible
      accessibilityRole="image"
      accessibilityLabel={title ? `Cover of ${title}${author ? ` by ${author}` : ''}` : 'Book cover'}
    >
      {remote ? (
        <Image
          source={{ uri: remote }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          accessible={false}
        />
      ) : (
        // Typographic poster placeholder when cover art is missing (design.md §10 The Wall)
        <View
          style={{
            flex: 1,
            padding: size === 'xs' ? 2 : space[2],
            justifyContent: 'center',
            alignItems: 'center',
            backgroundColor: c.surface2,
          }}
        >
          <Text
            numberOfLines={size === 'xs' ? 1 : 3}
            style={[
              t.micro as TextStyle,
              {
                color: c.ink2,
                textAlign: 'center',
                fontSize: size === 'xs' ? 8 : 10,
                lineHeight: size === 'xs' ? 10 : 13,
              },
            ]}
          >
            {title || 'Flyleaf'}
          </Text>
        </View>
      )}
    </View>
  );
}

// ---------------------------------------------------------------- Stars & StarRating
const starGlyph: TextStyle = { textAlign: 'center', includeFontPadding: false };

export function Stars({
  value,
  onChange,
  size = 32,
}: {
  value: number | null;
  onChange?: (v: number) => void;
  size?: number;
}) {
  const c = useTheme();
  const readOnly = !onChange;
  const [hoverValue, setHoverValue] = useState<number | null>(null);
  const v = hoverValue ?? value ?? 0;
  const starScale = useSharedValue(1);
  const lastStep = useRef<number>(Math.round((value ?? 0) * 2));
  const rowWidth = size * 5;

  const starAnimatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: starScale.value }],
  }));

  const handleRate = (target: number) => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    starScale.value = withSequence(
      withTiming(1.15, { duration: motion.star / 2 }),
      withTiming(1, { duration: motion.star / 2 }),
    );
    setHoverValue(null);
    onChange?.(target);
  };

  const calculateTarget = (x: number): number => {
    const clamped = Math.max(0, Math.min(rowWidth, x));
    const bucket = Math.ceil((clamped / rowWidth) * 10);
    return Math.max(0.5, Math.min(5.0, bucket * 0.5));
  };

  const panGesture = Gesture.Pan()
    .enabled(!readOnly)
    .onStart((e) => {
      const target = calculateTarget(e.x);
      runOnJS(setHoverValue)(target);
      const step = Math.round(target * 2);
      if (step !== lastStep.current) {
        lastStep.current = step;
        void Haptics.selectionAsync();
      }
    })
    .onUpdate((e) => {
      const target = calculateTarget(e.x);
      runOnJS(setHoverValue)(target);
      const step = Math.round(target * 2);
      if (step !== lastStep.current) {
        lastStep.current = step;
        void Haptics.selectionAsync();
      }
    })
    .onEnd((e) => {
      const target = calculateTarget(e.x);
      runOnJS(handleRate)(target);
    });

  const starsContent = (
    <Animated.View
      style={[
        {
          flexDirection: 'row',
          alignItems: 'center',
          paddingVertical: space[1],
          paddingHorizontal: space[1],
        },
        starAnimatedStyle,
      ]}
    >
      {[1, 2, 3, 4, 5].map((n) => {
        const fill = v >= n ? size : v >= n - 0.5 ? size / 2 : 0;
        return (
          <View
            key={n}
            style={{
              width: size,
              height: 44,
              justifyContent: 'center',
              alignItems: 'center',
            }}
          >
            <Text
              style={[
                starGlyph,
                { fontSize: size, width: size, color: c.lineStrong },
              ]}
            >
              ★
            </Text>
            {fill > 0 && (
              <View
                pointerEvents="none"
                style={{
                  position: 'absolute',
                  left: 0,
                  top: 0,
                  bottom: 0,
                  width: fill,
                  overflow: 'hidden',
                  justifyContent: 'center',
                }}
              >
                <Text
                  style={[
                    starGlyph,
                    { fontSize: size, width: size, color: c.star },
                  ]}
                >
                  ★
                </Text>
              </View>
            )}
            {!readOnly && (
              <>
                <Pressable
                  onPress={() => handleRate(n - 0.5)}
                  hitSlop={{ top: 8, bottom: 8, left: 4, right: 0 }}
                  accessibilityLabel={`Rate ${n - 0.5} stars`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: 0,
                    width: size / 2,
                  }}
                />
                <Pressable
                  onPress={() => handleRate(n)}
                  hitSlop={{ top: 8, bottom: 8, left: 0, right: 4 }}
                  accessibilityLabel={`Rate ${n} stars`}
                  style={{
                    position: 'absolute',
                    top: 0,
                    bottom: 0,
                    left: size / 2,
                    width: size / 2,
                  }}
                />
              </>
            )}
          </View>
        );
      })}
    </Animated.View>
  );

  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}
      accessible
      accessibilityRole={readOnly ? 'text' : 'adjustable'}
      accessibilityLabel={value ? `${value} out of 5 stars` : 'Not rated'}
      accessibilityValue={{ min: 0, max: 5, now: value ?? 0 }}
      accessibilityActions={
        readOnly
          ? undefined
          : [
              { name: 'increment', label: 'Half star up' },
              { name: 'decrement', label: 'Half star down' },
            ]
      }
      onAccessibilityAction={(e) => {
        if (readOnly) return;
        if (e.nativeEvent.actionName === 'increment') {
          handleRate(Math.min(5, (value ?? 0) + 0.5));
        } else if (e.nativeEvent.actionName === 'decrement') {
          handleRate(Math.max(0.5, (value ?? 0) - 0.5));
        }
      }}
    >
      {readOnly ? (
        starsContent
      ) : (
        <GestureDetector gesture={panGesture}>
          {starsContent}
        </GestureDetector>
      )}
      <Txt variant="caption" color="muted" tabular>
        {v > 0 ? v.toFixed(1) : value ? value.toFixed(1) : '—'}
      </Txt>
    </View>
  );
}

// ---------------------------------------------------------------- Heart
export function Heart({
  hearted,
  onToggle,
  size = 28,
}: {
  hearted: boolean;
  onToggle?: () => void;
  size?: number;
}) {
  const c = useTheme();
  const scale = useSharedValue(1);

  const animatedStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));

  const handlePress = () => {
    if (!onToggle) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    scale.value = withSequence(
      withTiming(1.3, { duration: motion.like / 2 }),
      withTiming(1, { duration: motion.like / 2 }),
    );
    onToggle();
  };

  return (
    <Pressable
      onPress={handlePress}
      disabled={!onToggle}
      accessibilityRole="button"
      accessibilityLabel={hearted ? 'Hearted. Remove heart' : 'Heart book'}
      style={{ width: 44, height: 44, alignItems: 'center', justifyContent: 'center' }}
    >
      <Animated.View style={animatedStyle}>
        <Text style={{ fontSize: size, color: hearted ? c.heart : c.lineStrong }}>
          {hearted ? '♥' : '♡'}
        </Text>
      </Animated.View>
    </Pressable>
  );
}

// ---------------------------------------------------------------- ProgressBar
export function ProgressBar({ percent }: { percent: number }) {
  const c = useTheme();
  const clamped = Math.max(0, Math.min(100, percent));
  const animatedWidth = useSharedValue(clamped);

  useEffect(() => {
    animatedWidth.value = withTiming(clamped, {
      duration: motion.progress,
      easing: Easing.out(Easing.ease),
    });
  }, [clamped]);

  const fillStyle = useAnimatedStyle(() => ({
    width: `${animatedWidth.value}%` as DimensionValue,
  }));

  return (
    <View
      style={{
        height: 6,
        borderRadius: radius.pill,
        backgroundColor: c.surface2,
        overflow: 'hidden',
      }}
      accessible
      accessibilityRole="progressbar"
      accessibilityValue={{ min: 0, max: 100, now: Math.round(clamped) }}
    >
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
  );
}

// ---------------------------------------------------------------- Skeleton
export function Skeleton({
  width,
  height,
  borderRadius = radius.sm,
  style,
}: {
  width: number | DimensionValue;
  height: number;
  borderRadius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const c = useTheme();
  const opacity = useSharedValue(0.4);

  useEffect(() => {
    opacity.value = withRepeat(
      withSequence(
        withTiming(0.8, { duration: 800, easing: Easing.inOut(Easing.ease) }),
        withTiming(0.4, { duration: 800, easing: Easing.inOut(Easing.ease) }),
      ),
      -1,
      true,
    );
  }, []);

  const animStyle = useAnimatedStyle(() => ({
    opacity: opacity.value,
  }));

  return (
    <Animated.View
      style={[
        {
          width: width as any,
          height,
          borderRadius,
          backgroundColor: c.surface2,
        },
        animStyle,
        style,
      ]}
    />
  );
}

// ---------------------------------------------------------------- EmptyState
export function EmptyState({
  title,
  subtitle,
  action,
  style,
}: {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  return (
    <View style={[{ padding: space[8], alignItems: 'center', gap: space[3] }, style]}>
      <Txt variant="title" color="ink" style={{ textAlign: 'center' }}>
        {title}
      </Txt>
      {subtitle ? (
        <Txt variant="body" color="muted" style={{ textAlign: 'center', maxWidth: 320 }}>
          {subtitle}
        </Txt>
      ) : null}
      {action ? <View style={{ marginTop: space[2] }}>{action}</View> : null}
    </View>
  );
}

// Alias for backwards compatibility
export const Empty = EmptyState;

// ---------------------------------------------------------------- SegmentedControl
export function SegmentedControl<T extends string>({
  values,
  selected,
  onSelect,
  labels,
  options,
  value,
  onChange,
}: {
  values?: readonly T[];
  selected?: T;
  onSelect?: (v: T) => void;
  labels?: Record<T, string>;
  options?: { value: T; label: string }[];
  value?: T;
  onChange?: (v: T) => void;
}) {
  const c = useTheme();
  const actualValues = values ?? (options ? options.map((o) => o.value) : []);
  const actualSelected = selected ?? value!;
  const handleSelect = onSelect ?? onChange ?? (() => {});
  const labelMap = labels ?? (options ? Object.fromEntries(options.map((o) => [o.value, o.label])) : {});

  return (
    <View
      style={{
        flexDirection: 'row',
        backgroundColor: c.surface2,
        borderRadius: radius.md,
        padding: 2,
      }}
      accessibilityRole="radiogroup"
    >
      {actualValues.map((val) => {
        const isSelected = actualSelected === val;
        return (
          <Pressable
            key={val}
            onPress={() => {
              void Haptics.selectionAsync();
              handleSelect(val);
            }}
            accessibilityRole="radio"
            accessibilityState={{ selected: isSelected }}
            style={{
              flex: 1,
              minHeight: 40,
              alignItems: 'center',
              justifyContent: 'center',
              borderRadius: radius.sm,
              backgroundColor: isSelected ? c.surface : 'transparent',
              borderWidth: isSelected ? 1 : 0,
              borderColor: isSelected ? c.line : 'transparent',
            }}
          >
            <Text
              style={[
                t.body as TextStyle,
                {
                  fontSize: 14,
                  fontWeight: isSelected ? '600' : '400',
                  color: isSelected ? c.ink : c.muted,
                },
              ]}
            >
              {(labelMap as Record<string, string>)?.[val] ?? val}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ---------------------------------------------------------------- Field
export function Field({
  label,
  value,
  onChangeText,
  secureTextEntry,
  autoCapitalize = 'none',
  keyboardType,
  error,
  placeholder,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences';
  keyboardType?: 'default' | 'email-address' | 'number-pad';
  error?: string;
  placeholder?: string;
}) {
  const c = useTheme();
  return (
    <View style={{ gap: space[1] }}>
      <Txt variant="micro" color="muted">
        {label.toUpperCase()}
      </Txt>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
        placeholder={placeholder}
        accessibilityLabel={label}
        placeholderTextColor={c.muted}
        style={{
          minHeight: 48,
          paddingHorizontal: space[3],
          borderRadius: radius.md,
          borderWidth: 1,
          borderColor: error ? c.critical : c.line,
          backgroundColor: c.surface,
          color: c.ink,
          fontSize: 15,
        }}
      />
      {error ? (
        <Txt variant="caption" color="critical">
          {error}
        </Txt>
      ) : null}
    </View>
  );
}

// ---------------------------------------------------------------- Sheet
export function BottomSheet({
  visible,
  onClose,
  title,
  children,
}: {
  visible: boolean;
  onClose: () => void;
  title?: string;
  children: React.ReactNode;
}) {
  const c = useTheme();
  const translateY = useSharedValue(600);

  useEffect(() => {
    if (visible) {
      translateY.value = withSpring(0, { damping: motion.sheet.damping });
    } else {
      translateY.value = withTiming(600, { duration: 250 });
    }
  }, [visible]);

  const pan = Gesture.Pan()
    .onUpdate((e) => {
      if (e.translationY > 0) {
        translateY.value = e.translationY;
      }
    })
    .onEnd((e) => {
      if (e.translationY > 120 || e.velocityY > 600) {
        translateY.value = withTiming(600, { duration: 200 });
        onClose();
      } else {
        translateY.value = withSpring(0, { damping: motion.sheet.damping });
      }
    });

  const sheetAnimStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: translateY.value }],
  }));

  if (!visible) return null;

  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          onPress={onClose}
          accessibilityLabel="Dismiss sheet"
          style={[StyleSheet.absoluteFill, { backgroundColor: c.overlay }]}
        />
        <GestureDetector gesture={pan}>
          <Animated.View
            style={[
              {
                backgroundColor: c.surface,
                borderTopLeftRadius: radius.lg,
                borderTopRightRadius: radius.lg,
                borderWidth: 1,
                borderColor: c.line,
                paddingBottom: space[8],
                maxHeight: '90%',
              },
              sheetAnimStyle,
            ]}
          >
            {/* Grabber handle */}
            <View style={{ alignItems: 'center', paddingVertical: space[2] }}>
              <View
                style={{
                  width: 36,
                  height: 4,
                  borderRadius: radius.pill,
                  backgroundColor: c.lineStrong,
                }}
              />
            </View>
            {title ? (
              <View
                style={{
                  paddingHorizontal: space[4],
                  paddingBottom: space[3],
                  borderBottomWidth: 1,
                  borderBottomColor: c.line,
                }}
              >
                <Txt variant="title">{title}</Txt>
              </View>
            ) : null}
            <View style={{ padding: space[4] }}>{children}</View>
          </Animated.View>
        </GestureDetector>
      </View>
    </Modal>
  );
}

export const sheet = StyleSheet.create({
  pad: { padding: space[4], gap: space[4] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space[3] },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
});
