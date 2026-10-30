// Can the change between two commits reach installed builds as an EAS update,
// or does it need a new APK? (.github/workflows/eas-update.yml)
//
//   node scripts/ota-check.mjs <base-ref> [head-ref]     from apps/mobile, after npm ci
//
// Prints JSON: { changed, native: [reasons] }. `changed` is false when nothing
// under apps/mobile or packages/api-client moved. Any reason in `native` means
// "build a new APK instead": an update carries JavaScript and assets only, and
// one that calls native code the installed binary lacks crashes on start.
//
// Native means: app.json / app.config.ts / eas.json changed (plugins,
// permissions, intent filters, the runtime version), or a dependency was added
// or changed whose package ships native code (android/, ios/, an Expo module
// config, or a React Native codegen config). Removing a dependency is safe:
// the binary keeps code the JavaScript no longer calls.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const [base, head = 'HEAD'] = process.argv.slice(2);
if (!base) {
  console.error('usage: node scripts/ota-check.mjs <base-ref> [head-ref]');
  process.exit(2);
}

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' });
const files = git('diff', '--name-only', base, head).split('\n').filter(Boolean);
const changed = files.some((f) => f.startsWith('apps/mobile/') || f.startsWith('packages/api-client/'));

const native = [];
for (const f of ['apps/mobile/app.json', 'apps/mobile/app.config.ts', 'apps/mobile/eas.json']) {
  if (files.includes(f)) native.push(`${f} changed`);
}
if (files.some((f) => /^apps\/mobile\/(android|ios)\//.test(f))) native.push('native project files changed');

const deps = (ref) => {
  try {
    const pkg = JSON.parse(git('show', `${ref}:apps/mobile/package.json`));
    return { ...pkg.dependencies };
  } catch {
    return {};
  }
};
const before = deps(base);
const after = deps(head);
for (const [name, version] of Object.entries(after)) {
  if (before[name] === version) continue;
  const dir = join('node_modules', name);
  const markers = ['android', 'ios', 'expo-module.config.json', 'react-native.config.js'];
  const hit = markers.find((m) => existsSync(join(dir, m)));
  let codegen = false;
  try {
    codegen = Boolean(JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).codegenConfig);
  } catch {
    // not installed: treated as native below, to be safe
  }
  if (!existsSync(dir)) native.push(`${name}: not installed, cannot tell`);
  else if (hit || codegen) native.push(`${name} ${before[name] ? `${before[name]} -> ` : 'added '}${version} has native code (${hit ?? 'codegenConfig'})`);
}

process.stdout.write(`${JSON.stringify({ changed, native })}\n`);
