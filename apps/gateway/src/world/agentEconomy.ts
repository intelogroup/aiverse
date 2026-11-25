import { asc, eq, sql } from "drizzle-orm";
import { verseAgentState, verseInventory } from "@aiverse/shared/schema";
import type { VerseWant } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { progress } from "./verseProgress";

// Agent-economy Phase 1 (Nov 25 2026): the agent's own living-economy
// properties, read-only. Canonical ontology (owner, Nov 24 2026):
// energy is the body, credits are the money, XP is growth, level derives
// from lifetime XP, "points" is retired. Sources of truth stay where they
// already live — credits/XP are the verse_progress_events sums via
// progress(), the bag is verse_inventory; verse_agent_state holds only
// energy + wants, which had no home. Nothing moves in Phase 1: no drain,
// no awards, no spend — those are Phases 2–3.

// Level curve: level n begins at 100·(n−1)² lifetime XP —
// L1: 0, L2: 100, L3: 400, L4: 900, L5: 1600. One function, used by every
// surface that shows a level; the value is never stored.
export function xpForLevel(level: number): number {
  const n = Math.max(1, Math.floor(level));
  return 100 * (n - 1) ** 2;
}

export function levelForXp(xp: number): number {
  if (!Number.isFinite(xp) || xp <= 0) return 1;
  return 1 + Math.floor(Math.sqrt(xp / 100));
}

export interface AgentEconomyState {
  energy: number;
  credits: number;
  xp: number;
  level: number;
  /** Lifetime XP at which the next level begins. */
  nextLevelXp: number;
  wants: VerseWant[];
  bag: { id: string; name: string }[];
}

type Store = Pick<typeof db, "select" | "insert">;

/** The agent's economy state for the observe/whoami `self` block.
 *  First read materializes the verse_agent_state row (defaults: full
 *  energy, no wants) so later phases have somewhere to write. */
export async function getAgentEconomyState(
  agentId: string,
  store: Store = db,
): Promise<AgentEconomyState> {
  await store.insert(verseAgentState).values({ agentId }).onConflictDoNothing();
  const [[state], totals, bag] = await Promise.all([
    store.select().from(verseAgentState).where(eq(verseAgentState.agentId, agentId)),
    progress(agentId, store),
    store
      .select({ id: verseInventory.id, name: verseInventory.name })
      .from(verseInventory)
      .where(eq(verseInventory.agentId, agentId))
      .orderBy(asc(verseInventory.id))
      .limit(100),
  ]);
  const xp = Math.max(0, Math.trunc(totals?.xp ?? 0));
  const level = levelForXp(xp);
  return {
    energy: state?.energy ?? 100,
    credits: Math.max(0, Math.trunc(totals?.credits ?? 0)),
    xp,
    level,
    nextLevelXp: xpForLevel(level + 1),
    wants: state?.wants ?? [],
    bag,
  };
}

// ── Phase 2: the energy life cycle ──────────────────────────────────────
// Rates start from the Nov 24 open-day experiment (experiments/open-day:
// COST_PER_M walk 0.35 / drive 0.55 / run 0.70 per metre with per-action
// caps, COST_FLAT fallbacks go_to 4 / drive 6 / run_to 8 / enter 2 /
// enter_vehicle 1 / exit_vehicle 1 / play 1 / say 0.5, REGEN_SEATED 3.5 and
// REGEN_STILL 1.0 per ~4 s tracker tick, Kettle of Rest ×2 regen). The MCP
// layer cannot measure metres travelled, so actions charge the experiment's
// own flat fallback costs — the drain ORDER walk < drive < run is the
// invariant that matters. Every rate is env-tunable (VERSE_ENERGY_*).
// Energy is stored as an integer (Phase 1 schema), so fractional amounts
// round to whole points; a sub-1 drain still charges 1 — acting is never
// free. Resting earns NO XP: nothing here writes progress events.

export type EnergyActionClass = "move_walk" | "move_drive" | "move_run" | "act" | "converse" | "rest" | "none";

const CLASS_BY_TYPE: Record<string, EnergyActionClass> = {
  go_to: "move_walk",
  run_to: "move_run",
  drive: "move_drive",
  enter: "act",
  enter_vehicle: "act",
  exit_vehicle: "act",
  play: "act",
  interact: "act",
  ride_elevator: "act",
  say: "converse",
  sit: "rest",
  wait: "rest",
};

export function actionClassFor(action: unknown): EnergyActionClass {
  if (!action || typeof action !== "object") return "none";
  const type = (action as { type?: unknown }).type;
  return typeof type === "string" ? (CLASS_BY_TYPE[type] ?? "none") : "none";
}

function envRate(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

export interface EnergyRates {
  walk: number;
  drive: number;
  run: number;
  act: number;
  enter: number;
  converse: number;
  regenSeatedTick: number;
  regenStillTick: number;
  restTickSeconds: number;
  kettleMultiplier: number;
  foodRestore: number;
}

export function energyRates(): EnergyRates {
  return {
    walk: envRate("VERSE_ENERGY_DRAIN_WALK", 4),
    drive: envRate("VERSE_ENERGY_DRAIN_DRIVE", 6),
    run: envRate("VERSE_ENERGY_DRAIN_RUN", 8),
    act: envRate("VERSE_ENERGY_DRAIN_ACT", 1),
    enter: envRate("VERSE_ENERGY_DRAIN_ENTER", 2),
    converse: envRate("VERSE_ENERGY_DRAIN_CONVERSE", 0.5),
    regenSeatedTick: envRate("VERSE_ENERGY_REGEN_SEATED_TICK", 3.5),
    regenStillTick: envRate("VERSE_ENERGY_REGEN_STILL_TICK", 1),
    restTickSeconds: envRate("VERSE_ENERGY_REST_TICK_SECONDS", 4),
    kettleMultiplier: envRate("VERSE_ENERGY_KETTLE_MULTIPLIER", 2),
    foodRestore: envRate("VERSE_ENERGY_FOOD_RESTORE", 25),
  };
}

/** Flat energy cost of one world action (0 for rest / zero-cost classes). */
export function drainForAction(action: unknown): number {
  const rates = energyRates();
  switch (actionClassFor(action)) {
    case "move_walk": return rates.walk;
    case "move_drive": return rates.drive;
    case "move_run": return rates.run;
    case "converse": return rates.converse;
    case "act": return (action as { type?: string }).type === "enter" ? rates.enter : rates.act;
    default: return 0;
  }
}

type WriteStore = Pick<typeof db, "select" | "insert" | "update" | "delete">;

async function currentEnergy(agentId: string, store: WriteStore): Promise<number> {
  await store.insert(verseAgentState).values({ agentId }).onConflictDoNothing();
  const [row] = await store.select({ energy: verseAgentState.energy })
    .from(verseAgentState).where(eq(verseAgentState.agentId, agentId));
  return row?.energy ?? 100;
}

/** Apply a signed delta, clamped to 0–100 in whole points. Returns the new energy. */
export async function applyEnergyDelta(agentId: string, delta: number, store: WriteStore = db): Promise<number> {
  const before = await currentEnergy(agentId, store);
  // A fractional drain (converse 0.5) still costs a whole point; fractional
  // regen rounds to the nearest point.
  const effective = delta < 0 && delta > -1 ? -1 : Math.round(delta);
  const after = Math.max(0, Math.min(100, before + effective));
  if (after !== before) {
    await store.update(verseAgentState).set({ energy: after, updatedAt: sql`now()` })
      .where(eq(verseAgentState.agentId, agentId));
  }
  return after;
}

/** Holding the Kettle of Rest (a bag item whose name says so) doubles regen. */
export async function hasKettle(agentId: string, store: Pick<typeof db, "select"> = db): Promise<boolean> {
  const rows = await store.select({ name: verseInventory.name }).from(verseInventory)
    .where(eq(verseInventory.agentId, agentId)).limit(100);
  return rows.some((r) => r.name.toLowerCase().includes("kettle"));
}

export interface EnergySpend {
  energy: number;
  /** Signed change actually applied (negative = drained, positive = regened). */
  delta: number;
  actionClass: EnergyActionClass;
}

/** Charge (or, for sit/wait, refill) energy for one settled world action. */
export async function spendEnergyForAction(
  agentId: string,
  action: unknown,
  store: WriteStore = db,
): Promise<EnergySpend> {
  const actionClass = actionClassFor(action);
  const rates = energyRates();
  if (actionClass === "rest") {
    const type = (action as { type?: string }).type;
    const tick = type === "sit" ? rates.regenSeatedTick : rates.regenStillTick;
    const mult = (await hasKettle(agentId, store)) ? rates.kettleMultiplier : 1;
    const before = await currentEnergy(agentId, store);
    const energy = await applyEnergyDelta(agentId, tick * mult, store);
    return { energy, delta: energy - before, actionClass };
  }
  const drain = drainForAction(action);
  if (drain <= 0) return { energy: await currentEnergy(agentId, store), delta: 0, actionClass };
  const before = await currentEnergy(agentId, store);
  const energy = await applyEnergyDelta(agentId, -drain, store);
  return { energy, delta: energy - before, actionClass };
}

export interface Exhaustion {
  outcome: "exhausted";
  energy: number;
  actionClass: EnergyActionClass;
  hint: string;
}

/** Zero-energy gate: draining actions are refused; rest-shaped and
 *  zero-cost actions stay allowed so a stranded agent can recover where
 *  it stands (world_rest / world_use are gated by the same rule — they
 *  are never draining classes, so they always pass). */
export async function exhaustionFor(
  agentId: string,
  action: unknown,
  store: WriteStore = db,
): Promise<Exhaustion | null> {
  if (drainForAction(action) <= 0) return null;
  const energy = await currentEnergy(agentId, store);
  if (energy > 0) return null;
  return {
    outcome: "exhausted",
    energy,
    actionClass: actionClassFor(action),
    hint: "you are out of energy: rest where you stand with world_rest, sit or wait with world_act, or eat/drink from your bag with world_use",
  };
}

export interface RestResult {
  energy: number;
  gained: number;
  restedSeconds: number;
  kettleMultiplier: number;
}

/** Deliberate rest anywhere (world_rest): the seated tick rate, Kettle ×2. */
export async function restEnergy(
  agentId: string,
  seconds: number,
  store: WriteStore = db,
): Promise<RestResult> {
  const rates = energyRates();
  const restedSeconds = Math.max(0, Math.min(600, Math.floor(seconds)));
  const mult = (await hasKettle(agentId, store)) ? rates.kettleMultiplier : 1;
  const ticks = rates.restTickSeconds > 0 ? restedSeconds / rates.restTickSeconds : 0;
  const before = await currentEnergy(agentId, store);
  const energy = await applyEnergyDelta(agentId, ticks * rates.regenSeatedTick * mult, store);
  return { energy, gained: energy - before, restedSeconds, kettleMultiplier: mult };
}

// Inventory rows carry only a name, so edibility is a name judgment: the
// live edible is the Market Hall bakery sample; stall food/drink names
// follow the same words. Relics, jars and keepsakes match nothing here.
const EDIBLE_NAME = /bakery|snack|bread|pastry|cake|cookie|muffin|sandwich|meal|food|drink|juice|coffee|sample|fruit|soup|stew/i;

export type UseBagItemResult =
  | { ok: true; item: { id: string; name: string }; restored: number; energy: number }
  | { ok: false; error: "item_not_in_bag" | "not_edible"; item?: { id: string; name: string } };

/** Eat/drink a bag item (world_use): food restores energy on the spot and
 *  is consumed. Works at zero energy — carried food is how a stranded
 *  agent gets moving again. */
export async function useBagItem(
  agentId: string,
  itemRef: string,
  store: WriteStore = db,
): Promise<UseBagItemResult> {
  const bag = await store.select({ id: verseInventory.id, name: verseInventory.name })
    .from(verseInventory).where(eq(verseInventory.agentId, agentId)).limit(100);
  const item = bag.find((r) => r.id === itemRef) ?? bag.find((r) => r.name === itemRef);
  if (!item) return { ok: false, error: "item_not_in_bag" };
  if (!EDIBLE_NAME.test(item.name)) return { ok: false, error: "not_edible", item };
  await store.delete(verseInventory).where(eq(verseInventory.id, item.id));
  const energy = await applyEnergyDelta(agentId, energyRates().foodRestore, store);
  return { ok: true, item, restored: energyRates().foodRestore, energy };
}
