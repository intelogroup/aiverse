// @vitest-environment node
// Recast's WASM loader needs real Node APIs; the console's vitest default
// environment is jsdom, so this file opts back into node.

import { describe, expect, it } from "vitest";
import {
  AGENT_MAX_SPEED,
  animState,
  buildAnnulusGeometry,
  buildRectGeometry,
  createGeometryCrowd,
  createPlatformCrowd,
  cruiseSpeedForIndex,
} from "./locomotion";

describe("animState", () => {
  it("is idle at rest and just below the walk threshold", () => {
    expect(animState(0, 0)).toEqual({ state: "idle", heading: null, speed: 0 });
    expect(animState(0.05, 0).state).toBe("idle");
    expect(animState(0, -0.09).state).toBe("idle");
  });

  it("walks with heading = atan2(vx, vz) (three.js rotation.y convention)", () => {
    // Facing +Z (three.js default facing) when moving along +Z.
    expect(animState(0, 1)).toEqual({ state: "walk", heading: 0, speed: 1 });
    // Moving along +X is a +90° yaw from +Z.
    const east = animState(1, 0);
    expect(east.state).toBe("walk");
    expect(east.heading).toBeCloseTo(Math.PI / 2);
    // Moving into the (-x, -z) quadrant: heading between -π and -π/2.
    const sw = animState(-1, -1);
    expect(sw.state).toBe("walk");
    expect(sw.heading).toBeCloseTo((-3 * Math.PI) / 4);
    expect(sw.speed).toBeCloseTo(Math.SQRT2);
  });
});

describe("cruiseSpeedForIndex", () => {
  it("is deterministic and stays inside [0.55, AGENT_MAX_SPEED]", () => {
    for (let i = 0; i < 64; i++) {
      const v = cruiseSpeedForIndex(i);
      expect(v).toBe(cruiseSpeedForIndex(i));
      expect(v).toBeGreaterThanOrEqual(0.55);
      expect(v).toBeLessThanOrEqual(AGENT_MAX_SPEED);
    }
  });

  it("spreads a crowd across slow, mid and fast paces", () => {
    const speeds = Array.from({ length: 32 }, (_, i) => cruiseSpeedForIndex(i));
    expect(speeds.some((v) => v <= 0.75)).toBe(true); // working pace
    expect(speeds.some((v) => v > 0.75 && v < 1.05)).toBe(true);
    expect(speeds.some((v) => v >= 1.05)).toBe(true);
    expect(new Set(speeds).size).toBeGreaterThan(24); // near-unique per slot
  });

  it("respects a lower crowd cap", () => {
    for (let i = 0; i < 32; i++) expect(cruiseSpeedForIndex(i, 0.8)).toBeLessThanOrEqual(0.8);
  });
});

describe("createPlatformCrowd", () => {
  it(
    "keeps 6 agents on a radius-6 disc, separated and wandering, for 60 s at 60 Hz",
    async () => {
      const crowd = await createPlatformCrowd(6, 6, { seed: 42 });
      const dt = 1 / 60;
      let maxRadius = 0;
      let minPairDist = Infinity;

      for (let s = 0; s < 60 * 60; s++) {
        const frames = crowd.step(dt);
        expect(frames).toHaveLength(6);
        for (const f of frames) {
          const r = Math.hypot(f.position[0], f.position[1]);
          if (r > maxRadius) maxRadius = r;
        }
        for (let i = 0; i < frames.length; i++) {
          for (let j = i + 1; j < frames.length; j++) {
            const d = Math.hypot(
              frames[i].position[0] - frames[j].position[0],
              frames[i].position[1] - frames[j].position[1],
            );
            if (d < minPairDist) minPairDist = d;
          }
        }
      }

      const finalFrames = crowd.step(0);
      // (a) bounds: no agent center ever left the disc (same tolerance and
      // reporting style as the spike: observed 2.5918..10.9717 on r=12).
      expect(maxRadius).toBeLessThanOrEqual(6.0 + 1e-6);
      // (b) separation: closest approach of any pair across the whole run.
      expect(minPairDist).toBeGreaterThanOrEqual(0.6);
      // (c) movement: at least 4 of 6 agents reached at least 2 targets.
      expect(finalFrames.filter((f) => f.targetsReached >= 2).length).toBeGreaterThanOrEqual(4);

      crowd.dispose();
    },
    60_000,
  );

  it(
    "keeps agents out of the hologlobe keep-out on the Agora deck annulus",
    async () => {
      const crowd = await createPlatformCrowd(9.7, 6, { seed: 11, keepOutRadius: 2.2 });
      const dt = 1 / 60;
      let minRadius = Infinity;
      let maxRadius = 0;

      for (let s = 0; s < 30 * 60; s++) {
        const frames = crowd.step(dt);
        expect(frames).toHaveLength(6);
        for (const f of frames) {
          const r = Math.hypot(f.position[0], f.position[1]);
          if (r < minRadius) minRadius = r;
          if (r > maxRadius) maxRadius = r;
        }
      }

      // No walkable geometry exists inside r=2.2 or outside r=9.7, so
      // agent centers can never cross those radii (the spike's assertion,
      // on the exact Agora dimensions).
      expect(minRadius).toBeGreaterThanOrEqual(2.2);
      expect(maxRadius).toBeLessThanOrEqual(9.7 + 1e-6);
      const finalFrames = crowd.step(0);
      expect(finalFrames.filter((f) => f.targetsReached >= 1).length).toBeGreaterThanOrEqual(4);

      crowd.dispose();
    },
    60_000,
  );

  it("reconciles the agent set with setAgentCount instead of rebuilding", async () => {
    const crowd = await createPlatformCrowd(6, 3, { seed: 7 });
    expect(crowd.agentCount).toBe(3);
    expect(crowd.step(1 / 60)).toHaveLength(3);

    crowd.setAgentCount(5);
    expect(crowd.agentCount).toBe(5);
    expect(crowd.step(1 / 60)).toHaveLength(5);

    crowd.setAgentCount(2);
    expect(crowd.agentCount).toBe(2);
    expect(crowd.step(1 / 60)).toHaveLength(2);

    crowd.dispose();
    expect(crowd.step(1 / 60)).toEqual([]);
  });
});

describe("navmesh geometry builders", () => {
  it("builds an annulus whose vertices sit exactly on the inner/outer radii", () => {
    const { positions, indices } = buildAnnulusGeometry(9.7, 2.2, 64);
    expect(positions.length).toBe(64 * 2 * 3);
    expect(indices.length).toBe(64 * 6);
    for (let i = 0; i < positions.length; i += 3) {
      const r = Math.hypot(positions[i], positions[i + 2]);
      expect(Math.abs(r - 2.2) < 1e-6 || Math.abs(r - 9.7) < 1e-6).toBe(true);
      expect(positions[i + 1]).toBe(0);
    }
    for (const ix of indices) expect(ix).toBeLessThan(128);
  });

  it("builds a subdivided rect centered where asked, at the given height", () => {
    const { positions, indices } = buildRectGeometry(-165, -95, 0.2, 110, 70, 4);
    expect(positions.length).toBe(25 * 3);
    expect(indices.length).toBe(16 * 6);
    const xs = positions.filter((_, i) => i % 3 === 0);
    const ys = positions.filter((_, i) => i % 3 === 1);
    const zs = positions.filter((_, i) => i % 3 === 2);
    expect(Math.min(...xs)).toBeCloseTo(-220);
    expect(Math.max(...xs)).toBeCloseTo(-110);
    expect(Math.min(...zs)).toBeCloseTo(-130);
    expect(Math.max(...zs)).toBeCloseTo(-60);
    expect(new Set(ys)).toEqual(new Set([0.2]));
  });
});

describe("createGeometryCrowd", () => {
  it(
    "wanders a world-space street rectangle without leaving it",
    async () => {
      const geo = buildRectGeometry(-165, -95, 0.2, 110, 70);
      const crowd = await createGeometryCrowd(geo.positions, geo.indices, 4, {
        seed: 3,
        cellSize: 0.5,
      });
      const dt = 1 / 60;
      const pathLength = [0, 0, 0, 0];
      let prev: [number, number][] | null = null;
      for (let s = 0; s < 60 * 60; s++) {
        const frames = crowd.step(dt);
        expect(frames).toHaveLength(4);
        frames.forEach((f, i) => {
          expect(f.position[0]).toBeGreaterThanOrEqual(-220);
          expect(f.position[0]).toBeLessThanOrEqual(-110);
          expect(f.position[1]).toBeGreaterThanOrEqual(-130);
          expect(f.position[1]).toBeLessThanOrEqual(-60);
          if (prev) pathLength[i] += Math.hypot(f.position[0] - prev[i][0], f.position[1] - prev[i][1]);
        });
        prev = frames.map((f) => f.position);
      }
      // Every agent genuinely walks the streets (tens of meters in 60 s).
      // Arrivals are rare by design at this scale — targets average ~50 m
      // away while the wander policy retargets every 8 s — so the test
      // asserts travel + bounds, not arrival counts. The travel floor is
      // per-agent now: each figure cruises at its own cruiseSpeedForIndex
      // pace, so the slowest walker legitimately covers less ground.
      pathLength.forEach((d, i) => expect(d).toBeGreaterThan(cruiseSpeedForIndex(i) * 60 * 0.35));
      const finalFrames = crowd.step(0);
      expect(finalFrames.reduce((sum, f) => sum + f.targetsReached, 0)).toBeGreaterThanOrEqual(1);
      crowd.dispose();
      expect(crowd.step(1 / 60)).toEqual([]);
    },
    60_000,
  );
});
