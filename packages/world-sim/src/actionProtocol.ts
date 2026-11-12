// actionProtocol.ts — the physical tool boundary of the server sim: what an agent may ask its body to do.
//
// Moved from tools/embodied/protocol.ts (which now re-exports it) so the browser experiment host and the server sim share ONE contract.
// Only physical intents pass: no teleport, no debug or eval. The one free-text action is `say`: short, range-limited, and handled by
// WorldService (it never reaches the body executor).
// IDs make a request idempotent: a retry with the same id and the same action returns the first result and does not act twice.
import { resolveSocialClip, SOCIAL_CLIPS } from "./clips";
import { GAZE_PITCH_MAX_DEG, GAZE_PITCH_MIN_DEG, GAZE_YAW_MAX_DEG } from "./scout";

const ID_RE = /^[a-zA-Z0-9-]{1,80}$/;
const MAX_NAME = 100;
/** Longest spoken line, and how far it carries (needs a clear line of sight too). */
export const MAX_SAY = 140;
export const SAY_RANGE_M = 6;

/** A request id: 1-80 letters, digits or dashes. */
export function validRequestId(id: unknown): id is string { return typeof id === "string" && ID_RE.test(id); }

/** Every action type a body accepts, with its fields (the public contract; the card and docs read this). */
export const ACTION_TYPES = {
  go_to: "{place}, {point:[x,z]} or {body: handle}: stop 1.2 m in front of someone you see", run_to: "{place} or {point:[x,z]}", enter: "{place} (lot or room id): walk inside",
  face: "{headingDeg}, {point:[x,z]} or {body: handle}", wait: "{seconds} 0-30", sit: "{sittable?}", stand: "{}",
  play: "{clip, seconds?} (GET /world/clips)", interact: "{target}", stop: "{}",
  gaze: `{yawDeg?: -${GAZE_YAW_MAX_DEG}..${GAZE_YAW_MAX_DEG} (+ right), pitchDeg?: ${GAZE_PITCH_MIN_DEG}..${GAZE_PITCH_MAX_DEG} (+ up)} or {reset:true}: turn your head, not your body; look and see follow it`,
  say: `{text <= ${MAX_SAY} chars, to?: handle}: speak aloud; bodies within ${SAY_RANGE_M} m with a clear line of sight hear it (read observe.heard)`,
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
      if (!resolveSocialClip(v.clip)) return `unknown clip ${JSON.stringify(v.clip)}; playable: ${SOCIAL_CLIPS.join(", ")} (aliases like "wave", "laugh", "nod" work too)`;
      if (v.seconds !== undefined && !num(v.seconds, 0, 30, true)) return "seconds must be > 0 and <= 30";
      return extra("clip", "seconds");
    case "sit":
      return v.sittable !== undefined && !name(v.sittable) ? "sittable must be a seat id" : extra("sittable");
    case "say":
      if (typeof v.text !== "string" || v.text.trim().length === 0 || v.text.length > MAX_SAY) return `say needs text, 1-${MAX_SAY} characters`;
      if (v.to !== undefined && !name(v.to)) return "to must be a handle from observe.scene";
      return extra("text", "to");
    case "gaze": {
      if (v.reset !== undefined) return v.reset === true && v.yawDeg === undefined && v.pitchDeg === undefined ? extra("reset") : "gaze: reset must be true and used alone";
      if (v.yawDeg === undefined && v.pitchDeg === undefined) return "gaze needs yawDeg and/or pitchDeg, or reset:true";
      if (v.yawDeg !== undefined && !num(v.yawDeg, -GAZE_YAW_MAX_DEG, GAZE_YAW_MAX_DEG)) return `yawDeg must be within +-${GAZE_YAW_MAX_DEG} (positive is right)`;
      if (v.pitchDeg !== undefined && !num(v.pitchDeg, GAZE_PITCH_MIN_DEG, GAZE_PITCH_MAX_DEG)) return `pitchDeg must be between ${GAZE_PITCH_MIN_DEG} and ${GAZE_PITCH_MAX_DEG} (positive is up)`;
      return extra("yawDeg", "pitchDeg");
    }
    case "interact": return name(v.target) ? extra("target") : "interact needs a target (a prop id from observe.scene)";
    case "wait": return num(v.seconds, 0, 30) ? extra("seconds") : "wait needs seconds, 0-30";
    case "face":
      if ([v.headingDeg, v.point, v.body].filter((x) => x !== undefined).length !== 1) return "face needs exactly one of headingDeg, point:[x,z] or body (a handle from observe.scene)";
      if (v.body !== undefined && !name(v.body)) return "body must be a handle from observe.scene";
      if (v.headingDeg !== undefined && !num(v.headingDeg, -360, 360)) return "headingDeg must be within +-360";
      if (v.point !== undefined && !point(v.point)) return "point must be [x, z]";
      return extra("headingDeg", "point", "body");
    case "enter": return name(v.place) ? extra("place") : "enter needs a place (a shop lot id or room id from GET /world/map)";
    case "go_to": case "run_to":
      if ([v.place, v.point, v.body].filter((x) => x !== undefined).length !== 1) return `${v.type} needs exactly one of place, point:[x,z] or body (a handle from observe.scene)`;
      if (v.body !== undefined && !name(v.body)) return "body must be a handle from observe.scene";
      if (v.point !== undefined && !point(v.point)) return "point must be [x, z], each within +-2000";
      if (v.place !== undefined && !name(v.place)) return "place must be a place id from GET /world/map";
      return extra("point", "place", "body");
    case undefined: {
      const keys = Object.keys(v);
      const nested = keys.length === 1 && keys[0] in ACTION_TYPES;
      return nested
        ? `actions are flat: {"type":"${keys[0]}", ...fields}, not {"${keys[0]}":{...}}. ${keys[0]}: ${ACTION_TYPES[keys[0] as keyof typeof ACTION_TYPES]}`
        : `action needs a "type" field, one of: ${Object.keys(ACTION_TYPES).join(", ")}. Example: {"type":"play","clip":"Waving"}`;
    }
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
