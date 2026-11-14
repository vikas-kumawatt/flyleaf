// Year in Review (ST-09; PRD §6.41, §17.6): vertically paged story cards,
// each with Share (the preview of its server-rendered card, public reads
// only). The words and figures come from GET /me/year-in-review, built from
// the same stats as the stats screen; under 5 books the server sends the
// gentle variant, which carries no counts. Re-viewable any time after
// 1 December; before then it says when it opens, and nothing more.
//
// Opened from the stats screen's banner or the Year in Review notification
// (flyleaf://year-in-review/YYYY → /year-in-review?year=YYYY).

import React, { useEffect, useState } from 'react';
import { FlatList, View, useWindowDimensions } from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import type { YearInReview, YearInReviewCard } from '@flyleaf/api-client';
import { api } from '@/lib/api';
import { track } from '@/lib/events';
import { useSession } from '@/lib/session';
import { deviceTimeZone } from '@/lib/statsView';
import { encodeShareOptions, yearShareOptions } from '@/lib/shareCard';
import { yirEmptyCopy } from '@/lib/yearInReview';
import { Button, Cover, EmptyState, Screen, Txt, sheet, Skeleton } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { radius, space, useTheme } from '@/ui/tokens';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function Calendar({ rows }: { rows: number[][] }) {
  const c = useTheme();
  return (
    <View style={{ gap: space[1] }} accessibilityLabel="Reading calendar: one square per day, filled on days with reading">
      {rows.map((days, m) => (
        <View key={m} style={[sheet.row, { gap: space[1] / 2 }]}>
          <Txt variant="micro" color="muted" style={{ width: space[4] }}>
            {MONTHS[m]}
          </Txt>
          {/* Every row is padded to 31 cells so the squares line up month to month. */}
          {Array.from({ length: 31 }, (_, d) => (
            <View
              key={d}
              style={{
                flex: 1,
                aspectRatio: 1,
                borderRadius: radius.xs,
                backgroundColor: d >= days.length ? 'transparent' : days[d] ? c.accent : c.surface2,
              }}
            />
          ))}
        </View>
      ))}
    </View>
  );
}

function StoryCard({ card, height, onShare }: { card: YearInReviewCard; height: number; onShare: () => void }) {
  const c = useTheme();
  const max = Math.max(1, ...card.bars.map((b) => b.value));
  return (
    <View style={{ height, padding: space[6], gap: space[3], justifyContent: 'center' }}>
      <Txt variant="displayM">{card.heading}</Txt>
      {card.value !== null && (
        <Txt variant="displayL" tabular style={{ fontSize: 64, lineHeight: 72 }}>
          {card.value}
        </Txt>
      )}
      {card.caption && <Txt variant="bodyL">{card.caption}</Txt>}
      {card.detail && (
        <Txt variant="body" color="ink2">
          {card.detail}
        </Txt>
      )}
      {card.books.length > 0 && (
        <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: space[2] }}>
          {card.books.slice(0, 4).map((b) => (
            <Cover key={b.work_id} coverId={b.explicit ? null : b.cover_id} title={b.title} size={card.books.length === 1 ? 'xl' : 'l'} />
          ))}
        </View>
      )}
      {card.bars.length > 0 && (
        <View style={{ gap: space[3] }}>
          {card.bars.map((b, i) => (
            <View key={b.label} style={{ gap: space[1] }}>
              <View style={[sheet.rowBetween, { gap: space[3] }]}>
                <Txt variant="caption" style={{ flexShrink: 1 }}>
                  {b.label}
                </Txt>
                <Txt variant="caption" color="ink2" tabular>
                  {b.text}
                </Txt>
              </View>
              {/* Ink and one accent per chart: the leading bar takes the accent. */}
              <View style={{ height: 4, borderRadius: radius.xs, backgroundColor: c.line }}>
                <View
                  style={{
                    width: `${(b.value / max) * 100}%`,
                    height: '100%',
                    borderRadius: radius.xs,
                    backgroundColor: i === 0 ? c.accent : c.ink,
                  }}
                />
              </View>
            </View>
          ))}
        </View>
      )}
      {card.calendar && <Calendar rows={card.calendar} />}
      {card.note && (
        <Txt variant="caption" color="muted">
          {card.note}
        </Txt>
      )}
      <View style={{ marginTop: space[3], alignItems: 'flex-start' }}>
        <Button label="Share this card" variant="secondary" onPress={onShare} />
      </View>
    </View>
  );
}

export default function YearInReviewScreen() {
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { height: screenHeight } = useWindowDimensions();
  const { user } = useSession();
  const params = useLocalSearchParams<{ year?: string }>();
  const year = params.year && /^\d{4}$/.test(params.year) ? Number(params.year) : undefined;
  const [yir, setYir] = useState<YearInReview | null>(null);
  const [failed, setFailed] = useState(false);
  const pageHeight = screenHeight - insets.top - 64;

  useEffect(() => {
    api.yearInReview(year, deviceTimeZone())
      .then((r) => {
        setYir(r);
        if (r.unlocked) track('yir_viewed', { year: r.year });
      })
      .catch(() => setFailed(true));
  }, [year]);

  const empty = yir ? yirEmptyCopy(yir) : null;
  return (
    <Screen>
      <ScreenHeader title={yir ? `${yir.year} in books` : 'Year in review'} />
      {!yir ? (
        failed ? (
          <EmptyState title="We couldn't load your year in review" subtitle="Try again in a moment" />
        ) : (
          // The first story card as its shape (design.md §5).
          <View
            style={{ padding: space[6], gap: space[4] }}
            accessible
            accessibilityLabel="Loading your year in review"
            accessibilityState={{ busy: true }}
          >
            <Skeleton width={140} height={12} />
            <Skeleton width={160} height={56} />
            <Skeleton width="80%" height={16} />
            <View style={{ flexDirection: 'row', gap: space[2], marginTop: space[4] }}>
              {[0, 1, 2, 3].map((k) => (
                <View key={k} style={{ flex: 1, aspectRatio: 2 / 3 }}>
                  <Skeleton width="100%" height={0} borderRadius={radius.xs} style={{ flex: 1 }} />
                </View>
              ))}
            </View>
          </View>
        )
      ) : empty ? (
        <EmptyState title={empty.title} subtitle={empty.subtitle} />
      ) : (
        <FlatList
          data={yir.cards}
          keyExtractor={(card) => card.kind}
          pagingEnabled
          showsVerticalScrollIndicator={false}
          getItemLayout={(_, i) => ({ length: pageHeight, offset: pageHeight * i, index: i })}
          renderItem={({ item }) => (
            <StoryCard
              card={item}
              height={pageHeight}
              onShare={() => {
                if (!user) return;
                void Haptics.selectionAsync();
                const options = yearShareOptions(user.id, yir.year, item.kind, deviceTimeZone());
                router.push(`/share?options=${encodeURIComponent(encodeShareOptions(options))}` as any);
              }}
            />
          )}
        />
      )}
    </Screen>
  );
}
