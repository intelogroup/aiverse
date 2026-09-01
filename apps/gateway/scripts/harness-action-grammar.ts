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
const SCALAR_ARG_KEY: Record<string, string> = { join_room: "room" };

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

// Per-action argument schemas — written against the EXECUTOR's actual contract
// (subject-harness execute(), snake_case), NOT an assumed convention. The first
// version of this table used camelCase and "repaired" correct model output
// ({"action":"join_room","room":"science"}) into room_slug, 404ing valid
// decisions — the 2026-08-31 e2a launch was voided twice for exactly this.
const ACTION_ARG_SCHEMAS: Record<string, z.ZodTypeAny> = {
  reply: z.object({ conversation_id: z.string(), content: z.string() }).passthrough(),
  message: z.object({ conversation_id: z.string(), content: z.string() }).passthrough(),
  start_conversation: z.object({ content: z.string() }).passthrough(),
  ask_peer: z.object({ agent_id: z.string(), content: z.string() }).passthrough(),
  invite: z.object({ conversation_id: z.string(), agent_id: z.string() }).passthrough(),
  join_room: z.object({ room: z.string() }).passthrough(),
  leave_conversation: z.object({ conversation_id: z.string() }).passthrough(),
  nothing: z.object({}).passthrough(),
  observe: z.object({}).passthrough(),
  discover_peers: z.object({}).passthrough(),
  create_goal: z.object({}).passthrough(),
  delegate: z.object({}).passthrough(),
};
const ARG_ALIASES: Record<string, string> = {
  roomSlug: "room", room_slug: "room", roomname: "room", slug: "room",
  conversationId: "conversation_id", conversation: "conversation_id", conv: "conversation_id", thread: "conversation_id",
  targetAgentId: "agent_id", targetAgent_id: "agent_id", agentId: "agent_id",
  target: "agent_id", peer: "agent_id",
  text: "content", message: "content", body: "content",
};
// Per-action aliases for arg names that are only unambiguous within one
// action. Empty for now — extend only with executor-verified mappings.
const ACTION_ARG_ALIASES: Record<string, Record<string, string>> = {};

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

// Curly-quote closer repair (gptoss20-class, 2026-09-01: ~10% of decisions
// failed parsing — traced live via full-raw + finish_reason capture, NOT
// truncation, finish_reason was consistently "stop"). The model ends its
// content string with a typographic right double quote (U+201D) instead of
// the straight quote JSON requires, immediately before the closing brace —
// e.g. `..."approach.”}` — leaving the string technically unterminated.
// Scoped to exactly that end-of-payload position so a legitimate curly quote
// used stylistically mid-content (which this model does constantly,
// intentionally) is never touched.
const CURLY_QUOTE_CLOSER = /[“”]\s*\}\s*$/;

// Invalid-escape repair (gptoss20-class, 2026-09-01, robotics-topic content:
// same finish_reason="stop" full-completion pattern as the curly-quote bug,
// different cause). The model writes LaTeX-style math notation in reply
// content — \(d(t)\), \dot{e}_k, \hat{d} — using bare backslashes that are
// not valid JSON escape sequences (JSON only allows \" \\ \/ \b \f \n \r \t
// and \uXXXX). JSON.parse throws on the first one it hits. Doubling any
// backslash NOT already followed by a valid escape character turns the
// invalid \d into a literal backslash-d in the string, which is what the
// model meant — legitimate escapes like \n, \t, \" are left untouched.
const INVALID_ESCAPE = /\\(?!["\\/bfnrtu])/g;

function tryParse(text: string): any {
  try {
    return normalizeAction(JSON.parse(text));
  } catch {
    const brace = text.match(/\{[\s\S]*\}/);
    if (!brace) return null;
    try {
      return normalizeAction(JSON.parse(brace[0]));
    } catch {
      return null;
    }
  }
}

// Full decision parse: JSON.parse → prose/trailing-text salvage → curly-quote
// repair → invalid-escape repair → normalize → arg repair. Only truly
// unparseable output becomes malformed_json. The two repairs are independent
// (different failure positions — end-of-payload vs anywhere in content) and
// tried in combination last, since a single response could hit both.
export function parseDecision(raw: unknown): any {
  const text = String(raw ?? "").replace(/```json|```/g, "").trim();
  const curlyFixed = CURLY_QUOTE_CLOSER.test(text) ? text.replace(CURLY_QUOTE_CLOSER, '"}') : null;
  const candidates = [
    text,
    curlyFixed,
    text.replace(INVALID_ESCAPE, "\\\\"),
    curlyFixed ? curlyFixed.replace(INVALID_ESCAPE, "\\\\") : null,
  ].filter((c): c is string => c !== null);

  let action: any = null;
  for (const candidate of candidates) {
    action = tryParse(candidate);
    if (action) break;
  }
  if (!action || typeof action !== "object") {
    return { action: "malformed_json", raw: String(raw ?? "").slice(0, 4000) };
  }
  if (action.action !== "malformed_json") action = repairActionArgs(action);
  return action;
}
