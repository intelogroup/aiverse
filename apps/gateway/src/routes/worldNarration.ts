import { Hono } from "hono";

// POST /world/narration — an agent's private inner narration, pushed by ITS OWN harness, relayed to the agent's OWNER only.
//
// Why it exists: a harness (opencode, pi, Claude Code ...) runs on the owner's machine, so the platform cannot read what the agent
// says to itself between tool calls. A harness that opts in pushes those lines here; the owner's console speaks them (TTS) while the
// owner watches the agent walk. Trust boundary, deliberately narrow:
//   - delivered ONLY to the owner's console sockets (broadcastToOwnerConsole): never to agents, never the public viewer stream;
//   - NOT persisted and NEVER logged: the text is the agent's reasoning, which the spectator spec keeps private (a log line would
//     leak it to anyone who can read logs). Only its length is logged;
//   - the owner is the active visit's owner, resolved by the world route's visit gate, never taken from the request;
//   - rate limited per agent, length capped, plain text only. Not a visit action (it must not spend the owner's action budget).
export const NARRATION_MAX_CHARS = 300;
/** Burst of 5, then one line per 2 s: well above a narrating agent's real pace, far below a flood. */
export const NARRATION_BURST = 5;
export const NARRATION_REFILL_PER_S = 0.5;
export const NARRATION_KINDS = ["visible", "thinking"] as const;
export type NarrationKind = (typeof NARRATION_KINDS)[number];

export interface NarrationDeps {
  /** Owner-only delivery (ws/fanout.ts broadcastToOwnerConsole, wrapped in the envelope). */
  deliver(ownerId: string, payload: { agentId: string; agentName: string; kind: NarrationKind; text: string; at: number }): void;
  takeToken(key: string, capacity: number, refillPerSec: number): Promise<boolean>;
  nameOf(agentId: string): Promise<string | null>;
  now(): number;
  /** Length-only telemetry; never receives the text. */
  log(event: string, fields: Record<string, unknown>): void;
}

type Env = { Variables: { agentId: string; ownerId: string } };

export function createNarrationRoute(deps: NarrationDeps) {
  const route = new Hono<Env>();
  route.post("/", async (c) => {
    const agentId = c.get("agentId");
    const ownerId = c.get("ownerId");
    const body = await c.req.json<{ text?: unknown; kind?: unknown }>().catch(() => null);
    if (!body || typeof body.text !== "string") return c.json({ error: "text must be a string" }, 400);
    const kind = body.kind === undefined ? "visible" : body.kind;
    if (!NARRATION_KINDS.includes(kind as NarrationKind)) return c.json({ error: `kind must be one of ${NARRATION_KINDS.join(", ")}` }, 400);
    // Plain text: collapse whitespace and drop control characters; the console renders it as text and speaks it.
    // eslint-disable-next-line no-control-regex
    const text = body.text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
    if (!text) return c.json({ error: "text is empty" }, 400);
    if (text.length > NARRATION_MAX_CHARS) return c.json({ error: `text must be at most ${NARRATION_MAX_CHARS} characters` }, 400);
    if (!(await deps.takeToken(`narration:${agentId}`, NARRATION_BURST, NARRATION_REFILL_PER_S))) {
      return c.json({ error: "rate_limited" }, 429, { "retry-after": String(Math.ceil(1 / NARRATION_REFILL_PER_S)) });
    }
    const agentName = (await deps.nameOf(agentId)) ?? "agent";
    deps.deliver(ownerId, { agentId, agentName, kind: kind as NarrationKind, text, at: deps.now() });
    deps.log("world_narration_relayed", { agentId, chars: text.length, kind });
    return c.json({ ok: true }, 202);
  });
  return route;
}
