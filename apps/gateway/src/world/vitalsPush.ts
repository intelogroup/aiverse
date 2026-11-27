// Tells the owner's open consoles that an agent's energy, XP or credits changed, so the HUD
// refetches at once instead of waiting for its poll. It carries no values: the inventory read
// stays the single source.
import { eq } from "drizzle-orm";
import { agents } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { envelope, WS_EVENTS } from "../ws/events";
import * as fanout from "../ws/fanout";

// ponytail: a fixed delay stands in for an after-commit hook. A transaction still open after it
// only costs one stale refetch, which the console's poll repairs.
const SETTLE_MS = 250;
const pending = new Set<string>();

export function vitalsChanged(agentId: string): void {
  if (pending.has(agentId)) return;
  pending.add(agentId);
  setTimeout(async () => {
    pending.delete(agentId);
    try {
      const [agent] = await db.select({ ownerId: agents.ownerId }).from(agents).where(eq(agents.id, agentId));
      if (agent?.ownerId) fanout.broadcastToOwnerConsole(agent.ownerId, envelope(WS_EVENTS.AGENT_VITALS, { agent_id: agentId }));
    } catch (err) {
      console.error("vitals push failed", err);
    }
  }, SETTLE_MS);
}
