import { describe, expect, it } from "vitest";
import { AGORA_BENCH_ANCHORS, CAST_HIPS_Y, seatedRootY } from "./embody";
import {
  BARBARIAN_HIPS_Y,
  BODIES,
  BODY_BARBARIAN,
  BODY_CAST,
  BODY_KNIGHT,
  BODY_MAGE,
  BODY_REMY,
  BODY_SUMMER,
  REMY_HIPS_Y,
  KNIGHT_HIPS_Y,
  MAGE_HIPS_Y,
  SUMMER_HIPS_Y,
  bodyForMember,
  cruiseCapForBody,
  excludeBody,
  sitClipForPhase,
} from "./bodies";

describe("cruiseCapForBody", () => {
  it("caps each body at its measured walkSpeed plus stride headroom", () => {
    expect(cruiseCapForBody(BODY_CAST)).toBeCloseTo(0.8746 * 1.15);
    expect(cruiseCapForBody(BODY_SUMMER)).toBeCloseTo(1.107 * 1.15);
    // The KayKit bodies were skating at up to 1.4 m/s on a 0.5749 gait;
    // since the 1.30 m shrink the Mage's gait is 0.3069, cap ~0.353.
    expect(cruiseCapForBody(BODY_MAGE)).toBeCloseTo(0.3069 * 1.15);
    expect(cruiseCapForBody(BODY_MAGE)).toBeLessThan(0.7);
  });
});

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

  it("resolves the character-wave bodies and their measured hips", () => {
    expect(bodyForMember({ body: "mage" })).toBe(BODY_MAGE);
    expect(BODY_MAGE.url).toBe("/assets/cast-mage.glb");
    expect(BODY_MAGE.hipsY).toBe(MAGE_HIPS_Y);
    expect(BODIES.mage).toBe(BODY_MAGE);
    expect(bodyForMember({ body: "barbarian" })).toBe(BODY_BARBARIAN);
    expect(BODY_BARBARIAN.url).toBe("/assets/cast-barbarian.glb");
    expect(BODY_BARBARIAN.hipsY).toBe(BARBARIAN_HIPS_Y);
    expect(BODIES.barbarian).toBe(BODY_BARBARIAN);
    expect(bodyForMember({ body: "knight" })).toBe(BODY_KNIGHT);
    expect(BODY_KNIGHT.url).toBe("/assets/cast-knight.glb");
    expect(BODY_KNIGHT.hipsY).toBe(KNIGHT_HIPS_Y);
    expect(BODIES.knight).toBe(BODY_KNIGHT);
    expect(bodyForMember({ body: "remy" })).toBe(BODY_REMY);
    expect(BODY_REMY.url).toBe("/assets/cast-remy.glb");
    expect(BODY_REMY.hipsY).toBe(REMY_HIPS_Y);
    expect(BODIES.remy).toBe(BODY_REMY);
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
        idle: "IdleLong",
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
    expect(seatedRootY(bench, BODY_MAGE.hipsY)).toBeCloseTo(bench.seatHeight - MAGE_HIPS_Y);
  });
});

describe("excludeBody — retiring a body from a roster", () => {
  it("drops default, explicit and unknown-body wearers of the excluded body", () => {
    const roster = [
      { id: "native-1", name: "Native One" },
      { id: "native-2", name: "Native Two", body: "cast" },
      { id: "native-3", name: "Native Three", body: "retired-name" },
      { id: "summer-guest", name: "Summer (new)", body: "summer" },
      { id: "mage-guest", name: "Mage (new)", body: "mage" },
      { id: "barbarian-guest", name: "Barbarian (new)", body: "barbarian" },
      { id: "knight-guest", name: "Knight (new)", body: "knight" },
    ];
    expect(excludeBody(roster, BODY_CAST).map((m) => m.id)).toEqual([
      "summer-guest",
      "mage-guest",
      "barbarian-guest",
      "knight-guest",
    ]);
    // The input roster is not mutated — other worlds keep everyone.
    expect(roster).toHaveLength(7);
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
