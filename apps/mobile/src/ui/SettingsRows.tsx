// LA-02: the pieces every Settings screen is made of. Each control is at
// least 44pt tall and names itself to a screen reader (LA-10).
import React from 'react';
import { Pressable, Switch, View } from 'react-native';
import * as Haptics from 'expo-haptics';
import { Txt, sheet } from './components';
import { radius, space, useTheme } from './tokens';
import { HOURS, hourLabel, minuteOptions } from '@/lib/settings';

export function SectionTitle({ children }: { children: string }) {
  return (
    <View accessibilityRole="header" accessibilityLabel={children} style={{ marginTop: space[2] }}>
      <Txt variant="caption" color="muted" style={{ fontWeight: '700', letterSpacing: 0.5 }}>
        {children.toUpperCase()}
      </Txt>
    </View>
  );
}

/** A grouped block of rows with hairlines between them. */
export function Group({ children }: { children: React.ReactNode }) {
  const c = useTheme();
  const items = React.Children.toArray(children).filter(Boolean);
  return (
    <View style={{ backgroundColor: c.surface, borderColor: c.line, borderWidth: 1, borderRadius: radius.md, overflow: 'hidden' }}>
      {items.map((child, i) => (
        <View key={i} style={i > 0 ? { borderTopWidth: 1, borderTopColor: c.line } : undefined}>
          {child}
        </View>
      ))}
    </View>
  );
}

export function NavRow({
  label,
  detail,
  onPress,
  destructive,
  disabled,
  trailing,
}: {
  label: string;
  detail?: string;
  onPress?: () => void;
  destructive?: boolean;
  disabled?: boolean;
  /** Replaces the arrow, e.g. "Published before launch". */
  trailing?: string;
}) {
  const inert = disabled || !onPress;
  return (
    <Pressable
      onPress={() => {
        if (inert) return;
        void Haptics.selectionAsync();
        onPress?.();
      }}
      disabled={inert}
      accessibilityRole={inert ? 'text' : 'button'}
      accessibilityLabel={[label, detail, trailing].filter(Boolean).join('. ')}
      accessibilityState={{ disabled: inert }}
      style={[sheet.rowBetween, { minHeight: 56, paddingHorizontal: space[4], paddingVertical: space[3], gap: space[3] }]}
    >
      <View style={{ flex: 1, gap: 2 }}>
        <Txt variant="body" color={destructive ? 'critical' : 'ink'} style={{ fontWeight: '600' }}>
          {label}
        </Txt>
        {detail ? (
          <Txt variant="caption" color="muted">
            {detail}
          </Txt>
        ) : null}
      </View>
      {trailing ? (
        <Txt variant="caption" color="muted">
          {trailing}
        </Txt>
      ) : !inert ? (
        <Txt variant="title" color={destructive ? 'critical' : 'accent'}>
          →
        </Txt>
      ) : null}
    </Pressable>
  );
}

export function SwitchRow({
  label,
  detail,
  value,
  onValueChange,
  disabled,
  accessibilityLabel,
}: {
  label: string;
  detail?: string;
  value: boolean;
  onValueChange: (v: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}) {
  const c = useTheme();
  return (
    <View style={[sheet.rowBetween, { minHeight: 56, paddingHorizontal: space[4], paddingVertical: space[3], gap: space[3] }]}>
      <View style={{ flex: 1, gap: 2 }} importantForAccessibility="no-hide-descendants" accessibilityElementsHidden>
        <Txt variant="body" style={{ fontWeight: '600' }} color={disabled ? 'muted' : 'ink'}>
          {label}
        </Txt>
        {detail ? (
          <Txt variant="caption" color="muted">
            {detail}
          </Txt>
        ) : null}
      </View>
      <Switch
        value={value}
        onValueChange={(v) => {
          void Haptics.selectionAsync();
          onValueChange(v);
        }}
        disabled={disabled}
        trackColor={{ false: c.line, true: c.accent }}
        accessibilityLabel={accessibilityLabel ?? label}
        accessibilityHint={detail}
        style={{ minHeight: 44 }}
      />
    </View>
  );
}

/** One selectable chip; 44pt square at least. */
function Chip({ label, a11y, selected, onPress }: { label: string; a11y: string; selected: boolean; onPress: () => void }) {
  const c = useTheme();
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onPress();
      }}
      accessibilityRole="radio"
      accessibilityLabel={a11y}
      accessibilityState={{ selected }}
      style={{
        minWidth: 52,
        minHeight: 44,
        paddingHorizontal: space[2],
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: selected ? c.accent : c.line,
        backgroundColor: selected ? c.accentSoft : c.ground,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Txt variant="caption" color={selected ? 'accent' : 'ink'} style={{ fontWeight: selected ? '700' : '400' }}>
        {label}
      </Txt>
    </Pressable>
  );
}

/**
 * Hour and minute chips. Nothing is selected unless `hour`/`minute` are given:
 * the reading reminder starts empty so the time is always the reader's (§19.2).
 */
export function TimePicker({
  label,
  hour,
  minute,
  current,
  onChange,
}: {
  label: string;
  hour: number | null;
  minute: number | null;
  /** The stored time, so an odd minute set elsewhere can still be shown. */
  current?: string | null;
  onChange: (hour: number | null, minute: number | null) => void;
}) {
  return (
    <View style={{ gap: space[2], paddingHorizontal: space[4], paddingBottom: space[3] }}>
      <Txt variant="micro" color="muted">
        {`${label} · HOUR`.toUpperCase()}
      </Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }} accessibilityRole="radiogroup" accessibilityLabel={`${label}, hour`}>
        {HOURS.map((h) => (
          <Chip key={h} label={hourLabel(h)} a11y={`${label}: ${hourLabel(h)}`} selected={hour === h} onPress={() => onChange(h, minute)} />
        ))}
      </View>
      <Txt variant="micro" color="muted">
        {`${label} · MINUTE`.toUpperCase()}
      </Txt>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[1] }} accessibilityRole="radiogroup" accessibilityLabel={`${label}, minute`}>
        {minuteOptions(current).map((m) => {
          const mm = `:${String(m).padStart(2, '0')}`;
          return <Chip key={m} label={mm} a11y={`${label}: ${m} minutes past`} selected={minute === m} onPress={() => onChange(hour, m)} />;
        })}
      </View>
    </View>
  );
}
