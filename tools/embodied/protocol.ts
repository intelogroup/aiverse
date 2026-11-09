import { SOCIAL_CLIPS, type SocialClip } from "../../apps/console/src/features/world/scout";

// One browser owns one body for this experiment. A new host session invalidates
// old requests; IDs are deduplicated, and raw JavaScript/debug APIs are never accepted.
export function validAction(a: unknown): boolean {
  if (!a || typeof a !== "object") return false;
  const v = a as Record<string, unknown>;
  const only = (...keys: string[]) => Object.keys(v).every(k => ["type", ...keys].includes(k));
  switch (v.type) {
    case "stop": case "stand": return only();
    case "play":
      return only("clip", "seconds") && SOCIAL_CLIPS.includes(v.clip as SocialClip) &&
        (v.seconds === undefined || (typeof v.seconds === "number" && Number.isFinite(v.seconds) && v.seconds > 0 && v.seconds <= 30));
    case "sit":
      return only("sittable") && (v.sittable === undefined ||
        (typeof v.sittable === "string" && v.sittable.length > 0 && v.sittable.length <= 100));
    case "wait": return only("seconds") && typeof v.seconds === "number" && Number.isFinite(v.seconds) && v.seconds >= 0 && v.seconds <= 30;
    case "face": return only("headingDeg") && typeof v.headingDeg === "number" && Number.isFinite(v.headingDeg) && Math.abs(v.headingDeg) <= 360;
    case "go_to": case "run_to":
      return only("point", "place") && ((Array.isArray(v.point) && v.point.length === 2 && v.point.every(x => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 2000) && v.place === undefined) ||
        (v.point === undefined && typeof v.place === "string" && v.place.length > 0 && v.place.length <= 100));
    default: return false;
  }
}
export class ActionLedger {
  private entries = new Map<string, { body: string; result: Promise<unknown> }>();
  run(id: string, action: unknown, execute: () => Promise<unknown>): Promise<unknown> {
    if (typeof id !== "string" || !/^[a-zA-Z0-9-]{1,80}$/.test(id) || !validAction(action)) throw new Error("invalid action");
    const body = JSON.stringify(action), old = this.entries.get(id);
    if (old) {
      if (old.body !== body) throw new Error("request ID reused with different action");
      return old.result;
    }
    if (this.entries.size >= 10000) throw new Error("session action budget exhausted");
    const result = Promise.resolve().then(execute);
    this.entries.set(id, { body, result });
    return result;
  }
}
