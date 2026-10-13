// The licences screen (owner decision on Phase 5 B; PRD §6.43 "About / Legal:
// licences, data attribution"): every bundled asset and every open-source
// package the app ships, with the credit its licence asks for.
//
// Two parts:
//   ASSET_CREDITS     written by hand: fonts, icons and emoji the app or its
//                     share cards draw, and the data sources (§41.1).
//   PACKAGE_LICENCES  generated from package-lock.json by
//                     `npx tsx scripts/generate-licences.ts` (licences.data.ts);
//                     a test fails when the lock file and the list disagree.

import { PACKAGE_LICENCES } from './licences.data';

export interface AssetCredit {
  name: string;
  /** Where it appears. */
  usedFor: string;
  /** The notice the licence asks to be kept. */
  notice: string;
  licence: string;
  url: string;
}

export const ASSET_CREDITS: AssetCredit[] = [
  {
    name: 'Twemoji',
    usedFor: 'Emoji on share cards',
    notice: 'Copyright 2019 Twitter, Inc. and other contributors; jdecked/twemoji. Graphics licensed under CC-BY 4.0.',
    licence: 'CC-BY 4.0',
    url: 'https://creativecommons.org/licenses/by/4.0/',
  },
  {
    name: 'Literata',
    usedFor: 'Titles and quotes in the app and on share cards',
    notice: 'Copyright 2017 The Literata Project Authors (https://github.com/googlefonts/literata).',
    licence: 'SIL Open Font License 1.1',
    url: 'https://openfontlicense.org',
  },
  {
    name: 'Archivo',
    usedFor: 'Text and numbers in the app and on share cards',
    notice: 'Copyright 2020 The Archivo Project Authors (https://github.com/Omnibus-Type/Archivo).',
    licence: 'SIL Open Font License 1.1',
    url: 'https://openfontlicense.org',
  },
  {
    name: 'Noto Sans and Noto Serif',
    usedFor:
      'Share cards in Arabic, Hebrew, Devanagari, Bengali, Tamil, Telugu, Kannada, Malayalam, Gujarati, Gurmukhi, Thai, Sinhala, Odia, Tibetan, Ethiopic, Khmer and Myanmar',
    notice: 'Copyright 2022 The Noto Project Authors (https://github.com/notofonts). Modified: static instances, hinting removed.',
    licence: 'SIL Open Font License 1.1',
    url: 'https://openfontlicense.org',
  },
  {
    name: 'Noto Sans CJK (SC, KR)',
    usedFor: 'Share cards in Chinese, Japanese and Korean',
    notice: "Copyright 2014-2021 Adobe (http://www.adobe.com/), with Reserved Font Name 'Source'. Modified: static instance, hinting removed, Korean subset to Hangul.",
    licence: 'SIL Open Font License 1.1',
    url: 'https://openfontlicense.org',
  },
  {
    name: 'Ionicons',
    usedFor: 'Icons in the app (through @expo/vector-icons)',
    notice: 'Copyright (c) 2015-present Ionic (http://ionic.io/).',
    licence: 'MIT',
    url: 'https://github.com/ionic-team/ionicons/blob/main/LICENSE',
  },
  {
    name: 'Open Library',
    usedFor: 'Book data and covers',
    notice: 'Book data from Open Library (openlibrary.org), dedicated to the public domain under CC0 1.0. Thank you to the Internet Archive and Open Library contributors.',
    licence: 'CC0 1.0 (data)',
    url: 'https://openlibrary.org/developers/licensing',
  },
];

export interface PackageLicence {
  name: string;
  version: string;
  licence: string;
}

/** Packages the app ships (not devDependencies), from a v3 package-lock, sorted by name. */
export function packageLicencesFromLock(lock: { packages?: Record<string, { version?: string; license?: string; dev?: boolean; devOptional?: boolean }> }): PackageLicence[] {
  const out = new Map<string, PackageLicence>();
  for (const [path, p] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith('node_modules/') || p.dev || p.devOptional) continue;
    const name = path.slice(path.lastIndexOf('node_modules/') + 'node_modules/'.length);
    const entry = { name, version: p.version ?? '', licence: p.license ?? 'See package' };
    out.set(`${name}@${entry.version}`, entry);
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

/** Packages grouped by licence, the largest group first, for the screen. */
export function licenceGroups(list: PackageLicence[] = PACKAGE_LICENCES): Array<{ licence: string; packages: PackageLicence[] }> {
  const groups = new Map<string, PackageLicence[]>();
  for (const p of list) groups.set(p.licence, [...(groups.get(p.licence) ?? []), p]);
  return [...groups.entries()]
    .map(([licence, packages]) => ({ licence, packages }))
    .sort((a, b) => b.packages.length - a.packages.length || a.licence.localeCompare(b.licence));
}

export { PACKAGE_LICENCES };
