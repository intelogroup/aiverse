// @vitest-environment node
// Same reason as locomotion.test.ts: Recast's WASM loader needs Node APIs.

import { describe, expect, it } from "vitest";
import {
  AGORA_BENCH_ANCHORS,
  CAST_HIPS_Y,
  SIT_DOWN_S,
  EmbodyController,
  seatedRootY,
  angleDelta,
  turnToward,
  type Anchor,
  type BodyFrame,
  type BodyPort,
  type Vec2,
} from "./embody";
import {
  buildDeckGeometry,
  createGeometryCrowd,
  createPlatformCrowd,
  type PlanObstacle,
} from "./locomotion";

const dist = (a: Vec2, b: Vec2) => Math.hypot(a[0] - b[0], a[1] - b[1]);

/** A scripted body: agents glide toward their target at a fixed cruise. */
class FakeBody implements BodyPort {
  agents = new Map<number, { pos: Vec2; target: Vec2 | null; heading: number }>();
  stuck = false;
  cruise = 1; // m/s

  spawn(i: number, pos: Vec2, heading = 0): void {
    this.agents.set(i, { pos: [...pos], target: null, heading });
  }
  frame(i: number): BodyFrame | null {
    const a = this.agents.get(i);
    if (!a) return null;
    const moving = a.target !== null && !this.stuck && dist(a.pos, a.target) > 0.01;
    return { position: [...a.pos], speed: moving ? this.cruise : 0, heading: a.heading };
  }
  setControlled(i: number, on: boolean): void {
    const a = this.agents.get(i);
    if (a && on) a.target = null;
  }
  moveTo(i: number, x: number, z: number): void {
    const a = this.agents.get(i);
    if (a) a.target = [x, z];
  }
  stop(i: number): void {
    const a = this.agents.get(i);
    if (a) a.target = null;
  }
  setHeading(i: number, h: number): void {
    const a = this.agents.get(i);
    if (a) a.heading = h;
  }
  advance(dt: number): void {
    if (this.stuck) return;
    for (const a of this.agents.values()) {
      if (!a.target) continue;
      const d = dist(a.pos, a.target);
      const step = this.cruise * dt;
      if (d <= step) a.pos = [...a.target];
      else a.pos = [a.pos[0] + ((a.target[0] - a.pos[0]) / d) * step, a.pos[1] + ((a.target[1] - a.pos[1]) / d) * step];
    }
  }
}

function run(ctl: EmbodyController, body: FakeBody, seconds: number, dt = 0.05): void {
  for (let t = 0; t < seconds; t += dt) {
    body.advance(dt);
    ctl.tick(dt);
  }
}

const freshAnchors = (): Anchor[] => AGORA_BENCH_ANCHORS.map((a) => ({ ...a, occupiedBy: null }));
const hasEvent = (ctl: EmbodyController, type: string, skill: string) =>
  ctl.events.some((e) => e.type === type && e.skill === skill);

describe("heading math", () => {
  it("angleDelta takes the short way around the circle", () => {
    expect(angleDelta(0, Math.PI)).toBeCloseTo(Math.PI);
    expect(angleDelta((3 * Math.PI) / 4, (-3 * Math.PI) / 4)).toBeCloseTo(Math.PI / 2);
    expect(angleDelta(0, -Math.PI / 2)).toBeCloseTo(-Math.PI / 2);
  });

  it("turnToward steps by at most maxStep and snaps within it", () => {
    expect(turnToward(0, Math.PI / 2, 0.3)).toBeCloseTo(0.3);
    expect(turnToward(0, 0.2, 0.3)).toBeCloseTo(0.2);
    expect(turnToward(0, -Math.PI / 2, 0.3)).toBeCloseTo(-0.3);
  });
});

describe("EmbodyController skills", () => {
  it("go_to completes on arrival and settles the body", () => {
    const body = new FakeBody();
    body.spawn(0, [0, 0]);
    const ctl = new EmbodyController(body, freshAnchors());
    expect(ctl.issue(0, { skill: "go_to", target: [3, 0] })).toBe(true);
    run(ctl, body, 5);
    expect(hasEvent(ctl, "completed", "go_to")).toBe(true);
    expect(ctl.stateFor(0).current).toBeNull();
    expect(body.agents.get(0)?.target).toBeNull();
  });

  it("go_to fails as blocked when the body cannot move", () => {
    const body = new FakeBody();
    body.spawn(0, [0, 0]);
    body.stuck = true;
    const ctl = new EmbodyController(body, freshAnchors());
    ctl.issue(0, { skill: "go_to", target: [5, 5] });
    run(ctl, body, 6);
    const fail = ctl.events.find((e) => e.type === "failed" && e.skill === "go_to");
    expect(fail?.detail).toContain("blocked");
    expect(ctl.stateFor(0).current).toBeNull();
  });

  it("face turns at the capped rate and completes within tolerance", () => {
    const body = new FakeBody();
    body.spawn(0, [0, 0], 0);
    const ctl = new EmbodyController(body, freshAnchors());
    ctl.issue(0, { skill: "face", target: { heading: Math.PI } });
    run(ctl, body, 0.4); // 180 deg/s: not there yet
    expect(ctl.stateFor(0).current).toBe("face");
    run(ctl, body, 1);
    expect(hasEvent(ctl, "completed", "face")).toBe(true);
    expect(ctl.stateFor(0).heading).toBeCloseTo(Math.PI);
    expect(body.agents.get(0)?.heading).toBeCloseTo(Math.PI);
  });

  it("face by point aims from the body's position", () => {
    const body = new FakeBody();
    body.spawn(0, [2, 0], 0);
    const ctl = new EmbodyController(body, freshAnchors());
    ctl.issue(0, { skill: "face", target: { point: [0, 0] } });
    run(ctl, body, 1);
    expect(ctl.stateFor(0).heading).toBeCloseTo(-Math.PI / 2);
  });

  it("refuses a second skill while busy; stop cancels the running one", () => {
    const body = new FakeBody();
    body.spawn(0, [0, 0]);
    const ctl = new EmbodyController(body, freshAnchors());
    ctl.issue(0, { skill: "go_to", target: [9, 9] });
    expect(ctl.issue(0, { skill: "go_to", target: [1, 1] })).toBe(false);
    expect(hasEvent(ctl, "refused", "go_to")).toBe(true);
    run(ctl, body, 0.5);
    expect(ctl.issue(0, { skill: "stop" })).toBe(true);
    expect(hasEvent(ctl, "cancelled", "go_to")).toBe(true);
    expect(ctl.stateFor(0).current).toBeNull();
  });

  it("sit_on runs the full cycle: approach, face, mount, seated lock, stand", () => {
    const body = new FakeBody();
    const anchors = freshAnchors();
    const bench = anchors[0];
    body.spawn(0, [bench.approach[0] + 1.5, bench.approach[1]], 0);
    const ctl = new EmbodyController(body, anchors);

    expect(ctl.issue(0, { skill: "sit_on", anchorId: "bench-a" })).toBe(true);
    run(ctl, body, 6);
    expect(hasEvent(ctl, "completed", "sit_on")).toBe(true);
    expect(ctl.stateFor(0).posture).toBe("seated");
    expect(bench.occupiedBy).toBe(0);
    const ov = ctl.overrideFor(0);
    expect(ov).not.toBeNull();
    expect(ov!.position[0]).toBeCloseTo(bench.seat[0]);
    expect(ov!.position[1]).toBeCloseTo(bench.seat[1]);
    // Seated root Y: the figure drops so the rig's hips rest on the seat
    // top (the sitting clip is rotations-only; placement lives here).
    expect(ov!.y).toBeCloseTo(bench.seatHeight - CAST_HIPS_Y);

    // Seated: locomotion is refused, facing still works.
    expect(ctl.issue(0, { skill: "go_to", target: [0, 0] })).toBe(false);
    expect(ctl.issue(0, { skill: "face", target: { heading: 0 } })).toBe(true);
    run(ctl, body, 1.5);
    expect(ctl.stateFor(0).heading).toBeCloseTo(0);

    // Stand releases the anchor and the override (the stand slide
    // takes the full SitDown clip length, SIT_DOWN_S).
    expect(ctl.issue(0, { skill: "stand" })).toBe(true);
    run(ctl, body, 3.5);
    expect(hasEvent(ctl, "completed", "stand")).toBe(true);
    expect(ctl.stateFor(0).posture).toBe("standing");
    expect(bench.occupiedBy).toBeNull();
    expect(ctl.overrideFor(0)).toBeNull();
  });

  it("refuses an occupied anchor, an unknown anchor, and standing up while standing", () => {
    const body = new FakeBody();
    const anchors = freshAnchors();
    const bench = anchors[0];
    body.spawn(1, [...bench.approach], 0);
    body.spawn(0, [0, 0], 0);
    const ctl = new EmbodyController(body, anchors);
    ctl.issue(1, { skill: "sit_on", anchorId: "bench-a" });
    run(ctl, body, 5);
    expect(ctl.stateFor(1).posture).toBe("seated");

    expect(ctl.issue(0, { skill: "sit_on", anchorId: "bench-a" })).toBe(false);
    expect(ctl.issue(0, { skill: "sit_on", anchorId: "nope" })).toBe(false);
    expect(ctl.issue(0, { skill: "stand" })).toBe(false);
    const refusals = ctl.events.filter((e) => e.type === "refused" && e.agent === 0);
    expect(refusals.some((e) => e.detail?.includes("occupied"))).toBe(true);
  });

  it("override phases run mounting -> seated -> standing, each transition lasting the SitDown clip", () => {
    const body = new FakeBody();
    const anchors = freshAnchors();
    const bench = anchors[0];
    body.spawn(0, [...bench.approach], bench.facing);
    const ctl = new EmbodyController(body, anchors);
    const dt = 0.05;
    const phases: (string | null)[] = [];
    const step = () => {
      body.advance(dt);
      ctl.tick(dt);
      phases.push(ctl.overrideFor(0)?.phase ?? null);
    };
    ctl.issue(0, { skill: "sit_on", anchorId: "bench-a" });
    let mountStart = -1;
    let seatedAt = -1;
    for (let i = 0; i < 200 && seatedAt < 0; i++) {
      step();
      if (mountStart < 0 && phases[phases.length - 1] === "mounting") mountStart = i;
      if (ctl.stateFor(0).posture === "seated") seatedAt = i;
    }
    expect(mountStart).toBeGreaterThanOrEqual(0);
    expect(seatedAt).toBeGreaterThan(mountStart);
    // The mount slide is synced to the clip: SIT_DOWN_S of ticks.
    const mountS = (seatedAt - mountStart) * dt;
    expect(mountS).toBeGreaterThan(SIT_DOWN_S - 0.25);
    expect(mountS).toBeLessThan(SIT_DOWN_S + 0.25);
    expect(ctl.overrideFor(0)?.phase).toBe("seated");

    phases.length = 0;
    ctl.issue(0, { skill: "stand" });
    let standTicks = 0;
    for (let i = 0; i < 200 && ctl.stateFor(0).posture !== "standing"; i++) {
      step();
      standTicks++;
    }
    expect(phases).toContain("standing");
    expect(standTicks * dt).toBeGreaterThan(SIT_DOWN_S - 0.25);
    expect(standTicks * dt).toBeLessThan(SIT_DOWN_S + 0.25);
    expect(ctl.overrideFor(0)).toBeNull();
  });

  it("seated root Y uses the member's own body hips (hipsYFor)", () => {
    const body = new FakeBody();
    const anchors = freshAnchors();
    const bench = anchors[0];
    body.spawn(0, [...bench.approach], bench.facing);
    const summerHips = 0.7854; // BODY_SUMMER.hipsY (bodies.ts)
    const ctl = new EmbodyController(body, anchors, { hipsYFor: () => summerHips });
    ctl.issue(0, { skill: "sit_on", anchorId: "bench-a" });
    run(ctl, body, 6);
    expect(ctl.stateFor(0).posture).toBe("seated");
    expect(ctl.overrideFor(0)!.y).toBeCloseTo(bench.seatHeight - summerHips);
    // The pure helper agrees, and still defaults to the cast body.
    expect(seatedRootY(bench, summerHips)).toBeCloseTo(bench.seatHeight - summerHips);
    expect(seatedRootY(bench)).toBeCloseTo(bench.seatHeight - CAST_HIPS_Y);
  });

  it("contextFor offers only nearby, enumerated interactables", () => {
    const body = new FakeBody();
    const anchors = freshAnchors();
    body.spawn(0, [...anchors[0].approach], 0);
    const ctl = new EmbodyController(body, anchors);
    const ctx = ctl.contextFor(0);
    expect(ctx.posture).toBe("standing");
    expect(ctx.current_action).toBeNull();
    expect(ctx.nearby_interactables.map((a) => a.id)).toEqual(["bench-a"]);
    expect(ctx.nearby_interactables[0].free).toBe(true);
  });
});

describe("sit_on over the bench-carved deck (production composition)", () => {
  it(
    "reaches the 0.95 m approach and sits, with the bench solid in the navmesh",
    async () => {
      const anchors = AGORA_BENCH_ANCHORS.map((a) => ({ ...a, occupiedBy: null }));
      const obstacles: PlanObstacle[] = anchors.map((a) => ({
        x: a.seat[0],
        z: a.seat[1],
        heading: a.facing,
        w: 1.3,
        d: 0.5,
      }));
      const geo = buildDeckGeometry(9.7, 2.2, obstacles);
      const bench = anchors[0];
      const crowd = await createGeometryCrowd(geo.positions, geo.indices, 2, {
        seed: 11,
        cellSize: 0.1,
        initialPositions: [
          [bench.approach[0] + 1.2, bench.approach[1] + 0.8],
          [-4, 3],
        ],
      });
      try {
        let frames = crowd.step(0);
        const port = {
          frame: (i: number) => {
            const f = frames[i];
            return f ? { position: f.position, speed: f.speed, heading: f.heading } : null;
          },
          setControlled: (i: number, on: boolean) => crowd.setControlled(i, on),
          moveTo: (i: number, x: number, z: number) => crowd.moveAgentTo(i, x, z),
          stop: (i: number) => crowd.stopAgent(i),
          setHeading: (i: number, h: number) => crowd.setHeading(i, h),
        };
        const ctl = new EmbodyController(port, anchors);
        expect(ctl.issue(0, { skill: "sit_on", anchorId: "bench-a" })).toBe(true);
        const dt = 1 / 30;
        for (let t = 0; t < 25 && ctl.stateFor(0).posture !== "seated"; t += dt) {
          frames = crowd.step(dt);
          ctl.tick(dt);
        }
        expect(ctl.stateFor(0).posture).toBe("seated");
        expect(hasEvent(ctl, "completed", "sit_on")).toBe(true);
        // And she can stand back up onto the same mesh.
        expect(ctl.issue(0, { skill: "stand" })).toBe(true);
        for (let t = 0; t < 5 && ctl.stateFor(0).posture !== "standing"; t += dt) {
          frames = crowd.step(dt);
          ctl.tick(dt);
        }
        expect(ctl.stateFor(0).posture).toBe("standing");
      } finally {
        crowd.dispose();
      }
    },
    60_000,
  );
});

describe("crowd control surface (real Recast crowd)", () => {
  it(
    "a controlled agent holds its commanded target; releasing it resumes wandering",
    async () => {
      const crowd = await createPlatformCrowd(6, 2, {
        seed: 7,
        initialPositions: [
          [-4, 0],
          [4, 0],
        ],
      });
      try {
        crowd.setControlled(0, true);
        crowd.moveAgentTo(0, 3, 3);
        let frames = crowd.step(1 / 30);
        let arrived = false;
        for (let t = 0; t < 30 && !arrived; t += 1 / 30) {
          frames = crowd.step(1 / 30);
          if (dist(frames[0].position, [3, 3]) < 0.7) arrived = true;
        }
        expect(arrived).toBe(true);
        // It stays: no wander retargeting while controlled.
        for (let t = 0; t < 3; t += 1 / 30) frames = crowd.step(1 / 30);
        expect(dist(frames[0].position, [3, 3])).toBeLessThan(1.0);
        // Heading override lands while the agent is at rest.
        crowd.setHeading(0, -2);
        frames = crowd.step(1 / 30);
        expect(frames[0].heading).toBeCloseTo(-2);
        // The uncontrolled agent kept wandering meanwhile.
        expect(frames[1].targetsReached >= 1 || dist(frames[1].position, [4, 0]) > 2).toBe(true);
        // Release: wandering (and its target counting) resumes.
        crowd.setControlled(0, false);
        let resumed = false;
        for (let t = 0; t < 15 && !resumed; t += 1 / 30) {
          frames = crowd.step(1 / 30);
          if (frames[0].targetsReached >= 1) resumed = true;
        }
        expect(resumed).toBe(true);
      } finally {
        crowd.dispose();
      }
    },
    30_000,
  );
});
