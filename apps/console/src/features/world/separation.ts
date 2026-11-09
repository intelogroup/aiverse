// separation.ts — body collision + separation ("eviction") for walking
// bodies in City 3.
//
// The problem (Jim, 2026-11-08): bots walked straight through each other.
// walker.ts collides a body against the static world only; nothing kept
// two bodies apart. DetourCrowd handles this for locomotion.ts's platform
// crowds, but the city walkers (Scout, residents, future verse bots) move
// through walker.ts and had no body-vs-body layer at all.
//
// Model: each body is a circle of AGENT_RADIUS (0.35 m — the same constant
// the navmesh bake erodes by, so a separated body still fits everywhere
// the navmesh says it fits) in the XZ plane, same-floor only (|dy| < 1 m;
// bodies on different storeys never interact). Three layers:
//
//   (a) STEERING — avoidVelocity(): velocity-level prediction. Bodies
//       deflect laterally before they touch, so most encounters never
//       reach the solver. (DetourCrowd's separation steering is the
//       equivalent for locomotion.ts crowds.)
//   (b) SOLVER — separateBodies(): a hard positional pass after movement
//       integration. Spatial-hash neighbour pairs, overlaps resolved by
//       pushing both bodies apart along the axis, split by inverse mass.
//       A body in a claim/interact pose is ANCHORED (infinite mass): it
//       does not move, the other body slides around it. Resident NPCs
//       (Mira on her patio) are anchored the same way. The per-call push
//       is capped so nothing visibly pops; 2 relaxation iterations.
//   (c) CLAMP — after separation the caller clamps every moved body back
//       onto the navmesh (cityNav.slideAlong), so a push can never shove
//       a body through a wall or off walkable space. separateBodies takes
//       the clamp as a callback to stay navmesh-agnostic and testable.
//
// Determinism: bodies are processed in id order and pairs in sorted
// order, so a replayed sim reproduces exactly. Pure and three-free.

export interface BodyDisc {
  id: string;
  x: number;
  y: number;
  z: number;
  /** Horizontal velocity, m/s (steering layer input; solver ignores it). */
  vx: number;
  vz: number;
  /** Anchored bodies never move (claim/interact pose, resident NPCs). */
  anchored?: boolean;
}

export interface SeparationOptions {
  radius?: number;
  /** Bodies interact only when |dy| is below this (same floor). */
  floorBand?: number;
  /** Max metres one body may be pushed in a single call (anti-pop). */
  maxPush?: number;
  iterations?: number;
}

export interface SeparationResult {
  /** Deepest pairwise overlap (2r - dist, clamped at 0) before the pass. */
  maxPenetrationBefore: number;
  /** Deepest pairwise overlap after the pass (and after the clamp). */
  maxPenetrationAfter: number;
  /** Pairs that overlapped at any point during the pass. */
  pairsResolved: number;
  /** Bodies whose position changed (before clamping). */
  movedBodies: number;
}

export const BODY_RADIUS = 0.35; // == locomotion.AGENT_RADIUS == navmesh erosion radius
const DEFAULTS = { floorBand: 1.0, maxPush: 0.09, iterations: 2 };

/**
 * Positional separation pass. Mutates bodies' x/z in place. `clamp`, when
 * given, runs on every moved body after the iterations (layer (c)) and
 * may rewrite x/y/z (cityNav.slideAlong semantics).
 */
export function separateBodies(
  bodies: BodyDisc[],
  opts: SeparationOptions = {},
  clamp?: (b: BodyDisc) => void,
): SeparationResult {
  const r = opts.radius ?? BODY_RADIUS;
  const floorBand = opts.floorBand ?? DEFAULTS.floorBand;
  const maxPush = opts.maxPush ?? DEFAULTS.maxPush;
  const iterations = opts.iterations ?? DEFAULTS.iterations;
  const minDist = 2 * r;

  const ordered = [...bodies].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const penetration = () => {
    let max = 0;
    for (let i = 0; i < ordered.length; i++) {
      for (let j = i + 1; j < ordered.length; j++) {
        const a = ordered[i];
        const b = ordered[j];
        if (Math.abs(a.y - b.y) >= floorBand) continue;
        const d = Math.hypot(b.x - a.x, b.z - a.z);
        if (minDist - d > max) max = minDist - d;
      }
    }
    return max;
  };

  const before = penetration();
  let pairsResolved = 0;
  const moved = new Set<string>();
  // Cumulative displacement per body across iterations: the anti-pop cap
  // is per CALL, so iteration 2 may only spend what iteration 1 left.
  const spent = new Map<string, { dx: number; dz: number }>();

  for (let iter = 0; iter < iterations; iter++) {
    // Spatial hash over XZ, cell = minDist: only same/neighbour cells pair.
    const cell = minDist;
    const hash = new Map<string, BodyDisc[]>();
    for (const b of ordered) {
      const key = `${Math.floor(b.x / cell)},${Math.floor(b.z / cell)}`;
      const arr = hash.get(key);
      if (arr) arr.push(b);
      else hash.set(key, [b]);
    }
    const disp = new Map<string, { dx: number; dz: number }>();
    const addDisp = (b: BodyDisc, dx: number, dz: number) => {
      const d = disp.get(b.id) ?? { dx: 0, dz: 0 };
      d.dx += dx;
      d.dz += dz;
      disp.set(b.id, d);
    };
    const seen = new Set<string>();
    for (const b of ordered) {
      const cx = Math.floor(b.x / cell);
      const cz = Math.floor(b.z / cell);
      for (let gx = cx - 1; gx <= cx + 1; gx++) {
        for (let gz = cz - 1; gz <= cz + 1; gz++) {
          const arr = hash.get(`${gx},${gz}`);
          if (!arr) continue;
          for (const o of arr) {
            if (o.id <= b.id) continue;
            const pairKey = `${b.id}|${o.id}`;
            if (seen.has(pairKey)) continue;
            seen.add(pairKey);
            if (Math.abs(b.y - o.y) >= floorBand) continue;
            const dx = o.x - b.x;
            const dz = o.z - b.z;
            const d = Math.hypot(dx, dz);
            if (d >= minDist) continue;
            if (iter === 0) pairsResolved++;
            let ux: number;
            let uz: number;
            if (d > 1e-9) {
              ux = dx / d;
              uz = dz / d;
            } else {
              // Exactly concentric: pick a deterministic axis from the ids
              // so the pair separates instead of jittering forever.
              const h = (b.id.charCodeAt(0) * 31 + o.id.charCodeAt(0) * 17) % 360;
              ux = Math.cos((h * Math.PI) / 180);
              uz = Math.sin((h * Math.PI) / 180);
            }
            const push = minDist - d;
            const wb = b.anchored ? 0 : 1;
            const wo = o.anchored ? 0 : 1;
            const wSum = wb + wo;
            if (wSum === 0) continue; // two anchored bodies: nothing may move
            addDisp(b, -ux * push * (wb / wSum), -uz * push * (wb / wSum));
            addDisp(o, ux * push * (wo / wSum), uz * push * (wo / wSum));
          }
        }
      }
    }
    for (const b of ordered) {
      const d = disp.get(b.id);
      if (!d) continue;
      let { dx, dz } = d;
      if (Math.hypot(dx, dz) < 1e-12) continue;
      // Clamp the CUMULATIVE move (previous iterations + this one) to the
      // per-call cap: scale this increment so the total lands on the cap.
      const s = spent.get(b.id) ?? { dx: 0, dz: 0 };
      const tx = s.dx + dx;
      const tz = s.dz + dz;
      const tLen = Math.hypot(tx, tz);
      if (tLen > maxPush) {
        const k = maxPush / tLen;
        dx = tx * k - s.dx;
        dz = tz * k - s.dz;
      }
      if (Math.hypot(dx, dz) < 1e-12) continue;
      b.x += dx;
      b.z += dz;
      s.dx += dx;
      s.dz += dz;
      spent.set(b.id, s);
      moved.add(b.id);
    }
  }

  if (clamp) {
    for (const b of ordered) if (moved.has(b.id)) clamp(b);
  }
  return {
    maxPenetrationBefore: before,
    maxPenetrationAfter: penetration(),
    pairsResolved,
    movedBodies: moved.size,
  };
}

/**
 * Steering layer: deflect a body's desired velocity away from a predicted
 * collision. For each neighbour, compute the time and distance of closest
 * approach over the horizon; if the bodies would pass within the combined
 * diameter, add a lateral deflection (away from the neighbour's side),
 * scaled by urgency. Output speed matches the desired speed (deflection
 * never accelerates the body). Returns the desired velocity unchanged
 * when no encounter is predicted.
 */
export function avoidVelocity(
  self: BodyDisc,
  neighbors: readonly BodyDisc[],
  desired: { vx: number; vz: number },
  opts: { radius?: number; floorBand?: number; horizon?: number } = {},
): { vx: number; vz: number } {
  const r = opts.radius ?? BODY_RADIUS;
  const floorBand = opts.floorBand ?? DEFAULTS.floorBand;
  const horizon = opts.horizon ?? 0.9;
  const speed = Math.hypot(desired.vx, desired.vz);
  if (speed < 1e-6) return desired;
  const hx = desired.vx / speed;
  const hz = desired.vz / speed;
  // Lateral axis (left of heading): (-hz, hx) in XZ.
  let deflect = 0;
  for (const o of neighbors) {
    if (o.id === self.id) continue;
    if (Math.abs(o.y - self.y) >= floorBand) continue;
    const px = o.x - self.x;
    const pz = o.z - self.z;
    const rvx = o.vx - desired.vx;
    const rvz = o.vz - desired.vz;
    const vv = rvx * rvx + rvz * rvz;
    let t = 0;
    if (vv > 1e-9) t = Math.max(0, Math.min(horizon, -(px * rvx + pz * rvz) / vv));
    const cx = px + rvx * t;
    const cz = pz + rvz * t;
    const dMin = Math.hypot(cx, cz);
    const need = 2 * r * 1.05;
    if (dMin >= need) continue;
    // Which side is the neighbour on, relative to our heading?
    const side = Math.sign(cx * -hz + cz * hx) || 1; // +1 = left
    // Urgency: mostly how deep the closest approach cuts into the bubble,
    // with a gentle time falloff — a pair closing to contact just past the
    // horizon must still deflect NOW (a (1 - t/horizon) factor would zero
    // the deflection exactly for the fastest-closing pairs).
    const urgency = (1 - dMin / need) * (1 - 0.5 * (t / horizon));
    deflect += -side * urgency;
  }
  if (deflect === 0) return desired;
  const lat = Math.max(-1, Math.min(1, deflect)) * speed * 0.9;
  let vx = desired.vx + -hz * lat;
  let vz = desired.vz + hx * lat;
  const out = Math.hypot(vx, vz);
  if (out > 1e-9) {
    vx = (vx / out) * speed;
    vz = (vz / out) * speed;
  }
  return { vx, vz };
}
