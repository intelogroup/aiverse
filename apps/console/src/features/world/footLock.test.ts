import { describe, expect, it } from "vitest";
import * as THREE from "three";
import {
  BLEND_S,
  FOOT_BONE,
  FootLock,
  MAX_DIP,
  MIN_LOCK_SPEED,
  STEP_LIFT,
  STEP_YAW,
  SWING_CLEARANCE,
  SHIN_BONE,
  THIGH_BONE,
  easeBlend,
  findLegs,
  solveTwoBone,
} from "./footLock";
import type { ContactPoint } from "./grounding";
import { setPlantSink } from "./soundPlants";

const V = (x: number, y: number, z: number) => new THREE.Vector3(x, y, z);

describe("bone names", () => {
  it("match Mixamo and KayKit legs, and only the right bones", () => {
    for (const n of ["mixamorig:LeftUpLeg", "mixamorig_RightUpLeg", "upperleg.l", "upperleg.r"]) expect(THIGH_BONE.test(n), n).toBe(true);
    for (const n of ["mixamorig:LeftLeg", "mixamorig_RightLeg", "lowerleg.l", "lowerleg.r"]) expect(SHIN_BONE.test(n), n).toBe(true);
    for (const n of ["mixamorig:LeftFoot", "mixamorig_RightFoot", "foot.l", "foot.r"]) expect(FOOT_BONE.test(n), n).toBe(true);
    // the thigh must not be taken for the shin, nor a toe for the foot
    expect(SHIN_BONE.test("mixamorig:LeftUpLeg")).toBe(false);
    expect(FOOT_BONE.test("mixamorig:LeftToeBase")).toBe(false);
    expect(THIGH_BONE.test("mixamorig:LeftLeg")).toBe(false);
  });
});

describe("solveTwoBone", () => {
  const a = V(0, 1, 0);
  const b = V(0, 0.5, 0.1); // knee bent forward (+z)
  const c = V(0, 0, 0);
  const l1 = a.distanceTo(b);
  const l2 = b.distanceTo(c);

  it("keeps both bone lengths and reaches a reachable target", () => {
    const knee = new THREE.Vector3();
    const ankle = new THREE.Vector3();
    const t = V(0.1, 0.1, 0.25);
    solveTwoBone(a, b, c, t, V(0, 0, 1), knee, ankle);
    expect(a.distanceTo(knee)).toBeCloseTo(l1, 6);
    expect(knee.distanceTo(ankle)).toBeCloseTo(l2, 6);
    expect(ankle.distanceTo(t)).toBeLessThan(1e-6);
  });

  it("keeps the knee on the clip's side (no flip)", () => {
    const knee = new THREE.Vector3();
    const ankle = new THREE.Vector3();
    for (const t of [V(0, 0, 0.3), V(0, 0.2, -0.3), V(0.2, 0.05, 0), V(-0.2, 0.05, 0.1)]) {
      solveTwoBone(a, b, c, t, V(0, 0, 1), knee, ankle);
      // knee in front of the hip-ankle line, as the original was
      const line = ankle.clone().sub(a).normalize();
      const off = knee.clone().sub(a);
      off.addScaledVector(line, -off.dot(line));
      expect(off.z).toBeGreaterThan(0);
    }
  });

  it("clamps an out-of-reach target to full extension and reports the reach", () => {
    const knee = new THREE.Vector3();
    const ankle = new THREE.Vector3();
    const far = V(0, -0.5, 0);
    const reach = solveTwoBone(a, b, c, far, V(0, 0, 1), knee, ankle);
    expect(reach).toBeGreaterThan(1);
    expect(a.distanceTo(ankle)).toBeLessThan(l1 + l2);
    expect(a.distanceTo(ankle)).toBeGreaterThan((l1 + l2) * 0.99);
    expect(a.distanceTo(knee)).toBeCloseTo(l1, 6);
  });

  it("a straight leg bends toward the fallback pole", () => {
    const straight = V(0, 0.5, 0);
    const knee = new THREE.Vector3();
    const ankle = new THREE.Vector3();
    solveTwoBone(a, straight, c, V(0, 0.15, 0), V(0, 0, 1), knee, ankle);
    expect(knee.z).toBeGreaterThan(0.1);
  });
});

describe("easeBlend", () => {
  it("is 0 -> 1 with zero slope at both ends", () => {
    expect(easeBlend(0)).toBe(0);
    expect(easeBlend(1)).toBe(1);
    expect(easeBlend(0.5)).toBeCloseTo(0.5, 9);
    expect(easeBlend(0.01)).toBeLessThan(0.001);
    expect(easeBlend(2)).toBe(1);
  });
});

// A one-leg rig: group > scene > hip > thigh > shin > foot, legs 0.5 + 0.5 m, hanging straight down at rest.
function rig() {
  const group = new THREE.Group();
  const scene = new THREE.Group();
  group.add(scene);
  const hip = new THREE.Object3D();
  hip.name = "mixamorig:Hips";
  hip.position.set(0, 0.95, 0);
  scene.add(hip);
  const thigh = new THREE.Object3D();
  thigh.name = "mixamorig:LeftUpLeg";
  hip.add(thigh);
  const shin = new THREE.Object3D();
  shin.name = "mixamorig:LeftLeg";
  shin.position.set(0, -0.5, 0);
  thigh.add(shin);
  const foot = new THREE.Object3D();
  foot.name = "mixamorig:LeftFoot";
  foot.position.set(0, -0.5, 0);
  shin.add(foot);
  const points: ContactPoint[] = [{ bone: foot, restY: 0 }];
  return { group, scene, hip, thigh, shin, foot, points };
}

/** Pose the leg like a clip would: ankle at `p` in the scene frame (parents here are identity-rotated). */
function poseClip(r: ReturnType<typeof rig>, p: THREE.Vector3): void {
  r.group.updateWorldMatrix(true, true);
  const a = r.thigh.getWorldPosition(new THREE.Vector3());
  const down = V(0, -1, 0);
  const wp = p.clone().applyMatrix4(r.scene.matrixWorld);
  const knee = new THREE.Vector3();
  const ankle = new THREE.Vector3();
  // a rest bend with exact 0.5 m bones (times the figure's display scale), knee forward
  const k = r.scene.getWorldScale(new THREE.Vector3()).x;
  const reach = solveTwoBone(a, V(a.x, a.y - 0.4 * k, a.z + 0.3 * k), V(a.x, a.y - 0.8 * k, a.z), wp, V(0, 0, 1), knee, ankle);
  expect(reach).toBeLessThan(1);
  const qT = new THREE.Quaternion().setFromUnitVectors(down, knee.clone().sub(a).normalize());
  // the thigh's parents are identity-rotated except the group, which may be turned (the body yawing on the spot)
  r.thigh.quaternion.copy(r.group.getWorldQuaternion(new THREE.Quaternion()).invert().multiply(qT));
  const qS = new THREE.Quaternion().setFromUnitVectors(down, ankle.clone().sub(knee).normalize());
  r.shin.quaternion.copy(qT.clone().invert().multiply(qS));
  // the clip's foot is level and faces where the body faces: its world yaw follows the group's
  r.foot.quaternion.copy(qS.clone().invert().multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 1, 0), r.group.rotation.y)));
  r.group.updateWorldMatrix(true, true);
}

describe("FootLock", () => {
  const dt = 1 / 60;
  const V_BODY = 1.3;

  function run(opts: { vClip: number; footY: number; lock: boolean; speed?: number; frames?: number; z0?: number; scale?: number; drop?: number }) {
    const r = rig();
    r.scene.scale.setScalar(opts.scale ?? 1);
    const lock = new FootLock(r.scene, r.points);
    const zs: number[] = [];
    const ys: number[] = [];
    const frames = opts.frames ?? 16;
    for (let i = 0; i < frames; i++) {
      r.group.position.z = V_BODY * dt * i;
      // scene-frame ankle: moves back relative to the body at the clip's own stance speed
      poseClip(r, V(0, opts.footY, (opts.z0 ?? 0.2) - opts.vClip * dt * i));
      if (opts.lock) lock.update(r.group, r.scene, opts.speed ?? V_BODY, dt, opts.drop ?? 0);
      r.group.updateWorldMatrix(true, true);
      const w = r.foot.getWorldPosition(new THREE.Vector3());
      zs.push(w.z);
      ys.push(w.y);
    }
    return { r, lock, zs, ys };
  }
  const span = (a: number[], from: number) => Math.max(...a.slice(from)) - Math.min(...a.slice(from));

  it("finds the leg chain and its contact joints", () => {
    const r = rig();
    const legs = findLegs(r.scene, r.points);
    expect(legs).toHaveLength(1);
    expect(legs[0].landmarks).toHaveLength(1);
  });

  it("pins a planted foot that the clip lets creep over the ground", () => {
    // clip foot goes back at 1.0 m/s under a body doing 1.3: world drift 0.3 m/s without the lock
    const free = run({ vClip: 1.0, footY: 0.005, lock: false });
    const locked = run({ vClip: 1.0, footY: 0.005, lock: true });
    expect(span(free.zs, 4)).toBeGreaterThan(0.04);
    expect(span(locked.zs, 4)).toBeLessThan(0.004);
    expect(locked.lock.active).toBe(1);
  });

  it("works the same on a figure shown at a display scale (bodies.ts): drop is world metres, clearance is the figure's own", () => {
    const K = 1.3;
    // scene-local ankle 4.5 cm up, grounding lowers the figure by 3 cm of ITS height (3.9 cm world): 1.5 cm clear = swing.
    // Read in mixed units (4.5 - 3.9) it was 0.6 cm: a false plant.
    const swing = run({ vClip: 1.0 * K, footY: 0.045, lock: true, scale: K, drop: 0.03 * K, speed: V_BODY });
    expect(swing.lock.active).toBe(0);
    // A truly planted foot on the scaled figure pins as well as on the unscaled one (clip stance 0.75 local = 0.975 m/s world
    // under a 1.3 m/s body: 0.33 m/s of skate without the lock).
    const free = run({ vClip: 0.75, footY: 0.005, lock: false, scale: K });
    const locked = run({ vClip: 0.75, footY: 0.005, lock: true, scale: K });
    expect(span(free.zs, 4)).toBeGreaterThan(0.04);
    expect(span(locked.zs, 4)).toBeLessThan(0.004 * K);
    expect(locked.lock.active).toBe(1);
  });

  it("changes only the horizontal: the ankle keeps the clip's height and the bones keep their lengths", () => {
    const locked = run({ vClip: 1.0, footY: 0.005, lock: true });
    for (const y of locked.ys) expect(y).toBeCloseTo(0.005, 4);
    const a = locked.r.thigh.getWorldPosition(new THREE.Vector3());
    const b = locked.r.shin.getWorldPosition(new THREE.Vector3());
    const c = locked.r.foot.getWorldPosition(new THREE.Vector3());
    expect(a.distanceTo(b)).toBeCloseTo(0.5, 6);
    expect(b.distanceTo(c)).toBeCloseTo(0.5, 6);
  });

  it("keeps the clip's foot orientation", () => {
    const locked = run({ vClip: 1.0, footY: 0.005, lock: true });
    const free = run({ vClip: 1.0, footY: 0.005, lock: false });
    const q = locked.r.foot.getWorldQuaternion(new THREE.Quaternion());
    const q0 = free.r.foot.getWorldQuaternion(new THREE.Quaternion());
    expect(q.angleTo(q0)).toBeLessThan(1e-5);
  });

  it("leaves a foot in swing alone", () => {
    const swing = run({ vClip: -0.6, footY: 0.12, lock: true }); // high and moving forward
    const free = run({ vClip: -0.6, footY: 0.12, lock: false });
    expect(swing.lock.active).toBe(0);
    swing.zs.forEach((z, i) => expect(z).toBeCloseTo(free.zs[i], 6));
  });

  it("lets go once the lock would overstretch the leg, and does not re-lock the same stance at once", () => {
    // a long stance: the locked point ends up so far behind the hip that no pelvis dip within MAX_DIP reaches it
    const long = run({ vClip: 1.0, footY: 0.005, lock: true, frames: 30 });
    const lm = long.lock.legs[0].landmarks[0];
    expect(lm.pinned).toBe(false);
    expect(lm.armed).toBe(false);
  });

  it("blends the correction in over BLEND_S, not in one frame", () => {
    const r = rig();
    const lock = new FootLock(r.scene, r.points);
    let firstActive = -1;
    for (let i = 0; i < 12; i++) {
      r.group.position.z = V_BODY * dt * i;
      poseClip(r, V(0, 0.005, 0.2 - 1.0 * dt * i));
      lock.update(r.group, r.scene, V_BODY, dt);
      if (firstActive < 0 && lock.active > 0) firstActive = i;
    }
    expect(firstActive).toBeGreaterThan(0); // needs one frame of history
    expect(lock.legs[0].w).toBeCloseTo(1, 6); // full weight after ~BLEND_S
    expect(BLEND_S).toBeLessThan(0.15);
  });

  it("keeps a swinging foot off the floor (SWING_CLEARANCE) without pinning it", () => {
    // the foot grazes the floor at 2 mm while swinging forward fast: the baked toes do this mid-swing
    const swing = run({ vClip: -3, footY: 0.002, lock: true, frames: 10, z0: -0.2 });
    expect(swing.lock.legs[0].landmarks[0].pinned).toBe(false);
    expect(swing.ys[swing.ys.length - 1]).toBeGreaterThan(SWING_CLEARANCE - 0.004);
    const free = run({ vClip: -3, footY: 0.002, lock: false, frames: 10, z0: -0.2 });
    swing.zs.forEach((z, i) => expect(z).toBeCloseTo(free.zs[i], 4)); // lifted, not dragged back
  });

  it("dips the pelvis to give a locked straight leg the slack it needs, never past MAX_DIP", () => {
    const locked = run({ vClip: 1.0, footY: 0.005, lock: true, frames: 24 });
    expect(locked.lock.dip).toBeGreaterThanOrEqual(0);
    expect(locked.lock.dip).toBeLessThanOrEqual(MAX_DIP + 1e-9);
    // the leg never ends longer than MAX_REACH of full extension while pinned
    const a = locked.r.thigh.getWorldPosition(new THREE.Vector3());
    const c = locked.r.foot.getWorldPosition(new THREE.Vector3());
    if (locked.lock.legs[0].landmarks[0].pinned) expect(a.distanceTo(c)).toBeLessThanOrEqual(1.0 * 0.999 + 1e-6);
  });

  describe("standing hold", () => {
    /** The body stands (speed 0) while the clip's foot sways and the group yaws; returns world ankle z/x and foot orientation per frame. */
    function stand(opts: { lock: boolean; frames: number; sway?: number; yaw?: (i: number) => number }) {
      const r = rig();
      const lock = new FootLock(r.scene, r.points);
      const xs: number[] = [];
      const zs: number[] = [];
      const qs: THREE.Quaternion[] = [];
      for (let i = 0; i < opts.frames; i++) {
        r.group.rotation.y = opts.yaw ? opts.yaw(i) : 0;
        const sw = (opts.sway ?? 0) * Math.sin(i * 0.3);
        poseClip(r, V(0.1 + sw, 0.005, 0.1 + sw));
        if (opts.lock) lock.update(r.group, r.scene, 0, dt);
        r.group.updateWorldMatrix(true, true);
        const w = r.foot.getWorldPosition(new THREE.Vector3());
        xs.push(w.x);
        zs.push(w.z);
        qs.push(r.foot.getWorldQuaternion(new THREE.Quaternion()));
      }
      return { r, lock, xs, zs, qs };
    }

    it("holds a standing foot still against the idle clip's sway", () => {
      const free = stand({ lock: false, frames: 70, sway: 0.012 });
      const held = stand({ lock: true, frames: 70, sway: 0.012 });
      expect(span(free.xs, 8)).toBeGreaterThan(0.015);
      expect(span(held.xs, 8)).toBeLessThan(0.0015);
      expect(span(held.zs, 8)).toBeLessThan(0.0015);
    });

    it("keeps the foot where it is, position and heading, while the body turns on the spot", () => {
      const yaw = (i: number) => Math.min(i, 30) * 0.01; // 0 -> 0.3 rad, inside STEP_YAW (no step yet)
      const free = stand({ lock: false, frames: 50, yaw });
      const held = stand({ lock: true, frames: 50, yaw });
      expect(span(free.xs, 8)).toBeGreaterThan(0.012); // the foot swings round the body
      expect(span(held.xs, 8)).toBeLessThan(0.003);
      expect(span(held.zs, 8)).toBeLessThan(0.003);
      expect(held.qs[49].angleTo(held.qs[8])).toBeLessThan(0.02); // not turned with it
    });

    it("does not drag the foot along when the body is teleported while standing", () => {
      const r = rig();
      const lock = new FootLock(r.scene, r.points);
      for (let i = 0; i < 60; i++) {
        r.group.position.x = i < 30 ? 0 : 4; // jump 4 m sideways at frame 30
        poseClip(r, V(0.1, 0.005, 0.1));
        lock.update(r.group, r.scene, 0, dt);
      }
      r.group.updateWorldMatrix(true, true);
      const ankle = r.foot.getWorldPosition(new THREE.Vector3());
      expect(Math.abs(ankle.x - 4.1)).toBeLessThan(0.05); // under the body again, not left behind at x=0.1
    });

    it("steps the foot round once the body has turned past STEP_YAW: lifted while it moves, aligned with the clip after", () => {
      const yaw = (i: number) => Math.min(i, 50) * 0.02; // 0 -> 1.0 rad, then still
      const free = stand({ lock: false, frames: 120, yaw });
      const r = rig();
      const lock = new FootLock(r.scene, r.points);
      let slidOnFloor = 0;
      let maxY = -Infinity;
      let prev: THREE.Vector3 | null = null;
      const qs: THREE.Quaternion[] = [];
      for (let i = 0; i < 120; i++) {
        r.group.rotation.y = yaw(i);
        poseClip(r, V(0.1, 0.005, 0.1));
        lock.update(r.group, r.scene, 0, dt);
        r.group.updateWorldMatrix(true, true);
        const w = r.foot.getWorldPosition(new THREE.Vector3());
        if (i > 8 && prev && Math.hypot(w.x - prev.x, w.z - prev.z) > 0.001 && w.y < 0.015) slidOnFloor++;
        maxY = Math.max(maxY, w.y);
        prev = w;
        qs.push(r.foot.getWorldQuaternion(new THREE.Quaternion()));
      }
      expect(maxY).toBeGreaterThan(0.03); // it stepped (lift arc), it did not pivot on the floor
      expect(maxY).toBeLessThan(0.005 + STEP_LIFT + 0.01);
      expect(slidOnFloor).toBeLessThan(4); // horizontal motion happens in the air
      expect(qs[119].angleTo(free.qs[119])).toBeLessThan(STEP_YAW + 0.02); // ends near the clip's heading
    });
  });

  it("reset forgets the plant", () => {
    const locked = run({ vClip: 1.0, footY: 0.005, lock: true });
    locked.lock.reset();
    expect(locked.lock.legs[0].landmarks[0].pinned).toBe(false);
    expect(locked.lock.legs[0].w).toBe(0);
  });
});

describe("foot plants (sound v1 hook)", () => {
  const dt = 1 / 60;
  // The pin cadence proven above: body at 1.3 m/s, clip ankle sweeping
  // back at 1.0 m/s, 5 mm over the ground.
  function walk(lock: FootLock, r: ReturnType<typeof rig>, frames: number, speed = 1.3): void {
    for (let i = 0; i < frames; i++) {
      r.group.position.z = 1.3 * dt * i;
      poseClip(r, V(0, 0.005, 0.2 - 1.0 * dt * i));
      lock.update(r.group, r.scene, speed, dt);
    }
  }

  it("emits a plant at the pin, at the foot's world spot", () => {
    const plants: Array<{ x: number; z: number }> = [];
    setPlantSink((x, z) => plants.push({ x, z }));
    try {
      const r = rig();
      walk(new FootLock(r.scene, r.points), r, 24);
    } finally {
      setPlantSink(null);
    }
    expect(plants.length).toBeGreaterThanOrEqual(1);
    for (const p of plants) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.z)).toBe(true);
      expect(Math.abs(p.x)).toBeLessThan(0.05); // the rig's leg is on x=0
      expect(p.z).toBeGreaterThan(-0.2);
      expect(p.z).toBeLessThan(0.8);
    }
  });

  it("a standing foot engages exactly once (main's hold pin), and nothing fires once the sink is cleared", () => {
    // On current main a standing foot pins too (the turn-stepping
    // hold): the engagement is a single plant at the foot's spot,
    // not a repeating one while it stays held.
    const plants: Array<{ x: number; z: number }> = [];
    setPlantSink((x, z) => plants.push({ x, z }));
    const slow = rig();
    walk(new FootLock(slow.scene, slow.points), slow, 24, MIN_LOCK_SPEED - 0.05);
    expect(plants).toHaveLength(1);
    expect(plants[0].z).toBeCloseTo(0.205, 1);
    setPlantSink(null);
    const r = rig();
    walk(new FootLock(r.scene, r.points), r, 24);
    expect(plants).toHaveLength(1);
  });
});
