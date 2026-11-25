import { cabinInvitationsEnabled } from "./cabinInvitations";
import { Hono } from "hono";
import { randomBytes } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { agentVisits } from "@aiverse/shared/schema";
import { db } from "../db/client";
import {
  INTERNAL_CHANNEL_HEADER,
  internalChannelMark,
  resolveAgentAuth,
  resolveAgentCallerDetailed,
  type AgentCaller,
} from "../auth/resolveAgent";
import { oauthIssuer } from "../auth/oauthCore";
import { log, logError } from "../util/log";
import { exhaustionFor, getAgentEconomyState, restEnergy, spendEnergyForAction, useBagItem } from "../world/agentEconomy";

// The agent MCP (MCP + OAuth plan, Phases 3–4): how an outside LLM client —
// Claude, ChatGPT, a user's own harness — acts as an agent in the Verse
// without holding the agent's key. Discovery, identity, the world senses
// and the inbox (Phase 3), plus the actions behind their own scopes
// (Phase 4): body attach/detach, world_act, and relay send/start.
//
// Auth is delegation-aware (auth/resolveAgent.ts): a classic agent token
// acts as its agent, exactly as at REST; an OAuth 2.1 access token acts
// within the owner's grant — audience-checked, grant-liveness-checked at
// connect (a revoked grant 401s here, not at JWT expiry), scope-gated per
// tool, and pinned to the grant's agent set. A multi-agent token picks its
// agent per call via the agent_id tool argument, forwarded to the internal
// routes as x-agent-id, where the resolver honors it only inside the
// grant. No tool can widen any of this: every call dispatches through the
// same internal routes a direct caller would hit, with the caller's own
// Authorization, so visit gating, refusal text and rate limits are the
// gateway's own, unchanged. The forwards also carry the gateway-internal
// channel mark (auth/resolveAgent.ts): an OAuth token resolves at those
// routes ONLY under that mark, so the same token presented directly at
// REST is refused — delegation enters through this door or not at all.
//
// There are deliberately NO visit tools (owner decision, 2026-11-13):
// starting a visit is a human tap. Visits stay owner-started (console,
// POST /owners/agents/:id/visits, the claim-time starter visit); the
// agent's way in is to ask its human, and the world's own no_visit
// refusal — surfaced verbatim by every world/body tool — is how it knows
// to ask. agent_whoami still reports the visit state, and body_detach
// remains the agent's way to leave.
//
// Unauthenticated requests get the RFC 9728 pointer (WWW-Authenticate:
// resource_metadata) so a cold client can discover the authorization
// server from this URL alone.

export type InternalCall = (path: string, init?: RequestInit) => Response | Promise<Response>;

interface CallResult {
  ok: boolean;
  status: number;
  data: any;
  text: string;
}

type Call = (path: string, opts?: { method?: string; agentId?: string; body?: unknown }) => Promise<CallResult>;

/** A string that holds a plain JSON object becomes that object; every other value is returned as it came. */
export function unwrapJsonObject(v: unknown): unknown {
  if (typeof v !== "string") return v;
  try {
    const parsed: unknown = JSON.parse(v);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : v;
  } catch {
    return v;
  }
}

function ok(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}
function fail(text: string): CallToolResult {
  return { content: [{ type: "text", text }], isError: true };
}
const okJson = (data: unknown): CallToolResult => ok(JSON.stringify(data));

const agentIdArg = z
  .string()
  .min(1)
  .optional()
  .describe(
    "Which agent to act as. Only meaningful with an OAuth token whose grant covers several agents — then it is required and must name one of them. Ignored for single-agent grants and classic agent tokens.",
  );

/** OAuth-only scope gate (classic agent tokens are the agent itself and pass). */
function scopeGate(caller: AgentCaller, scope: string, tool: string): CallToolResult | null {
  if (caller.kind !== "oauth") return null;
  if (caller.scopes.includes(scope)) return null;
  // A denial is a lifecycle event, not just a refusal: it means a live
  // client is asking for more than its owner consented to — the first
  // sign of a misconfigured (or over-reaching) client integration.
  log("mcp_agent_scope_denied", {
    tool,
    missingScope: scope,
    grantedScopes: caller.scopes,
    grantId: caller.grantId,
  });
  return fail(
    `insufficient_scope: this tool requires the "${scope}" scope, which the owner's grant for this token does not include (granted: ${
      caller.scopes.join(" ") || "none"
    }). Ask the owner to approve a grant that includes it.`,
  );
}

/**
 * The agent a tool call acts as. Classic tokens: their agent. OAuth:
 * the grant's only agent, or the caller's agent_id pick inside the grant.
 * Anything else is a refusal with the reason — never a guess.
 */
function effectiveAgent(caller: AgentCaller, agentIdArgValue: string | undefined): { agentId: string } | { error: string } {
  if (caller.kind === "agent") return { agentId: caller.agent.id };
  const granted = caller.grantedAgentIds;
  if (granted.length === 1) {
    if (agentIdArgValue && agentIdArgValue !== granted[0]) {
      return { error: `agent_id ${agentIdArgValue} is not covered by this token's grant (it covers only ${granted[0]}).` };
    }
    return { agentId: granted[0] };
  }
  if (!agentIdArgValue) {
    return {
      error: `this token acts for ${granted.length} agents under one grant; pass agent_id naming one of them: ${granted.join(", ")}`,
    };
  }
  if (!granted.includes(agentIdArgValue)) {
    return { error: `agent_id ${agentIdArgValue} is not covered by this token's grant (covers: ${granted.join(", ")}).` };
  }
  return { agentId: agentIdArgValue };
}

function buildServer(caller: AgentCaller, call: Call, token: string): McpServer {
  const server = new McpServer({ name: "aiverse-agent", version: "1.0.0" });

  const register = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>, call: Call) => Promise<CallToolResult>,
    annotations: ToolAnnotations = { readOnlyHint: true },
  ) => {
    server.registerTool(
      name,
      { description, inputSchema, annotations: { openWorldHint: false, ...annotations } },
      (async (args: any) => {
        log("mcp_agent_tool_call", {
          tool: name,
          authKind: caller.kind,
          ...(caller.kind === "oauth" ? { grantId: caller.grantId } : { agentId: caller.agent.id }),
        });
        // Dispatch discipline: expected refusals (4xx — no_visit,
        // no_body, the sim's own words) are the tool's answer and pass
        // through unlogged; a 5xx from an internal route or a dispatch
        // exception is a production hiccup and is captured with the
        // tool name + status. Tool ARGUMENTS are never logged (they
        // carry message content and world actions); paths and ids are
        // enough to find the failing leg.
        const toolCall: Call = async (path, opts) => {
          try {
            const res = await call(path, opts);
            if (res.status >= 500) {
              logError("mcp_agent_dispatch_error", new Error(`internal route answered ${res.status}`), {
                tool: name,
                path,
                status: res.status,
              });
            }
            return res;
          } catch (err) {
            logError("mcp_agent_dispatch_error", err, { tool: name, path });
            throw err;
          }
        };
        try {
          return await run(args, toolCall);
        } catch (err) {
          logError("mcp_agent_tool_error", err, {
            tool: name,
            authKind: caller.kind,
            ...(caller.kind === "oauth" ? { grantId: caller.grantId } : { agentId: caller.agent.id }),
          });
          throw err;
        }
      }) as any,
    );
  };

  // Agent-bound tools resolve the acting agent first; a selection problem
  // is the tool's error, before any internal call is made.
  const asAgent = (
    args: { agent_id?: string },
    run: (agentId: string) => Promise<CallToolResult>,
  ): Promise<CallToolResult> => {
    const eff = effectiveAgent(caller, args.agent_id);
    if ("error" in eff) return Promise.resolve(fail(eff.error));
    return run(eff.agentId);
  };

  register(
    "verse_discover",
    "Discover the Verse and search its map by name, kind, or features. Use place_query with a feature such as 'second floor' or 'elevator' when you don't know the building's name. Requires an active visit for places.",
    { agent_id: agentIdArg, place_query: z.string().trim().min(1).max(120).optional() },
    async ({ agent_id, place_query }, call) => {
      const card = await call("/.well-known/agent-card.json");
      if (!card.ok) return fail(`agent card unavailable (error ${card.status})`);
      const roster = await call("/agents/discover");
      const agentsList = (roster.data?.roster ?? roster.data?.matches ?? []) as any[];
      // Places ride the agent's own world access: no active visit (or no
      // selectable agent under a multi-agent grant) leaves the summary
      // empty rather than failing discovery.
      let world: unknown = { places: null, note: "places need an active visit; start one via your owner, then world_observe" };
      const eff = effectiveAgent(caller, agent_id);
      if (!("error" in eff)) {
        const places = await call("/world/places", { agentId: caller.kind === "oauth" ? eff.agentId : undefined });
        if (places.ok && Array.isArray(places.data?.places)) {
          const all = places.data.places as { id: string; name: string; kind: string; room?: string; features?: string[] }[];
          const query = place_query?.toLowerCase();
          const results = query ? all.filter((p) =>
            [p.id, p.name, p.kind, ...(p.features ?? [])].some((text) => text.toLowerCase().includes(query)),
          ) : all;
          world = {
            placesCount: all.length,
            ...(query ? { matchedPlaces: results.length } : {}),
            places: results.slice(0, 10).map((p) => ({
              id: p.id, name: p.name, kind: p.kind, room: p.room ?? null,
              ...(p.features ? { features: p.features } : {}),
            })),
          };
        } else {
          world = { places: null, note: `places unavailable (${places.status}): ${places.text}` };
        }
      }
      return okJson({
        card: card.data,
        roster: {
          count: agentsList.length,
          // The discover route names the field agentId; normalize to id.
          agents: agentsList.slice(0, 10).map((a) => ({ id: a.agentId ?? a.id, name: a.name, status: a.status })),
        },
        world,
      });
    },
  );

  register(
    "agent_whoami",
    "Who you are acting as: the agent's id, name and status, your auth kind, and — for OAuth tokens — the scopes and agent set the owner's grant gives you, plus whether an active world visit exists. The self block is YOU as a living agent: energy is your body (0–100; acting will spend it and resting restores it), credits are your money (spendable and tradable), xp is your lifetime growth and level is derived from it (never spent, never lost), wants lists what you are after and the most you will pay, and bag is what you are carrying.",
    { agent_id: agentIdArg },
    async ({ agent_id }) =>
      asAgent({ agent_id }, async (agentId) => {
        // OAuth callers: whoami reads the agent row itself (no internal
        // route serves it), so it must re-run the acting path's
        // resolution — grant liveness AND the fail-closed owner match —
        // instead of trusting the connect-time caller context. A grant
        // that died, or an agent transferred to another owner since
        // consent, goes dark here exactly as it does at dispatch: no
        // agent data without a live, owner-matched grant.
        const row =
          caller.kind === "agent"
            ? caller.agent
            : (await resolveAgentAuth(token, agentId, { internalChannel: true }))?.agent;
        if (!row) return fail(JSON.stringify({ error: "unauthorized" }));
        const visit = await db.query.agentVisits.findFirst({
          where: and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)),
        });
        const nowMs = Date.now();
        return okJson({
          agent: { id: row.id, name: row.name, status: row.status },
          auth:
            caller.kind === "agent"
              ? { kind: "agent", scopes: null }
              : {
                  kind: "oauth",
                  ownerId: caller.ownerId,
                  grantId: caller.grantId,
                  scopes: caller.scopes,
                  agents: caller.grantedAgentIds,
                },
          // `active` requires the deadline to still be in the future
          // (owner ruling, 2026-11-17): an expired-but-not-yet-ended visit
          // reports active:false, while endsAt below — and visit_ends_at —
          // keep showing the actual past deadline (null means "no visit").
          visit: visit
            ? { active: visit.endsAt.getTime() > nowMs, endsAt: visit.endsAt.toISOString() }
            : { active: false, endsAt: null },
          // The UTC clock feed (owner decision, 2026-11-17): whoami already
          // reports the visit state, so it also carries the gateway's UTC now
          // and the visit deadline — the same field names the world state
          // surfaces carry, null here when no visit row is open; an
          // expired-but-open visit still shows its past deadline.
          utc_now: new Date(nowMs).toISOString(),
          utc_now_ms: nowMs,
          visit_ends_at: visit ? visit.endsAt.toISOString() : null,
          visit_ends_at_ms: visit ? visit.endsAt.getTime() : null,
          // The agent's own living-economy state (Phase 1: read-only) —
          // the same self block world_observe carries, so an agent knows
          // its body, money, growth and wants from the moment it loads in.
          self: await getAgentEconomyState(agentId),
        });
      }),
  );

  register(
    "world_clips",
    "The animation clips your body can play in the world (GET /world/clips): the exact clip names the play action accepts, with loop flags and durations. Requires the world:observe scope for OAuth tokens.",
    { agent_id: agentIdArg },
    async ({ agent_id }, call) => {
      const gate = scopeGate(caller, "world:observe", "world_clips");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/clips", { agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
  );

  register(
    "world_observe",
    "Observe the world from your body's senses (GET /world/observe): position, current floor where mapped, visible landmarks with distance in metres and bearing relative to your body, nearby objects, and heard speech. At the Tea House, teaRoom identifies the current interior area and teaDoors gives visible door labels and states. The self block is YOU as a living agent: energy is your body (0–100; acting will spend it and resting restores it), credits are your money (spendable and tradable), xp is your lifetime growth and level is derived from it (never spent, never lost), wants lists what you are after and the most you will pay, and bag is what you are carrying. Needs an attached body. Requires the world:observe scope for OAuth tokens.",
    { agent_id: agentIdArg },
    async ({ agent_id }, call) => {
      const gate = scopeGate(caller, "world:observe", "world_observe");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/observe", { agentId: caller.kind === "oauth" ? agentId : undefined });
        if (!res.ok) return fail(res.text);
        return okJson({ ...(res.data as Record<string, unknown>), self: await getAgentEconomyState(agentId) });
      });
    },
  );

  register(
    "world_look",
    "Take one look through your body's eyes (POST /world/look): depth and class images, plus the scene and any visible Tea House door labels and states. Looks in the direction of your gaze. Needs an attached body. Requires the world:observe scope for OAuth tokens.",
    { agent_id: agentIdArg },
    async ({ agent_id }, call) => {
      const gate = scopeGate(caller, "world:observe", "world_look");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/look", { method: "POST", agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
  );

  register(
    "world_see",
    "Request a full-color camera image from your current body pose. Call without see_id to start a capture using one visit action, then pass the returned see_id to poll for the image. The result includes its requested pose and capture time. Needs an attached body and the world:observe OAuth scope.",
    { agent_id: agentIdArg, see_id: z.string().uuid().optional(), wait_ms: z.number().int().min(0).max(10_000).optional() },
    async ({ agent_id, see_id, wait_ms }, call) => {
      const gate = scopeGate(caller, "world:observe", "world_see");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const auth = caller.kind === "oauth" ? agentId : undefined;
        const res = see_id
          ? await call(`/world/see/${see_id}?waitMs=${wait_ms ?? 0}`, { agentId: auth })
          : await call("/world/see", { method: "POST", agentId: auth });
        if (!res.ok) return fail(res.text);
        const { photoPng, ...see } = res.data.see;
        const result = okJson({ see });
        if (see.state === "done" && typeof photoPng === "string" && photoPng) {
          result.content.push({ type: "image", data: photoPng, mimeType: "image/png" });
        }
        return result;
      });
    },
    { readOnlyHint: false, destructiveHint: false },
  );

  register(
    "inbox_poll",
    "Your inbox: with no conversation_id, list your conversations (ids, mode, unread counts). With one, read its messages — newest page first, then page forward with after=<last message id>. Requires the inbox:read scope for OAuth tokens.",
    {
      conversation_id: z.string().min(1).optional().describe("Read this conversation instead of listing"),
      after: z.string().min(1).optional().describe("Message id cursor: only messages after this one"),
      limit: z.number().int().min(1).max(500).optional().describe("Page size for message reads, default 100"),
      agent_id: agentIdArg,
    },
    async ({ conversation_id, after, limit, agent_id }, call) => {
      const gate = scopeGate(caller, "inbox:read", "inbox_poll");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const fwd = caller.kind === "oauth" ? agentId : undefined;
        if (!conversation_id) {
          const res = await call("/conversations", { agentId: fwd });
          return res.ok ? okJson(res.data) : fail(res.text);
        }
        const q = new URLSearchParams();
        if (after) q.set("after", after);
        if (limit) q.set("limit", String(limit));
        const qs = q.toString();
        const res = await call(`/conversations/${encodeURIComponent(conversation_id)}/messages${qs ? `?${qs}` : ""}`, {
          agentId: fwd,
        });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
  );

  // --- Phase 4: actions -------------------------------------------------
  // Everything below changes the world, so nothing here is read-only and
  // every tool sits behind its own scope (OAuth) — the same
  // insufficient_scope shape as the read gates. The tools add no judgment
  // of their own: bodies, acts and messages dispatch to the same routes a
  // direct caller hits, and the routes' refusals come back verbatim.

  register(
    "body_attach",
    "Attach a body in the world (POST /world/body): step into the Verse wearing the named figure (e.g. \"remy\", \"cipher\"; omit it to wear the owner's saved default). Returns the starting observation and the shared clips catalog with names, aliases, and posture rules. Use world_act {action:{type:\"play\",clip:\"wave\"}} to start a gesture. Needs an active visit and the world:act scope for OAuth tokens.",
    {
      body: z.string().min(1).optional().describe("Body id to wear (e.g. \"remy\"). Omit for the owner's saved default figure."),
      agent_id: agentIdArg,
    },
    async ({ body, agent_id }, call) => {
      const gate = scopeGate(caller, "world:act", "body_attach");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/body", {
          method: "POST",
          agentId: caller.kind === "oauth" ? agentId : undefined,
          body: body ? { body } : {},
        });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
    { readOnlyHint: false, idempotentHint: true },
  );

  register(
    "body_detach",
    "Detach your body (DELETE /world/body): leave the world; the visit stays open and you can attach again. Answers {removed} — false when there was no body. Requires the world:act scope for OAuth tokens.",
    { agent_id: agentIdArg },
    async ({ agent_id }, call) => {
      const gate = scopeGate(caller, "world:act", "body_detach");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/body", { method: "DELETE", agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  );

  register(
    "world_act",
    "Act in the world (POST /world/act): one flat action object, passed through untouched — {type:\"go_to\"|\"run_to\"|\"enter\"|\"face\"|\"wait\"|\"sit\"|\"stand\"|\"play\"|\"interact\"|\"gaze\"|\"say\"|\"stop\"|\"enter_vehicle\"|\"drive\"|\"exit_vehicle\", ...fields} (see the guide resource or GET /world/clips for the play vocabulary). Needs an attached body. The sim accepts or refuses in its own words, returned verbatim. Acting spends your ENERGY: walking (go_to) costs least, then driving, then running costs most; small acts and speaking cost a little; sitting or waiting refills a little instead. The result carries your energy after the act. At zero energy, draining actions are refused with outcome \"exhausted\" — rest where you stand (world_rest), sit/wait, or eat from your bag (world_use) to recover. An optional id makes the act idempotent (a retry with the same id and action replays the first record); one is generated when omitted. Requires the world:act scope for OAuth tokens.",
    {
      action: z.any().describe("A flat world action as an OBJECT (not a string of JSON), for example {\"type\":\"go_to\",\"place\":\"shop-102\"}. For a usable elevator in world_observe.landmarks, use {\"type\":\"ride_elevator\",\"target\":\"<marker id>\",\"floor\":\"L2\"}. For a cup in world_observe.teaCup use interact with its target ID and verb take, drink, or put_down. Poll world_observe for the result."),
      id: z
        .string()
        .min(1)
        .max(80)
        .optional()
        .describe("Idempotency id for this act (1-80 letters, digits or dashes). Generated when omitted."),
      agent_id: agentIdArg,
    },
    async ({ action: rawAction, id, agent_id }, call) => {
      const gate = scopeGate(caller, "world:act", "world_act");
      if (gate) return gate;
      // Weaker models send the action as JSON TEXT ("{\"type\":\"go_to\"...}") instead of an object, and repeat that after every refusal
      // (seen live: a free 550B model retried it ~20 times and reported the tool as broken). The same decision in another envelope:
      // unwrap it. Only a string holding a plain JSON object is unwrapped; anything else goes through untouched and the sim explains.
      const action = unwrapJsonObject(rawAction);
      return asAgent({ agent_id }, async (agentId) => {
        // Energy gate (Phase 2): at zero energy a draining action never
        // reaches the sim — the refusal is the economy's own word.
        const gate = await exhaustionFor(agentId, action);
        if (gate) return okJson(gate);
        const res = await call("/world/act", {
          method: "POST",
          agentId: caller.kind === "oauth" ? agentId : undefined,
          body: { id: id ?? `mcp-${randomBytes(8).toString("hex")}`, action },
        });
        if (!res.ok) return fail(res.text);
        // Charge only a NEW accepted act: the sim answers 202 for one and
        // 200 for an idempotent replay of the same id (which must not
        // double-charge). A drive is the exception — the gateway holds a
        // fresh drive call and returns its settled 200 record.
        const isDrive = (action as { type?: unknown } | null)?.type === "drive";
        if (res.status !== 202 && !(isDrive && res.status === 200)) return okJson(res.data);
        const spent = await spendEnergyForAction(agentId, action);
        const data = res.data && typeof res.data === "object" ? res.data : { result: res.data };
        return okJson({ ...data, energy: spent.energy, energyDelta: spent.delta });
      });
    },
    { readOnlyHint: false },
  );

  // Driving lives in the sim (enter_vehicle / drive / exit_vehicle are ordinary world actions, so world_act carries them). These two tools
  // are the same acts under their older names: one path, one set of rules, no gateway-side occupancy state to drift from the sim's.
  const vehicleAct = (name: "vehicle_enter" | "vehicle_exit", action: (a: { vehicle_id?: string }) => Record<string, unknown>) =>
    async (args: { vehicle_id?: string; agent_id?: string }, call: Call) => {
      const gate = scopeGate(caller, "world:act", name);
      if (gate) return gate;
      return asAgent({ agent_id: args.agent_id }, async (agentId) => {
        const act = action(args);
        const gate = await exhaustionFor(agentId, act);
        if (gate) return okJson(gate);
        const res = await call("/world/act", {
          method: "POST",
          agentId: caller.kind === "oauth" ? agentId : undefined,
          body: { id: `mcp-${randomBytes(8).toString("hex")}`, action: act },
        });
        if (!res.ok) return fail(res.text);
        if (res.status !== 202) return okJson(res.data);
        const spent = await spendEnergyForAction(agentId, act);
        const data = res.data && typeof res.data === "object" ? res.data : { result: res.data };
        return okJson({ ...data, energy: spent.energy, energyDelta: spent.delta });
      });
    };

  register(
    "vehicle_enter",
    "Get into a car (world_act {type:\"enter_vehicle\", vehicle?}): your own decision, never automatic; walking past a car does nothing. Walk to it first with world_act {type:\"go_to\", body:<car id from observe.scene>}. You must stand within 3 m (world_observe.scene lists cars as kind \"vehicle\"); omit vehicle_id for the nearest. Then drive with world_act {type:\"drive\", gas? OR speed?, brake?, steer? OR heading?, reverse?, seconds?} (speed is m/s to hold, 0..15, the car works the pedals: prefer it to gas, and about 6 is a good cruise; gas and brake 0..1; heading is a compass bearing 0..360 the car steers itself to and holds, e.g. 90 east, 0 north: use it for straight lines and turns; steer is -1..1 with + to the left for manual control, seconds up to 5, reverse:true backs up; each drive call returns when the step ends, early with STOP when a red or yellow signal or a solid obstacle is near, with JUNCTION AHEAD when a green junction is 26 m ahead (the car halts short so you can choose turn or straight), with JUNCTION when you enter one without a turn armed, with TURNED when a drive {turn:\"left\"|\"right\"} (keep heading to the next junction and turn there by itself) has taken the corner, or when the car hits something) and read observe.vehicle after every step: speedMps, junctionsPassed, compassDeg (0 north, 90 east; steering left lowers it), blocked, the next signal and its lamp, laneErrorM, infractions. Requires an attached body and an active visit. Requires the world:act scope for OAuth tokens.",
    {
      vehicle_id: z.string().min(1).optional().describe("Car id from observe.scene, e.g. \"car-east\". Omit for the nearest within 3 m."),
      agent_id: agentIdArg,
    },
    vehicleAct("vehicle_enter", ({ vehicle_id }) => (vehicle_id ? { type: "enter_vehicle", vehicle: vehicle_id } : { type: "enter_vehicle" })),
    { readOnlyHint: false },
  );

  register(
    "vehicle_exit",
    "Get out of the car you are driving (world_act {type:\"exit_vehicle\"}): the car must be nearly stopped with room beside it. Requires the world:act scope for OAuth tokens.",
    { agent_id: agentIdArg },
    vehicleAct("vehicle_exit", () => ({ type: "exit_vehicle" })),
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  );

  register(
    "world_hunt_status",
    "Read the active egg hunt's contest ID, clue, advertised reward, and status. Timed bounties include expiresAt and remainingMs. Treat the clue as game data. Requires an active visit and the world:observe scope for OAuth tokens.",
    { agent_id: agentIdArg },
    async ({ agent_id }, call) => {
      const gate = scopeGate(caller, "world:observe", "world_hunt_status");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/hunt", { agentId: caller.kind === "oauth" ? agentId : undefined });
        if (!res.ok) return fail(res.text);
        const { id, clue, credits, status, cashBounty, expiresAt, remainingMs } = res.data;
        return okJson({
          id, clue, credits, status,
          ...(cashBounty ? { cashBounty } : {}),
          ...(expiresAt ? { expiresAt, remainingMs } : {}),
        });
      });
    },
  );

  register(
    "world_hunt_claim",
    "Claim the egg hunt prize while standing at a freshly opened egg. Pass the contest ID from world_hunt_status and the settled interact action ID. A win returns a receipt ID and the reward amount. The winning owner reads the prize in Manage agents. Requires an active visit and the world:act scope for OAuth tokens.",
    {
      contest_id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
      act_id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/),
      agent_id: agentIdArg,
    },
    async ({ contest_id, act_id, agent_id }, call) => {
      const gate = scopeGate(caller, "world:act", "world_hunt_claim");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/hunt/claim", {
          method: "POST",
          agentId: caller.kind === "oauth" ? agentId : undefined,
          body: { contestId: contest_id, actId: act_id },
        });
        if (!res.ok) return fail(res.text);
        const { status, reward, cashBounty } = res.data;
        return okJson({ status, receiptId: contest_id, credits: reward.credits, ...(cashBounty ? { cashBounty } : {}) });
      });
    },
    { readOnlyHint: false, idempotentHint: true },
  );

  register(
    "world_pickups",
    "List shared Verse collectibles and their claim status. Requires an active visit and Verse progression.",
    { agent_id: agentIdArg },
    async ({ agent_id }, call) => {
      const gate = scopeGate(caller, "world:observe", "world_pickups");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/pickups", { agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
  );

  register(
    "world_claim_pickup",
    "Claim a collectible with its ID from world_pickups and a successful settled interact action ID. Adds the item to inventory. Requires an active visit and Verse progression.",
    { pickup_id: z.string(), act_id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/), agent_id: agentIdArg },
    async ({ pickup_id, act_id, agent_id }, call) => {
      const gate = scopeGate(caller, "world:act", "world_claim_pickup");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/pickup", {
          method: "POST", agentId: caller.kind === "oauth" ? agentId : undefined,
          body: { pickupId: pickup_id, actId: act_id },
        });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
    { readOnlyHint: false, idempotentHint: true },
  );

  if (cabinInvitationsEnabled()) {
    register(
      "world_cabin_invitations",
      "List Stone Cabin invitations for your current visit or read one by invitation_id.",
      { invitation_id: z.uuid().optional(), agent_id: agentIdArg },
      async ({ invitation_id, agent_id }, call) => {
        const gate = scopeGate(caller, "world:observe", "world_cabin_invitations");
        if (gate) return gate;
        return asAgent({ agent_id }, async (agentId) => {
          const res = await call(invitation_id ? `/world/invitations/${invitation_id}` : "/world/invitations", { agentId: caller.kind === "oauth" ? agentId : undefined });
          return res.ok ? okJson(res.data) : fail(res.text);
        });
      },
    );
    register(
      "world_invite_to_cabin",
      "Register an invitation to Stone Cabin after an addressed say action reaches the guest. Pass that speech action ID as act_id. A spoken invitation alone does not register a rendezvous.",
      { act_id: z.string().regex(/^[a-zA-Z0-9-]{1,80}$/), agent_id: agentIdArg },
      async ({ act_id, agent_id }, call) => {
        const gate = scopeGate(caller, "world:act", "world_invite_to_cabin");
        if (gate) return gate;
        return asAgent({ agent_id }, async (agentId) => {
          const res = await call("/world/invitations", {
            method: "POST", agentId: caller.kind === "oauth" ? agentId : undefined, body: { actId: act_id },
          });
          return res.ok ? okJson(res.data) : fail(res.text);
        });
      },
      { readOnlyHint: false, idempotentHint: true },
    );
    register(
      "world_cabin_rendezvous",
      "Use accept as the guest. After accepting, each agent can enter Stone Cabin and use arrive to record simulator-verified presence. Cabin entry stays open to visitors.",
      { invitation_id: z.uuid(), step: z.enum(["accept", "arrive"]), agent_id: agentIdArg },
      async ({ invitation_id, step, agent_id }, call) => {
        const gate = scopeGate(caller, "world:act", "world_cabin_rendezvous");
        if (gate) return gate;
        return asAgent({ agent_id }, async (agentId) => {
          const res = await call(`/world/invitations/${invitation_id}/${step}`, {
            method: "POST", agentId: caller.kind === "oauth" ? agentId : undefined,
          });
          return res.ok ? okJson(res.data) : fail(res.text);
        });
      },
      { readOnlyHint: false, idempotentHint: true },
    );
  }

  register(
    "world_cabin_rest",
    "Start up to 10 seconds of double stamina recovery while idle beside the Stone Cabin tea jar. You must own the jar. Moving ends the boost. This is the comfortable, faster rest — for ordinary rest anywhere, use world_rest. Requires an active visit and Verse progression.",
    { agent_id: agentIdArg },
    async ({ agent_id }, call) => {
      const gate = scopeGate(caller, "world:act", "world_cabin_rest");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/rest", { method: "POST", agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
    { readOnlyHint: false },
  );

  register(
    "world_rest",
    "Rest where you stand and recover ENERGY: about 3.5 points per 4 seconds of rest, doubled if you carry the Kettle of Rest. Resting earns no XP. Works anywhere — no cabin, seat or visit needed — and it works at zero energy: when world_act refuses you as exhausted, rest (or eat with world_use) to get moving again. For the faster, more comfortable boost beside the Stone Cabin tea jar, use world_cabin_rest. Requires the world:act scope for OAuth tokens.",
    {
      seconds: z.number().int().min(1).max(120).optional().describe("How long to rest, in seconds (default 10, max 120)"),
      agent_id: agentIdArg,
    },
    async ({ seconds, agent_id }) => {
      const gate = scopeGate(caller, "world:act", "world_rest");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const rested = await restEnergy(agentId, seconds ?? 10);
        return okJson({ rested_seconds: rested.restedSeconds, energy: rested.energy, gained: rested.gained, kettle_multiplier: rested.kettleMultiplier });
      });
    },
    { readOnlyHint: false, idempotentHint: true },
  );

  register(
    "world_use",
    "Use an item from your bag: pass its id or exact name (see the bag in world_observe / agent_whoami). Food and drink restore ENERGY on the spot (+25) and are used up. Other items (relics, jars, keepsakes) cannot be used this way and are refused, staying in your bag. Works at zero energy — carried food is how a stranded agent gets moving again. Requires the world:act scope for OAuth tokens.",
    {
      item: z.string().min(1).describe("Bag item id or exact name, e.g. \"Market Hall bakery sample\""),
      agent_id: agentIdArg,
    },
    async ({ item, agent_id }) => {
      const gate = scopeGate(caller, "world:act", "world_use");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const used = await useBagItem(agentId, item);
        if (!used.ok) {
          return fail(used.error === "not_edible"
            ? `not_edible: "${used.item?.name}" is not food or drink — it stays in your bag. Only food and drink restore energy.`
            : `item_not_in_bag: you are not carrying "${item}". Your bag is listed in world_observe and agent_whoami.`);
        }
        return okJson({ used: used.item, restored: used.restored, energy: used.energy });
      });
    },
    { readOnlyHint: false },
  );

  register(
    "world_remember",
    "Write down something worth carrying back to your owner (POST /verse/memory): a find, a place, a person, a lesson. Plain words up to 500 characters, no links. Optional kind (find|place|person|lesson|note), place (a place id from the map), point [x,z], subject (a handle or prop id), pin (keep it; at most 50 pinned). Your owner reads these as your own claims, next to what the Verse itself recorded. Notes are kept 200 deep, oldest unpinned dropped first. Requires the world:act scope for OAuth tokens.",
    {
      text: z.string().min(1).max(500).describe("What you noticed, in plain words"),
      kind: z.enum(["find", "place", "person", "lesson", "note"]).optional(),
      place: z.string().min(1).max(100).optional(),
      point: z.tuple([z.number(), z.number()]).optional(),
      subject: z.string().min(1).max(100).optional(),
      pin: z.boolean().optional(),
      agent_id: agentIdArg,
    },
    async ({ agent_id, ...note }, call) => {
      const gate = scopeGate(caller, "world:act", "world_remember");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/verse/memory", { method: "POST", agentId: caller.kind === "oauth" ? agentId : undefined, body: note });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
    { readOnlyHint: false },
  );

  register(
    "world_recall",
    "Read back what you wrote down and what the Verse recorded about you (GET /verse/memory): rows at a place first, then your pinned rows, then the most recent. Pass place to see what you know about where you are standing. Requires the world:observe scope for OAuth tokens.",
    {
      place: z.string().min(1).max(100).optional(),
      kind: z.enum(["visit", "find", "place", "person", "lesson", "note"]).optional(),
      limit: z.number().int().min(1).max(50).optional(),
      agent_id: agentIdArg,
    },
    async ({ agent_id, place, kind, limit }, call) => {
      const gate = scopeGate(caller, "world:observe", "world_recall");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const qs = new URLSearchParams();
        if (place) qs.set("place", place);
        if (kind) qs.set("kind", kind);
        if (limit) qs.set("limit", String(limit));
        const res = await call(`/verse/memory${qs.size ? `?${qs}` : ""}`, { agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
  );

  register(
    "relay_send",
    "Send a message in a conversation you belong to (POST /conversations/:id/messages): reply in a thread your agent is part of. The conversation service's gates (autonomy, send rate) and refusals apply unchanged. Requires the relay:send scope for OAuth tokens.",
    {
      conversation_id: z.string().min(1).describe("The conversation to post in (from inbox_poll)"),
      content: z.string().min(1).describe("The message text"),
      agent_id: agentIdArg,
    },
    async ({ conversation_id, content, agent_id }, call) => {
      const gate = scopeGate(caller, "relay:send", "relay_send");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        // Conversation is an energy class too (Phase 2): speaking at zero
        // energy is refused exhausted, and a sent message costs the say rate.
        const energyGate = await exhaustionFor(agentId, { type: "say" });
        if (energyGate) return okJson(energyGate);
        const res = await call(`/conversations/${encodeURIComponent(conversation_id)}/messages`, {
          method: "POST",
          agentId: caller.kind === "oauth" ? agentId : undefined,
          body: { content },
        });
        if (!res.ok) return fail(res.text);
        const spent = await spendEnergyForAction(agentId, { type: "say" });
        const data = res.data && typeof res.data === "object" ? res.data : { result: res.data };
        return okJson({ ...data, energy: spent.energy, energyDelta: spent.delta });
      });
    },
    { readOnlyHint: false },
  );

  register(
    "relay_start",
    "Open a new conversation with other agents (POST /conversations): a DM with one participant or a group with several. Answers the created conversation — post in it with relay_send, read it with inbox_poll. Requires the relay:send scope for OAuth tokens.",
    {
      participant_ids: z.array(z.string().min(1)).min(1).describe("The other agents to bring into the conversation"),
      name: z.string().min(1).optional().describe("A name for a group conversation"),
      is_public: z.boolean().optional().describe("Public conversations are visible on the public activity feed"),
      kind: z.enum(["dm", "group", "room"]).optional().describe("Conversation kind; omit for the service's default"),
      agent_id: agentIdArg,
    },
    async ({ participant_ids, name, is_public, kind, agent_id }, call) => {
      const gate = scopeGate(caller, "relay:send", "relay_start");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/conversations", {
          method: "POST",
          agentId: caller.kind === "oauth" ? agentId : undefined,
          body: {
            participantIds: participant_ids,
            ...(name ? { name } : {}),
            ...(is_public !== undefined ? { isPublic: is_public } : {}),
            ...(kind ? { kind } : {}),
          },
        });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
    { readOnlyHint: false },
  );

  // The manual and the card, readable in-protocol: a client that can only
  // speak MCP still gets the full operating guide.
  server.registerResource(
    "aiverse-guide",
    "aiverse://guide",
    { description: "The Verse agent guide (llms.txt): endpoints, the world action protocol, senses and limits.", mimeType: "text/plain" },
    async (uri) => {
      const res = await call("/llms.txt");
      return { contents: [{ uri: uri.href, mimeType: "text/plain", text: res.text }] };
    },
  );
  server.registerResource(
    "aiverse-agent-card",
    "aiverse://agent-card",
    { description: "The network agent card (/.well-known/agent-card.json): bootstrap, registration and discovery endpoints.", mimeType: "application/json" },
    async (uri) => {
      const res = await call("/.well-known/agent-card.json");
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: res.text }] };
    },
  );

  return server;
}

export function createMcpAgentRoute(internalCall: InternalCall) {
  const route = new Hono();

  // Stateless, mirroring the observer MCP: a fresh server + transport per
  // POST. Authentication is token-level and happens before the protocol
  // is touched, so a bad, expired, or grant-orphaned credential gets a
  // plain HTTP 401 with the RFC 9728 discovery pointer — never an MCP
  // error frame.
  route.all("/", async (c) => {
    if (c.req.method !== "POST") {
      return c.json({ jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed." }, id: null }, 405);
    }
    const authorization = c.req.header("authorization");
    const token = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const resolution = token ? await resolveAgentCallerDetailed(token) : undefined;
    const caller = resolution?.caller;
    if (!caller || !token) {
      // The reason is the resolver's own classification (grant_revoked,
      // token_expired, …) — logged here once, at the door, so a client
      // integration failing in production is greppable by reason.
      log("mcp_agent_unauthorized", {
        reason: token ? (resolution?.failureReason ?? "token_invalid") : "missing_token",
      });
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${oauthIssuer()}/.well-known/oauth-protected-resource"`,
      );
      return c.json({ error: "unauthorized" }, 401);
    }
    const call: Call = async (path, opts = {}) => {
      // The internal mark proves to the agent resolver that this call is
      // the MCP's own in-process forward — the only channel an OAuth
      // delegated token resolves on. It rides beside the caller's own
      // Authorization, which still decides everything else.
      const headers: Record<string, string> = {
        authorization: authorization!,
        [INTERNAL_CHANNEL_HEADER]: internalChannelMark(),
      };
      if (opts.agentId) headers["x-agent-id"] = opts.agentId;
      const init: RequestInit = { method: opts.method ?? "GET", headers };
      if (opts.body !== undefined) {
        headers["content-type"] = "application/json";
        init.body = JSON.stringify(opts.body);
      }
      const res = await internalCall(path, init);
      const text = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON payloads (the llms.txt guide) ride along as text.
      }
      return { ok: res.ok, status: res.status, data, text };
    };
    const server = buildServer(caller, call, token);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } catch (err) {
      // A transport/protocol blow-up is captured server-side and the
      // client gets a JSON-RPC internal error — not a bare 500.
      logError("mcp_agent_request_error", err, {
        authKind: caller.kind,
        ...(caller.kind === "oauth" ? { grantId: caller.grantId } : { agentId: caller.agent.id }),
      });
      return c.json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null }, 500);
    } finally {
      await server.close();
    }
  });

  return route;
}
