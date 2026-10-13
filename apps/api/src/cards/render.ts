// The share-card renderer (ST-07; PRD §6.45, §29.1 loop 1, AC-18;
// architecture §9 `media.sharecard`): an element tree → satori → SVG →
// resvg → PNG, in this process, with nothing fetched while it runs.
//
//   Fonts      assets/fonts, read once (scripts/build-card-fonts.sh; OFL,
//              licences beside them). Literata for titles and quotes, Archivo
//              for labels and numbers, Noto for Arabic, Hebrew, the main Indic
//              scripts, Thai, Chinese/Japanese (Noto Sans SC), Hangul, and
//              (Phase 5 C) Sinhala, Odia, Tibetan, Ethiopic, Khmer, Myanmar.
//              resvg loads no system fonts, so a card looks the same on every
//              machine.
//   Emoji      Twemoji SVGs from disk (text.ts).
//   Images     data: URIs only. A template is given bytes, never a URL, so
//              nothing can be hot-linked (covers come from our storage: covers.ts).
//   Cache      by content hash: sha-256 of the template version, the template
//              and its model (every string and image byte it draws). Same
//              content, same PNG, from memory. Bounded in bytes, least
//              recently used out first. The hash is also the ETag.
//   Load       at most MAX_CONCURRENT renders at once; others wait their turn.
//   Memory     resvg draws into a native pixmap (1080 × 1920 × 4 ≈ 8 MB) that
//              is freed only when V8 collects the small JS object holding it,
//              and V8 cannot see the 8 MB, so it is in no hurry: measured in
//              the sandbox, RSS swung to 600 MB–2.4 GB over a few hundred
//              renders. A young-generation GC after each render (≈0.5 ms)
//              and one turn of the event loop free it, and RSS stays flat
//              (bench:cards; `--no-gc` shows the difference).
//
// What a card may show and who may fetch it is decided before it gets here
// (service.ts): this file draws what it is given.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import v8 from 'node:v8';
import vm from 'node:vm';
import satori, { type Font } from 'satori';
import { Resvg } from '@resvg/resvg-js';

import { emojiDataUri } from './text.js';

/** Portrait, story dimensions (PRD §6.45, §29.1). */
export const CARD_WIDTH = 1080;
export const CARD_HEIGHT = 1920;

/** Bump when any template's drawing changes, so cached PNGs of the old design are not served. */
export const TEMPLATE_VERSION = 'st-c.1';

const FONT_DIR = new URL('../../assets/fonts/', import.meta.url);

/** Family names the templates use. */
export const SERIF = 'Literata';
export const SANS = 'Archivo';

/** Fallbacks for scripts the two faces lack, in the order satori tries them. */
const FALLBACKS = [
  'Noto Sans Arabic', 'Noto Sans Hebrew', 'Noto Sans Devanagari', 'Noto Sans Bengali', 'Noto Sans Tamil',
  'Noto Sans Telugu', 'Noto Sans Kannada', 'Noto Sans Malayalam', 'Noto Sans Gujarati', 'Noto Sans Gurmukhi',
  'Noto Sans Thai', 'Noto Sans SC', 'Noto Sans KR',
  // Owner decision on Phase 5 B, built in 5 C.
  'Noto Sans Sinhala', 'Noto Sans Oriya', 'Noto Serif Tibetan', 'Noto Sans Ethiopic', 'Noto Sans Khmer', 'Noto Sans Myanmar',
];
export const SERIF_STACK = [SERIF, ...FALLBACKS].map((f) => `"${f}"`).join(', ');
export const SANS_STACK = [SANS, ...FALLBACKS].map((f) => `"${f}"`).join(', ');

const FONT_FILES: Array<[name: string, file: string, weight: 400 | 600]> = [
  ['Literata', 'Literata-Regular.ttf', 400],
  ['Literata', 'Literata-SemiBold.ttf', 600],
  ['Archivo', 'Archivo-Regular.ttf', 400],
  ['Archivo', 'Archivo-SemiBold.ttf', 600],
  ['Noto Sans Arabic', 'NotoSansArabic-Regular.ttf', 400],
  ['Noto Sans Arabic', 'NotoSansArabic-SemiBold.ttf', 600],
  ['Noto Sans Hebrew', 'NotoSansHebrew-Regular.ttf', 400],
  ['Noto Sans Hebrew', 'NotoSansHebrew-SemiBold.ttf', 600],
  ['Noto Sans Devanagari', 'NotoSansDevanagari-Regular.ttf', 400],
  ['Noto Sans Bengali', 'NotoSansBengali-Regular.ttf', 400],
  ['Noto Sans Tamil', 'NotoSansTamil-Regular.ttf', 400],
  ['Noto Sans Telugu', 'NotoSansTelugu-Regular.ttf', 400],
  ['Noto Sans Kannada', 'NotoSansKannada-Regular.ttf', 400],
  ['Noto Sans Malayalam', 'NotoSansMalayalam-Regular.ttf', 400],
  ['Noto Sans Gujarati', 'NotoSansGujarati-Regular.ttf', 400],
  ['Noto Sans Gurmukhi', 'NotoSansGurmukhi-Regular.ttf', 400],
  ['Noto Sans Thai', 'NotoSansThai-Regular.ttf', 400],
  ['Noto Sans SC', 'NotoSansSC-Regular.ttf', 400],
  ['Noto Sans KR', 'NotoSansKR-Hangul-Regular.ttf', 400],
  ['Noto Sans Sinhala', 'NotoSansSinhala-Regular.ttf', 400],
  ['Noto Sans Oriya', 'NotoSansOriya-Regular.ttf', 400],
  ['Noto Serif Tibetan', 'NotoSerifTibetan-Regular.ttf', 400],
  ['Noto Sans Ethiopic', 'NotoSansEthiopic-Regular.ttf', 400],
  ['Noto Sans Khmer', 'NotoSansKhmer-Regular.ttf', 400],
  ['Noto Sans Myanmar', 'NotoSansMyanmar-Regular.ttf', 400],
];

let fonts: Font[] | null = null;

/** The fonts, read from disk once. The same array every call: satori keeps its parsed fonts per array. */
export function cardFonts(): Font[] {
  fonts ??= FONT_FILES.map(([name, file, weight]) => ({
    name,
    weight,
    style: 'normal' as const,
    data: readFileSync(new URL(file, FONT_DIR)),
  }));
  return fonts;
}

/** A satori element: what JSX compiles to, without JSX. */
export interface CardNode {
  type: string;
  props: { style?: Record<string, unknown>; children?: CardChild | CardChild[]; [key: string]: unknown };
}
export type CardChild = CardNode | string | null | undefined | false;

export function h(type: string, props: Record<string, unknown> | null, ...children: CardChild[]): CardNode {
  const kids = children.filter((c) => c !== null && c !== undefined && c !== false);
  return { type, props: { ...(props ?? {}), ...(kids.length ? { children: kids.length === 1 ? kids[0] : kids } : {}) } };
}

/** SVG for an element tree. Emoji from Twemoji; a script with no font draws nothing rather than fetching one. */
export async function toSvg(node: CardNode, size = { width: CARD_WIDTH, height: CARD_HEIGHT }): Promise<string> {
  return satori(node as never, {
    ...size,
    fonts: cardFonts(),
    loadAdditionalAsset: async (code: string, segment: string) => (code === 'emoji' ? emojiDataUri(segment) : []),
  });
}

/** PNG for SVG, with no system fonts (every glyph is already a path) and nothing loaded from outside. */
export function toPng(svg: string, width = CARD_WIDTH): Buffer {
  const resvg = new Resvg(svg, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: false },
    // No external hrefs: images are data URIs already.
    imageRendering: 0,
    shapeRendering: 2,
    textRendering: 1,
  });
  return resvg.render().asPng();
}

type Gc = (opts?: { type?: 'minor' | 'major' }) => void;
let collect: Gc | null | undefined;

/** V8's gc(), from `--expose-gc` when the process has it, else enabled here once. null if neither works. */
function gcFunction(): Gc | null {
  if (collect !== undefined) return collect;
  const exposed = (globalThis as { gc?: Gc }).gc;
  if (typeof exposed === 'function') return (collect = exposed);
  try {
    v8.setFlagsFromString('--expose-gc');
    collect = vm.runInNewContext('gc') as Gc;
  } catch {
    collect = null;
  }
  return collect;
}

/**
 * Frees the native pixmaps of renders that are done (see "Memory" above):
 * a young-generation GC finds their holders dead, and Node runs the native
 * finalizers on the next turn of the event loop, which this waits for.
 */
export async function releaseRenderMemory(): Promise<void> {
  gcFunction()?.({ type: 'minor' });
  await new Promise<void>((resolve) => setImmediate(resolve));
}

/** The cache key: template version, template, and everything it draws. */
export function contentHash(template: string, model: unknown): string {
  return createHash('sha256').update(TEMPLATE_VERSION).update('\0').update(template).update('\0').update(JSON.stringify(model)).digest('hex');
}

class Semaphore {
  #free: number;
  #queue: Array<() => void> = [];
  constructor(n: number) { this.#free = n; }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#free > 0) this.#free -= 1;
    else await new Promise<void>((resolve) => this.#queue.push(resolve));
    try {
      return await fn();
    } finally {
      const next = this.#queue.shift();
      if (next) next();
      else this.#free += 1;
    }
  }
}

export interface RenderedCard {
  png: Buffer;
  hash: string;
  cached: boolean;
  /** Milliseconds spent rendering (0 from cache). */
  renderMs: number;
}

export interface CardRendererOptions {
  /** Bytes of PNG kept in memory. Default 32 MB (a story card is ~50–400 KB). */
  maxCacheBytes?: number;
  /** Renders at once. Default 2: the server is a small VM. */
  maxConcurrent?: number;
}

export class CardRenderer {
  readonly #cache = new Map<string, Buffer>();
  #bytes = 0;
  readonly #maxBytes: number;
  readonly #gate: Semaphore;
  /** Renders in flight by hash, so two requests for the same new card render it once. */
  readonly #inflight = new Map<string, Promise<Buffer>>();
  /** Renders done (not cache hits): tests and the bench read it. */
  renders = 0;

  constructor(opts: CardRendererOptions = {}) {
    this.#maxBytes = opts.maxCacheBytes ?? 32 * 1024 * 1024;
    this.#gate = new Semaphore(opts.maxConcurrent ?? 2);
  }

  async render(template: string, model: unknown, draw: () => CardNode): Promise<RenderedCard> {
    const hash = contentHash(template, model);
    const hit = this.#cache.get(hash);
    if (hit) {
      // Most recently used goes to the back.
      this.#cache.delete(hash);
      this.#cache.set(hash, hit);
      return { png: hit, hash, cached: true, renderMs: 0 };
    }
    const started = performance.now();
    let pending = this.#inflight.get(hash);
    if (!pending) {
      pending = this.#gate.run(async () => {
        const png = toPng(await toSvg(draw()));
        // Before the next render may start, so a queue of them stays flat.
        await releaseRenderMemory();
        this.renders += 1;
        this.#store(hash, png);
        return png;
      }).finally(() => this.#inflight.delete(hash));
      this.#inflight.set(hash, pending);
    }
    const png = await pending;
    return { png, hash, cached: false, renderMs: performance.now() - started };
  }

  #store(hash: string, png: Buffer) {
    if (png.length > this.#maxBytes) return;
    this.#cache.set(hash, png);
    this.#bytes += png.length;
    for (const [key, value] of this.#cache) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#cache.delete(key);
      this.#bytes -= value.length;
    }
  }

  get cachedBytes(): number {
    return this.#bytes;
  }
}
