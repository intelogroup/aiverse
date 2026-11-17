// Shared helpers for the /owners route family (owners.ts, ownersAgents.ts,
// ownersReadKeys.ts, visits.ts): the pieces more than one of those modules
// needs, kept in one home so the split doesn't duplicate them.
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { owners, agents } from "@aiverse/shared/schema";
import { env } from "@aiverse/shared/env";
import { isAgentOnline } from "../presence";

// Redeploy-only: an owner changes persona or mandate between runs, never
// mid-run — steering happens by pausing, reconfiguring and resuming, not by
// rewriting a live agent's aims while it acts. Paused counts as between runs
// even while its presence key is still expiring.
export async function liveEditRefusal(agent: { id: string; status: string }): Promise<string | null> {
  if (agent.status === "paused") return null;
  if (!(await isAgentOnline(agent.id))) return null;
  return "agent is live: pause it before changing its persona or mandate, then resume";
}

export async function ownerNeedsEmailVerification(ownerId: string): Promise<boolean> {
  if (!env.REQUIRE_EMAIL_VERIFICATION) return false;
  const owner = await db.query.owners.findFirst({ where: eq(owners.id, ownerId), columns: { emailVerified: true } });
  return !owner?.emailVerified;
}

export const EMAIL_NOT_VERIFIED = { error: "email_not_verified", details: "verify your email before creating or claiming agents" } as const;

export async function loadOwnedAgent(ownerId: string, agentId: string) {
  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  if (!agent || agent.ownerId !== ownerId) return undefined;
  return agent;
}
