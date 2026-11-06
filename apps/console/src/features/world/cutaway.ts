// cutaway.ts — pure clip-box maths for opening one building at a time (three-free, DOM-free).
//
// Every room building's upper floors and roof live in the merged city meshes, so there is nothing per
// building to hide. Instead the console gives the city materials six clipping planes with
// clipIntersection = true: a fragment is discarded only when it lies inside ALL planes, i.e. inside
// the box. Planes use outward normals (positive side = outside the box). One box means one open
// building; moving it only updates uniforms, so it never recompiles a shader.

export type PlaneSpec = [nx: number, ny: number, nz: number, constant: number];

export interface CutBox {
  /** [minX, minZ, maxX, maxZ] in three.js space. */
  rect: [number, number, number, number];
  /** Cut everything above this height (m): the ground-floor ceiling. */
  y: number;
}

/** Height of the box above `y`; anything taller than the tallest building will do. */
export const CUT_HEIGHT = 80;

/** Six outward-facing planes bounding the box. A point is inside the box iff n·p + c < 0 for all six. */
export function boxPlanes(box: CutBox): PlaneSpec[] {
  const [x0, z0, x1, z1] = box.rect;
  return [
    [1, 0, 0, -x1],
    [-1, 0, 0, x0],
    [0, 0, 1, -z1],
    [0, 0, -1, z0],
    [0, -1, 0, box.y],
    [0, 1, 0, -(box.y + CUT_HEIGHT)],
  ];
}

/** Planes that clip nothing: the top plane's positive side covers all of space. */
export function inactivePlanes(): PlaneSpec[] {
  return [
    [1, 0, 0, 0],
    [-1, 0, 0, 0],
    [0, 0, 1, 0],
    [0, 0, -1, 0],
    [0, -1, 0, 0],
    [0, 1, 0, 1e6],
  ];
}

/** What the GPU does with clipIntersection: clipped only when negative against every plane. */
export function isClipped(p: { x: number; y: number; z: number }, planes: readonly PlaneSpec[]): boolean {
  return planes.every(([nx, ny, nz, c]) => nx * p.x + ny * p.y + nz * p.z + c < 0);
}

export interface CutRoom {
  id: string;
  center: [number, number];
  /** [minX, minZ, maxX, maxZ] of the building footprint. */
  rect: [number, number, number, number];
  cut: CutBox;
}

const inRect = (r: CutRoom["rect"], x: number, z: number, slack: number): boolean =>
  x >= r[0] - slack && x <= r[2] + slack && z >= r[1] - slack && z <= r[3] + slack;

/**
 * Which room (if any) should be open. An orbit camera looks at a target on the ground, and the
 * building being inspected is the one under it: the room whose footprint holds the target (or, off
 * any footprint, the nearest centre within 14 m). It opens once the camera is within `hideWithin`
 * of the target. The open room stays open while the target remains on/near its footprint and the
 * camera is within `showBeyond`, so panning across a building edge or hovering at the zoom edge
 * doesn't flicker.
 */
export function pickCutRoom(
  rooms: readonly CutRoom[],
  target: { x: number; z: number },
  camDist: number,
  current: string | null,
  hideWithin: number,
  showBeyond: number,
): string | null {
  const cur = current ? rooms.find((r) => r.id === current) : undefined;
  if (cur && camDist <= showBeyond && inRect(cur.rect, target.x, target.z, 6)) return cur.id;
  if (camDist >= hideWithin) return null;
  const d = (r: CutRoom) => Math.hypot(target.x - r.center[0], target.z - r.center[1]);
  const under = rooms.filter((r) => inRect(r.rect, target.x, target.z, 1));
  const pool = under.length ? under : rooms.filter((r) => d(r) < 14);
  let best: CutRoom | null = null;
  for (const r of pool) if (!best || d(r) < d(best) || (d(r) === d(best) && r.id < best.id)) best = r;
  return best ? best.id : null;
}
