// The non-ready states of a useRemote screen, in one place so every screen
// says the same thing (audit 08).

import React from 'react';
import { View } from 'react-native';
import type { RemoteState } from '@/lib/useRemote';
import { Button, EmptyState, Screen, Txt, sheet } from '@/ui/components';

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
    return (
      <Screen>
        <View style={sheet.pad}>
          <Txt color="muted">Loading {noun}…</Txt>
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
