// The only place colour literals are permitted. See design.md §2.
//
// Graphite surfaces on purpose: book covers are wildly varied and saturated,
// and an interface with its own strong colour fights every one of them.
// The colour in this product comes from the books. One ink-blue accent for
// interaction; gold belongs to the star row and nothing else.

import { TextStyle } from 'react-native';

export const palette = {
  ground:     { light: '#FAFAFA', dark: '#141415' },
  surface:    { light: '#FFFFFF', dark: '#19191B' },
  surface2:   { light: '#F4F4F5', dark: '#232325' },
  ink:        { light: '#171717', dark: '#EDEDED' },
  ink2:       { light: '#525252', dark: '#A1A1A6' },
  muted:      { light: '#737373', dark: '#85858B' },
  line:       { light: 'rgba(23,23,23,0.08)', dark: 'rgba(237,237,237,0.08)' },
  lineStrong: { light: 'rgba(23,23,23,0.16)', dark: 'rgba(237,237,237,0.16)' },
  accent:     { light: '#3355C4', dark: '#8DA6EE' },
  // Text and icons drawn on an accent fill.
  onAccent:   { light: '#FFFFFF', dark: '#141415' },
  accentSoft: { light: '#EEF2FC', dark: '#1B2133' },
  star:       { light: '#B07F14', dark: '#E0AF45' },
  heart:      { light: '#B4423A', dark: '#E5726A' },
  positive:   { light: '#16A34A', dark: '#4CC38A' },
  critical:   { light: '#DC2626', dark: '#E5484D' },
  overlay:    { light: 'rgba(0,0,0,0.4)', dark: 'rgba(0,0,0,0.6)' },
  // Scrim over cover art (wall and diary badges), the same in both themes.
  scrim:      { light: 'rgba(0,0,0,0.64)', dark: 'rgba(0,0,0,0.64)' },
} as const;

export type ColorName = keyof typeof palette;
export type Theme = Record<ColorName, string>;

// Re-export useTheme from theme provider
export { useTheme, useThemeContext, ThemeProvider, type ThemeMode } from './theme';

export const space = {
  1: 4,
  2: 8,
  3: 12,
  4: 16,
  6: 24,
  8: 32,
  12: 48,
  16: 64,
} as const;

// Controls 10, cards 14, sheets 20. Nested: inner = outer - padding, never < 4.
export const radius = {
  xs: 4,
  sm: 6,
  md: 10,
  lg: 14,
  xl: 20,
  pill: 999,
} as const;

// 2:3, always. Placeholders render at the same ratio so grids never jump.
export const cover = {
  xs: { width: 32,  height: 48  },
  s:  { width: 56,  height: 84  },
  m:  { width: 88,  height: 132 },
  l:  { width: 120, height: 180 },
  xl: { width: 180, height: 270 },
} as const;

// Font families (design.md §3):
// Interface: Instrument Sans. Book titles, screen titles, review body: Newsreader.
// Weights stop at 600; hierarchy comes from size and colour.
export const fontFamilies = {
  displayRegular: 'Newsreader_400Regular',
  displayMedium: 'Newsreader_500Medium',
  uiRegular: 'InstrumentSans_400Regular',
  uiMedium: 'InstrumentSans_500Medium',
  uiSemiBold: 'InstrumentSans_600SemiBold',
};

// Custom fonts ignore fontWeight on Android, so a weight is a family.
// Anything heavier than 600 is clamped: there are no bold headings.
export function familyFor(serif: boolean, weight: TextStyle['fontWeight']): string {
  const w = Number(weight === 'bold' ? 700 : weight === 'normal' || weight == null ? 400 : weight) || 400;
  if (serif) return w >= 500 ? fontFamilies.displayMedium : fontFamilies.displayRegular;
  if (w >= 600) return fontFamilies.uiSemiBold;
  if (w >= 500) return fontFamilies.uiMedium;
  return fontFamilies.uiRegular;
}

export const type = {
  displayL: {
    fontFamily: fontFamilies.displayRegular,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '400' as const,
  },
  displayM: {
    fontFamily: fontFamilies.displayMedium,
    fontSize: 24,
    lineHeight: 30,
    fontWeight: '500' as const,
  },
  title: {
    fontFamily: fontFamilies.uiMedium,
    fontSize: 17,
    lineHeight: 24,
    fontWeight: '500' as const,
  },
  bodyL: {
    // Review body: serif, because reading a review should feel like reading
    fontFamily: fontFamilies.displayRegular,
    fontSize: 17,
    lineHeight: 26,
    fontWeight: '400' as const,
  },
  body: {
    fontFamily: fontFamilies.uiRegular,
    fontSize: 15,
    lineHeight: 22,
    fontWeight: '400' as const,
  },
  caption: {
    fontFamily: fontFamilies.uiRegular,
    fontSize: 13,
    lineHeight: 20,
    fontWeight: '400' as const,
  },
  // Section labels and meta. Sentence case, no tracking.
  micro: {
    fontFamily: fontFamilies.uiMedium,
    fontSize: 12,
    lineHeight: 16,
    fontWeight: '500' as const,
  },
} satisfies Record<string, TextStyle>;

// Tabular numbers style for aligning stats and page counts
export const tabularNums: TextStyle = {
  fontVariant: ['tabular-nums'],
};

// One easing curve everywhere: cubic-bezier(0.22, 1, 0.36, 1).
// Short for feedback, longer for things that enter. No bounces.
export const motion = {
  press: 140,
  menu: 180,
  push: 280,
  sheet: { damping: 0.8 },
  progress: 400,
  star: 150,
  like: 200,
  statsReveal: 600,
  stagger: 40,
  easing: [0.22, 1, 0.36, 1] as const,
} as const;

// Covers are served straight from Open Library's CDN at the size the surface
// renders. Never request L for a grid (architecture.md §5.3, stage 1).
export function coverUrl(coverId: number | null | undefined, size: 'S' | 'M' | 'L'): string | null {
  if (!coverId) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
}
