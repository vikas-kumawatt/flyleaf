// One statistic per card (ST-04; PRD §17.3): one dominant number, the chart
// as support, the ST-03 note under it, the method on tap, share on the card.
// Bars grow on first view (design.md §7, 600 ms); with reduced motion they
// render in their final state.

import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { StatCardView } from '@/lib/statCards';
import { Button, Card, Cover, Txt, sheet } from './components';
import { motion, radius, space, useTheme } from './tokens';

function Bar({ fill, reduce }: { fill: number; reduce: boolean }) {
  const c = useTheme();
  const width = useRef(new Animated.Value(reduce ? fill : 0)).current;
  useEffect(() => {
    if (reduce) {
      width.setValue(fill);
      return;
    }
    Animated.timing(width, { toValue: fill, duration: motion.statsReveal, useNativeDriver: false }).start();
  }, [fill, reduce, width]);
  return (
    <View style={{ height: 4, borderRadius: radius.xs, backgroundColor: c.line, overflow: 'hidden' }}>
      <Animated.View
        style={{
          // Ink and one accent: the leading bar takes the accent, the rest are ink.
          height: '100%', borderRadius: radius.xs, backgroundColor: fill >= 100 ? c.accent : c.ink,
          width: width.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
        }}
      />
    </View>
  );
}

/** The figures on a profile: large serif numerals with direct labels, on one card. */
export function StatStrip({
  figures,
  trailing,
  onPress,
}: {
  figures: { value: string; label: string; detail?: string; star?: boolean }[];
  /** Something that sits beside the figures, such as the goal ring. */
  trailing?: React.ReactNode;
  onPress?: () => void;
}) {
  const c = useTheme();
  return (
    <Card onPress={onPress}>
      <View style={{ flexDirection: 'row', flexWrap: 'wrap', alignItems: 'center', gap: space[4] }}>
        {figures.map((f) => (
          <View key={f.label} style={{ flexGrow: 1, flexBasis: 88, gap: space[1] }}>
            <View style={[sheet.row, { gap: space[1] }]}>
              {f.star ? <Ionicons name="star" size={16} color={c.star} /> : null}
              <Txt variant="displayM" tabular>
                {f.value}
              </Txt>
            </View>
            <Txt variant="caption" color="ink2">
              {f.label}
            </Txt>
            {f.detail ? (
              <Txt variant="caption" color="muted">
                {f.detail}
              </Txt>
            ) : null}
          </View>
        ))}
        {trailing}
      </View>
    </Card>
  );
}

export function StatCard({ card, onShare, onOpenBook }: { card: StatCardView; onShare?: () => void; onOpenBook?: (workId: string) => void }) {
  const c = useTheme();
  const [showMethod, setShowMethod] = useState(false);
  const [reduce, setReduce] = useState(false);
  useEffect(() => {
    void AccessibilityInfo.isReduceMotionEnabled().then(setReduce).catch(() => undefined);
  }, []);
  const max = Math.max(1, ...card.bars.map((b) => b.value));

  return (
    <Card style={{ padding: space[4], gap: space[2] }}>
      <View style={sheet.rowBetween}>
        <Txt variant="body" color="ink2" style={{ flex: 1 }}>
          {card.title}
        </Txt>
        {onShare && (
          <Button
            label="Share"
            variant="tertiary"
            size="sm"
            accessibilityLabel={`Share ${card.title}`}
            onPress={onShare}
            style={{ minHeight: 44 }}
          />
        )}
      </View>

      <Pressable
        disabled={!card.method}
        onPress={() => setShowMethod((v) => !v)}
        accessibilityRole={card.method ? 'button' : undefined}
        accessibilityHint={card.method ? 'Shows how this figure is worked out' : undefined}
        style={[sheet.rowTop, { gap: space[3] }]}
      >
        {card.book && (
          <Pressable onPress={() => onOpenBook?.(card.book!.work_id)} accessibilityRole="button" accessibilityLabel={`Open ${card.book.title}`}>
            <Cover coverId={card.book.cover_id} title={card.book.title} size="m" />
          </Pressable>
        )}
        <View style={{ flex: 1, gap: space[1] }}>
          <Txt variant="displayL" tabular>
            {card.hero}
          </Txt>
          {card.caption && <Txt variant="bodyL">{card.caption}</Txt>}
          {card.detail && (
            <Txt variant="caption" color="muted">
              {card.detail}
            </Txt>
          )}
        </View>
      </Pressable>

      {card.bars.length > 0 && (
        <View style={{ gap: space[3], marginTop: space[2] }}>
          {card.bars.map((b) => (
            // Label and figure share a line and the bar runs the full width
            // beneath, so no label sits in a fixed-width column.
            <View key={b.label} style={{ gap: space[1] }}>
              <View style={[sheet.rowBetween, { gap: space[3] }]}>
                <Txt variant="caption" style={{ flexShrink: 1 }}>
                  {b.label}
                </Txt>
                <Txt variant="caption" color="ink2" tabular>
                  {b.text}
                </Txt>
              </View>
              <Bar fill={(b.value / max) * 100} reduce={reduce} />
            </View>
          ))}
        </View>
      )}

      {card.note && (
        <Txt variant="caption" color="muted">
          {card.note}
        </Txt>
      )}
      {showMethod && card.method && (
        <Txt variant="caption" color="ink2" style={{ backgroundColor: c.surface2, padding: space[2], borderRadius: radius.sm }}>
          {card.method}
        </Txt>
      )}
    </Card>
  );
}
