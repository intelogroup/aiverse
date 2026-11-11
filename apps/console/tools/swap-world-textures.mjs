// swap-textures.mjs — replace a GLB's embedded JPEG/PNG images with KTX2 (Basis) encodings,
// touching NOTHING else: geometry bufferViews are copied byte-for-byte (meshopt streams and
// their extension offsets are remapped through an exact range map), nodes/materials/extras/
// lights JSON is preserved verbatim. Only edits: images[].mimeType, image bufferView
// byteOffset/byteLength, textures[].extensions.KHR_texture_basisu, extensionsUsed += basisu.
//
// usage: node swap-textures.mjs <in.glb> <out.glb> <toktx-bin-dir>
import { readFileSync, writeFileSync, mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [inPath, outPath, toktxDir] = process.argv.slice(2);
if (!inPath || !outPath || !toktxDir) { console.error("usage: node swap-textures.mjs <in.glb> <out.glb> <toktx-bin-dir>"); process.exit(2); }
const toktx = join(toktxDir, "toktx");

const buf = readFileSync(inPath);
if (buf.readUInt32LE(0) !== 0x46546c67) throw new Error("not a GLB");
const jsonLen = buf.readUInt32LE(12);
const json = JSON.parse(buf.subarray(20, 20 + jsonLen).toString("utf8"));
const binHead = 20 + jsonLen;
if (buf.readUInt32LE(binHead + 4) !== 0x004e4942) throw new Error("BIN chunk not second");
const binLen = buf.readUInt32LE(binHead);
const bin = buf.subarray(binHead + 8, binHead + 8 + binLen);

// ---- classify images by role via material texture slots --------------------
const roleOf = new Map(); // imageIndex -> 'color'|'normal'|'data'
const rank = { data: 0, color: 1, normal: 2 };
function note(texIndex, key) {
  const tex = json.textures?.[texIndex];
  if (!tex || tex.source == null) return;
  const role = /normal/i.test(key) ? "normal" : /(basecolor|emissive|diffuse|sheencolor|specularcolor)/i.test(key) ? "color" : "data";
  const prev = roleOf.get(tex.source);
  if (!prev || rank[role] > rank[prev]) roleOf.set(tex.source, role);
}
function scan(obj) {
  if (!obj || typeof obj !== "object") return;
  for (const [k, v] of Object.entries(obj)) {
    if (k.endsWith("Texture") && v && typeof v === "object" && Number.isInteger(v.index)) note(v.index, k);
    else if (typeof v === "object") scan(v);
  }
}
for (const m of json.materials ?? []) scan(m);
const conflicts = [];
for (const [img, role] of roleOf) if (role === "color") { /* color wins over data silently; normal logged below */ }
const unreferenced = [];
(json.images ?? []).forEach((im, i) => { if (!roleOf.has(i)) { roleOf.set(i, "color"); unreferenced.push(i); } });

// ---- extract + encode (cached: exp/ktx-cache/img<i>.ktx2; delete a cache file to re-encode it)
const cacheDir = new URL("./ktx-cache/", import.meta.url).pathname;
mkdirSync(cacheDir, { recursive: true });
const tmp = mkdtempSync(join(tmpdir(), "ktxswap-"));
const newPayload = new Map(); // imageIndex -> Buffer (ktx2)
let oldImgBytes = 0, newImgBytes = 0;
const roleCount = { color: 0, normal: 0, data: 0 };
(json.images ?? []).forEach((im, i) => {
  if (im.bufferView == null) throw new Error(`image ${i} has no bufferView (external uri unsupported)`);
  const bv = json.bufferViews[im.bufferView];
  const start = bv.byteOffset || 0;
  const payload = bin.subarray(start, start + bv.byteLength);
  oldImgBytes += payload.length;
  const role = roleOf.get(i); roleCount[role]++;
  const cached = join(cacheDir, `img${i}.ktx2`);
  if (existsSync(cached)) { const out = readFileSync(cached); newPayload.set(i, out); newImgBytes += out.length; return; }
  const ext = im.mimeType === "image/png" ? "png" : "jpg";
  const src = join(tmp, `img${i}.${ext}`);
  writeFileSync(src, payload);
  const args = ["--encode", "etc1s", "--clevel", "1", "--qlevel", role === "normal" ? "255" : "128", "--genmipmap", "--assign_oetf", role === "color" ? "srgb" : "linear", cached, src];
  execFileSync(toktx, args, { stdio: ["ignore", "ignore", "pipe"] });
  console.log(`encoded img${i} (role=${role})`);
  const out = readFileSync(cached);
  newPayload.set(i, out);
  newImgBytes += out.length;
});
console.log(`images: ${json.images.length} (color=${roleCount.color} normal=${roleCount.normal} data=${roleCount.data}) unreferenced=${unreferenced.length}`);
console.log(`image bytes: ${oldImgBytes} -> ${newImgBytes}`);

// ---- repack the BIN by atomic segmentation -----------------------------------
// This file's meshopt streams are NOT all covered by bufferView ranges (some live in
// unreferenced BIN gaps, some straddle BV boundaries — BV ranges describe the decoded
// fallback layout). The only safe unit is the atomic segment between consecutive
// interval boundaries, copied in original order; intervals spanning segments stay
// contiguous (alignment padding is inserted only at fresh interval-run starts).
const imgByBV = new Map(); // bufferViewIndex -> imageIndex
(json.images ?? []).forEach((im, i) => {
  if (imgByBV.has(im.bufferView)) throw new Error(`bufferView ${im.bufferView} shared by two images`);
  imgByBV.set(im.bufferView, i);
});
const align4 = (n) => (n + 3) & ~3;
const intervals = []; // {start, end, kind, idx}
json.bufferViews.forEach((bv, i) => {
  const s = bv.byteOffset || 0;
  if (s % 4 !== 0) throw new Error(`bufferView ${i} starts at non-4-aligned offset ${s}`);
  intervals.push({ start: s, end: s + bv.byteLength, kind: "bv", idx: i });
  const e = bv.extensions?.EXT_meshopt_compression;
  if (e) intervals.push({ start: e.byteOffset, end: e.byteOffset + e.byteLength, kind: "ext", idx: i });
});
const imgRange = new Map();
(json.images ?? []).forEach((im, i) => {
  const bv = json.bufferViews[im.bufferView];
  const s = bv.byteOffset || 0;
  imgRange.set(i, { start: s, end: s + bv.byteLength });
});
const boundsSet = new Set([0, bin.length]);
for (const iv of intervals) { boundsSet.add(iv.start); boundsSet.add(iv.end); }
for (const r of imgRange.values()) { boundsSet.add(r.start); boundsSet.add(r.end); }
const bounds = [...boundsSet].sort((a, b) => a - b);
const segIntervals = (a, b) => intervals.filter(iv => iv.start < b && a < iv.end); // intervals covering segment [a,b)
const segNewStart = new Map(); // old boundary -> new offset
const outChunks = []; // {to, bytes}
let cursor = 0;
let prevCover = [];
const imgEmittedAt = new Map(); // imageIndex -> new offset of its payload
for (let s = 0; s < bounds.length - 1; s++) {
  const a = bounds[s], b = bounds[s + 1];
  if (b <= a) { segNewStart.set(a, cursor); continue; }
  const cover = segIntervals(a, b);
  const continuation = cover.some(iv => prevCover.includes(iv));
  if (!continuation) cursor = align4(cursor);
  const imgHit = [...imgRange.entries()].find(([, r]) => a >= r.start && a < r.end);
  if (imgHit) {
    const [imgIdx, r] = imgHit;
    if (!imgEmittedAt.has(imgIdx)) {
      const p = newPayload.get(imgIdx);
      imgEmittedAt.set(imgIdx, cursor);
      outChunks.push({ to: cursor, bytes: p });
      cursor += p.length;
    }
    segNewStart.set(a, imgEmittedAt.get(imgIdx) + (a - r.start));
  } else {
    segNewStart.set(a, cursor);
    outChunks.push({ to: cursor, bytes: bin.subarray(a, b) });
    cursor += b - a;
  }
  prevCover = cover;
}
segNewStart.set(bin.length, cursor);
const newBin = Buffer.alloc(align4(cursor));
for (const c of outChunks) Buffer.from(c.bytes).copy(newBin, c.to);
function mapOffset(o) {
  // largest boundary <= o
  let lo = 0, hi = bounds.length - 1;
  while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (bounds[mid] <= o) lo = mid; else hi = mid - 1; }
  const segStart = bounds[lo];
  const base = segNewStart.get(segStart);
  if (base == null) throw new Error(`no segment recorded for offset ${o}`);
  return base + (o - segStart);
}

// apply remapping. Semantics per bufferView class (verified against this file):
// - image BVs are PHYSICAL: remap offset, set length to the KTX2 payload length.
// - BVs with EXT_meshopt_compression: byteOffset/byteLength are a LOGICAL decoded-layout
//   fiction (consecutively packed from 0) that loaders ignore — leave them; only the
//   extension's stream offset is physical and gets remapped.
// - plain BVs referenced by accessors are PHYSICAL payloads: remap offset, keep length.
// - plain BVs referenced by nothing (orphans): leave untouched.
const accessorBVs = new Set((json.accessors ?? []).map(a => a.bufferView).filter(x => x != null));
json.bufferViews.forEach((bv, i) => {
  const ext = bv.extensions?.EXT_meshopt_compression;
  if (imgByBV.has(i)) {
    bv.byteOffset = mapOffset(bv.byteOffset || 0);
    bv.byteLength = newPayload.get(imgByBV.get(i)).length;
  } else if (ext) {
    ext.byteOffset = mapOffset(ext.byteOffset);
  } else if (accessorBVs.has(i)) {
    bv.byteOffset = mapOffset(bv.byteOffset || 0);
  }
});
if (json.buffers?.[0]) json.buffers[0].byteLength = newBin.length;

// ---- texture extensions ------------------------------------------------------
for (const tex of json.textures ?? []) {
  tex.extensions = { ...(tex.extensions ?? {}), KHR_texture_basisu: { source: tex.source } };
}
json.extensionsUsed = [...new Set([...(json.extensionsUsed ?? []), "KHR_texture_basisu"])];
for (const im of json.images ?? []) im.mimeType = "image/ktx2";

// ---- serialize ---------------------------------------------------------------
const jsonStr = JSON.stringify(json);
const jsonBuf = Buffer.from(jsonStr + " ".repeat((4 - (Buffer.byteLength(jsonStr) % 4)) % 4), "utf8");
const total = 12 + 8 + jsonBuf.length + 8 + newBin.length;
const out = Buffer.alloc(total);
out.writeUInt32LE(0x46546c67, 0); out.writeUInt32LE(2, 4); out.writeUInt32LE(total, 8);
out.writeUInt32LE(jsonBuf.length, 12); out.writeUInt32LE(0x4e4f534a, 16);
jsonBuf.copy(out, 20);
const bh = 20 + jsonBuf.length;
out.writeUInt32LE(newBin.length, bh); out.writeUInt32LE(0x004e4942, bh + 4);
newBin.copy(out, bh + 8);
writeFileSync(outPath, out);
console.log(`wrote ${outPath}: ${buf.length} -> ${total} bytes`);
