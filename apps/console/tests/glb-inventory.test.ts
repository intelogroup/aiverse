// @vitest-environment node
// Inventory of the shipped body GLBs (public/assets): clip names and
// durations, skin joints, triangle counts. Reads the binary files
// directly — these assert the Blender bake pipeline's output contract
// (five-clip catalog, exact durations) against what the console loads.
// Lives outside src/ because the app tsconfig is browser-typed; vitest
// picks it up from here with the node environment above.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

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

const EXPECTED_CLIPS: Record<string, number> = {
  Idle: 2.667,
  Walk: 1.2,
  SittingTalking: 44.1,
  SitDown: 2.2333, // dedicated stand_to_sit, 67 frames @ 30 fps
  StandUp: 2.2667, // dedicated sit_to_stand, 68 frames @ 30 fps
};

describe("shipped body GLBs — clip inventory", () => {
  it("cast-bodyblock.glb: five clips, exact durations, 57 joints, 72,164 tris", () => {
    const g = readGlb("../public/assets/cast-bodyblock.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(57);
    expect(g.tris).toBe(72164);
  });

  it("cast-summer.glb: five clips, exact durations, 33 joints, dieted mesh", () => {
    const g = readGlb("../public/assets/cast-summer.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(33);
    expect(g.tris).toBeLessThanOrEqual(120000);
    expect(g.tris).toBeGreaterThan(40000);
  });

  it("cast-ninja.glb: five clips, exact durations, 65 joints, 24,780 tris", () => {
    const g = readGlb("../public/assets/cast-ninja.glb");
    expect(Object.keys(g.anims).sort()).toEqual(Object.keys(EXPECTED_CLIPS).sort());
    for (const [name, dur] of Object.entries(EXPECTED_CLIPS)) {
      expect(g.anims[name], name).toBeCloseTo(dur, 2);
    }
    expect(g.joints).toBe(65);
    expect(g.tris).toBe(24780);
  });
});
