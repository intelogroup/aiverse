// @vitest-environment node
// Per-district asset budgets — the CI gate installed 2026-11-12 so the
// world cannot silently outgrow a phone browser. Measures every GLB
// named by public/assets/districts.json (district + collision) and
// asserts the budgets in asset-budgets.ts. That file is the budget
// table and its own rulebook: budgets move only by deliberate PR.
//
// Gated: file bytes + triangle counts (exact, from accessor counts —
// same discipline as glb-inventory.test.ts). Reported but NOT gated:
// estimated texture VRAM (KTX2 uncompressed level sizes; RGBA8 + mip
// chain for PNG/JPEG) — method-dependent, printed for review signal.
//
// Lives outside src/ for the same reason as glb-inventory.test.ts:
// the app tsconfig is browser-typed; vitest picks this up in node env.

import { readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { DISTRICT_BUDGETS, DISTRICT_TOTAL_BUDGET } from "./asset-budgets";

interface DistrictEntry {
  id: string;
  url: string;
  collisionUrl?: string;
  resident?: boolean;
}

const ASSETS = "../public/assets/";

function assetPath(urlPath: string): URL {
  // Manifest URLs are site-absolute ("/assets/world-city3.glb").
  return new URL(ASSETS + urlPath.split("/").pop(), import.meta.url);
}

interface GlbDoc {
  meshes?: { primitives: { mode?: number; indices?: number; attributes: { POSITION: number } }[] }[];
  accessors?: { count: number }[];
  images?: { bufferView?: number; mimeType?: string }[];
  bufferViews?: { byteOffset?: number; byteLength: number }[];
}

function parseGlb(buf: Buffer): { doc: GlbDoc; binOffset: number } {
  const jlen = buf.readUInt32LE(12);
  const doc = JSON.parse(buf.subarray(20, 20 + jlen).toString("utf8")) as GlbDoc;
  let binOffset = -1;
  const off = 20 + jlen;
  if (off + 8 <= buf.length && buf.readUInt32LE(off + 4) === 0x004e4942) binOffset = off + 8;
  return { doc, binOffset };
}

function triangleCount(doc: GlbDoc): number {
  let tris = 0;
  for (const mesh of doc.meshes ?? []) {
    for (const prim of mesh.primitives) {
      const mode = prim.mode ?? 4;
      const count =
        prim.indices !== undefined
          ? (doc.accessors?.[prim.indices]?.count ?? 0)
          : (doc.accessors?.[prim.attributes.POSITION]?.count ?? 0);
      if (mode === 4) tris += Math.floor(count / 3);
      else if (mode === 5 || mode === 6) tris += Math.max(0, count - 2);
    }
  }
  return tris;
}

// Estimated texture VRAM: KTX2 → sum of the level index's
// uncompressedByteLength (the GPU-format size once supercompression is
// undone); PNG/JPEG → decoded RGBA8 + a full mip chain (×1.33).
function ktx2Vram(buf: Buffer, start: number, len: number): number {
  const levelCount = Math.max(1, buf.readUInt32LE(start + 40));
  let total = 0;
  for (let i = 0; i < levelCount; i++) {
    const e = start + 80 + i * 24;
    if (e + 24 > start + len) break;
    total += Number(buf.readBigUInt64LE(e + 16));
  }
  if (total > 0) return total;
  const w = buf.readUInt32LE(start + 20);
  const h = buf.readUInt32LE(start + 24);
  return Math.round(w * h * 4 * 1.33);
}

function jpegDims(buf: Buffer, start: number, len: number): { w: number; h: number } | null {
  let p = start + 2;
  const end = start + len;
  while (p + 4 < end) {
    if (buf[p] !== 0xff) {
      p++;
      continue;
    }
    const marker = buf[p + 1];
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      return { h: buf.readUInt16BE(p + 5), w: buf.readUInt16BE(p + 7) };
    }
    const segLen = buf.readUInt16BE(p + 2);
    if (segLen < 2) break;
    p += 2 + segLen;
  }
  return null;
}

function textureVram(buf: Buffer, doc: GlbDoc, binOffset: number): number {
  if (binOffset < 0) return 0;
  let vram = 0;
  for (const img of doc.images ?? []) {
    if (img.bufferView === undefined) continue;
    const bv = doc.bufferViews?.[img.bufferView];
    if (!bv) continue;
    const start = binOffset + (bv.byteOffset ?? 0);
    if (img.mimeType === "image/ktx2") vram += ktx2Vram(buf, start, bv.byteLength);
    else if (img.mimeType === "image/png") {
      const w = buf.readUInt32BE(start + 16);
      const h = buf.readUInt32BE(start + 20);
      vram += Math.round(w * h * 4 * 1.33);
    } else if (img.mimeType === "image/jpeg") {
      const d = jpegDims(buf, start, bv.byteLength);
      if (d) vram += Math.round(d.w * d.h * 4 * 1.33);
    }
  }
  return vram;
}

function measureGlb(url: URL): { bytes: number; triangles: number; estTextureVram: number } {
  const buf = readFileSync(url);
  const { doc, binOffset } = parseGlb(buf);
  return {
    bytes: statSync(url).size,
    triangles: triangleCount(doc),
    estTextureVram: textureVram(buf, doc, binOffset),
  };
}

const manifest = JSON.parse(
  readFileSync(new URL(ASSETS + "districts.json", import.meta.url), "utf8"),
) as { districts: DistrictEntry[]; links: string; shell: string };

interface DistrictMeasure {
  glbBytes: number;
  collisionBytes: number;
  triangles: number;
  collisionTriangles: number;
  estTextureVram: number;
}

const measured = new Map<string, DistrictMeasure>();
for (const d of manifest.districts) {
  const main = measureGlb(assetPath(d.url));
  const coll = d.collisionUrl
    ? measureGlb(assetPath(d.collisionUrl))
    : { bytes: 0, triangles: 0, estTextureVram: 0 };
  measured.set(d.id, {
    glbBytes: main.bytes,
    collisionBytes: coll.bytes,
    triangles: main.triangles,
    collisionTriangles: coll.triangles,
    estTextureVram: main.estTextureVram + coll.estTextureVram,
  });
}

const fmt = (n: number) => n.toLocaleString("en-US");
const mb = (n: number) => `${(n / (1024 * 1024)).toFixed(1)} MB`;

function gateMessage(
  district: string,
  metric: string,
  current: number,
  budget: number,
  measuredAtSet: number,
): string {
  return (
    `${district} ${metric}: current ${fmt(current)} exceeds budget ${fmt(budget)} ` +
    `(${fmt(current - budget)} over; ${fmt(current - measuredAtSet)} of growth since the budget ` +
    `was set at ${fmt(measuredAtSet)}). Slim the district, or raise the budget deliberately ` +
    `in tests/asset-budgets.ts with the justification in the PR body.`
  );
}

describe("district asset budgets", () => {
  it("prints the district size table (always — visibility even when green)", () => {
    const lines: string[] = [
      "",
      "district        glb MB   coll MB   triangles   est tex VRAM",
    ];
    for (const d of manifest.districts) {
      const m = measured.get(d.id)!;
      lines.push(
        `${d.id.padEnd(14)} ${mb(m.glbBytes).padStart(8)} ${mb(m.collisionBytes).padStart(9)} ` +
          `${fmt(m.triangles).padStart(10)} ${mb(m.estTextureVram).padStart(13)}${d.resident ? "  (spawn)" : ""}`,
      );
    }
    const totalBytes = [...measured.values()].reduce((s, m) => s + m.glbBytes + m.collisionBytes, 0);
    lines.push(`TOTAL districts: ${mb(totalBytes)} of ${mb(DISTRICT_TOTAL_BUDGET.budgetBytes)} budget`);
    for (const extra of [
      { id: "links (shared)", url: manifest.links },
      { id: "shell (shared)", url: manifest.shell },
    ]) {
      const m = measureGlb(assetPath(extra.url));
      lines.push(`${extra.id.padEnd(14)} ${mb(m.bytes).padStart(8)} ${"—".padStart(9)} ${fmt(m.triangles).padStart(10)} ${mb(m.estTextureVram).padStart(13)}  (reported, not budgeted)`);
    }
    console.log(lines.join("\n"));
    expect(manifest.districts.length).toBeGreaterThan(0);
  });

  it("every manifest district has a budget entry, and every budget entry names a live district", () => {
    const manifestIds = manifest.districts.map((d) => d.id).sort();
    expect(
      manifestIds,
      "a district without a budget entry would grow ungated — add it to tests/asset-budgets.ts deliberately",
    ).toEqual(Object.keys(DISTRICT_BUDGETS).sort());
  });

  for (const d of manifest.districts) {
    it(`${d.id}: GLB bytes, collision bytes and triangles stay within budget`, () => {
      const m = measured.get(d.id)!;
      const b = DISTRICT_BUDGETS[d.id];
      expect(b, `no budget entry for district ${d.id}`).toBeDefined();
      expect(m.glbBytes, gateMessage(d.id, "glbBytes", m.glbBytes, b.budget.glbBytes, b.measured.glbBytes)).toBeLessThanOrEqual(b.budget.glbBytes);
      expect(
        m.collisionBytes,
        gateMessage(d.id, "collisionBytes", m.collisionBytes, b.budget.collisionBytes, b.measured.collisionBytes),
      ).toBeLessThanOrEqual(b.budget.collisionBytes);
      expect(
        m.triangles,
        gateMessage(d.id, "triangles", m.triangles, b.budget.triangles, b.measured.triangles),
      ).toBeLessThanOrEqual(b.budget.triangles);
    });
  }

  it("districts total (GLB + collision bytes) stays within budget", () => {
    const total = [...measured.values()].reduce((s, m) => s + m.glbBytes + m.collisionBytes, 0);
    expect(
      total,
      gateMessage("ALL DISTRICTS", "totalBytes", total, DISTRICT_TOTAL_BUDGET.budgetBytes, DISTRICT_TOTAL_BUDGET.measuredBytes),
    ).toBeLessThanOrEqual(DISTRICT_TOTAL_BUDGET.budgetBytes);
  });
});
