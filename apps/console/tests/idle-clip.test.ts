// @vitest-environment node
// The clip a body rests in (bodies.ts clips.idle) must be a STANDING clip. The catalog's plain "Idle" is a walk in place (ankles swing
// 0.1-0.6 m apart in a repeating step), which made every standing bot march and made the Idle -> Walk crossfade mix two unrelated step
// cycles (found 2026-11-07). Pinned on the shipped GLBs: over the whole loop the left thigh may not rotate more than MAX_DEG away from its
// mean orientation, and the loop must close (first vs last key).

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { BODIES } from "../src/features/world/bodies";

interface Doc {
  nodes: { name?: string }[];
  accessors: { bufferView: number; byteOffset?: number; count: number; type: string; componentType: number }[];
  bufferViews: { byteOffset?: number; byteStride?: number }[];
  animations: { name: string; channels: { sampler: number; target: { node: number; path: string } }[]; samplers: { input: number; output: number }[] }[];
}

function load(url: string): { doc: Doc; bin: Buffer } {
  const buf = readFileSync(new URL(`../public${url}`, import.meta.url));
  const jlen = buf.readUInt32LE(12);
  const doc = JSON.parse(buf.subarray(20, 20 + jlen).toString("utf8")) as Doc;
  const binStart = 20 + jlen + 8;
  return { doc, bin: buf.subarray(binStart, binStart + buf.readUInt32LE(20 + jlen)) };
}

function floats(doc: Doc, bin: Buffer, acc: number, comps: number): number[][] {
  const a = doc.accessors[acc];
  expect(a.componentType, "float accessor").toBe(5126);
  const bv = doc.bufferViews[a.bufferView];
  const stride = bv.byteStride ?? comps * 4;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  return Array.from({ length: a.count }, (_, i) => Array.from({ length: comps }, (_, k) => bin.readFloatLE(base + i * stride + k * 4)));
}

const angle = (p: number[], q: number[]) => {
  const d = Math.abs(p[0] * q[0] + p[1] * q[1] + p[2] * q[2] + p[3] * q[3]);
  return (2 * Math.acos(Math.min(1, d)) * 180) / Math.PI;
};

/** Left-thigh rotation keys of a clip, or null when the rig/clip has no such channel. */
function thighKeys(url: string, clip: string): number[][] {
  const { doc, bin } = load(url);
  const anim = doc.animations.find((a) => a.name === clip);
  expect(anim, `${url} has clip ${clip}`).toBeTruthy();
  const ch = anim!.channels.find((c) => c.target.path === "rotation" && /LeftUpLeg$|^upperleg\.l$/.test(doc.nodes[c.target.node].name ?? ""));
  expect(ch, `${url} ${clip} left-thigh rotation channel`).toBeTruthy();
  return floats(doc, bin, anim!.samplers[ch!.sampler].output, 4);
}

const MAX_DEG = 12; // measured: IdleLong <= ~5 deg; the walking "Idle" is 36 deg (Summer)

describe("the resting clip is a standing clip", () => {
  for (const body of Object.values(BODIES)) {
    it(`${body.id}: clips.idle "${body.clips.idle}" keeps the thighs still and loops cleanly`, () => {
      const keys = thighKeys(body.url, body.clips.idle);
      const mean = [0, 0, 0, 0];
      for (const q of keys) {
        const s = Math.sign(q[0] * keys[0][0] + q[1] * keys[0][1] + q[2] * keys[0][2] + q[3] * keys[0][3]) || 1;
        for (let i = 0; i < 4; i++) mean[i] += s * q[i];
      }
      const n = Math.hypot(...mean);
      const m = mean.map((v) => v / n);
      expect(Math.max(...keys.map((q) => angle(q, m)))).toBeLessThan(MAX_DEG);
      expect(angle(keys[0], keys[keys.length - 1])).toBeLessThan(2);
    });
  }

  it("documents why: the catalog's plain Idle is a walk in place (thigh swings > 25 deg on the Mixamo bodies)", () => {
    const keys = thighKeys("/assets/cast-summer.glb", "Idle");
    expect(Math.max(...keys.map((q) => angle(q, keys[0])))).toBeGreaterThan(25);
  });
});
