// @vitest-environment node
// Inventory of the shipped body GLBs (public/assets): clip names and
// durations, skin joints, triangle counts. Reads the binary files
// directly — these assert the Blender bake pipeline's output contract
// (the full 45-clip catalog, exact durations) against what the
// console loads.
// Lives outside src/ because the app tsconfig is browser-typed; vitest
// picks it up from here with the node environment above.

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { CLIP_CATALOG } from "../src/features/world/clips";

interface GlbInfo {
  tris: number;
  joints: number;
  anims: Record<string, number>;
}

function readGlb(rel: string): GlbInfo {
  const buf = readFileSync(new URL(rel, import.meta.url));
  const jlen = buf.readUInt32LE(12);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const doc: any = JSON.parse(buf.subarray(20, 20 + jlen).toString("utf8"));
  let tris = 0;
  for (const m of doc.meshes ?? []) {
    for (const p of m.primitives) {
      if (p.indices !== undefined) tris += doc.accessors[p.indices].count / 3;
    }
  }
  const anims: Record<string, number> = {};
  for (const a of doc.animations ?? []) {
    let tmax = 0;
    for (const ch of a.channels) {
      const smp = a.samplers[ch.sampler];
      tmax = Math.max(tmax, doc.accessors[smp.input].max[0]);
    }
    anims[a.name] = tmax;
  }
  return { tris, joints: doc.skins?.[0]?.joints.length ?? 0, anims };
}

// The full catalog (clips.ts is the single source of truth): the five
// core clips plus the 40 baked from the 2026-11-05 Mixamo batch —
// every body carries all 45, durations exact.
const EXPECTED_CLIPS: Record<string, number> = Object.fromEntries(
  CLIP_CATALOG.map((c) => [c.name, c.duration]),
);

describe("shipped body GLBs — clip inventory", () => {
  it("cast-bodyblock.glb: full catalog, exact durations, 57 joints, 72,164 tris", () => {
    const g = readGlb("../public/assets/cast-bodyblock.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(57);
    expect(g.tris).toBe(72164);
  });

  it("cast-summer.glb: full catalog, exact durations, 33 joints, dieted mesh", () => {
    const g = readGlb("../public/assets/cast-summer.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(33);
    // Diet ceiling raised 2026-11-06: the 200k-tri surface fix (bind-pivot
    // rebuild) supersedes the old 95k crunch; still well under the 500k source.
    expect(g.tris).toBeLessThanOrEqual(210000);
    expect(g.tris).toBeGreaterThan(40000);
  });

  it("cast-ninja.glb is ABSENT — Ninja deleted at Jim's word, 2026-11-05", () => {
    expect(existsSync(new URL("../public/assets/cast-ninja.glb", import.meta.url))).toBe(false);
  });

  // Character wave (2026-11-05): KayKit Adventurers bodies (CC0,
  // Rig_Medium, 41 joints) retargeted with the same 45-clip catalog.
  it("cast-mage.glb: full catalog, exact durations, 41 joints, 4,509 tris", () => {
    const g = readGlb("../public/assets/cast-mage.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(41);
    expect(g.tris).toBe(4509);
  });

  it("cast-barbarian.glb: full catalog, exact durations, 41 joints, 5,061 tris", () => {
    const g = readGlb("../public/assets/cast-barbarian.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(41);
    expect(g.tris).toBe(5061);
  });

  it("cast-knight.glb: full catalog, exact durations, 41 joints, 4,712 tris", () => {
    const g = readGlb("../public/assets/cast-knight.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(41);
    expect(g.tris).toBe(4712);
  });

  // Remy (Mixamo FBX, 67 joints, 1.3 m): Body Block's 45 clips retargeted by bone name with a
  // world-space rest-delta bake (tools/city3/bake_remy.py), JPEG textures at 1K.
  it("cast-remy.glb: full catalog, exact durations, 67 joints, 35,196 tris", () => {
    const g = readGlb("../public/assets/cast-remy.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(67);
    expect(g.tris).toBe(35196);
  });

  // Skeleton Warrior (KayKit "Character Pack: Skeletons", CC0, Rig_Medium, 41 joints):
  // the character wave's matrix-delta bake of the full 45-clip catalog, scaled by total
  // figure height (head top, horns excluded) to exactly 1.30 m; helmet rigid-skinned.
  it("cast-skeleton-warrior.glb: full catalog, exact durations, 41 joints, 5,934 tris", () => {
    const g = readGlb("../public/assets/cast-skeleton-warrior.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(41);
    expect(g.tris).toBe(5934);
  });

  // Cipher (Mixamo "Soldier", Entering Code.fbx, 69 joints, 1.3 m): same bake as Remy via tools/city3/bake_cipher.py, JPEG textures.
  it("cast-cipher.glb: full catalog, exact durations, 69 joints, 19,450 tris", () => {
    const g = readGlb("../public/assets/cast-cipher.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(69);
    expect(g.tris).toBe(19450);
  });

  // Eve (Mixamo "Space Pirate", 65 joints, 1.3 m): same bake as Cipher via tools/city3/bake_cipher.py, JPEG textures at 1K.
  it("cast-eve.glb: full catalog, exact durations, 65 joints, 27,207 tris", () => {
    const g = readGlb("../public/assets/cast-eve.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(65);
    expect(g.tris).toBe(27207);
  });
});
