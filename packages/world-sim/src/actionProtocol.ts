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

export function validAction(a: unknown): boolean {
  if (!a || typeof a !== "object") return false;
  const v = a as Record<string, unknown>;
  const only = (...keys: string[]) => Object.keys(v).every((k) => ["type", ...keys].includes(k));
  const name = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= MAX_NAME;
  switch (v.type) {
    case "stop": case "stand": return only();
    case "play":
      return only("clip", "seconds") && SOCIAL_CLIPS.includes(v.clip as SocialClip) &&
        (v.seconds === undefined || (typeof v.seconds === "number" && Number.isFinite(v.seconds) && v.seconds > 0 && v.seconds <= 30));
    case "sit":
      return only("sittable") && (v.sittable === undefined || name(v.sittable));
    case "interact":
      return only("target") && name(v.target);
    case "wait": return only("seconds") && typeof v.seconds === "number" && Number.isFinite(v.seconds) && v.seconds >= 0 && v.seconds <= 30;
    case "face": return only("headingDeg") && typeof v.headingDeg === "number" && Number.isFinite(v.headingDeg) && Math.abs(v.headingDeg) <= 360;
    case "go_to": case "run_to":
      return only("point", "place") && ((Array.isArray(v.point) && v.point.length === 2 && v.point.every((x) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 2000) && v.place === undefined) ||
        (v.point === undefined && name(v.place)));
    default: return false;
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
