// @vitest-environment node
// Pure kinematics against fake worlds — no three, no DOM.

import { describe, expect, it } from "vitest";
import { MOVING_SPEED, WALK_CONFIG, clipFor, makeWalker, moveToIntent, step, wrapAngle, type Hit, type World, type WalkInput } from "./walker";

const IDLE: WalkInput = { forward: 0, strafe: 0, turn: 0, run: false };
const FWD: WalkInput = { forward: 1, strafe: 0, turn: 0, run: false };

/** Flat ground at y=0.2 with optional wall slab x in [wx, wx+0.2] (z unbounded), step ledges and a water region. */
function fakeWorld(opts: { wallX?: number; ground?: (x: number, z: number) => number | null } = {}): World {
  const R = WALK_CONFIG.radius;
  return {
    groundY: (x, z, fromY) => {
      const g = opts.ground ? opts.ground(x, z) : 0.2;
      return g === null || g > fromY ? null : g;
    },
    blocked: (_from, to): Hit | null => {
      if (opts.wallX === undefined) return null;
      // Wall face at x = wallX (facing -x). Overlap when the body's right edge passes it.
      const pen = to[0] + R - opts.wallX;
      return pen > 0 ? { nx: -1, nz: 0, depth: pen } : null;
    },
  };
}

const run = (s: ReturnType<typeof makeWalker>, input: WalkInput, secs: number, w: World, dt = 1 / 60) => {
  for (let t = 0; t < secs; t += dt) step(s, input, dt, w);
  return s;
};

describe("heading and velocity", () => {
  it("forward walks along (sin h, cos h) at walk speed", () => {
    const s = run(makeWalker(0, 0.2, 0, Math.PI / 2), FWD, 2, fakeWorld());
    expect(s.x).toBeGreaterThan(2.3);
    expect(s.z).toBeCloseTo(0, 3);
    expect(s.speed).toBeCloseTo(WALK_CONFIG.walkSpeed, 1);
  });

  it("run is faster than walk", () => {
    const a = run(makeWalker(0, 0.2, 0, 0), FWD, 2, fakeWorld());
    const b = run(makeWalker(0, 0.2, 0, 0), { ...FWD, run: true }, 2, fakeWorld());
    expect(b.z).toBeGreaterThan(a.z * 1.5);
  });

  it("strafe right at heading 0 goes to -x; diagonal is not faster than straight", () => {
    const s = run(makeWalker(0, 0.2, 0, 0), { ...IDLE, strafe: 1 }, 1, fakeWorld());
    expect(s.x).toBeLessThan(-0.8);
    const d = run(makeWalker(0, 0.2, 0, 0), { ...FWD, strafe: 1 }, 2, fakeWorld());
    expect(d.speed).toBeLessThanOrEqual(WALK_CONFIG.walkSpeed + 0.01);
  });

  it("turn right decreases heading; look (mouse) is a direct delta", () => {
    const s = run(makeWalker(0, 0.2, 0, 0), { ...IDLE, turn: 1 }, 0.5, fakeWorld());
    expect(s.heading).toBeLessThan(-0.9);
    const m = makeWalker(0, 0.2, 0, 0);
    step(m, { ...IDLE, look: 0.3 }, 1 / 60, fakeWorld());
    expect(m.heading).toBeCloseTo(-0.3, 6);
  });

  it("heading stays wrapped", () => {
    expect(wrapAngle(7)).toBeCloseTo(7 - 2 * Math.PI, 9);
    const s = run(makeWalker(0, 0.2, 0, 3), { ...IDLE, turn: -1 }, 2, fakeWorld());
    expect(Math.abs(s.heading)).toBeLessThanOrEqual(Math.PI);
  });

  it("stops when input stops, and the clip follows speed", () => {
    const w = fakeWorld();
    const s = run(makeWalker(0, 0.2, 0, 0), FWD, 1, w);
    expect(clipFor(s.speed)).toBe("walk");
    run(s, IDLE, 1, w);
    expect(s.speed).toBeLessThan(MOVING_SPEED);
    expect(clipFor(s.speed)).toBe("idle");
  });

  it("is dt-independent enough and ignores dt=0", () => {
    const a = run(makeWalker(0, 0.2, 0, 0), FWD, 2, fakeWorld(), 1 / 30);
    const b = run(makeWalker(0, 0.2, 0, 0), FWD, 2, fakeWorld(), 1 / 120);
    expect(Math.abs(a.z - b.z)).toBeLessThan(0.1);
    const s = makeWalker(1, 0.2, 1, 0);
    step(s, FWD, 0, fakeWorld());
    expect([s.x, s.z]).toEqual([1, 1]);
  });
});

describe("walls", () => {
  it("never passes a wall, even running at it", () => {
    const w = fakeWorld({ wallX: 5 });
    const s = run(makeWalker(0, 0.2, 0, Math.PI / 2), { ...FWD, run: true }, 6, w);
    expect(s.x + WALK_CONFIG.radius).toBeLessThanOrEqual(5 + 1e-6);
    expect(s.x).toBeGreaterThan(4.5);
  });

  it("slides along a wall when walking at it diagonally", () => {
    const w = fakeWorld({ wallX: 5 });
    const s = makeWalker(4.5, 0.2, 0, Math.PI / 4); // diagonal: +x and +z
    run(s, FWD, 2, w);
    expect(s.z).toBeGreaterThan(1.0);
    expect(s.x + WALK_CONFIG.radius).toBeLessThanOrEqual(5 + 1e-6);
  });

  it("a huge dt spike cannot tunnel (dt is clamped)", () => {
    const w = fakeWorld({ wallX: 1 });
    const s = makeWalker(0, 0.2, 0, Math.PI / 2);
    s.vx = 50;
    step(s, FWD, 5, w);
    expect(s.x + WALK_CONFIG.radius).toBeLessThanOrEqual(1 + 1e-6);
  });
});

describe("ground", () => {
  it("climbs a 0.3 m stair but not a 0.6 m ledge", () => {
    const stair = fakeWorld({ ground: (x) => (x < 2 ? 0.2 : x < 3 ? 0.5 : 0.8) });
    const s = run(makeWalker(0, 0.2, 0, Math.PI / 2), FWD, 4, stair);
    expect(s.y).toBeCloseTo(0.8, 6);
    expect(s.x).toBeGreaterThan(3);
    const ledge = fakeWorld({ ground: (x) => (x < 2 ? 0.2 : 0.8) });
    const t = run(makeWalker(0, 0.2, 0, Math.PI / 2), FWD, 4, ledge);
    expect(t.y).toBeCloseTo(0.2, 6);
    expect(t.x).toBeLessThan(2.01);
  });

  it("walks down stairs and tracks a bridge ramp", () => {
    const down = fakeWorld({ ground: (x) => (x < 1 ? 0.8 : x < 2 ? 0.5 : 0.2) });
    const s = run(makeWalker(0, 0.8, 0, Math.PI / 2), FWD, 3, down);
    expect(s.y).toBeCloseTo(0.2, 6);
    expect(s.grounded).toBe(true);
    const ramp = fakeWorld({ ground: (x) => 0.2 + Math.max(0, x) * 0.15 });
    const r = run(makeWalker(0, 0.2, 0, Math.PI / 2), FWD, 5, ramp);
    expect(r.y).toBeCloseTo(0.2 + r.x * 0.15, 1);
  });

  it("ignores decks above the walker (bridge over the plaza)", () => {
    const w: World = {
      groundY: (_x, _z, fromY) => {
        const surfaces = [0.2, 6];
        const ok = surfaces.filter((y) => y <= fromY);
        return ok.length ? Math.max(...ok) : null;
      },
      blocked: () => null,
    };
    const s = run(makeWalker(0, 0.2, 0, 0), FWD, 2, w);
    expect(s.y).toBeCloseTo(0.2, 6);
  });

  it("never enters water or void: the quay edge stops the walker", () => {
    const w = fakeWorld({ ground: (x) => (x < 3 ? 0.2 : x < 4 ? -1.25 : null) });
    const s = run(makeWalker(0, 0.2, 0, Math.PI / 2), { ...FWD, run: true }, 5, w);
    expect(s.x).toBeLessThan(3.001);
    expect(s.y).toBeCloseTo(0.2, 6);
  });

  it("slides along a quay edge", () => {
    const w = fakeWorld({ ground: (x) => (x < 3 ? 0.2 : -1.25) });
    const s = makeWalker(2.9, 0.2, 0, Math.PI / 4);
    run(s, FWD, 2, w);
    expect(s.x).toBeLessThan(3.001);
    expect(s.z).toBeGreaterThan(1);
  });

  it("falls off a big drop with gravity and lands", () => {
    const w = fakeWorld({ ground: (x) => (x < 1 ? 3 : 0.2) });
    const s = makeWalker(0, 3, 0, Math.PI / 2);
    s.grounded = true;
    let airborne = false;
    for (let i = 0; i < 240; i++) { step(s, FWD, 1 / 60, w); if (!s.grounded) airborne = true; }
    expect(airborne).toBe(true);
    expect(s.y).toBeCloseTo(0.2, 6);
    expect(s.grounded).toBe(true);
  });
});

describe("agent intents", () => {
  it("moveToIntent walks to a point and arrives, with no keyboard involved", () => {
    const w = fakeWorld();
    const s = makeWalker(0, 0.2, 0, 0);
    let arrived = false;
    for (let i = 0; i < 60 * 20 && !arrived; i++) {
      const r = moveToIntent(s, [-4, 6]);
      arrived = r.arrived;
      step(s, r.input, 1 / 60, w);
    }
    expect(arrived).toBe(true);
    expect(Math.hypot(s.x + 4, s.z - 6)).toBeLessThan(0.6);
  });

  it("faceHeading turns at the capped rate and stops on target", () => {
    const s = makeWalker(0, 0.2, 0, 0);
    step(s, { ...IDLE, faceHeading: 3 }, 0.1, fakeWorld());
    expect(s.heading).toBeCloseTo(WALK_CONFIG.turnRate * 0.1, 6);
    run(s, { ...IDLE, faceHeading: 1 }, 2, fakeWorld());
    expect(s.heading).toBeCloseTo(1, 6);
  });
});
