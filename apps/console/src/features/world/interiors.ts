// interiors.ts — pure streaming rules for City 3's interiors (three-free, DOM-free).
//
// Only buildings that hold a room get an interior; each is a layout (a list of
// placements into one shared asset library), never a baked mesh. The camera
// decides what is loaded: nearest first, a hard cap on how many stay resident,
// and a wider "keep" radius than "load" radius so a camera hovering at the
// edge doesn't load and drop the same room every second.

export type Prop = [asset: string, x: number, y: number, z: number, rotY: number, scale: number];

export interface InteriorLayout {
  id: string;
  library: string;
  props: Prop[];
}

export interface StreamHero {
  id: string;
  center: [number, number];
}

export interface StreamOptions {
  cam: { x: number; y: number; z: number };
  heroes: StreamHero[];
  loaded: readonly string[];
  /** Start loading a room this close (m). */
  loadWithin: number;
  /** Keep a loaded room until it is farther than this (m). Must exceed loadWithin. */
  keepWithin: number;
  /** Rooms kept resident at once; the farthest are evicted first. */
  maxLoaded: number;
}

export interface StreamPlan {
  load: string[];
  evict: string[];
}

const dist = (h: StreamHero, c: StreamOptions["cam"]): number =>
  Math.hypot(c.x - h.center[0], c.y, c.z - h.center[1]);

/**
 * Decide which interiors to load and which to drop for this camera.
 * Desired set = loaded rooms inside the keep radius plus unloaded rooms inside
 * the load radius, nearest first, truncated to maxLoaded. Deterministic: ties
 * break on id, so two identical frames never disagree.
 */
export function planStreaming(o: StreamOptions): StreamPlan {
  const have = new Set(o.loaded);
  const scored = o.heroes
    .map((h) => ({ id: h.id, d: dist(h, o.cam) }))
    .filter((h) => (have.has(h.id) ? h.d <= o.keepWithin : h.d <= o.loadWithin))
    .sort((a, b) => a.d - b.d || (a.id < b.id ? -1 : 1))
    .slice(0, Math.max(0, o.maxLoaded));
  const want = new Set(scored.map((h) => h.id));
  return {
    load: scored.filter((h) => !have.has(h.id)).map((h) => h.id),
    evict: o.loaded.filter((id) => !want.has(id)),
  };
}

/** Group placements by asset so each asset becomes one instanced draw per primitive. */
export function groupByAsset(props: readonly Prop[]): Map<string, Prop[]> {
  const out = new Map<string, Prop[]>();
  for (const p of props) {
    const list = out.get(p[0]);
    if (list) list.push(p);
    else out.set(p[0], [p]);
  }
  return out;
}

/** Sidecar of a layout URL: `/assets/interiors/<id>.json` -> `/assets/interiors/<id>.col.json` (furniture boxes). */
export function colUrl(layoutUrl: string): string {
  return layoutUrl.replace(/\.json$/, ".col.json");
}

/** One furniture box: [cx, cz, hx, hz, y0, y1, rotY] in the same three space as the layout (before any room shift). */
export type ColBoxTuple = [number, number, number, number, number, number, number];

/** Accepts `[[...], ...]` or `{boxes: [[...], ...]}`; drops malformed / degenerate entries. */
export function parseColBoxes(json: unknown): ColBoxTuple[] {
  const raw = Array.isArray(json) ? json : (json as { boxes?: unknown } | null)?.boxes;
  if (!Array.isArray(raw)) return [];
  const out: ColBoxTuple[] = [];
  for (const b of raw) {
    if (!Array.isArray(b) || b.length < 6 || !b.slice(0, 7).every((v) => typeof v === "number" && Number.isFinite(v))) continue;
    const [cx, cz, hx, hz, y0, y1, rot = 0] = b as number[];
    if (hx <= 0 || hz <= 0 || y1 <= y0) continue;
    out.push([cx, cz, hx, hz, y0, y1, rot]);
  }
  return out;
}
