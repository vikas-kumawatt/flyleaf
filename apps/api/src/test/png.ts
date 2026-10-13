// A minimal PNG reader for the share-card tests (ST-08 golden images): 8-bit
// RGBA or RGB, not interlaced (what resvg writes). Returns RGBA pixels.

import { inflateSync } from 'node:zlib';

export interface Pixels {
  width: number;
  height: number;
  /** RGBA, row-major. */
  data: Uint8Array;
}

export function decodePng(buf: Buffer): Pixels {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const body = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      if (body[8] !== 8 || body[12] !== 0) throw new Error('only 8-bit, non-interlaced PNGs');
      colorType = body[9]!;
    } else if (type === 'IDAT') idat.push(body);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : 0;
  if (!channels) throw new Error(`unsupported colour type ${colorType}`);
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!;
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      out[o] = cur[x * channels]!;
      out[o + 1] = cur[x * channels + 1]!;
      out[o + 2] = cur[x * channels + 2]!;
      out[o + 3] = channels === 4 ? cur[x * channels + 3]! : 255;
    }
    prev = cur;
  }
  return { width, height, data: out };
}

/** Share of pixels where any channel differs by more than `threshold`. */
export function diffRatio(a: Pixels, b: Pixels, threshold = 24, region?: { x0: number; y0: number; x1: number; y1: number }): number {
  if (a.width !== b.width || a.height !== b.height) return 1;
  const r = region ?? { x0: 0, y0: 0, x1: a.width, y1: a.height };
  let differ = 0;
  let total = 0;
  for (let y = r.y0; y < r.y1; y++) {
    for (let x = r.x0; x < r.x1; x++) {
      const o = (y * a.width + x) * 4;
      total += 1;
      for (let k = 0; k < 4; k++) {
        if (Math.abs(a.data[o + k]! - b.data[o + k]!) > threshold) { differ += 1; break; }
      }
    }
  }
  return total === 0 ? 0 : differ / total;
}

/** Pixels in a region that are not `rgb` (within `threshold`). */
export function pixelsNot(p: Pixels, rgb: [number, number, number], region: { x0: number; y0: number; x1: number; y1: number }, threshold = 8): number {
  let n = 0;
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const o = (y * p.width + x) * 4;
      if (Math.abs(p.data[o]! - rgb[0]) > threshold || Math.abs(p.data[o + 1]! - rgb[1]) > threshold || Math.abs(p.data[o + 2]! - rgb[2]) > threshold) n += 1;
    }
  }
  return n;
}
