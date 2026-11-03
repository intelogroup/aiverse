// @vitest-environment node
// Recast's WASM loader needs real Node APIs; the console's vitest default
// environment is jsdom, so this file opts back into node.

import { describe, expect, it } from "vitest";
import { animState, createPlatformCrowd } from "./locomotion";

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
