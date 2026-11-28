import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { agents, owners, verseAgentState, verseInventory } from "@aiverse/shared/schema";
import { db } from "../db/client";
import {
  applyEnergyDelta,
  drainForAction,
  energyRates,
  exhaustionFor,
  getAgentEconomyState,
  restEnergy,
  spendEnergyForAction,
  useBagItem,
} from "./agentEconomy";

// Agent-economy Phase 2: the energy life cycle. Rates come from the Nov 24
// open-day experiment (experiments/open-day patch constants): flat per-action
// costs go_to 4 / drive 6 / run_to 8 / enter 2 / other acts 1 / say 0.5,
// seated regen tick 3.5, still tick 1.0, Kettle of Rest ×2 regen.

async function createAgentRow() {
  const [owner] = await db.insert(owners).values({
    email: `economy-energy-${randomUUID()}@example.com`, passwordHash: "unused-in-test",
  }).returning();
  const [agent] = await db.insert(agents).values({
    ownerId: owner.id, name: `NRG-${randomUUID().slice(0, 8)}`, apiKeyHash: randomUUID(),
  }).returning();
  return agent;
}

async function setEnergy(agentId: string, energy: number) {
  await db.insert(verseAgentState).values({ agentId, energy })
    .onConflictDoUpdate({ target: verseAgentState.agentId, set: { energy } });
}

async function energyOf(agentId: string) {
  const [row] = await db.select().from(verseAgentState).where(eq(verseAgentState.agentId, agentId));
  return row.energy;
}

afterEach(() => {
  delete process.env.VERSE_ENERGY_DRAIN_WALK;
});

// ── drain rates (pure) ──────────────────────────────────────────────────

describe("drainForAction", () => {
  test("per-class flat costs from the open-day constants, walk < drive < run", () => {
    const walk = drainForAction({ type: "go_to" });
    const drive = drainForAction({ type: "drive" });
    const run = drainForAction({ type: "run_to" });
    expect(walk).toBe(4);
    expect(drive).toBe(6);
    expect(run).toBe(8);
    expect(walk).toBeLessThan(drive);
    expect(drive).toBeLessThan(run);
    expect(drainForAction({ type: "enter" })).toBe(2);
    expect(drainForAction({ type: "play" })).toBe(1);
    expect(drainForAction({ type: "interact" })).toBe(1);
    expect(drainForAction({ type: "say" })).toBe(0.5);
  });

  test("rest and zero-cost actions drain nothing", () => {
    expect(drainForAction({ type: "sit" })).toBe(0);
    expect(drainForAction({ type: "wait" })).toBe(0);
    expect(drainForAction({ type: "face" })).toBe(0);
    expect(drainForAction({ type: "gaze" })).toBe(0);
    expect(drainForAction({ type: "mystery" })).toBe(0);
    expect(drainForAction(null)).toBe(0);
    expect(drainForAction("go_to")).toBe(0);
  });

  test("rates are env-tunable", () => {
    process.env.VERSE_ENERGY_DRAIN_WALK = "2";
    expect(energyRates().walk).toBe(2);
    expect(drainForAction({ type: "go_to" })).toBe(2);
  });
});

// ── drain applied (real DB) ─────────────────────────────────────────────

describe("spendEnergyForAction", () => {
  test("each action class drains its rate from a full agent", async () => {
    const agent = await createAgentRow();
    expect((await spendEnergyForAction(agent.id, { type: "go_to" })).energy).toBe(96);
    await setEnergy(agent.id, 100);
    expect((await spendEnergyForAction(agent.id, { type: "drive" })).energy).toBe(94);
    await setEnergy(agent.id, 100);
    expect((await spendEnergyForAction(agent.id, { type: "run_to" })).energy).toBe(92);
    await setEnergy(agent.id, 100);
    // converse is 0.5 in the float experiment; integer energy charges 1.
    expect((await spendEnergyForAction(agent.id, { type: "say" })).energy).toBe(99);
    await setEnergy(agent.id, 100);
    expect((await spendEnergyForAction(agent.id, { type: "play" })).energy).toBe(99);
  });

  test("drain clamps at zero and never goes negative", async () => {
    const agent = await createAgentRow();
    await setEnergy(agent.id, 3);
    const spent = await spendEnergyForAction(agent.id, { type: "run_to" });
    expect(spent.energy).toBe(0);
    expect(await energyOf(agent.id)).toBe(0);
  });

  test("sit and wait refill instead of draining (one regen tick)", async () => {
    const agent = await createAgentRow();
    await setEnergy(agent.id, 50);
    // seated tick 3.5 → rounds to +4 in integer energy
    expect((await spendEnergyForAction(agent.id, { type: "sit" })).energy).toBe(54);
    await setEnergy(agent.id, 50);
    expect((await spendEnergyForAction(agent.id, { type: "wait" })).energy).toBe(51);
    await setEnergy(agent.id, 100);
    expect((await spendEnergyForAction(agent.id, { type: "sit" })).energy).toBe(100);
  });
});

// ── exhaustion ──────────────────────────────────────────────────────────

describe("exhaustionFor", () => {
  test("at zero energy, draining actions are refused as exhausted", async () => {
    const agent = await createAgentRow();
    await setEnergy(agent.id, 0);
    for (const type of ["go_to", "run_to", "drive", "play", "say"]) {
      const gate = await exhaustionFor(agent.id, { type });
      expect(gate?.outcome).toBe("exhausted");
      expect(gate?.energy).toBe(0);
    }
  });

  test("rest-shaped and zero-cost actions stay allowed at zero energy", async () => {
    const agent = await createAgentRow();
    await setEnergy(agent.id, 0);
    expect(await exhaustionFor(agent.id, { type: "sit" })).toBeNull();
    expect(await exhaustionFor(agent.id, { type: "wait" })).toBeNull();
    expect(await exhaustionFor(agent.id, { type: "face" })).toBeNull();
  });

  test("any positive energy is not exhausted, even below the next drain", async () => {
    const agent = await createAgentRow();
    await setEnergy(agent.id, 3);
    expect(await exhaustionFor(agent.id, { type: "run_to" })).toBeNull();
    await setEnergy(agent.id, 100);
    expect(await exhaustionFor(agent.id, { type: "go_to" })).toBeNull();
  });
});

// ── rest / regen ────────────────────────────────────────────────────────

describe("restEnergy", () => {
  test("resting refills at the seated tick rate (3.5 per 4 s)", async () => {
    const agent = await createAgentRow();
    await setEnergy(agent.id, 20);
    const rested = await restEnergy(agent.id, 8);
    expect(rested.gained).toBe(7);
    expect(rested.energy).toBe(27);
    expect(rested.kettleMultiplier).toBe(1);
  });

  test("rest clamps at full and resting earns no XP", async () => {
    const agent = await createAgentRow();
    await setEnergy(agent.id, 98);
    const rested = await restEnergy(agent.id, 40);
    expect(rested.energy).toBe(100);
    const state = await getAgentEconomyState(agent.id);
    expect(state.xp).toBe(0);
    expect(state.credits).toBe(0);
  });

  test("the Kettle doubles regen — rest and sit alike", async () => {
    const agent = await createAgentRow();
    await db.insert(verseInventory).values({ agentId: agent.id, name: "Kettle of Rest" });
    await setEnergy(agent.id, 20);
    const rested = await restEnergy(agent.id, 8);
    expect(rested.kettleMultiplier).toBe(2);
    expect(rested.gained).toBe(14);
    expect(rested.energy).toBe(34);
    await setEnergy(agent.id, 50);
    expect((await spendEnergyForAction(agent.id, { type: "sit" })).energy).toBe(57);
  });
});

// ── use a bag item ──────────────────────────────────────────────────────

describe("useBagItem", () => {
  test("food from the bag restores energy on the spot and is consumed", async () => {
    const agent = await createAgentRow();
    const [snack] = await db.insert(verseInventory).values({ agentId: agent.id, name: "Market Hall bakery sample" }).returning();
    await setEnergy(agent.id, 50);
    const used = await useBagItem(agent.id, snack.id);
    expect(used.ok).toBe(true);
    if (used.ok) {
      expect(used.restored).toBe(25);
      expect(used.energy).toBe(75);
      expect(used.item.name).toBe("Market Hall bakery sample");
    }
    const bag = await db.select().from(verseInventory).where(eq(verseInventory.agentId, agent.id));
    expect(bag).toHaveLength(0);
  });

  test("use by exact name works too, and works while exhausted", async () => {
    const agent = await createAgentRow();
    await db.insert(verseInventory).values({ agentId: agent.id, name: "Market Hall bakery sample" });
    await setEnergy(agent.id, 0);
    const used = await useBagItem(agent.id, "Market Hall bakery sample");
    expect(used.ok).toBe(true);
    expect(await energyOf(agent.id)).toBe(25);
  });

  test("a non-edible collectible is refused and stays in the bag", async () => {
    const agent = await createAgentRow();
    await db.insert(verseInventory).values({ agentId: agent.id, name: "Sun Relic" });
    await setEnergy(agent.id, 50);
    const used = await useBagItem(agent.id, "Sun Relic");
    expect(used.ok).toBe(false);
    if (!used.ok) expect(used.error).toBe("not_edible");
    expect(await energyOf(agent.id)).toBe(50);
    const bag = await db.select().from(verseInventory).where(eq(verseInventory.agentId, agent.id));
    expect(bag).toHaveLength(1);
  });

  test("an item the agent does not hold is a clean refusal", async () => {
    const agent = await createAgentRow();
    const used = await useBagItem(agent.id, "Market Hall bakery sample");
    expect(used.ok).toBe(false);
    if (!used.ok) expect(used.error).toBe("item_not_in_bag");
  });
});

// ── hostile delta shapes (AIV-ENERGY-DELTA-SHAPE-001) ──────────────────

describe("applyEnergyDelta hostile shapes", () => {
  test("non-finite and out-of-range deltas never throw and never corrupt energy", async () => {
    for (const d of [NaN, Infinity, -Infinity, 1e12, -1e12]) {
      const agent = await createAgentRow();
      await setEnergy(agent.id, 50);
      await applyEnergyDelta(agent.id, d);
      const e = await energyOf(agent.id);
      expect(Number.isInteger(e) && e >= 0 && e <= 100).toBe(true);
    }
  });

  test("huge finite deltas saturate at the clamp bounds", async () => {
    const agent = await createAgentRow();
    await setEnergy(agent.id, 50);
    expect(await applyEnergyDelta(agent.id, 1e12)).toBe(100);
    expect(await applyEnergyDelta(agent.id, -1e12)).toBe(0);
  });
});
