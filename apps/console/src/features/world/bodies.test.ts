import { describe, expect, it } from "vitest";
import { CAST_HIPS_Y, seatedRootY, type Anchor } from "./embody";
import {
  BARBARIAN_HIPS_Y,
  BODIES,
  BODY_BARBARIAN,
  BODY_CAST,
  BODY_KNIGHT,
  BODY_MAGE,
  BODY_REMY,
  BODY_SKELETON_WARRIOR,
  BODY_SUMMER,
  REMY_HIPS_Y,
  SCALE_BARBARIAN,
  SCALE_CAST,
  SCALE_KNIGHT,
  SCALE_MAGE,
  SCALE_REMY,
  SCALE_SKELETON_WARRIOR,
  SCALE_SUMMER,
  bodyAtScale,
  SKELETON_WARRIOR_HIPS_Y,
  KNIGHT_HIPS_Y,
  MAGE_HIPS_Y,
  SUMMER_HIPS_Y,
  bodyForMember,
  cruiseCapForBody,
  excludeBody,
  sitClipForPhase,
} from "./bodies";

describe("cruiseCapForBody", () => {
  it("caps each body at its (scaled) measured walkSpeed plus stride headroom", () => {
    expect(cruiseCapForBody(BODY_CAST)).toBeCloseTo(0.8746 * SCALE_CAST * 1.15);
    expect(cruiseCapForBody(BODY_SUMMER)).toBeCloseTo(1.107 * SCALE_SUMMER * 1.15);
    expect(cruiseCapForBody(BODY_MAGE)).toBeCloseTo(0.3069 * SCALE_MAGE * 1.15);
    expect(cruiseCapForBody(BODY_MAGE)).toBeLessThan(0.7); // the chibi KayKit stride stays short even at 1.70 m
  });
});

describe("realistic heights (display scale)", () => {
  it("bodyAtScale scales lengths and speeds, never the phase offset", () => {
    const raw = { ...BODY_SUMMER, scale: undefined, hipsY: 1, walkSpeed: 2, run: { speed: 3, footLift: 0.1, phaseOffset: -0.08 } };
    const b = bodyAtScale(1.5, raw);
    expect(b.scale).toBe(1.5);
    expect(b.hipsY).toBeCloseTo(1.5, 9);
    expect(b.walkSpeed).toBeCloseTo(3, 9);
    expect(b.run!.speed).toBeCloseTo(4.5, 9);
    expect(b.run!.footLift).toBeCloseTo(0.15, 9);
    expect(b.run!.phaseOffset).toBe(-0.08);
  });
  it("every body is shown at its scale, and its facts are the raw rig measurement x that scale", () => {
    const cases: [typeof BODY_CAST, number, number][] = [
      [BODY_CAST, SCALE_CAST, CAST_HIPS_Y],
      [BODY_SUMMER, SCALE_SUMMER, SUMMER_HIPS_Y],
      [BODY_REMY, SCALE_REMY, REMY_HIPS_Y],
      [BODY_MAGE, SCALE_MAGE, MAGE_HIPS_Y],
      [BODY_BARBARIAN, SCALE_BARBARIAN, BARBARIAN_HIPS_Y],
      [BODY_KNIGHT, SCALE_KNIGHT, KNIGHT_HIPS_Y],
      [BODY_SKELETON_WARRIOR, SCALE_SKELETON_WARRIOR, SKELETON_WARRIOR_HIPS_Y],
    ];
    for (const [b, sc, hips] of cases) {
      expect(b.scale).toBe(sc);
      expect(b.hipsY).toBeCloseTo(hips * sc, 9);
    }
  });
  it("lands everyone at a realistic adult height from the measured GLB heights (1.25-1.34 m as shipped)", () => {
    const heights: [number, number, number][] = [
      // [measured shipped height (m), scale, target]
      [1.34, SCALE_CAST, 1.75],
      [1.225, SCALE_SUMMER, 1.68], // head top (1.254 with her hat)
      [1.283, SCALE_REMY, 1.78],
      [1.306, SCALE_MAGE, 1.7],
      [1.293, SCALE_BARBARIAN, 1.7],
      [1.293, SCALE_KNIGHT, 1.7],
      [1.3, SCALE_SKELETON_WARRIOR, 1.7],
    ];
    for (const [h, sc, target] of heights) expect(h * sc).toBeCloseTo(target, 2);
  });
});

describe("body registry", () => {
  it("defaults every member to the cast body", () => {
    expect(bodyForMember({})).toBe(BODY_CAST);
    expect(bodyForMember(null)).toBe(BODY_CAST);
    expect(bodyForMember(undefined)).toBe(BODY_CAST);
    expect(bodyForMember({ body: "nope" })).toBe(BODY_CAST);
    expect(BODY_CAST.hipsY).toBeCloseTo(CAST_HIPS_Y * SCALE_CAST, 9);
    expect(BODY_CAST.url).toBe("/assets/cast-bodyblock.glb");
  });

  it("resolves the summer body and its measured hips", () => {
    expect(bodyForMember({ body: "summer" })).toBe(BODY_SUMMER);
    expect(BODY_SUMMER.url).toBe("/assets/cast-summer.glb");
    expect(BODY_SUMMER.hipsY).toBeCloseTo(SUMMER_HIPS_Y * SCALE_SUMMER, 9);
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
    expect(BODY_MAGE.hipsY).toBeCloseTo(MAGE_HIPS_Y * SCALE_MAGE, 9);
    expect(BODIES.mage).toBe(BODY_MAGE);
    expect(bodyForMember({ body: "barbarian" })).toBe(BODY_BARBARIAN);
    expect(BODY_BARBARIAN.url).toBe("/assets/cast-barbarian.glb");
    expect(BODY_BARBARIAN.hipsY).toBeCloseTo(BARBARIAN_HIPS_Y * SCALE_BARBARIAN, 9);
    expect(BODIES.barbarian).toBe(BODY_BARBARIAN);
    expect(bodyForMember({ body: "knight" })).toBe(BODY_KNIGHT);
    expect(BODY_KNIGHT.url).toBe("/assets/cast-knight.glb");
    expect(BODY_KNIGHT.hipsY).toBeCloseTo(KNIGHT_HIPS_Y * SCALE_KNIGHT, 9);
    expect(BODIES.knight).toBe(BODY_KNIGHT);
    expect(bodyForMember({ body: "remy" })).toBe(BODY_REMY);
    expect(BODY_REMY.url).toBe("/assets/cast-remy.glb");
    expect(BODY_REMY.hipsY).toBeCloseTo(REMY_HIPS_Y * SCALE_REMY, 9);
    expect(BODIES.remy).toBe(BODY_REMY);
    expect(bodyForMember({ body: "skeleton-warrior" })).toBe(BODY_SKELETON_WARRIOR);
    expect(BODY_SKELETON_WARRIOR.url).toBe("/assets/cast-skeleton-warrior.glb");
    expect(BODY_SKELETON_WARRIOR.hipsY).toBeCloseTo(SKELETON_WARRIOR_HIPS_Y * SCALE_SKELETON_WARRIOR, 9);
    expect(BODIES["skeleton-warrior"]).toBe(BODY_SKELETON_WARRIOR);
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
    // A bench-shaped anchor fixture (the Agora bench anchors left with
    // that world, 2026-11-08; seatedRootY only reads seatHeight).
    const bench: Anchor = {
      id: "bench-test",
      label: "Bench",
      seat: [0, 0],
      facing: 0,
      approach: [0, 0.62],
      seatHeight: 0.45,
      occupiedBy: null,
    };
    expect(seatedRootY(bench, BODY_CAST.hipsY)).toBeCloseTo(bench.seatHeight - BODY_CAST.hipsY);
    expect(seatedRootY(bench, BODY_SUMMER.hipsY)).toBeCloseTo(bench.seatHeight - BODY_SUMMER.hipsY);
    expect(seatedRootY(bench, BODY_SUMMER.hipsY)).not.toBeCloseTo(seatedRootY(bench, BODY_CAST.hipsY));
    expect(seatedRootY(bench, BODY_MAGE.hipsY)).toBeCloseTo(bench.seatHeight - BODY_MAGE.hipsY);
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
