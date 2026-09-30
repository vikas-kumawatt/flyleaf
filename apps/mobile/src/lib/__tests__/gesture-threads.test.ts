// Gesture callbacks run on the UI thread (audit 09).
//
// With Reanimated installed, the worklets Babel plugin workletizes the
// callbacks of every Gesture.*() builder chain (onStart, onUpdate, onEnd, …),
// and they run on the UI thread. There, a synchronous call to a plain JS
// function (a component helper, Haptics, a prop callback) is an error. The
// Stars drag and the Sheet's swipe-to-dismiss both did that. Nothing here can
// run a gesture, and jest-free node tests run everything on one thread, so the
// rule is pinned structurally: a chain either opts into the JS thread with
// .runOnJS(true), or wraps each JS call in runOnJS(fn)(…). The phone
// checklist (docs/audit/findings/09-reviews.md) is the proof on a device.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Every `const x = Gesture.…` chain in a file, up to its terminating `;`. */
function chains(source: string): string[] {
  const out: string[] = [];
  const re = /=\s*Gesture\.(Pan|Tap|LongPress|Fling|Pinch|Rotation)\(\)/g;
  for (let m = re.exec(source); m; m = re.exec(source)) {
    const end = source.indexOf(';\n', m.index);
    out.push(source.slice(m.index, end));
  }
  return out;
}

// Calls that are fine on the UI thread: shared values, Reanimated animation
// builders, Math, and runOnJS itself.
const WORKLET_SAFE = new Set([
  'runOnJS', 'withTiming', 'withSpring', 'withSequence', 'withRepeat', 'withDecay',
  'max', 'min', 'round', 'abs', 'floor', 'ceil',
  'Pan', 'Tap', 'LongPress', 'Fling', 'Pinch', 'Rotation',
  'enabled', 'onBegin', 'onStart', 'onUpdate', 'onChange', 'onEnd', 'onFinalize',
  'minDistance', 'activeOffsetX', 'activeOffsetY', 'failOffsetX', 'failOffsetY', 'hitSlop', 'maxDuration',
]);

function unsafeCalls(chain: string): string[] {
  const body = chain.replace(/runOnJS\(\s*[\w.]+\s*\)/g, 'runOnJS(ok)');
  const calls = [...body.matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)].map((m) => m[1]!);
  return calls.filter((name) => !WORKLET_SAFE.has(name) && name !== 'ok' && name !== 'if');
}

const FILES = ['../../ui/components.tsx', '../../ui/ProgressSlider.tsx'];

test('every gesture chain runs its callbacks on the JS thread or calls JS only through runOnJS', () => {
  let seen = 0;
  for (const file of FILES) {
    for (const chain of chains(read(file))) {
      seen++;
      if (/\.runOnJS\(true\)/.test(chain)) continue;
      assert.deepEqual(unsafeCalls(chain), [], `${file}: a UI-thread gesture callback calls JS directly:\n${chain}`);
    }
  }
  // Stars, Sheet, and ProgressSlider's pan and tap.
  assert.equal(seen, 4);
});

test('the Stars drag opts into the JS thread', () => {
  const src = read('../../ui/components.tsx');
  const stars = chains(src.slice(src.indexOf('export function Stars')))[0]!;
  assert.match(stars, /\.runOnJS\(true\)/);
});
