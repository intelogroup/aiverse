// @vitest-environment node
import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { pinRootMotion } from "./clipUtils";

function hipsClip(): THREE.AnimationClip {
  // 1 s loop, 5 keys: hips travel +10 on X and -4 on Z while bobbing on Y.
  const times = new Float32Array([0, 0.25, 0.5, 0.75, 1]);
  const values = new Float32Array([
    0, 1.0, 0,
    2.5, 1.1, -1,
    5, 0.9, -2,
    7.5, 1.1, -3,
    10, 1.0, -4,
  ]);
  const hips = new THREE.VectorKeyframeTrack("mixamorig:Hips.position", times, values);
  const arm = new THREE.VectorKeyframeTrack(
    "mixamorig:LeftArm.position",
    times,
    new Float32Array(15).fill(7),
  );
  return new THREE.AnimationClip("Walk", 1, [hips, arm]);
}

describe("pinRootMotion", () => {
  it("removes net travel so the loop ends where it started, keeping the bounce", () => {
    const clip = pinRootMotion(hipsClip());
    const track = clip.tracks[0] as THREE.VectorKeyframeTrack;
    const v = track.values;
    // Endpoints now identical on every component (loop-clean).
    expect(v[0]).toBeCloseTo(v[12]);
    expect(v[1]).toBeCloseTo(v[13]);
    expect(v[2]).toBeCloseTo(v[14]);
    // Mid-key: travel ramp removed (5 - 10*0.5 = 0 on X), bob untouched
    // (Y had first == last, so no ramp was subtracted there).
    expect(v[6]).toBeCloseTo(0);
    expect(v[7]).toBeCloseTo(0.9);
    expect(v[8]).toBeCloseTo(0);
  });

  it("leaves non-hips tracks and already-in-place clips untouched", () => {
    const clip = pinRootMotion(hipsClip());
    const arm = clip.tracks[1] as THREE.VectorKeyframeTrack;
    expect(Array.from(arm.values)).toEqual(new Array(15).fill(7));

    const still = new THREE.AnimationClip("Idle", 1, [
      new THREE.VectorKeyframeTrack(
        "mixamorig:Hips.position",
        new Float32Array([0, 1]),
        new Float32Array([0, 1, 0, 0, 1, 0]),
      ),
    ]);
    const before = Array.from((still.tracks[0] as THREE.VectorKeyframeTrack).values);
    pinRootMotion(still);
    expect(Array.from((still.tracks[0] as THREE.VectorKeyframeTrack).values)).toEqual(before);
  });

  it("returns clips without a hips position track unchanged", () => {
    const clip = new THREE.AnimationClip("Wave", 1, [
      new THREE.QuaternionKeyframeTrack(
        "mixamorig:Head.quaternion",
        new Float32Array([0, 1]),
        new Float32Array([0, 0, 0, 1, 0, 0, 0, 1]),
      ),
    ]);
    expect(pinRootMotion(clip)).toBe(clip);
    expect(clip.tracks).toHaveLength(1);
  });
});
