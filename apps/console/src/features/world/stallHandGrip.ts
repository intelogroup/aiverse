import { Quaternion, QuaternionKeyframeTrack, Vector3, type AnimationClip, type Object3D } from "three";
import { STALL_MOUTH_S, STALL_PICKUP_S, STALL_RETURN_S, stallEase, type StallConsumableId } from "@aiverse/world-sim/stallConsumables";
import { type AppleBody } from "@aiverse/world-sim/movableProps";
import { appleGripOffset } from "./appleGrip";

const DIGITS = ["Thumb", "Index", "Middle", "Ring", "Pinky"] as const;
const CLOSE_LEAD = [0.185, 0.225, 0.24, 0.218, 0.193];
const JOINT_DELAY = [0, 0.034, 0.062];
const PINKY_FLEX = [0.4, 0.65, 0.36];
const FLEX_AXIS = new Vector3(1, 0, 0);
const APPLE_CONTACT_S = 59 / 24;
const BOTTLE_HOLD_S = 3.4;
const IDLE_SAMPLE_S = 1.1;

type Grip = {
  // Metres in the scaled hand's local frame. Curl is thumb to pinky.
  center: [number, number, number];
  curl: [number, number, number, number, number];
  tableReach: [dip: number, lean: number];
};
type Fit = { apple: Grip; bottle: Grip; bottleAxis: Vector3 };

// Sampled against the skinned palm and each digit of the shipped rigs.
// The bottle lies across the palm. Its axis is fixed while the wrist tips it.
const FITS: Partial<Record<AppleBody, Fit>> = {
  eve: {
    apple: { center: [-0.0088, 0.09254, 0.04786], curl: [1, 1, 0.5, 0.2, 0.9], tableReach: [0.10, 0.24] },
    bottle: { center: [-0.0368, 0.10054, 0.05186], curl: [0.7, 1, 0.5, 0, 0.6], tableReach: [0.075, 0.19] },
    bottleAxis: new Vector3(0.92, -0.31, -0.20).normalize(),
  },
  cipher: {
    apple: { center: [-0.0008, 0.12454, 0.04786], curl: [0.2, 1, 0, 0, 1], tableReach: [0.075, 0.195] },
    bottle: { center: [0.0032, 0.12454, 0.05586], curl: [1, 1, 0.5, 0, 0.5], tableReach: [0.04, 0.16] },
    bottleAxis: new Vector3(0.80, -0.56, -0.22).normalize(),
  },
  remy: {
    apple: { center: [0.0032, 0.12454, 0.04786], curl: [0.4, 1, 0.6, 0.6, 1], tableReach: [0.10, 0.22] },
    bottle: { center: [0.0192, 0.14454, 0.05986], curl: [1, 0.6, 0.2, 0, 0.8], tableReach: [0.065, 0.17] },
    bottleAxis: new Vector3(0.80, -0.56, -0.22).normalize(),
  },
};

export function stallGripOffset(id: StallConsumableId, body: AppleBody, handScale: number, out: Vector3): Vector3 {
  const fit = FITS[body];
  return fit
    ? out.set(...(id === "stall-apple" ? fit.apple : fit.bottle).center).divideScalar(handScale)
    : appleGripOffset(body, handScale, out);
}

export const stallTableReach = (id: StallConsumableId, body: AppleBody) =>
  FITS[body]?.[id === "stall-apple" ? "apple" : "bottle"].tableReach;

export const stallBottleAxis = (body: AppleBody) => FITS[body]?.bottleAxis;

export function stallFingerWeight(id: StallConsumableId, elapsed: number, digit: number, joint: number): number {
  const begin = STALL_PICKUP_S - CLOSE_LEAD[digit] + JOINT_DELAY[joint];
  const close = stallEase((elapsed - begin) / (STALL_PICKUP_S - begin));
  const release = (id === "stall-apple" ? STALL_MOUTH_S + 0.05 : STALL_RETURN_S)
    + (2 - joint) * 0.022 + digit * 0.007;
  return close * (1 - stallEase((elapsed - release) / 0.2));
}

function sampleRotation(clip: AnimationClip | undefined, name: string, time: number) {
  const track = clip?.tracks.find((track) => track.name === `${name}.quaternion`);
  return track instanceof QuaternionKeyframeTrack
    ? new Quaternion().fromArray(track.createInterpolant().evaluate(time)).normalize()
    : null;
}

export function makeStallHandGrip(scene: Object3D, animations: readonly AnimationClip[], body: AppleBody, idleName: string) {
  const fit = FITS[body];
  if (!fit) return null;
  const pickup = animations.find((animation) => animation.name === "PickUp");
  const idle = animations.find((animation) => animation.name === idleName);
  const fingers = DIGITS.flatMap((name, digit) => JOINT_DELAY.flatMap((_, joint) => {
    const boneName = `mixamorigRightHand${name}${joint + 1}`;
    const bone = scene.getObjectByName(boneName);
    const resting = sampleRotation(idle, boneName, IDLE_SAMPLE_S);
    const apple = sampleRotation(pickup, boneName, APPLE_CONTACT_S);
    const bottle = sampleRotation(pickup, boneName, BOTTLE_HOLD_S);
    if (!bone || !resting || !apple || !bottle) return [];
    if (name === "Pinky") {
      const flex = new Quaternion().setFromAxisAngle(FLEX_AXIS, PINKY_FLEX[joint]);
      apple.multiply(flex);
      bottle.multiply(flex);
    }
    return [{
      bone, digit, joint,
      apple: resting.clone().slerp(apple, fit.apple.curl[digit]),
      bottle: resting.slerp(bottle, fit.bottle.curl[digit]),
    }];
  }));
  if (fingers.length !== DIGITS.length * JOINT_DELAY.length) return null;
  return (id: StallConsumableId, elapsed: number): void => {
    for (const { bone, digit, joint, apple, bottle } of fingers) {
      bone.quaternion.slerp(id === "stall-apple" ? apple : bottle, stallFingerWeight(id, elapsed, digit, joint));
    }
  };
}
