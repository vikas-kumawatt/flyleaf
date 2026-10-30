// Share card preview (PRD §6.45; ST-04, ST-09): the server's card, in full,
// before the share sheet opens. A template switcher when there are options
// (this year / all time), the share sheet, and a line saying cards count
// public reads only. Full-screen: no tab bar (design.md §5).
//
// Opened with ?options=<JSON ShareOption[]> (src/lib/shareCard.ts).

import React, { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Image, Pressable, ScrollView, View } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import * as Haptics from 'expo-haptics';
import * as Sharing from 'expo-sharing';
import { File, Paths } from 'expo-file-system';
import { api } from '@/lib/api';
import { track } from '@/lib/events';
import { cardFileName, parseShareOptions, pngBytes, shareErrorMessage, shareEvents } from '@/lib/shareCard';
import { Button, Screen, Txt } from '@/ui/components';
import { ScreenHeader } from '@/ui/ScreenHeader';
import { radius, space, useTheme } from '@/ui/tokens';

export default function SharePreviewScreen() {
  const c = useTheme();
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ options?: string }>();
  const options = useMemo(() => parseShareOptions(params.options), [params.options]);
  const [index, setIndex] = useState(0);
  const [uri, setUri] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [sharing, setSharing] = useState(false);
  const option = options[index];

  useEffect(() => {
    let cancelled = false;
    if (!option) {
      setLoading(false);
      setError("We couldn't make this card. Try again.");
      return;
    }
    setLoading(true);
    setError(null);
    setUri(null);
    (async () => {
      try {
        const img = await api.shareCard(option.card);
        const file = new File(Paths.cache, cardFileName(img.etag, `${option.card.template}${index}`));
        if (file.exists) file.delete();
        file.create();
        file.write(pngBytes(img.png));
        if (cancelled) return;
        setUri(file.uri);
        track('share_card_generated', { template: option.card.template });
      } catch (err) {
        if (!cancelled) setError(shareErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [option, index]);

  const share = async () => {
    if (!uri || !option) return;
    setSharing(true);
    void Haptics.selectionAsync();
    try {
      if (!(await Sharing.isAvailableAsync())) {
        setError('Sharing is not available on this device.');
        return;
      }
      await Sharing.shareAsync(uri, { mimeType: 'image/png', UTI: 'public.png', dialogTitle: 'Share card' });
      for (const e of shareEvents(option.card)) track(e.name, e.props);
    } catch {
      // The sheet was dismissed or failed: nothing to say.
    } finally {
      setSharing(false);
    }
  };

  return (
    <Screen>
      <ScreenHeader title="Share" />
      <ScrollView contentContainerStyle={{ padding: space[4], paddingBottom: insets.bottom + space[8], gap: space[4], alignItems: 'center' }}>
        {options.length > 1 && (
          <View style={{ flexDirection: 'row', gap: space[2] }} accessibilityRole="tablist">
            {options.map((o, i) => (
              <Pressable
                key={o.label}
                onPress={() => setIndex(i)}
                accessibilityRole="tab"
                accessibilityState={{ selected: i === index }}
                style={{
                  paddingHorizontal: space[3], minHeight: 36, justifyContent: 'center', borderRadius: radius.sm, borderWidth: 1,
                  backgroundColor: i === index ? c.surface : c.surface2, borderColor: i === index ? c.lineStrong : c.line,
                }}
              >
                <Txt variant="caption" color={i === index ? 'ink' : 'ink2'} style={{ fontWeight: i === index ? '500' : '400' }}>
                  {o.label}
                </Txt>
              </Pressable>
            ))}
          </View>
        )}

        {/* Story size, 9:16, as it will be posted. */}
        <View
          style={{
            width: '86%', aspectRatio: 1080 / 1920, borderRadius: radius.lg, overflow: 'hidden',
            backgroundColor: c.surface2, borderWidth: 1, borderColor: c.line, alignItems: 'center', justifyContent: 'center',
          }}
        >
          {loading ? (
            <ActivityIndicator color={c.muted} />
          ) : uri ? (
            <Image source={{ uri }} style={{ width: '100%', height: '100%' }} resizeMode="contain" accessibilityLabel="The card you are about to share" />
          ) : (
            <Txt variant="body" color="muted" style={{ textAlign: 'center', padding: space[4] }}>
              {error}
            </Txt>
          )}
        </View>

        <Txt variant="caption" color="muted" style={{ textAlign: 'center', maxWidth: 320 }}>
          Cards count your public reads only, so a figure here can be smaller than the one on your screen.
        </Txt>
        <Button label="Share" onPress={share} disabled={!uri || sharing} loading={sharing} />
      </ScrollView>
    </Screen>
  );
}
