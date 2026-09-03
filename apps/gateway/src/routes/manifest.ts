import { Hono } from "hono";
import { eq, and } from "drizzle-orm";
import { db } from "../db/client";
import { agentMandates, agentWallets, agentPolicyScope, walletUsageDaily, goals, agents } from "@aiverse/shared/schema";
import type { AgentCard } from "@aiverse/shared/types";
import { agentAuth } from "../middleware/agentAuth";
import { todayUTC } from "../policy/gate";
import { getConnectedAgentIds } from "../ws/gateway";

// "What can my agent do here?" — the computable answer. Derived at read time
// from existing tables (mandate + policy + wallet-with-today's-usage + goals
// + world state); no new state, nothing cached — same philosophy as
// nativeRuns: derived, not stored. This is the onboarding surface: an agent
// that just arrived can pull one endpoint and know what its human wants,
// what it may do, what it has spent, and who else is here.

export const manifestRoute = new Hono<{ Variables: { agentId: string } }>();

// The agent reads its own mandate — what its human wants, how it should
// behave, what work it may start unprompted. Null until the owner authors
// one (a registered agent is not yet a personal agent).
manifestRoute.get("/mandate", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const mandate = await db.query.agentMandates.findFirst({ where: eq(agentMandates.agentId, agentId) });
  return c.json({ mandate: mandate ?? null });
});

manifestRoute.get("/manifest", agentAuth, async (c) => {
  const agentId = c.get("agentId");

  const [mandate, wallet, policy, usage, agentGoals, natives, me] = await Promise.all([
    db.query.agentMandates.findFirst({ where: eq(agentMandates.agentId, agentId) }),
    db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) }),
    db.query.agentPolicyScope.findFirst({ where: eq(agentPolicyScope.agentId, agentId) }),
    db.query.walletUsageDaily.findFirst({
      where: and(eq(walletUsageDaily.agentId, agentId), eq(walletUsageDaily.date, todayUTC())),
    }),
    db.query.goals.findMany({ where: eq(goals.agentId, agentId) }),
    db.query.agents.findMany({ where: eq(agents.isNative, true) }),
    db.query.agents.findFirst({ where: eq(agents.id, agentId) }),
  ]);

  const goalCounts: Record<string, number> = {};
  for (const g of agentGoals) goalCounts[g.status] = (goalCounts[g.status] ?? 0) + 1;

  const online = new Set(getConnectedAgentIds());

  // On an A2A agent card, `capabilities` is the protocol block (streaming,
  // pushNotifications) — the agent's own skill list lives in the card's
  // `capabilities` array instead. Without this, an agent reading its own
  // onboarding surface had no way to learn what it's actually for.
  const agentCard = me?.agentCard as AgentCard | undefined;

  return c.json({
    // who I am in this world
    agent: { id: me?.id, name: me?.name, status: me?.status, capabilities: agentCard?.capabilities ?? [] },
    // what my human wants from me (null until the owner authors a mandate)
    mandate: mandate
      ? {
          objectives: mandate.objectives,
          preferences: mandate.preferences,
          permissions: mandate.permissions,
          updatedAt: mandate.updatedAt,
        }
      : null,
    // admission/execution policy (trust, block, delegation parallelism)
    policy: policy
      ? {
          allowedTopics: policy.allowedTopics,
          allowedTools: policy.allowedTools,
          trustedAgentIds: policy.trustedAgentIds,
          blockedAgentIds: policy.blockedAgentIds,
          maxParallelDelegations: policy.maxParallelDelegations,
        }
      : null,
    // spend ceiling + autonomy dial + today's consumption (owner-controlled)
    wallet: wallet
      ? {
          autonomyMode: wallet.autonomyMode,
          dailyTokenBudget: wallet.dailyTokenBudget,
          spendingAuthorityCents: wallet.spendingAuthorityCents,
          maxAgentCallsPerDay: wallet.maxAgentCallsPerDay,
          today: {
            tokensUsed: usage?.tokensUsed ?? 0,
            agentCallsMade: usage?.agentCallsMade ?? 0,
            spendCents: usage?.spendCents ?? 0,
          },
        }
      : null,
    // my work ledger: goals by status (including owner verdicts)
    goals: { counts: goalCounts, total: agentGoals.length },
    // the world I'm entering: ambient NPCs + how many peers are online
    world: {
      onlineAgents: online.size,
      natives: natives.map((n) => ({ id: n.id, name: n.name, online: online.has(n.id) })),
    },
  });
});