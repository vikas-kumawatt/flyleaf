// Phase -1 component set. Deliberately small: enough to build four screens
// with tokens rather than literals. The real design system is SL-02.

import React from 'react';
import {
  ActivityIndicator, Pressable, StyleSheet, Text, TextInput,
  View, ViewStyle, TextStyle,
} from 'react-native';
import { Image } from 'expo-image';
import * as Haptics from 'expo-haptics';
import { cover, coverUrl, radius, space, type as t, useTheme } from './tokens';

export function Screen({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  return <View style={{ flex: 1, backgroundColor: c.ground }}>{children}</View>;
}

export function Txt({
  variant = 'body', color = 'ink', style, children, numberOfLines,
}: {
  variant?: keyof typeof t;
  color?: 'ink' | 'ink2' | 'muted' | 'accent' | 'critical' | 'star';
  style?: TextStyle;
  children: React.ReactNode;
  numberOfLines?: number;
}) {
  const c = useTheme();
  return (
    <Text
      numberOfLines={numberOfLines}
      style={[t[variant] as TextStyle, { color: c[color] }, style]}
    >
      {children}
    </Text>
  );
}

export function Button({
  label, onPress, variant = 'primary', disabled, loading,
}: {
  label: string;
  onPress: () => void;
  variant?: 'primary' | 'secondary' | 'text';
  disabled?: boolean;
  loading?: boolean;
}) {
  const c = useTheme();
  const base: ViewStyle = {
    minHeight: 48,                    // 44 minimum target, 48 for comfort
    paddingHorizontal: space[4],
    borderRadius: radius.md,
    alignItems: 'center',
    justifyContent: 'center',
    opacity: disabled || loading ? 0.5 : 1,
  };
  const styles: Record<string, ViewStyle> = {
    primary: { ...base, backgroundColor: c.accent },
    secondary: { ...base, borderWidth: 1, borderColor: c.accent },
    text: { ...base, paddingHorizontal: space[2] },
  };
  const fg = variant === 'primary' ? c.ground : c.accent;
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled || loading}
      accessibilityRole="button"
      accessibilityLabel={label}
      style={styles[variant]}
    >
      {loading
        ? <ActivityIndicator color={fg} />
        : <Text style={{ ...(t.body as TextStyle), fontWeight: '600', color: fg }}>{label}</Text>}
    </Pressable>
  );
}

export function Field({
  label, value, onChangeText, secureTextEntry, autoCapitalize = 'none', keyboardType, error,
}: {
  label: string;
  value: string;
  onChangeText: (v: string) => void;
  secureTextEntry?: boolean;
  autoCapitalize?: 'none' | 'sentences';
  keyboardType?: 'default' | 'email-address' | 'number-pad';
  error?: string;
}) {
  const c = useTheme();
  return (
    <View style={{ gap: space[1] }}>
      <Txt variant="micro" color="muted">{label.toUpperCase()}</Txt>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        secureTextEntry={secureTextEntry}
        autoCapitalize={autoCapitalize}
        autoCorrect={false}
        keyboardType={keyboardType}
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
          ...(t.body as object),
        }}
      />
      {error ? <Txt variant="caption" color="critical">{error}</Txt> : null}
    </View>
  );
}

export function Cover({
  coverId, size = 'm',
}: { coverId?: number | null; size?: keyof typeof cover }) {
  const c = useTheme();
  const dims = cover[size];
  // S for rows, M for grids, L only for the detail hero.
  const remote = coverUrl(coverId, size === 'xl' || size === 'l' ? 'L' : size === 'm' ? 'M' : 'S');
  return (
    <View style={{
      ...dims,
      borderRadius: radius.sm,
      backgroundColor: c.surface2,
      borderWidth: 1,
      borderColor: c.line,
      overflow: 'hidden',
    }}>
      {remote ? (
        <Image
          source={{ uri: remote }}
          style={{ width: '100%', height: '100%' }}
          contentFit="cover"
          transition={200}
          accessible={false}
        />
      ) : null}
    </View>
  );
}

// Centring the glyph in a box exactly `size` wide is what makes the half
// star work: whatever the font's actual advance width, the glyph's centre
// lands on the box's centre, so clipping at size/2 always cuts it in half.
const starGlyph: TextStyle = { textAlign: 'center', includeFontPadding: false };

// Half-star control. The most-repeated interaction in the product, so it gets
// the extra hit area and the numeral beside it from day one (design.md §5).
export function Stars({
  value, onChange, size = 32,
}: { value: number | null; onChange?: (v: number) => void; size?: number }) {
  const c = useTheme();
  const readOnly = !onChange;
  const v = value ?? 0;

  return (
    <View
      style={{ flexDirection: 'row', alignItems: 'center', gap: space[2] }}
      accessible
      accessibilityRole={readOnly ? 'text' : 'adjustable'}
      accessibilityLabel={value ? `${value} out of 5 stars` : 'Not rated'}
    >
      <View style={{ flexDirection: 'row' }}>
        {[1, 2, 3, 4, 5].map((n) => {
          // How much of THIS star is gold: all of it, half, or none.
          const fill = v >= n ? size : v >= n - 0.5 ? size / 2 : 0;
          return (
            <View key={n} style={{ width: size, height: 44, justifyContent: 'center' }}>
              {/* ONE glyph, drawn twice: grey underneath, gold on top and
                  clipped. The previous version stacked a '★' layer and a
                  '☆'/'⯨' layer, which showed through each other, and '⯨'
                  is not in the Android system font anyway. */}
              <Text style={[starGlyph, { fontSize: size, width: size, color: c.lineStrong }]}>★</Text>
              {fill > 0 && (
                <View
                  pointerEvents="none"
                  style={{
                    position: 'absolute', left: 0, top: 0, bottom: 0,
                    width: fill, overflow: 'hidden', justifyContent: 'center',
                  }}
                >
                  <Text style={[starGlyph, { fontSize: size, width: size, color: c.star }]}>★</Text>
                </View>
              )}
              {/* Left half sets n-0.5, right half sets n. Full 44pt height,
                  so the target is comfortable even though the glyph is not. */}
              {!readOnly && [n - 0.5, n].map((target, i) => (
                <Pressable
                  key={target}
                  onPress={() => {
                    void Haptics.selectionAsync();
                    onChange?.(target);
                  }}
                  accessibilityLabel={`Rate ${target} ${target === 1 ? 'star' : 'stars'}`}
                  style={{
                    position: 'absolute', top: 0, bottom: 0,
                    left: i === 0 ? 0 : size / 2, width: size / 2,
                  }}
                />
              ))}
            </View>
          );
        })}
      </View>
      {/* Colour is never the sole carrier of meaning (design.md §9). */}
      <Txt variant="caption" color="muted">{value ? value.toFixed(1) : '—'}</Txt>
    </View>
  );
}

export function ProgressBar({ percent }: { percent: number }) {
  const c = useTheme();
  return (
    <View style={{
      height: 6, borderRadius: radius.pill, backgroundColor: c.surface2, overflow: 'hidden',
    }}>
      <View style={{
        height: '100%',
        width: `${Math.max(0, Math.min(100, percent))}%`,
        backgroundColor: c.accent,
        borderRadius: radius.pill,
      }} />
    </View>
  );
}

export function Card({ children, onPress }: { children: React.ReactNode; onPress?: () => void }) {
  const c = useTheme();
  const style: ViewStyle = {
    backgroundColor: c.surface,
    borderColor: c.line,
    borderWidth: 1,
    borderRadius: radius.md,
    padding: space[4],
    gap: space[3],
  };
  return onPress
    ? <Pressable onPress={onPress} style={style}>{children}</Pressable>
    : <View style={style}>{children}</View>;
}

// Never a shrug. Always content or one concrete action (design.md §5).
export function Empty({ title, action }: { title: string; action?: React.ReactNode }) {
  return (
    <View style={{ padding: space[8], alignItems: 'center', gap: space[4] }}>
      <Txt variant="bodyL" color="ink2" style={{ textAlign: 'center' }}>{title}</Txt>
      {action}
    </View>
  );
}

export const sheet = StyleSheet.create({
  pad: { padding: space[4], gap: space[4] },
  row: { flexDirection: 'row', alignItems: 'center', gap: space[3] },
  // Top-aligned row, registered as its own style rather than composed
  // inline. `<Link asChild>` clones its child and merges props into it, and
  // it rejects a child whose `style` is an ARRAY — so `[sheet.row, {...}]`
  // throws inside renderItem and takes the whole list down with it.
  // Being a single style also stops FlatList allocating a new array per row.
  rowTop: { flexDirection: 'row', alignItems: 'flex-start', gap: space[3] },
});
