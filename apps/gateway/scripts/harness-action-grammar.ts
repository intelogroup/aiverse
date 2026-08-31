// Subject-harness action grammar — exported so the shakedown-tested repair
// pipeline (normalize → alias repair → malformed salvage) is unit-testable.
// STRUCTURAL only (relabel the same decision), never semantic: the model still
// chose the action and supplied its arguments; we only fix the envelope.
import { z } from "zod";

export const ACTIONS = new Set([
  "nothing", "observe", "join_room", "leave_conversation", "message", "reply",
  "start_conversation", "invite", "discover_peers", "ask_peer", "create_goal", "delegate",
]);

// Scalar bare-key args land in the action's primary argument key ({"join_room":"x"}).
const SCALAR_ARG_KEY: Record<string, string> = { join_room: "room_slug" };

export function editDistanceAtMostOne(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [s, t] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < s.length && j < t.length) {
    if (s[i] === t[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (s.length === t.length) { i++; j++; } else { j++; } // substitution vs insertion
  }
  return edits <= 1;
}

export function normalizeAction(parsed: any): any {
  if (!parsed || typeof parsed !== "object") return parsed;
  if (typeof parsed.action === "string") {
    const name = parsed.action.trim().toLowerCase();
    if (ACTIONS.has(name)) return { ...parsed, action: name };
    const fuzzy = [...ACTIONS].find((a) => editDistanceAtMostOne(a, name));
    if (fuzzy) return { ...parsed, action: fuzzy };
    return { ...parsed, action: name }; // stays off_grammar, as before
  }
  // No "action" key: promote a single bare action key, e.g. {"delegate": {...}}
  // or {"join_room": "general"}. The key's value becomes the argument object.
  const keys = Object.keys(parsed);
  if (keys.length > 0) {
    const k = keys.find((key) => {
      const lower = key.trim().toLowerCase();
      return ACTIONS.has(lower) || [...ACTIONS].some((a) => editDistanceAtMostOne(a, lower));
    });
    if (k !== undefined) {
      const lower = k.trim().toLowerCase();
      const actionName = ACTIONS.has(lower) ? lower : [...ACTIONS].find((a) => editDistanceAtMostOne(a, lower))!;
      // A scalar arg lands in the action's primary argument, not a generic
      // "value" bucket: {"join_room":"general"} must become room_slug, or the
      // executor 404s with room:undefined (voided e2a launch, 2026-08-31).
      const argKey = SCALAR_ARG_KEY[actionName] ?? "value";
      const args = parsed[k];
      return { ...(args && typeof args === "object" ? args : { [argKey]: args }), action: actionName };
    }
  }
  return parsed;
}

// Per-action argument schemas. A near-miss arg name (e.g. "room" instead of
// "room_slug") used to sail through and only fail later as an API 404 — the
// shakedown caught join_room({"room":…}) doing exactly that. The schema
// detects the miss at PARSE time; known aliases are relabeled below.
const ACTION_ARG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  reply: z.object({ conversationId: z.string(), content: z.string() }).passthrough(),
  message: z.object({ conversationId: z.string(), content: z.string() }).passthrough(),
  start_conversation: z.object({ content: z.string() }).passthrough(),
  ask_peer: z.object({ targetAgentId: z.string(), content: z.string() }).passthrough(),
  invite: z.object({ conversationId: z.string(), targetAgentId: z.string() }).passthrough(),
  join_room: z.object({ room_slug: z.string() }).passthrough(),
  leave_conversation: z.object({ conversationId: z.string() }).passthrough(),
  nothing: z.object({}).passthrough(),
  observe: z.object({}).passthrough(),
  discover_peers: z.object({}).passthrough(),
  create_goal: z.object({}).passthrough(),
  delegate: z.object({}).passthrough(),
};
const ARG_ALIASES: Record<string, string> = {
  room: "room_slug", slug: "room_slug", roomSlug: "room_slug", roomname: "room_slug",
  conversation: "conversationId", conv: "conversationId", thread: "conversationId", conversation_id: "conversationId",
  target: "targetAgentId", agent: "targetAgentId", peer: "targetAgentId", agent_id: "targetAgentId", agentId: "targetAgentId",
  text: "content", message: "content", body: "content",
};
// Per-action aliases for arg names that are only unambiguous within one
// action ("name" is generic, but join_room's only meaningful argument is the
// room slug). shk2 run: join_room emitted with name-like keys → room:undefined.
const ACTION_ARG_ALIASES: Record<string, Record<string, string>> = {
  join_room: { name: "room_slug", room_name: "room_slug", roomName: "room_slug", title: "room_slug", topic: "room_slug" },
};

export function repairActionArgs(a: any): any {
  if (!a || typeof a !== "object") return a;
  const name = String(a.action);
  const schema = ACTION_ARG_SCHEMAS[name];
  if (!schema) return a;
  if (schema.safeParse(a).success) return a;
  const aliases = { ...ARG_ALIASES, ...(ACTION_ARG_ALIASES[name] ?? {}) };
  const repaired: any = { ...a };
  for (const [k, v] of Object.entries(a)) {
    if (k === "action") continue;
    const canonical = aliases[k];
    if (canonical && repaired[canonical] === undefined) {
      repaired[canonical] = v;
      delete repaired[k];
    }
  }
  // Unrepaired near-misses stay untouched — the executor then reports the
  // real API error, which is data, not a harness bug.
  return schema.safeParse(repaired).success ? repaired : a;
}

// Full decision parse: JSON.parse → prose/trailing-text salvage → normalize →
// arg repair. Only truly unparseable output becomes malformed_json.
export function parseDecision(raw: unknown): any {
  let action: any = null;
  const text = String(raw ?? "").replace(/```json|```/g, "").trim();
  try {
    action = normalizeAction(JSON.parse(text));
  } catch {
    const brace = text.match(/\{[\s\S]*\}/);
    if (brace) {
      try {
        action = normalizeAction(JSON.parse(brace[0]));
      } catch {
        action = null;
      }
    }
  }
  if (!action || typeof action !== "object") {
    return { action: "malformed_json", raw: String(raw ?? "").slice(0, 200) };
  }
  if (action.action !== "malformed_json") action = repairActionArgs(action);
  return action;
}
