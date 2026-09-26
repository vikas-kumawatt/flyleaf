// react-native-gesture-handler ignores every gesture (feed-card swipes, the
// progress slider) unless the app is wrapped in GestureHandlerRootView. It was
// missing until 26 Sep 2026 and only showed as a runtime warning on a device,
// so pin it structurally: nothing here can render the root layout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const source = readFileSync(
  fileURLToPath(new URL('../../../app/_layout.tsx', import.meta.url)),
  'utf8',
);

test('the root layout is wrapped in GestureHandlerRootView with flex 1', () => {
  const body = source.slice(source.indexOf('export default function RootLayout'));
  const returned = body.slice(body.indexOf('return ('));
  const firstTag = returned.match(/<([A-Za-z.]+)/)?.[1];
  assert.equal(firstTag, 'GestureHandlerRootView');
  assert.match(returned, /<GestureHandlerRootView style=\{\{ flex: 1 \}\}>/);
  assert.match(source, /import \{ GestureHandlerRootView \} from 'react-native-gesture-handler';/);
});
