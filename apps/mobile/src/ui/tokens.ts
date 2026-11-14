// The only place colour literals are permitted. See design.md §2.
//
// Paper and ink: the app is a printed page. Warm paper grounds, warm near-black
// ink, hairline rules where other apps draw boxes. One accent, oxblood, for
// the primary action, selection and progress. Ratings are set in ink with a
// numeral; the heart takes the accent. One grey family, and it is warm.

import { TextStyle } from 'react-native';

export const palette = {
  ground:     { light: '#F4EEE2', dark: '#17130F' },
  surface:    { light: '#FBF6EC', dark: '#1E1A15' },
  surface2:   { light: '#EBE3D3', dark: '#2A251E' },
  ink:        { light: '#211C16', dark: '#EDE6D8' },
  ink2:       { light: '#5C5347', dark: '#B3A998' },
  muted:      { light: '#6B6155', dark: '#948A7A' },
  line:       { light: 'rgba(33,28,22,0.12)', dark: 'rgba(237,230,216,0.12)' },
  lineStrong: { light: 'rgba(33,28,22,0.24)', dark: 'rgba(237,230,216,0.24)' },
  accent:     { light: '#8C2F2A', dark: '#E08A7E' },
  // Text and icons drawn on an accent fill.
  onAccent:   { light: '#FBF6EC', dark: '#17130F' },
  accentSoft: { light: '#F0DDD6', dark: '#33201C' },
  // Stars are ink, not a second accent. A numeral always sits beside them.
  star:       { light: '#211C16', dark: '#EDE6D8' },
  heart:      { light: '#8C2F2A', dark: '#E08A7E' },
  positive:   { light: '#2F6B3F', dark: '#7FBF8B' },
  critical:   { light: '#B3261E', dark: '#F0796E' },
  overlay:    { light: 'rgba(23,19,15,0.4)', dark: 'rgba(0,0,0,0.6)' },
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

// The shape rule: covers 2 (books have corners), inputs and chips 8,
// cards 12, sheets 20, and every action is a pill.
export const radius = {
  xs: 2,
  sm: 2,
  md: 8,
  lg: 12,
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
// Headings, book titles and card titles: Figtree, set firm (500/600) so a
// sans heading still stands apart from the sans body. Everything else,
// review body included: Instrument Sans. Weights stop at 600.
export const fontFamilies = {
  displayRegular: 'Figtree_500Medium',
  displayMedium: 'Figtree_600SemiBold',
  uiRegular: 'InstrumentSans_400Regular',
  uiMedium: 'InstrumentSans_500Medium',
  uiSemiBold: 'InstrumentSans_600SemiBold',
};

// Custom fonts ignore fontWeight on Android, so a weight is a family.
// Anything heavier than 600 is clamped: there are no bold headings.
// `display` picks the heading face (Figtree): 600 and up is SemiBold, anything
// lighter is Medium, so a heading is never set thin.
export function familyFor(display: boolean, weight: TextStyle['fontWeight']): string {
  const w = Number(weight === 'bold' ? 700 : weight === 'normal' || weight == null ? 400 : weight) || 400;
  if (display) return w >= 600 ? fontFamilies.displayMedium : fontFamilies.displayRegular;
  if (w >= 600) return fontFamilies.uiSemiBold;
  if (w >= 500) return fontFamilies.uiMedium;
  return fontFamilies.uiRegular;
}

export const type = {
  // Headings are tightened a little: Figtree at display sizes reads loose
  // with default spacing.
  displayL: {
    fontFamily: fontFamilies.displayMedium,
    fontSize: 32,
    lineHeight: 38,
    fontWeight: '600' as const,
    letterSpacing: -0.6,
  },
  displayM: {
    fontFamily: fontFamilies.displayMedium,
    fontSize: 22,
    lineHeight: 28,
    fontWeight: '600' as const,
    letterSpacing: -0.3,
  },
  // Titles share the heading face: a card or sheet title reads like a
  // heading, not a label on a control.
  title: {
    fontFamily: fontFamilies.displayMedium,
    fontSize: 17,
    lineHeight: 23,
    fontWeight: '600' as const,
    letterSpacing: -0.2,
  },
  bodyL: {
    // Review body: the reading face at a reading size and leading.
    fontFamily: fontFamilies.uiRegular,
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
  // A damping *ratio* with a perceptual duration. Reanimated's plain `damping`
  // is a physical coefficient (default 10): `damping: 0.8` there bounced every
  // sheet for about ten seconds.
  sheet: { duration: 300, dampingRatio: 0.8 },
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
