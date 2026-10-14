// Owner decision on SO-5x: https links to the public pages open the app.
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { appPathFor, linkHostsFrom } from '../appLinks';

const root = new URL('../../../', import.meta.url);
const read = (p: string) => readFileSync(new URL(p, root), 'utf8');

describe('App Links (owner decision on SO-5x)', () => {
  test('/@username opens the username screen, /book/:id the book', () => {
    assert.equal(appPathFor('https://flyleaf.app/@ada_reads'), '/u/ada_reads');
    assert.equal(appPathFor('https://flyleaf.app/%40ada_reads/'), '/u/ada_reads');
    assert.equal(appPathFor('/@ada_reads?utm=x'), '/u/ada_reads?utm=x');
    assert.equal(appPathFor('https://flyleaf.app/book/0b6f7a3e-1111-4222-8333-444455556666'), '/work/0b6f7a3e-1111-4222-8333-444455556666');
  });

  test('every other link passes through unchanged', () => {
    for (const p of [
      'https://flyleaf.app/u/ada_reads',
      'https://flyleaf.app/u/ada_reads/shelves/sci-fi',
      'https://flyleaf.app/verify-email?token=abc',
      'flyleaf://work/123',
      '/user/123',
      'https://example.com/@ada',
      'https://flyleaf.app/%E0%A4%A',
    ]) {
      assert.equal(appPathFor(p), p);
    }
  });

  test('the rewrite is wired in, and the username screen resolves through the API', () => {
    assert.match(read('app/+native-intent.tsx'), /appPathFor\(path, HOSTS\)/);
    assert.match(read('app/+native-intent.tsx'), /linkHostsFrom\(Constants\.expoConfig\?\.extra\)/);
    assert.ok(existsSync(new URL('app/u/[username]/index.tsx', root)));
    assert.match(read('app/u/[username]/index.tsx'), /api\s*\.userByUsername\(username\)/);
    assert.ok(existsSync(new URL('app/work/[id].tsx', root)));
  });

  test('links to the beta server are rewritten when the build lists its host', () => {
    const beta = 'flyleaf-vk.koreacentral.cloudapp.azure.com';
    const hosts = linkHostsFrom({ appLinkHosts: [beta.toUpperCase()] });
    assert.deepEqual(hosts, ['flyleaf.app', 'www.flyleaf.app', beta]);
    assert.equal(appPathFor(`https://${beta}/@ada_reads`, hosts), '/u/ada_reads');
    assert.equal(appPathFor(`https://${beta}/book/abc`, hosts), '/work/abc');
    assert.equal(appPathFor('https://flyleaf.app/@ada_reads', hosts), '/u/ada_reads');
    // Not listed: untouched.
    assert.equal(appPathFor(`https://${beta}/@ada_reads`), `https://${beta}/@ada_reads`);
    assert.deepEqual(linkHostsFrom(undefined), ['flyleaf.app', 'www.flyleaf.app']);
    assert.deepEqual(linkHostsFrom({ appLinkHosts: 'x' }), ['flyleaf.app', 'www.flyleaf.app']);
  });

  test("app.json sends the three public-page prefixes to the app", () => {
    const json = JSON.parse(read('app.json'));
    const prefixes = json.expo.android.intentFilters.flatMap((f: any) => f.data).map((d: any) => d.pathPrefix).filter(Boolean);
    assert.deepEqual([...new Set(prefixes)].sort(), ['/@', '/book/', '/u/']);
  });
});
