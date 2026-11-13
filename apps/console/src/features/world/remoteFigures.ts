// remoteFigures — which streamed (server-driven) figures are standing where, so a first-person capture can leave out the one that is
// the camera's own body. The look service's page streams every server body (so photos show OTHER agents), and the agent's own server
// body is among them, drawn at the eye: its helmet/hair filled the frame. A first-person camera never sees its own body.
//
// Pure: no React, no GL. RemoteCast registers each figure's outer group plus a way to read its current x/z; ScoutAgent asks for the
// figures near the eye and hides them for the capture pass only.
import type * as THREE from "three";

export interface RemoteFigureRef {
  /** The figure's outer group: visible=false hides the figure and its speech bubble. */
  group: THREE.Object3D;
  /** Current world [x, z] (the interpolated stream frame), or undefined before the first frame. */
  at: () => readonly [number, number] | undefined;
}

/** The eye is the stand-in's pose (within ~0.4 m of the true body, apply_pose's arrival radius) pushed EYE_FORWARD ahead; this is that plus margin. */
export const SELF_HIDE_RADIUS_M = 0.9;

const figures = new Map<number, RemoteFigureRef>();

export function registerRemoteFigure(n: number, ref: RemoteFigureRef): void { figures.set(n, ref); }
export function unregisterRemoteFigure(n: number): void { figures.delete(n); }

/** Streamed figures whose horizontal distance to (x, z) is within `r`: the camera's own body, plus anything standing in its face. */
export function remoteFiguresNear(x: number, z: number, r = SELF_HIDE_RADIUS_M): THREE.Object3D[] {
  const out: THREE.Object3D[] = [];
  for (const f of figures.values()) {
    const p = f.at();
    if (p && Math.hypot(p[0] - x, p[1] - z) <= r) out.push(f.group);
  }
  return out;
}
