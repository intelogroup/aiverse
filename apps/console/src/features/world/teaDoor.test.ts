// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  createCapsuleWorld,
  boxesMesh,
  meshFromArrays,
} from "./capsuleWorld";
import {
  makeWalker,
  step,
  WALK_CONFIG,
  type WalkerState,
  type World,
} from "./walker";
import {
  TEA_BLOCKER_BOX,
  TEA_CLEAR_ANGLE,
  TEA_DOOR_ORIGIN,
  TEA_GRASP,
  TEA_KNOB_WORLD,
  TEA_OPEN_ANGLE,
  TEA_REQUEST_RANGE,
  TeaDoorController,
  alignInput,
  teaAutoClip,
  TEA_AUTO_RANGE,
  teaDoorwayOccupied,
  teaExitPoint,
  teaLeafAngleAt,
  teaStandPose,
  type TeaDoorChannel,
} from "./teaDoor";
import type { WalkDoorClip } from "./walkOverride";
import { angleTo } from "./walker";

const DT = 1 / 60;
const IN: WalkDoorClip = "OpenDoorInwards";
const OUT: WalkDoorClip = "OpenDoorOutwards";
const ZERO = { forward: 0, strafe: 0, turn: 0, run: false };

/** Flat ground quad at y = 0.20 over the whole tea-door test area. */
function groundMesh(): THREE.Mesh {
  const x0 = -32, x1 = -14, z0 = -82, z1 = -64, y = 0.2;
  const pos = new Float32Array([
    x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0,
  ]);
  const index = new Uint32Array([0, 1, 2, 0, 2, 3]);
  return meshFromArrays(pos, index, "test-ground");
}

function groundWorld(extra: THREE.Mesh[] = []): World {
  const meshes = [groundMesh(), ...extra];
  return createCapsuleWorld(() => meshes);
}

/** Fake clip channel honouring the catalog durations. */
function fakeChannel(now: () => number) {
  let fired: { clip: WalkDoorClip; at: number } | null = null;
  const ch = {
    fireDoor(name: WalkDoorClip): boolean {
      fired = { clip: name, at: now() };
      return true;
    },
    get doorPlaying(): boolean {
      return fired !== null && now() - fired.at < TEA_GRASP[fired.clip].duration;
    },
    lastFired(): WalkDoorClip | null {
      return fired?.clip ?? null;
    },
  };
  return ch satisfies TeaDoorChannel & { lastFired(): WalkDoorClip | null };
}

function makeRig(
  start: { x: number; z: number; heading?: number },
  world: World = groundWorld(),
) {
  const blockerLog: boolean[] = [];
  let t = 0;
  const channel = fakeChannel(() => t);
  const ctl = new TeaDoorController({
    channel,
    setBlocker: (on) => blockerLog.push(on),
  });
  const s = makeWalker(start.x, 0.2, start.z, start.heading ?? Math.PI);
  return {
    ctl,
    channel,
    s,
    blockerLog,
    /** One frame: controller input (or idle keys) through the production walker. */
    frame(keys: typeof ZERO | { forward: number; strafe: number; turn: number; run: boolean } = ZERO) {
      t += DT;
      const input = ctl.drive(s, DT, keys.forward > 0);
      step(s, input ?? keys, DT, world);
      return input;
    },
    frames(n: number, keys?: { forward: number; strafe: number; turn: number; run: boolean }) {
      for (let i = 0; i < n; i++) this.frame(keys);
    },
  };
}

describe("tea stand poses (solved from the physical knob)", () => {
  it("street pose reproduces the study stand table", () => {
    const p = teaStandPose(IN);
    expect(p.heading).toBeCloseTo(Math.PI, 6);
    expect(p.x).toBeCloseTo(-22.7797, 3);
    expect(p.z).toBeCloseTo(-72.275, 3);
    // 0.305 m street-side of the street leaf face (world z = -72.58);
    // the study's table reads 0.31 off the face.
    expect(p.z - (TEA_DOOR_ORIGIN.z - 0.08)).toBeCloseTo(0.305, 2);
    // Hand placement: pos + graspFwd*F + graspLat*R == knob (by construction).
    const g = TEA_GRASP[IN];
    const hx = p.x + g.graspFwd * Math.sin(p.heading) + g.graspLat * -Math.cos(p.heading);
    const hz = p.z + g.graspFwd * Math.cos(p.heading) + g.graspLat * Math.sin(p.heading);
    expect(hx).toBeCloseTo(TEA_KNOB_WORLD.street.x, 6);
    expect(hz).toBeCloseTo(TEA_KNOB_WORLD.street.z, 6);
  });

  it("interior pose places the hand on the same single knob", () => {
    const p = teaStandPose(OUT);
    expect(p.heading).toBeCloseTo(0, 6);
    expect(p.x).toBeCloseTo(-22.9867, 3);
    expect(p.z).toBeCloseTo(-73.013, 3);
    const g = TEA_GRASP[OUT];
    const hx = p.x + g.graspFwd * Math.sin(p.heading) + g.graspLat * -Math.cos(p.heading);
    const hz = p.z + g.graspFwd * Math.cos(p.heading) + g.graspLat * Math.sin(p.heading);
    expect(hx).toBeCloseTo(TEA_KNOB_WORLD.interior.x, 6);
    expect(hz).toBeCloseTo(TEA_KNOB_WORLD.interior.z, 6);
    // One physical knob: same x on both faces, faces 0.25 m apart in z,
    // centre height 1.28 = 0.80 above the 0.48 plinth the performer
    // stands on (the floor proof's col_heroes finding — NOT the 0.20
    // street the study assumed before the interior floor was checked).
    expect(TEA_KNOB_WORLD.street.x).toBe(TEA_KNOB_WORLD.interior.x);
    expect(TEA_KNOB_WORLD.street.z - TEA_KNOB_WORLD.interior.z).toBeCloseTo(0.25, 6);
    expect(TEA_KNOB_WORLD.street.y).toBeCloseTo(1.28, 6);
  });

  it("exit points sit 1.2 m past the far face on the door centre line", () => {
    const ein = teaExitPoint(IN);
    expect(ein.x).toBeCloseTo(TEA_DOOR_ORIGIN.x, 6);
    expect(ein.z).toBeCloseTo(-73.91, 3);
    const eout = teaExitPoint(OUT);
    expect(eout.x).toBeCloseTo(TEA_DOOR_ORIGIN.x, 6);
    expect(eout.z).toBeCloseTo(-71.38, 3);
  });
});

describe("leaf angle curves (one clock = the clip)", () => {
  it("Inwards: shut through the whole contact window (theta* = 0), free swing after release", () => {
    const g = TEA_GRASP[IN];
    expect(teaLeafAngleAt(IN, 0)).toBe(0);
    expect(teaLeafAngleAt(IN, g.contactAt)).toBe(0);
    // FK theta-star: the hand settles on the CLOSED knob and holds it;
    // any angle before release displaces the knob from the palm.
    expect(teaLeafAngleAt(IN, g.settledAt)).toBe(0);
    expect(teaLeafAngleAt(IN, g.releaseAt)).toBe(0);
    // Fully open before the clip ends, and monotone throughout.
    expect(teaLeafAngleAt(IN, 5.85)).toBe(TEA_OPEN_ANGLE);
    expect(teaLeafAngleAt(IN, g.duration)).toBe(TEA_OPEN_ANGLE);
    let prev = -1;
    for (let t = 0; t <= g.duration; t += 0.05) {
      const a = teaLeafAngleAt(IN, t);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
    // Clear angle reached during the step-through window.
    let clearAt = -1;
    for (let t = 0; t <= g.duration; t += 0.01)
      if (teaLeafAngleAt(IN, t) >= TEA_CLEAR_ANGLE) { clearAt = t; break; }
    expect(clearAt).toBeGreaterThan(g.travelAt);
    expect(clearAt).toBeLessThan(5.6);
  });

  it("Outwards: leaf slaved to the pull (theta* fit), then swings free", () => {
    const g = TEA_GRASP[OUT];
    expect(teaLeafAngleAt(OUT, 0)).toBe(0);
    expect(teaLeafAngleAt(OUT, g.contactAt)).toBe(0);
    // FK theta-star: the palm stays on the closed knob until ~2.6 s;
    // at settle the best-tracking angle is still ~0-1 deg.
    expect(teaLeafAngleAt(OUT, g.settledAt)).toBeLessThan(3);
    expect(teaLeafAngleAt(OUT, g.releaseAt)).toBeCloseTo(10, 6);
    expect(teaLeafAngleAt(OUT, 3.8)).toBe(TEA_OPEN_ANGLE);
    expect(teaLeafAngleAt(OUT, g.duration)).toBe(TEA_OPEN_ANGLE);
    let prev = -1;
    for (let t = 0; t <= g.duration; t += 0.05) {
      const a = teaLeafAngleAt(OUT, t);
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
  });
});

describe("blocker rule + state machine", () => {
  it("blocker present while closed and idle; construction syncs it once", () => {
    const rig = makeRig({ x: -22.78, z: -72.28 });
    expect(rig.ctl.blockerActive()).toBe(true);
    expect(rig.blockerLog).toEqual([true]);
    rig.frames(10);
    expect(rig.blockerLog).toEqual([true]); // no churn
  });

  it("request validation: too far, wrong side, then started", () => {
    const far = makeRig({ x: -22.9, z: -60 });
    far.frames(2); // let the controller observe the bot
    expect(far.ctl.request(IN)).toBe("too-far");
    expect(far.ctl.status()).toContain("too far");

    const inside = makeRig({ x: -22.99, z: -73.01, heading: 0 });
    inside.frames(2);
    expect(inside.ctl.request(IN)).toBe("wrong-side");
    expect(inside.ctl.request(OUT)).toBe("started");

    const street = makeRig({ x: -22.78, z: -72.28 });
    street.frames(2);
    expect(street.ctl.request(OUT)).toBe("wrong-side");
    expect(street.ctl.request(IN)).toBe("started");
    expect(street.ctl.request(IN)).toBe("busy"); // second press while aligning
  });

  it("full ENTER session: align fires the clip, bot crosses to the interior exit", () => {
    const rig = makeRig({ x: -21.6, z: -71.2 }); // ~1.6 m out, in range
    rig.frames(2);
    expect(rig.ctl.request(IN)).toBe("started");
    // Session running: blocker handed over to the choreography.
    expect(rig.ctl.blockerActive()).toBe(false);
    let sawPerform = false;
    for (let i = 0; i < 60 * 14; i++) {
      rig.frame();
      if (rig.ctl.phase === "perform" || rig.ctl.phase === "travel") sawPerform = true;
      if (rig.ctl.phase === "idle" && sawPerform) break;
    }
    expect(sawPerform).toBe(true);
    expect(rig.channel.lastFired()).toBe(IN);
    expect(rig.ctl.state).toBe("open");
    expect(rig.ctl.angle).toBe(TEA_OPEN_ANGLE);
    const exit = teaExitPoint(IN);
    expect(Math.hypot(rig.s.x - exit.x, rig.s.z - exit.z)).toBeLessThan(0.2);
    expect(rig.s.z).toBeLessThan(TEA_DOOR_ORIGIN.z - 1.2); // inside the room
    expect(rig.s.y).toBeCloseTo(0.2, 6); // stayed on the district ground
  });

  it("full EXIT session mirrors the entry", () => {
    const rig = makeRig({ x: -23.4, z: -73.6, heading: 0 });
    rig.frames(2);
    expect(rig.ctl.request(OUT)).toBe("started");
    for (let i = 0; i < 60 * 12; i++) {
      rig.frame();
      if (rig.ctl.phase === "idle" && rig.ctl.state === "open") break;
    }
    expect(rig.channel.lastFired()).toBe(OUT);
    const exit = teaExitPoint(OUT);
    expect(Math.hypot(rig.s.x - exit.x, rig.s.z - exit.z)).toBeLessThan(0.2);
    expect(rig.s.z).toBeGreaterThan(TEA_DOOR_ORIGIN.z + 0.9); // back on the street
    expect(rig.s.y).toBeCloseTo(0.2, 6);
  });

  it("auto-close waits for an unoccupied doorway and a clear bot, then closes", () => {
    const rig = makeRig({ x: -21.6, z: -71.2 });
    rig.frames(2);
    rig.ctl.request(IN);
    for (let i = 0; i < 60 * 14 && rig.ctl.state !== "open"; i++) rig.frame();
    expect(rig.ctl.state).toBe("open");
    // The interior exit (z = -73.91) is outside the occupancy box and
    // more than 1 m from the door plane, so auto-close may proceed.
    expect(teaDoorwayOccupied(rig.s.x, rig.s.z)).toBe(false);
    rig.frames(60 * 4);
    expect(rig.ctl.state).toBe("closed");
    expect(rig.ctl.angle).toBe(0);
    expect(rig.ctl.blockerActive()).toBe(true);
  });

  it("occupancy guard: door held open while the bot stands in the doorway", () => {
    const rig = makeRig({ x: -21.6, z: -71.2 });
    rig.frames(2);
    rig.ctl.request(IN);
    for (let i = 0; i < 60 * 14 && rig.ctl.state !== "open"; i++) rig.frame();
    expect(rig.ctl.state).toBe("open");
    // Teleport the bot into the doorway sweep and keep it there.
    rig.s.x = TEA_DOOR_ORIGIN.x;
    rig.s.z = TEA_DOOR_ORIGIN.z - 0.3;
    rig.frames(60 * 3);
    expect(rig.ctl.state).toBe("open"); // never swings onto the capsule
    expect(rig.ctl.angle).toBe(TEA_OPEN_ANGLE);
  });

  it("request range constant is the brief's 2.5 m", () => {
    expect(TEA_REQUEST_RANGE).toBe(2.5);
  });
});

describe("auto-open: walking at the door starts the performance", () => {
  const WALK = { forward: 1, strafe: 0, turn: 0, run: false };
  const dx = TEA_DOOR_ORIGIN.x;
  const dz = TEA_DOOR_ORIGIN.z;

  it("truth table: street Inwards, inside Outwards, never when idle, passing, backing or far", () => {
    expect(teaAutoClip({ x: dx, z: dz + 1.5, heading: Math.PI }, true)).toBe(IN);
    expect(teaAutoClip({ x: dx, z: dz - 1.5, heading: 0 }, true)).toBe(OUT);
    expect(teaAutoClip({ x: dx, z: dz + 1.5, heading: Math.PI }, false)).toBeNull(); // not pushing forward
    expect(teaAutoClip({ x: dx, z: dz + 1.5, heading: Math.PI / 2 }, true)).toBeNull(); // walking along the street
    expect(teaAutoClip({ x: dx, z: dz + 1.5, heading: 0 }, true)).toBeNull(); // walking away
    expect(teaAutoClip({ x: dx, z: dz + TEA_AUTO_RANGE + 0.3, heading: Math.PI }, true)).toBeNull(); // too far
    expect(teaAutoClip({ x: dx + 2, z: dz + 1.5, heading: Math.PI }, true)).toBeNull(); // beside the door
  });

  it("holding forward at the shut door opens it and walks the bot in, no button", () => {
    const rig = makeRig({ x: dx + 0.1, z: dz + 2.4, heading: Math.PI });
    rig.frames(2);
    let started = false;
    for (let i = 0; i < 60 * 20; i++) {
      rig.frame(WALK);
      if (rig.ctl.phase !== "idle") started = true;
      if (started && rig.ctl.phase === "idle") break;
    }
    expect(started).toBe(true);
    expect(rig.channel.lastFired()).toBe(IN);
    expect(rig.s.z).toBeLessThan(dz - 1.2); // inside the room
  });

  it("walking along the street past the door never starts it", () => {
    const rig = makeRig({ x: dx - 5, z: dz + 1.2, heading: Math.PI / 2 }); // facing +x
    for (let i = 0; i < 60 * 6; i++) rig.frame(WALK);
    expect(rig.ctl.phase).toBe("idle");
    expect(rig.channel.lastFired()).toBeNull();
  });

  it("standing at the door facing it does nothing until the player pushes forward", () => {
    const rig = makeRig({ x: dx, z: dz + 1.2, heading: Math.PI });
    rig.frames(120);
    expect(rig.ctl.phase).toBe("idle");
    rig.frames(2, WALK);
    expect(rig.ctl.phase).not.toBe("idle");
  });
});

describe("headless walker proof (production walker + capsule world)", () => {
  function walkAtDoor(world: World, seconds: number): WalkerState {
    // Start 1.2 m street-side of the door, walk straight at it.
    const s = makeWalker(TEA_DOOR_ORIGIN.x, 0.2, TEA_DOOR_ORIGIN.z + 1.2, Math.PI);
    const steps = Math.round(seconds / DT);
    for (let i = 0; i < steps; i++) step(s, { ...ZERO, forward: 1 }, DT, world);
    return s;
  }

  it("shut door blocks: the bot never crosses the door plane", () => {
    const blocker = boxesMesh([TEA_BLOCKER_BOX], [0, 0], "door:tea");
    expect(blocker).not.toBeNull();
    const s = walkAtDoor(groundWorld([blocker!]), 4);
    expect(s.z).toBeGreaterThan(TEA_DOOR_ORIGIN.z + 0.25); // held street-side
    expect(s.y).toBeCloseTo(0.2, 6);
  });

  it("same walk with the blocker lifted passes through (control)", () => {
    const s = walkAtDoor(groundWorld(), 4);
    expect(s.z).toBeLessThan(TEA_DOOR_ORIGIN.z - 1.0); // crossed to the room side
    expect(s.y).toBeCloseTo(0.2, 6);
    expect(WALK_CONFIG.radius).toBe(0.4);
  });
});

describe("alignInput (fine alignment into the stand pose)", () => {
  it("never hunts: from a fast approach it settles at the pose with the pose heading, from both sides", () => {
    for (const clip of [IN, OUT]) {
      const pose = teaStandPose(clip);
      const start = clip === IN ? { x: pose.x + 0.05, z: pose.z + 2.0 } : { x: pose.x - 0.04, z: pose.z - 2.0 };
      const rig = makeRig({ ...start, heading: pose.heading });
      let settled = -1;
      for (let i = 0; i < 60 * 15; i++) {
        const input = alignInput(rig.s, pose);
        step(rig.s, input, DT, groundWorld());
        const d = Math.hypot(rig.s.x - pose.x, rig.s.z - pose.z);
        if (d <= 0.03 && Math.abs(angleTo(rig.s.heading, pose.heading)) <= 0.03) { settled = i; break; }
      }
      expect(settled).toBeGreaterThan(0);
      expect(Math.abs(angleTo(rig.s.heading, pose.heading))).toBeLessThan(0.05); // never turned round
    }
  });
});
