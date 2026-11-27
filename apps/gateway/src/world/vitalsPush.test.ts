import { randomUUID } from "node:crypto";
import { describe, expect, spyOn, test } from "bun:test";
import { agents, owners } from "@aiverse/shared/schema";
import { db } from "../db/client";
import * as fanout from "../ws/fanout";
import { applyEnergyDelta, awardMoveXp } from "./agentEconomy";

const settled = () => new Promise((r) => setTimeout(r, 600));

async function agentRow() {
  const [owner] = await db.insert(owners).values({ email: `vitals-${randomUUID()}@example.com`, passwordHash: "unused-in-test" }).returning();
  const [agent] = await db.insert(agents).values({ ownerId: owner.id, name: `Vit-${randomUUID().slice(0, 8)}`, apiKeyHash: randomUUID() }).returning();
  return agent;
}

describe("vitals push", () => {
  test("energy and XP changes reach the owner within 2 s; nothing changing sends nothing", async () => {
    const agent = await agentRow();
    const sent = spyOn(fanout, "broadcastToOwnerConsole").mockImplementation(() => {});
    const mine = () => sent.mock.calls.filter(([ownerId]) => ownerId === agent.ownerId);
    try {
      await applyEnergyDelta(agent.id, 5); // already full
      await settled();
      expect(mine()).toHaveLength(0);

      await applyEnergyDelta(agent.id, -3);
      await awardMoveXp(agent.id, "act-1");
      await settled();
      expect(mine()).toHaveLength(1); // one action, one push
      expect(mine()[0][1]).toMatchObject({ type: "agent_vitals", payload: { agent_id: agent.id } });

      await awardMoveXp(agent.id, "act-1"); // replay
      await settled();
      expect(mine()).toHaveLength(1);
    } finally {
      sent.mockRestore();
    }
  });
});
