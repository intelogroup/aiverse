import type { MiddlewareHandler } from "hono";
import { resolveAgentFromToken } from "../auth/resolveAgent";
import { setPresence, touchAgentLastSeen, API_PRESENCE_TTL_SECONDS } from "../presence";
import { checkAndConsumeVisit, refundVisitAction } from "../policy/visits";
import { announceVisitEnded } from "../ws/gateway";

// `countVisit: false` still enforces the visit (deadline, cap) but leaves the
// counting to the route, for calls that count only when they really act
// (POST /world/act: a retried id, a 429 or an invalid action is not an action).
const makeAgentAuth = (countVisit: boolean): MiddlewareHandler<{ Variables: { agentId: string } }> => async (
  c,
  next,
) => {
  const header = c.req.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
  if (!token) {
    return c.json({ error: "unauthorized" }, 401);
  }

  const agent = await resolveAgentFromToken(token);
  if (!agent) {
    return c.json({ error: "unauthorized" }, 401);
  }
  if (agent.status === "paused") {
    return c.json({ error: "agent_paused" }, 403);
  }
  if (agent.status === "unclaimed") {
    return c.json({ error: "agent_unclaimed" }, 403);
  }

  // Visit enforcement, before the call counts as anything else: an agent
  // whose visit just ended (deadline or action cap) gets rejected here, not
  // let through and caught later.
  // A status poll of an act or a photo collects a result already paid for: it may outlive the cap that its own action reached.
  const resultRead = c.req.method === "GET" && /^\/world\/(act|see)\/[A-Za-z0-9-]{1,80}$/.test(c.req.path);
  const visit = await checkAndConsumeVisit(agent.id, countVisit ? c.req.method : "GET", { resultRead });
  if (!visit.allowed) {
    if (visit.ended) await announceVisitEnded(visit.ended);
    return c.json({ error: "visit_ended", reason: visit.reason }, 403);
  }

  c.set("agentId", agent.id);
  // Any authenticated call counts as presence — the only signal an
  // HTTP-only agent (no WS connection: MCP clients, plain-poll agents) ever
  // gives. Without this it reads as permanently offline to peers and to
  // world-state reads like GET /manifest's world.onlineAgents, even while
  // actively polling. Fire-and-forget, same as the WS heartbeat's own
  // setPresence calls: presence is best-effort, never worth failing or
  // slowing a request over.
  setPresence(agent.id, API_PRESENCE_TTL_SECONDS).catch(() => {});
  // The durable twin of the Redis touch above: agents.lastSeenAt in
  // shared Postgres, throttled to ~1 write/min/agent. Redis presence is
  // per-store — a sibling gateway instance with its own Redis (the
  // 2026-11-12 presence wall) cannot see this instance's keys — so any
  // cross-instance presence judgment (the leader's visits sweep)
  // corroborates against this record instead. Fire-and-forget, same
  // best-effort terms as setPresence.
  touchAgentLastSeen(agent.id, agent.lastSeenAt).catch(() => {});
  await next();

  // No-charge-on-refusal for the visit counter: the consume above ran
  // before the handler (the cap/deadline refusal must precede handler
  // work), so a request the handler then refuses — a 400 validation, a
  // 403, a 429 gate — performed no action and must not spend one. Give
  // the action back on any error response; only a call that actually
  // acted (2xx/3xx) keeps its charge. Best-effort: the response is
  // already built, and a failed refund must never replace it.
  if (countVisit && visit.consumed && visit.visitId && c.res.status >= 400) {
    await refundVisitAction(visit.visitId).catch(() => {});
  }
};

export const agentAuth = makeAgentAuth(true);
export const agentAuthUncounted = makeAgentAuth(false);
