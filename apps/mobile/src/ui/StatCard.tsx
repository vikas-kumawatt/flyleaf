// One statistic per card (ST-04; PRD §17.3): one dominant number, the chart
// as support, the ST-03 note under it, the method on tap, share on the card.
// Bars grow on first view (design.md §7, 600 ms); with reduced motion they
// render in their final state.

import React, { useEffect, useRef, useState } from 'react';
import { AccessibilityInfo, Animated, Pressable, View } from 'react-native';
import type { StatCardView } from '@/lib/statCards';
import { Card, Cover, Txt, sheet } from './components';
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
    <View style={{ flex: 1, height: 6, borderRadius: radius.xs, backgroundColor: c.surface2, overflow: 'hidden' }}>
      <Animated.View
        style={{
          // One accent per chart: the leading bar; the rest sit in neutral.
          height: '100%', borderRadius: radius.xs, backgroundColor: fill >= 100 ? c.accent : c.muted,
          width: width.interpolate({ inputRange: [0, 100], outputRange: ['0%', '100%'] }),
        }}
      />
    </View>
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
        <Txt variant="micro" color="muted">
          {card.title}
        </Txt>
        {onShare && (
          <Pressable
            onPress={onShare}
            accessibilityRole="button"
            accessibilityLabel={`Share ${card.title}`}
            hitSlop={{ top: 12, bottom: 12, left: 12, right: 12 }}
            style={{ minWidth: 44, minHeight: 44, alignItems: 'flex-end', justifyContent: 'center' }}
          >
            <Txt variant="caption" color="accent" style={{ fontWeight: '500' }}>
              Share
            </Txt>
          </Pressable>
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
          <Txt variant="title" tabular style={{ fontSize: 32, lineHeight: 36 }}>
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
        <View style={{ gap: space[1], marginTop: space[1] }}>
          {card.bars.map((b) => (
            <View key={b.label} style={[sheet.row, { gap: space[2] }]}>
              <Txt variant="caption" style={{ width: 88 }} numberOfLines={1}>
                {b.label}
              </Txt>
              <Bar fill={(b.value / max) * 100} reduce={reduce} />
              <Txt variant="caption" color="muted" tabular style={{ minWidth: 28, textAlign: 'right' }}>
                {b.text}
              </Txt>
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
