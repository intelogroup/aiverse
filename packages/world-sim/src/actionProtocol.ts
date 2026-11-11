// actionProtocol.ts — the physical tool boundary of the server sim: what an agent may ask its body to do.
//
// Moved from tools/embodied/protocol.ts (which now re-exports it) so the browser experiment host and the server sim share ONE contract.
// Only physical intents pass: no teleport, no debug or eval, no free text (`say` goes through the social path, not the body).
// IDs make a request idempotent: a retry with the same id and the same action returns the first result and does not act twice.
import { SOCIAL_CLIPS, type SocialClip } from "./scout";

const ID_RE = /^[a-zA-Z0-9-]{1,80}$/;
const MAX_NAME = 100;

/** A request id: 1-80 letters, digits or dashes. */
export function validRequestId(id: unknown): id is string { return typeof id === "string" && ID_RE.test(id); }

/** Every action type a body accepts, with its fields (the public contract; the card and docs read this). */
export const ACTION_TYPES = {
  go_to: "{place} or {point:[x,z]}", run_to: "{place} or {point:[x,z]}", enter: "{place} (lot or room id): walk inside",
  face: "{headingDeg} or {point:[x,z]}", wait: "{seconds} 0-30", sit: "{sittable?}", stand: "{}",
  play: "{clip, seconds?} (GET /world/clips)", interact: "{target}", stop: "{}",
} as const;

export function validAction(a: unknown): boolean { return explainAction(a) === null; }

/** Why an action is refused (null when it is valid). The message names the valid options, so a cold agent can correct itself. */
export function explainAction(a: unknown): string | null {
  if (!a || typeof a !== "object") return "action must be an object with a type";
  const v = a as Record<string, unknown>;
  const extra = (...keys: string[]) => {
    const bad = Object.keys(v).filter((k) => !["type", ...keys].includes(k));
    return bad.length ? `unexpected field(s) ${bad.join(", ")} for ${String(v.type)}; allowed: ${keys.join(", ") || "none"}` : null;
  };
  const name = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= MAX_NAME;
  const num = (x: unknown, lo: number, hi: number, openLo = false) => typeof x === "number" && Number.isFinite(x) && (openLo ? x > lo : x >= lo) && x <= hi;
  const point = (x: unknown) => Array.isArray(x) && x.length === 2 && x.every((n) => num(n, -2000, 2000));
  switch (v.type) {
    case "stop": case "stand": return extra();
    case "play":
      if (!SOCIAL_CLIPS.includes(v.clip as SocialClip)) return `unknown clip ${JSON.stringify(v.clip)}; playable: ${SOCIAL_CLIPS.join(", ")}`;
      if (v.seconds !== undefined && !num(v.seconds, 0, 30, true)) return "seconds must be > 0 and <= 30";
      return extra("clip", "seconds");
    case "sit":
      return v.sittable !== undefined && !name(v.sittable) ? "sittable must be a seat id" : extra("sittable");
    case "interact": return name(v.target) ? extra("target") : "interact needs a target (a prop id from observe.scene)";
    case "wait": return num(v.seconds, 0, 30) ? extra("seconds") : "wait needs seconds, 0-30";
    case "face":
      if ((v.headingDeg === undefined) === (v.point === undefined)) return "face needs exactly one of headingDeg or point:[x,z]";
      if (v.headingDeg !== undefined && !num(v.headingDeg, -360, 360)) return "headingDeg must be within +-360";
      if (v.point !== undefined && !point(v.point)) return "point must be [x, z]";
      return extra("headingDeg", "point");
    case "enter": return name(v.place) ? extra("place") : "enter needs a place (a shop lot id or room id from GET /world/map)";
    case "go_to": case "run_to":
      if ((v.place === undefined) === (v.point === undefined)) return `${v.type} needs exactly one of place or point:[x,z]`;
      if (v.point !== undefined && !point(v.point)) return "point must be [x, z], each within +-2000";
      if (v.place !== undefined && !name(v.place)) return "place must be a place id from GET /world/map";
      return extra("point", "place");
    default: return `unknown action type ${JSON.stringify(v.type)}; valid: ${Object.keys(ACTION_TYPES).join(", ")}`;
  }
}

/** Per-session request ledger: dedupes by id, rejects an id reused for a different action, caps the number of distinct ids. */
export class ActionLedger<T = unknown> {
  private entries = new Map<string, { body: string; result: Promise<T> }>();
  constructor(private readonly maxEntries = 10000) {}

  has(id: string): boolean { return this.entries.has(id); }

  run(id: string, action: unknown, execute: () => Promise<T>): Promise<T> {
    if (!validRequestId(id) || !validAction(action)) throw new Error("invalid action");
    const body = JSON.stringify(action), old = this.entries.get(id);
    if (old) {
      if (old.body !== body) throw new Error("request ID reused with different action");
      return old.result;
    }
    if (this.entries.size >= this.maxEntries) throw new Error("session action budget exhausted");
    const result = Promise.resolve().then(execute);
    this.entries.set(id, { body, result });
    return result;
  }
}
