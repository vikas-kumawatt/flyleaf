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
import { ActivityIndicator, FlatList, View, useWindowDimensions } from 'react-native';
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
import { Button, Cover, EmptyState, Screen, Txt, sheet } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { radius, space, useTheme } from '@/ui/tokens';

const MONTHS = ['J', 'F', 'M', 'A', 'M', 'J', 'J', 'A', 'S', 'O', 'N', 'D'];

function Calendar({ rows }: { rows: number[][] }) {
  const c = useTheme();
  return (
    <View style={{ gap: 3 }} accessibilityLabel="Reading calendar: one square per day, filled on days with reading">
      {rows.map((days, m) => (
        <View key={m} style={[sheet.row, { gap: 3 }]}>
          <Txt variant="micro" color="muted" style={{ width: 12 }}>
            {MONTHS[m]}
          </Txt>
          {days.map((on, d) => (
            <View key={d} style={{ width: 7, height: 7, borderRadius: 2, backgroundColor: on ? c.accent : c.surface2 }} />
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
      {card.bars.map((b) => (
        <View key={b.label} style={[sheet.row, { gap: space[2] }]}>
          <Txt variant="caption" style={{ width: 96 }} numberOfLines={1}>
            {b.label}
          </Txt>
          <View style={{ flex: 1, height: 10, borderRadius: radius.pill, backgroundColor: c.surface2 }}>
            <View style={{ width: `${(b.value / max) * 100}%`, height: '100%', borderRadius: radius.pill, backgroundColor: c.accent }} />
          </View>
          <Txt variant="caption" color="muted" tabular>
            {b.text}
          </Txt>
        </View>
      ))}
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
      <ScreenHeader title={yir ? `${yir.year} in books` : 'Year in Review'} />
      {!yir ? (
        failed ? (
          <EmptyState title="We couldn't load your Year in Review." subtitle="Try again in a moment." />
        ) : (
          <ActivityIndicator style={{ marginTop: space[8] }} />
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
