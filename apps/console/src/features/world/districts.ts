/**
 * District world (City 3 + modern districts): pure planning + theme maths, no three.js here so it is unit-testable.
 * Coordinates are three.js XZ metres. A district is a square island of half-size `half` centred on `center`.
 * Manifest: apps/console/public/assets/districts.json (maintained as data; the per-district GLBs are
 * built by the tools/city3 per-district scripts, and the far shell by tools/city3/build_shell.py).
 */
export type Theme = {
  skyTop: [number, number, number];
  skyHorizon: [number, number, number];
  fog: [number, number, number];
  fogDensity: number;
  water: [number, number, number];
  sun: [number, number, number];
  sunIntensity: number;
  sunDir: [number, number, number]; // direction TO the sun (unit-ish)
  ambient: number;
  envIntensity: number;
  exposure: number;
  night: number; // 0..1: scales emissive windows / signs / LEDs
};
export type DistrictDef = {
  id: string;
  name: string;
  url: string;
  center: [number, number];
  half: number;
  theme: string;
  resident?: boolean; // always loaded (the Bazaar)
  /** Walker collision GLB (closed solids, `col_*`), same frame as `url`; loaded and dropped with the district. Never rendered. */
  collisionUrl?: string;
};
export type DistrictManifest = { districts: DistrictDef[]; themes: Record<string, Theme>; links?: string; shell?: string };

/**
 * Streaming policy (Jim, 2026-11-08): spawn loads ONLY the resident district;
 * neighbours stream in as the focus approaches and evict after it leaves.
 * The old radii (load 330 / keep 520, cap 4) defeated that: every neighbour
 * island is exactly 220 m from the Bazaar centre, so all four loaded at
 * spawn and never evicted. The far shell (manifest `shell`) covers the
 * distance view, so detail only needs to exist near the focus.
 */
export const LOAD_RADIUS = 90; // m from the focus (or its lookahead) to a district's edge: load
export const KEEP_RADIUS = 300; // beyond this: eligible to evict (hysteresis), after the grace below
export const MAX_STREAMED = 3; // streamed districts resident at once (plus the resident Bazaar)
export const EVICT_GRACE_MS = 20_000; // a district must stay beyond KEEP_RADIUS this long before eviction

/** Distance from (x,z) to the district square (0 inside). */
export function rectDistance(x: number, z: number, d: DistrictDef): number {
  const dx = Math.max(Math.abs(x - d.center[0]) - d.half, 0);
  const dz = Math.max(Math.abs(z - d.center[1]) - d.half, 0);
  return Math.hypot(dx, dz);
}

/**
 * Which districts to load/unload for a focus point. Residents are never touched; nearest first; capped.
 * `ahead` is an optional lookahead point (focus + velocity): it can only ADD loads (prefetch where the
 * focus is heading), never keeps — keep/unload are judged from the true focus alone.
 */
export function planDistricts(
  focus: [number, number],
  defs: DistrictDef[],
  loaded: ReadonlySet<string>,
  opts: { loadR?: number; keepR?: number; cap?: number; ahead?: [number, number] } = {},
): { load: string[]; unload: string[] } {
  const loadR = opts.loadR ?? LOAD_RADIUS;
  const keepR = opts.keepR ?? KEEP_RADIUS;
  const cap = opts.cap ?? MAX_STREAMED;
  const loadDist = (d: DistrictDef) => {
    const here = rectDistance(focus[0], focus[1], d);
    return opts.ahead ? Math.min(here, rectDistance(opts.ahead[0], opts.ahead[1], d)) : here;
  };
  const ds = defs
    .filter((d) => !d.resident)
    .map((d) => ({ d, dist: rectDistance(focus[0], focus[1], d), ldist: loadDist(d) }))
    .sort((a, b) => a.ldist - b.ldist);
  const keep = new Set<string>();
  for (const { d, dist } of ds) if (loaded.has(d.id) && dist <= keepR) keep.add(d.id);
  const load: string[] = [];
  for (const { d, ldist } of ds) {
    if (keep.has(d.id) || ldist > loadR) continue;
    if (keep.size + load.length >= cap) break;
    load.push(d.id);
  }
  const unload = [...loaded].filter((id) => defs.some((d) => d.id === id && !d.resident) && !keep.has(id));
  return { load, unload };
}

/**
 * Eviction grace: of the districts the plan wants unloaded, only those whose
 * "beyond keep radius" stamp (`since`, maintained by the caller) is at least
 * `graceMs` old are due. A district oscillating across the keep boundary
 * keeps resetting its stamp, so border movement never thrashes loads.
 */
export function dueEvictions(unload: readonly string[], since: ReadonlyMap<string, number>, now: number, graceMs: number = EVICT_GRACE_MS): string[] {
  return unload.filter((id) => {
    const t = since.get(id);
    return t !== undefined && now - t >= graceMs;
  });
}

/**
 * Is a district's far-shell group covered by real geometry? Covered when the
 * district's detail is in the streamed `loaded` set, OR when it is the
 * resident district and the resident has mounted (`residentReady`). The
 * resident never enters the streamed set — it loads via useGLTF — so a rule
 * keyed on the streamed set alone leaves the resident's shell group visible
 * forever, carpeting the Bazaar's plaza with massing boxes (found by the
 * Phase 3 screenshot proof, 2026-11-09).
 */
export function isShellCovered(id: string, loaded: ReadonlySet<string>, residentId: string | undefined, residentReady: boolean): boolean {
  return loaded.has(id) || (residentReady && residentId !== undefined && id === residentId);
}

/** Collision GLB to fetch for each district id in `ids` (those without a `collisionUrl` are simply absent). */
export function collisionJobs(ids: readonly string[], defs: readonly DistrictDef[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const id of ids) {
    const d = defs.find((x) => x.id === id);
    if (d?.collisionUrl) out.set(id, d.collisionUrl);
  }
  return out;
}

/** Resident (Bazaar) collision GLB: the manifest's, else this default. */
export const RESIDENT_COLLISION_URL = "/assets/world-city3-collision.glb";
export function residentCollisionUrl(defs: readonly DistrictDef[]): string {
  return defs.find((d) => d.resident)?.collisionUrl ?? RESIDENT_COLLISION_URL;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
function mix3(a: [number, number, number], b: [number, number, number], t: number): [number, number, number] {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}
export function mixTheme(a: Theme, b: Theme, t: number): Theme {
  const f = (x: number, y: number) => x + (y - x) * t;
  return {
    skyTop: mix3(a.skyTop, b.skyTop, t), skyHorizon: mix3(a.skyHorizon, b.skyHorizon, t), fog: mix3(a.fog, b.fog, t),
    fogDensity: f(a.fogDensity, b.fogDensity), water: mix3(a.water, b.water, t), sun: mix3(a.sun, b.sun, t),
    sunIntensity: f(a.sunIntensity, b.sunIntensity), sunDir: mix3(a.sunDir, b.sunDir, t), ambient: f(a.ambient, b.ambient),
    envIntensity: f(a.envIntensity, b.envIntensity), exposure: f(a.exposure, b.exposure), night: f(a.night, b.night),
  };
}
/**
 * Theme at a focus point: every district contributes with weight smoothstep(1 - d/fade) where d is the distance to its
 * square, so the hue changes gradually over `fade` metres around each island; ties resolved by normalising weights.
 */
export function blendTheme(focus: [number, number], m: DistrictManifest, fade = 140): Theme {
  const parts = m.districts
    .map((d) => ({ w: smooth(Math.max(0, 1 - rectDistance(focus[0], focus[1], d) / fade)), t: m.themes[d.theme] }))
    .filter((p) => p.t && p.w > 0);
  if (!parts.length) {
    const nearest = [...m.districts].sort((a, b) => rectDistance(focus[0], focus[1], a) - rectDistance(focus[0], focus[1], b))[0];
    return m.themes[nearest.theme];
  }
  let acc = parts[0].t;
  let wsum = parts[0].w;
  for (let i = 1; i < parts.length; i++) {
    wsum += parts[i].w;
    acc = mixTheme(acc, parts[i].t, parts[i].w / wsum);
  }
  return acc;
}
/** Largest per-channel difference between two themes (to decide when the PMREM env needs rebuilding). */
export function themeDelta(a: Theme, b: Theme): number {
  const v = (t: Theme) => [...t.skyTop, ...t.skyHorizon, ...t.sun, t.sunIntensity / 4, t.night, ...t.sunDir.map((x) => x * 0.5)];
  const x = v(a), y = v(b);
  return Math.max(...x.map((q, i) => Math.abs(q - y[i])));
}
