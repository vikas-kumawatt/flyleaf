// The non-ready states of a useRemote screen, in one place so every screen
// says the same thing (audit 08).

import React from 'react';
import { View } from 'react-native';
import type { RemoteState } from '@/lib/useRemote';
import { Button, EmptyState, Screen, Skeleton, SkeletonHeader, SkeletonList, sheet } from '@/ui/components';
import { space } from '@/ui/tokens';

export function RemoteStatus({
  remote,
  noun,
  onRetry,
}: {
  remote: RemoteState<unknown>;
  /** "book", "author", "series" */
  noun: string;
  onRetry: () => void;
}) {
  if (remote.state === 'loading') {
    // Shape-matched to the screen that will replace it (design.md §5).
    return (
      <Screen>
        <View accessible accessibilityLabel={`Loading ${noun}`} accessibilityState={{ busy: true }}>
          {noun === 'series' ? (
            <>
              <View style={[sheet.pad, { gap: space[2] }]}>
                <Skeleton width="60%" height={30} />
                <Skeleton width="30%" height={12} />
              </View>
              <SkeletonList lead="cover" rows={5} />
            </>
          ) : (
            <>
              <SkeletonHeader lead={noun === 'book' ? 'cover' : 'avatar'} />
              <View style={[sheet.pad, { gap: space[2] }]}>
                {['100%', '94%', '88%', '60%'].map((w, i) => (
                  <Skeleton key={i} width={w as `${number}%`} height={14} />
                ))}
              </View>
            </>
          )}
        </View>
      </Screen>
    );
  }
  if (remote.state === 'missing') {
    return (
      <Screen>
        <EmptyState title={`This ${noun} isn’t available`} subtitle="It may have been removed, or the link is out of date." />
      </Screen>
    );
  }
  return (
    <Screen>
      <EmptyState
        title={`Couldn’t load this ${noun}`}
        subtitle="Check your connection and try again."
        action={<Button label="Try again" variant="secondary" onPress={onRetry} />}
      />
    </Screen>
  );
}
