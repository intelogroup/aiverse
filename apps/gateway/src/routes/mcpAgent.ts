import { Hono } from "hono";
import { and, eq, isNull } from "drizzle-orm";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { agentVisits, agents } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { resolveAgentCaller, type AgentCaller } from "../auth/resolveAgent";
import { oauthIssuer } from "../auth/oauthCore";
import { log } from "../util/log";

// The agent MCP (MCP + OAuth plan, Phase 3): how an outside LLM client —
// Claude, ChatGPT, a user's own harness — acts as an agent in the Verse
// without holding the agent's key. Read-mostly: discovery, identity, the
// world senses, and the inbox. Actions (world_act, body attach, relay
// send) are Phase 4 and deliberately absent.
//
// Auth is delegation-aware (auth/resolveAgent.ts): a classic agent token
// acts as its agent, exactly as at REST; an OAuth 2.1 access token acts
// within the owner's grant — audience-checked, grant-liveness-checked at
// connect (a revoked grant 401s here, not at JWT expiry), scope-gated per
// tool, and pinned to the grant's agent set. A multi-agent token picks its
// agent per call via the agent_id tool argument, forwarded to the internal
// routes as x-agent-id, where the resolver honors it only inside the
// grant. No tool can widen any of this: every read dispatches through the
// same internal routes a direct caller would hit, with the caller's own
// Authorization, so visit gating, refusal text and rate limits are the
// gateway's own, unchanged.
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

type Call = (path: string, opts?: { method?: string; agentId?: string }) => Promise<CallResult>;

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
function scopeGate(caller: AgentCaller, scope: string): CallToolResult | null {
  if (caller.kind !== "oauth") return null;
  if (caller.scopes.includes(scope)) return null;
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

function buildServer(caller: AgentCaller, call: Call): McpServer {
  const server = new McpServer({ name: "aiverse-agent", version: "1.0.0" });

  const register = <S extends z.ZodRawShape>(
    name: string,
    description: string,
    inputSchema: S,
    run: (args: z.infer<z.ZodObject<S>>) => Promise<CallToolResult>,
  ) => {
    server.registerTool(
      name,
      { description, inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } },
      (async (args: any) => {
        log("mcp_agent_tool_call", {
          tool: name,
          authKind: caller.kind,
          ...(caller.kind === "oauth" ? { grantId: caller.grantId } : { agentId: caller.agent.id }),
        });
        return run(args);
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
    "Discover the Verse: the network agent card (bootstrap endpoints, world info), how many agents are here, and a compact world summary (places, when your visit and the world allow). Start here when you arrive cold.",
    { agent_id: agentIdArg },
    async ({ agent_id }) => {
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
          const all = places.data.places as any[];
          world = {
            placesCount: all.length,
            places: all.slice(0, 10).map((p) => ({ id: p.id, name: p.name, kind: p.kind, room: p.room ?? null })),
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
    "Who you are acting as: the agent's id, name and status, your auth kind, and — for OAuth tokens — the scopes and agent set the owner's grant gives you, plus whether an active world visit exists.",
    { agent_id: agentIdArg },
    async ({ agent_id }) =>
      asAgent({ agent_id }, async (agentId) => {
        const row =
          caller.kind === "agent"
            ? caller.agent
            : await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
        if (!row) return fail(`agent ${agentId} no longer exists`);
        const visit = await db.query.agentVisits.findFirst({
          where: and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)),
        });
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
          visit: visit
            ? { active: true, endsAt: visit.endsAt.toISOString() }
            : { active: false, endsAt: null },
        });
      }),
  );

  register(
    "world_clips",
    "The animation clips your body can play in the world (GET /world/clips): the exact clip names the play action accepts, with loop flags and durations. Requires the world:observe scope for OAuth tokens.",
    { agent_id: agentIdArg },
    async ({ agent_id }) => {
      const gate = scopeGate(caller, "world:observe");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/clips", { agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
  );

  register(
    "world_observe",
    "Observe the world from your body's senses (GET /world/observe): where you are, what is near, what you can see and have heard. Needs an attached body — with none, the world's own no_body error comes back unchanged. Requires the world:observe scope for OAuth tokens.",
    { agent_id: agentIdArg },
    async ({ agent_id }) => {
      const gate = scopeGate(caller, "world:observe");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/observe", { agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
  );

  register(
    "world_look",
    "Take one look through your body's eyes (POST /world/look): depth + class images and the scene, as the world route returns them. Needs an attached body. Requires the world:observe scope for OAuth tokens.",
    { agent_id: agentIdArg },
    async ({ agent_id }) => {
      const gate = scopeGate(caller, "world:observe");
      if (gate) return gate;
      return asAgent({ agent_id }, async (agentId) => {
        const res = await call("/world/look", { method: "POST", agentId: caller.kind === "oauth" ? agentId : undefined });
        return res.ok ? okJson(res.data) : fail(res.text);
      });
    },
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
    async ({ conversation_id, after, limit, agent_id }) => {
      const gate = scopeGate(caller, "inbox:read");
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
    const caller = token ? await resolveAgentCaller(token) : undefined;
    if (!caller) {
      c.header(
        "WWW-Authenticate",
        `Bearer resource_metadata="${oauthIssuer()}/.well-known/oauth-protected-resource"`,
      );
      return c.json({ error: "unauthorized" }, 401);
    }
    const call: Call = async (path, opts = {}) => {
      const headers: Record<string, string> = { authorization: authorization! };
      if (opts.agentId) headers["x-agent-id"] = opts.agentId;
      const res = await internalCall(path, { method: opts.method ?? "GET", headers });
      const text = await res.text();
      let data: any = null;
      try {
        data = JSON.parse(text);
      } catch {
        // Non-JSON payloads (the llms.txt guide) ride along as text.
      }
      return { ok: res.ok, status: res.status, data, text };
    };
    const server = buildServer(caller, call);
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(c.req.raw);
    } finally {
      await server.close();
    }
  });

  return route;
}
