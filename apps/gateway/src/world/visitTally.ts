// visitTally.ts — what one visit did, counted from what the gateway already sees, flushed as one ledger row when the visit ends.
//
// The sim keeps no odometer and no place log per body, and the gateway is the single door every observe and say passes through, so
// the tally lives here: no extra sim call, no extra IO on the hot path (observe is polled up to 5/s). Distances are summed between
// the positions the agent actually observed, so they are a floor: ground covered between two polls is cut straight.
// shortcut: in-process Map, lost on a gateway restart (that visit then ends with no summary row); move to Redis if the gateway
// ever runs as more than one instance.
export type Tally = {
  x: number | null; z: number | null; distanceM: number;
  places: Map<string, string>;
  heardSeq: number; heardLines: number; speakers: Set<string>;
  said: number; junctions: number; infractions: Record<string, number>;
};

/** A hop longer than this between two observed positions is a respawn or a gap, not walking. */
const MAX_HOP_M = 500;
/** A place counts as visited when the body was this close to its centre (m). */
const NEAR_PLACE_M = 10;
const MAX_PLACES = 50;
const MAX_SPEAKERS = 200;
const MAX_TALLIES = 5000;

const tallies = new Map<string, Tally>();

function tallyFor(visitId: string): Tally {
  let t = tallies.get(visitId);
  if (!t) {
    // Bounded: a visit that never ends cleanly cannot grow the map without limit.
    if (tallies.size >= MAX_TALLIES) tallies.delete(tallies.keys().next().value!);
    t = { x: null, z: null, distanceM: 0, places: new Map(), heardSeq: 0, heardLines: 0, speakers: new Set(), said: 0, junctions: 0, infractions: {} };
    tallies.set(visitId, t);
  }
  return t;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

/** Feed one observe payload (the sim's `observation`). Unknown shapes are ignored: a tally must never break an observe. */
export function noteObservation(visitId: string, obs: unknown): void {
  if (!obs || typeof obs !== "object") return;
  const o = obs as {
    body?: { x?: unknown; z?: unknown };
    nearestPlace?: { id?: unknown; name?: unknown; dist?: unknown } | null;
    insideRoom?: unknown;
    heard?: { seq?: unknown; from?: unknown }[];
    vehicle?: { junctionsPassed?: unknown; infractions?: Record<string, unknown> } | null;
  };
  const t = tallyFor(visitId);
  const { x, z } = o.body ?? {};
  if (isNum(x) && isNum(z)) {
    if (t.x !== null && t.z !== null) {
      const hop = Math.hypot(x - t.x, z - t.z);
      if (hop <= MAX_HOP_M) t.distanceM += hop;
    }
    t.x = x; t.z = z;
  }
  const np = o.nearestPlace;
  if (np && typeof np.id === "string" && isNum(np.dist) && np.dist <= NEAR_PLACE_M && t.places.size < MAX_PLACES) {
    t.places.set(np.id, typeof np.name === "string" ? np.name : np.id);
  }
  if (typeof o.insideRoom === "string" && t.places.size < MAX_PLACES && !t.places.has(o.insideRoom)) t.places.set(o.insideRoom, o.insideRoom);
  // heard[] repeats the last 60 s when the agent polls without a cursor: count each line once, by its sequence number.
  for (const h of o.heard ?? []) {
    if (!isNum(h?.seq) || h.seq <= t.heardSeq) continue;
    t.heardSeq = h.seq;
    t.heardLines++;
    if (typeof h.from === "string" && t.speakers.size < MAX_SPEAKERS) t.speakers.add(h.from);
  }
  const v = o.vehicle;
  if (v) {
    if (isNum(v.junctionsPassed)) t.junctions = Math.max(t.junctions, v.junctionsPassed);
    for (const [kind, n] of Object.entries(v.infractions ?? {})) if (isNum(n)) t.infractions[kind] = Math.max(t.infractions[kind] ?? 0, n);
  }
}

/** One accepted `say` line. */
export function noteSaid(visitId: string): void {
  tallyFor(visitId).said++;
}

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The summary sentence for the owner. Handles of other bodies are visit-only ids, so only counts are given, never who they were. */
export function summaryText(t: Tally | null, startedAt: Date, endedAt: Date, actionsUsed: number, maxActions: number): string {
  const minutes = Math.max(0, Math.round((endedAt.getTime() - startedAt.getTime()) / 60_000));
  const parts = [`Visit summary: ${plural(minutes, "minute")}, ${actionsUsed} of ${maxActions} actions.`];
  if (!t) return parts.join(" ");
  parts.push(t.distanceM > 0 ? `Moved at least ${Math.round(t.distanceM)} m.` : "Did not move.");
  const names = [...new Set(t.places.values())];
  parts.push(names.length ? `Places it was near: ${names.slice(0, 8).join(", ")}${names.length > 8 ? ` and ${names.length - 8} more` : ""}.` : "No known place within reach.");
  parts.push(`Said ${plural(t.said, "line")}; heard ${plural(t.heardLines, "line")} from ${plural(t.speakers.size, "body", "bodies")}.`);
  if (t.junctions > 0) {
    const broke = Object.entries(t.infractions).filter(([, n]) => n > 0).map(([k, n]) => `${n} ${k.replace(/_/g, " ")}`);
    parts.push(`Drove through ${plural(t.junctions, "junction")}${broke.length ? `, broke: ${broke.join(", ")}` : ", no infractions"}.`);
  }
  return parts.join(" ");
}

/** Removes and returns the tally for a visit that is over. */
export function takeTally(visitId: string): Tally | null {
  const t = tallies.get(visitId) ?? null;
  tallies.delete(visitId);
  return t;
}

export const _forTests = { size: () => tallies.size, clear: () => tallies.clear() };
