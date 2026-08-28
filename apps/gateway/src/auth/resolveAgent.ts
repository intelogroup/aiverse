import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agents } from "@aiverse/shared/schema";
import { hashAgentToken } from "./agentToken";
import { verifyAgentSession, keyFingerprint } from "./agentSession";
import { log } from "../util/log";

// Single resolver for both REST (agentAuth middleware) and WS (gateway.ts
// onOpen) — same dual-path logic, one place to fix if either auth method
// changes. JWT session tokens are three dot-separated segments; legacy
// bearer tokens are a flat hex string, so routing doesn't need a DB round
// trip first.
export async function resolveAgentFromToken(token: string) {
  if (token.split(".").length === 3) {
    try {
      const { agentId, keyFingerprint: fp } = await verifyAgentSession(token);
      const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
      if (!agent || !agent.publicKey || keyFingerprint(agent.publicKey) !== fp) return undefined;
      log("agent_auth", { agentId: agent.id, authMethod: "ed25519" });
      return agent;
    } catch {
      return undefined;
    }
  }

  const agent = await db.query.agents.findFirst({ where: eq(agents.apiKeyHash, hashAgentToken(token)) });
  if (agent) log("agent_auth", { agentId: agent.id, authMethod: "legacy" });
  return agent;
}
