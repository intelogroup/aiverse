import { describe, expect, it } from "vitest";
import { AGORA_BENCH_ANCHORS, CAST_HIPS_Y, seatedRootY } from "./embody";
import {
  BODIES,
  BODY_CAST,
  BODY_SUMMER,
  SUMMER_HIPS_Y,
  bodyForMember,
  sitClipForPhase,
} from "./bodies";

describe("body registry", () => {
  it("defaults every member to the cast body", () => {
    expect(bodyForMember({})).toBe(BODY_CAST);
    expect(bodyForMember(null)).toBe(BODY_CAST);
    expect(bodyForMember(undefined)).toBe(BODY_CAST);
    expect(bodyForMember({ body: "nope" })).toBe(BODY_CAST);
    expect(BODY_CAST.hipsY).toBe(CAST_HIPS_Y);
    expect(BODY_CAST.url).toBe("/assets/cast-bodyblock.glb");
  });

  it("resolves the summer body and its measured hips", () => {
    expect(bodyForMember({ body: "summer" })).toBe(BODY_SUMMER);
    expect(BODY_SUMMER.url).toBe("/assets/cast-summer.glb");
    expect(BODY_SUMMER.hipsY).toBe(SUMMER_HIPS_Y);
    expect(BODIES.summer).toBe(BODY_SUMMER);
    expect(BODIES.cast).toBe(BODY_CAST);
  });

  it("every body carries the same four-clip catalog", () => {
    for (const b of Object.values(BODIES)) {
      expect(b.clips).toEqual({
        idle: "Idle",
        walk: "Walk",
        sitTalk: "SittingTalking",
        sitDown: "SitDown",
      });
    }
  });

  it("seatedRootY is computed per body", () => {
    const bench = AGORA_BENCH_ANCHORS[0];
    expect(seatedRootY(bench, BODY_CAST.hipsY)).toBeCloseTo(bench.seatHeight - CAST_HIPS_Y);
    expect(seatedRootY(bench, BODY_SUMMER.hipsY)).toBeCloseTo(bench.seatHeight - SUMMER_HIPS_Y);
    expect(seatedRootY(bench, BODY_SUMMER.hipsY)).not.toBeCloseTo(seatedRootY(bench));
  });
});

describe("sitClipForPhase — clip selection per override phase", () => {
  it("mounting plays SitDown forward, once", () => {
    expect(sitClipForPhase("mounting")).toEqual({ clip: "sitDown", reverse: false });
  });
  it("seated loops SittingTalking", () => {
    expect(sitClipForPhase("seated")).toEqual({ clip: "sitTalk", reverse: false });
  });
  it("standing plays SitDown in reverse", () => {
    expect(sitClipForPhase("standing")).toEqual({ clip: "sitDown", reverse: true });
  });
  it("no override — no sitting clip", () => {
    expect(sitClipForPhase(null)).toEqual({ clip: null, reverse: false });
    expect(sitClipForPhase(undefined)).toEqual({ clip: null, reverse: false });
  });
});

// The shipped GLBs' clip inventories are asserted in
// tests/glb-inventory.test.ts (it reads files from disk, so it lives
// outside the type-checked src tree).
