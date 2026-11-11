// png.ts — the smallest PNG writer that does the job: one grey channel, 8 or 16 bits. Used for the depth and class images of `look`.
import { deflateSync } from "node:zlib";

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length), v = new DataView(out.buffer);
  v.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  v.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** Encode a width x height grey image. 16-bit samples are written big-endian, as PNG requires. */
export function encodeGrayPng(width: number, height: number, bits: 8 | 16, samples: Uint8Array | Uint16Array): Uint8Array {
  if (samples.length !== width * height) throw new Error("png: sample count does not match the size");
  const bpp = bits / 8, row = width * bpp;
  const raw = new Uint8Array((row + 1) * height); // each row starts with filter byte 0 (none)
  for (let y = 0; y < height; y++) {
    let o = y * (row + 1) + 1;
    for (let x = 0; x < width; x++) {
      const s = samples[y * width + x];
      if (bits === 16) { raw[o++] = s >> 8; raw[o++] = s & 0xff; } else raw[o++] = s;
    }
  }
  const head = new Uint8Array(13), hv = new DataView(head.buffer);
  hv.setUint32(0, width); hv.setUint32(4, height);
  head[8] = bits; head[9] = 0; // grey, no interlace
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", head), chunk("IDAT", deflateSync(raw)), chunk("IEND", new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}
