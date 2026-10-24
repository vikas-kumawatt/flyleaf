// Owner decision on Phase 5 B: an in-app licences screen crediting every
// bundled asset and every open-source licence that asks for credit.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ASSET_CREDITS, PACKAGE_LICENCES, licenceGroups, packageLicencesFromLock } from '../licences.js';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const FONTS = join(ROOT, '../api/assets/fonts');

describe('licences screen', () => {
  it('the package list is the lock file\'s: regenerate with scripts/generate-licences.ts after a dependency change', () => {
    const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
    assert.deepEqual(PACKAGE_LICENCES, packageLicencesFromLock(lock));
    assert.ok(PACKAGE_LICENCES.length > 100);
    // Shipped packages, not devDependencies.
    assert.ok(PACKAGE_LICENCES.some((p) => p.name === 'react-native'));
    assert.ok(!PACKAGE_LICENCES.some((p) => p.name === 'typescript'));
  });

  it('Twemoji is credited under CC-BY 4.0 with its copyright notice', () => {
    const t = ASSET_CREDITS.find((a) => a.name === 'Twemoji');
    assert.ok(t);
    assert.equal(t.licence, 'CC-BY 4.0');
    assert.match(t.notice, /Twitter, Inc\. and other contributors/);
    assert.match(t.url, /creativecommons\.org\/licenses\/by\/4\.0/);
  });

  it('every font the share cards bundle is credited (OFL keeps its copyright notice)', () => {
    const families = readdirSync(FONTS).filter((f) => f.startsWith('OFL-')).map((f) => f.slice(4, -4));
    assert.ok(families.length >= 21);
    const credit = (fam: string) =>
      fam === 'notosanssc' || fam === 'notosanskr' ? 'Noto Sans CJK (SC, KR)'
        : fam.startsWith('noto') ? 'Noto Sans and Noto Serif' : fam === 'literata' ? 'Literata' : fam === 'archivo' ? 'Archivo' : null;
    for (const fam of families) {
      const name = credit(fam);
      assert.ok(name, `no credit for ${fam}`);
      const c = ASSET_CREDITS.find((a) => a.name === name)!;
      assert.equal(c.licence, 'SIL Open Font License 1.1');
      // The copyright line of the font's own licence file, holder and all, is in the credit.
      const line = readFileSync(join(FONTS, `OFL-${fam}.txt`), 'utf8').split('\n')[0]!;
      const holder = /^Copyright [\d-]+ (.+?) \(/.exec(line)?.[1];
      assert.ok(holder && c.notice.includes(holder), `${fam}: ${line}`);
    }
    // The six scripts added in Phase 5 C are named.
    const noto = ASSET_CREDITS.find((a) => a.name === 'Noto Sans and Noto Serif')!;
    for (const s of ['Sinhala', 'Odia', 'Tibetan', 'Ethiopic', 'Khmer', 'Myanmar']) assert.match(noto.usedFor, new RegExp(s));
  });

  it('the icons and the data source are credited', () => {
    assert.ok(ASSET_CREDITS.some((a) => a.name === 'Ionicons' && a.licence === 'MIT'));
    assert.ok(ASSET_CREDITS.some((a) => a.name === 'Open Library'));
  });

  it('the server packages that draw the share cards are credited at the versions the API pins (Phase 5 C)', () => {
    const api = JSON.parse(readFileSync(join(ROOT, '../api/package.json'), 'utf8')).dependencies;
    for (const [name, pkg] of [['satori', 'satori'], ['resvg-js', '@resvg/resvg-js']] as const) {
      const c = ASSET_CREDITS.find((a) => a.name === name);
      assert.ok(c, name);
      assert.equal(c.licence, 'Mozilla Public License 2.0');
      assert.ok(c.notice.includes(`${pkg} ${api[pkg]}`), `${name}: ${c.notice} vs ${api[pkg]}`);
    }
  });

  it('packages are grouped by licence, every package once', () => {
    const groups = licenceGroups();
    assert.equal(groups.reduce((n, g) => n + g.packages.length, 0), PACKAGE_LICENCES.length);
    assert.equal(groups[0]!.licence, 'MIT');
  });

  // LA-02: reached from Settings → About & legal (it was a Profile tab card).
  it('the screen exists and Settings → About links to it', () => {
    assert.match(readFileSync(join(ROOT, 'app/licences.tsx'), 'utf8'), /ASSET_CREDITS/);
    assert.match(readFileSync(join(ROOT, 'src/lib/settings.ts'), 'utf8'), /href: '\/licences'/);
    assert.match(readFileSync(join(ROOT, 'app/settings/about.tsx'), 'utf8'), /LEGAL_LINKS/);
  });
});
