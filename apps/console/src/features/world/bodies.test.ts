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

  it("ninja is gone from the registry (deleted at Jim's word, 2026-11-05)", () => {
    expect(BODIES.ninja).toBeUndefined();
    expect(bodyForMember({ body: "ninja" })).toBe(BODY_CAST);
  });

  it("every body carries a measured natural walk speed", () => {
    for (const b of Object.values(BODIES)) {
      expect(b.walkSpeed).toBeGreaterThan(0.3);
      expect(b.walkSpeed).toBeLessThan(2.0);
    }
  });

  it("every body carries the same five-clip catalog", () => {
    for (const b of Object.values(BODIES)) {
      expect(b.clips).toEqual({
        idle: "Idle",
        walk: "Walk",
        sitTalk: "SittingTalking",
        sitDown: "SitDown",
        standUp: "StandUp",
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
    expect(sitClipForPhase("mounting")).toEqual({ clip: "sitDown" });
  });
  it("seated loops SittingTalking", () => {
    expect(sitClipForPhase("seated")).toEqual({ clip: "sitTalk" });
  });
  it("standing plays the dedicated StandUp clip forward — never reverse", () => {
    expect(sitClipForPhase("standing")).toEqual({ clip: "standUp" });
  });
  it("no override — no sitting clip", () => {
    expect(sitClipForPhase(null)).toEqual({ clip: null });
    expect(sitClipForPhase(undefined)).toEqual({ clip: null });
  });
});

// The shipped GLBs' clip inventories are asserted in
// tests/glb-inventory.test.ts (it reads files from disk, so it lives
// outside the type-checked src tree).
