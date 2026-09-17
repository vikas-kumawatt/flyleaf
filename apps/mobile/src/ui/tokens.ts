// The only place colour literals are permitted. See design.md §11.
//
// Near-monochrome on purpose: book covers are wildly varied and saturated,
// and an interface with its own strong colour fights every one of them.
// The colour in this product comes from the books.

import { TextStyle } from 'react-native';

export const palette = {
  ground:     { light: '#F7F7F5', dark: '#0F1113' },
  surface:    { light: '#FFFFFF', dark: '#17191C' },
  surface2:   { light: '#EFEFEC', dark: '#1F2226' },
  ink:        { light: '#14161A', dark: '#ECEEF0' },
  ink2:       { light: '#43484F', dark: '#B4BAC2' },
  muted:      { light: '#6E747C', dark: '#868D96' },
  line:       { light: '#E2E2DE', dark: '#262A2F' },
  lineStrong: { light: '#CBCBC5', dark: '#363B41' },
  accent:     { light: '#2F5D50', dark: '#7FB3A1' },
  accentSoft: { light: '#E4EDE9', dark: '#18241F' },
  star:       { light: '#C8951F', dark: '#E0AF45' },
  heart:      { light: '#A8443A', dark: '#D9756A' },
  positive:   { light: '#2E6B4E', dark: '#6DB68B' },
  critical:   { light: '#93441D', dark: '#D4906A' },
  overlay:    { light: 'rgba(20,22,26,0.4)', dark: 'rgba(0,0,0,0.6)' },
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

export const radius = {
  sm: 6,
  md: 12,
  lg: 16,
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

// Font families matching design.md §3:
// Display & review body: Literata (fallback Georgia / serif)
// UI & metadata: Archivo (fallback System / sans-serif)
export const fontFamilies = {
  displaySemiBold: 'Literata_600SemiBold',
  displayRegular: 'Literata_400Regular',
  uiSemiBold: 'Archivo_600SemiBold',
  uiMedium: 'Archivo_500Medium',
  uiRegular: 'Archivo_400Regular',
};

// Typography scale (design.md §3, scale 1:1)
export const type = {
  displayL: {
    fontFamily: fontFamilies.displaySemiBold,
    fontSize: 34,
    lineHeight: 40,
    fontWeight: '600' as const,
  },
  displayM: {
    fontFamily: fontFamilies.displaySemiBold,
    fontSize: 26,
    lineHeight: 32,
    fontWeight: '600' as const,
  },
  title: {
    fontFamily: fontFamilies.uiSemiBold,
    fontSize: 20,
    lineHeight: 26,
    fontWeight: '600' as const,
  },
  bodyL: {
    // Review body - serif for bookish feel
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
    lineHeight: 18,
    fontWeight: '400' as const,
  },
  micro: {
    fontFamily: fontFamilies.uiMedium,
    fontSize: 11,
    lineHeight: 14,
    fontWeight: '500' as const,
    letterSpacing: 0.9,
  },
} satisfies Record<string, TextStyle>;

// Tabular numbers style for aligning stats and page counts
export const tabularNums: TextStyle = {
  fontVariant: ['tabular-nums'],
};

export const motion = {
  push: 280,
  sheet: { damping: 0.8 },
  progress: 400,
  star: 150,
  like: 200,
  statsReveal: 600,
  stagger: 40,
} as const;

// Covers are served straight from Open Library's CDN at the size the surface
// renders. Never request L for a grid (architecture.md §5.3, stage 1).
export function coverUrl(coverId: number | null | undefined, size: 'S' | 'M' | 'L'): string | null {
  if (!coverId) return null;
  return `https://covers.openlibrary.org/b/id/${coverId}-${size}.jpg`;
}
