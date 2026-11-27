import { and, asc, eq, sql } from "drizzle-orm";
import { verseAgentState, verseInventory, verseProgressEvents } from "@aiverse/shared/schema";
import type { VerseWant } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { isStallUse } from "@aiverse/world-sim/stallConsumables";
import { progress } from "./verseProgress";
import { vitalsChanged } from "./vitalsPush";

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

/** Level fields for a lifetime XP total, shared by every surface that shows them. */
export function levelInfo(totalXp: number) {
  const level = levelForXp(totalXp);
  return { level, nextLevelXp: xpForLevel(level + 1) };
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
  return {
    energy: state?.energy ?? 100,
    credits: Math.max(0, Math.trunc(totals?.credits ?? 0)),
    xp,
    ...levelInfo(xp),
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
  if (isStallUse(action)) return "none";
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
  // A fractional drain (converse 0.5) still costs a whole point; fractional
  // regen rounds to the nearest point.
  const effective = delta < 0 && delta > -1 ? -1 : Math.round(delta);
  if (!effective) return currentEnergy(agentId, store);
  const before = await currentEnergy(agentId, store);
  const [row] = await store.update(verseAgentState).set({
    energy: sql`greatest(0, least(100, ${verseAgentState.energy} + ${effective}))`, updatedAt: sql`now()`,
  }).where(eq(verseAgentState.agentId, agentId)).returning({ energy: verseAgentState.energy });
  // Resting at 100 or draining at 0 changes nothing, so it pushes nothing.
  if (row!.energy !== before) vitalsChanged(agentId);
  return row!.energy;
}

export function creditStallConsumption(agentId: string, visitId: string, actId: string): Promise<number> {
  return db.transaction(async (tx) => {
    const [receipt] = await tx.insert(verseProgressEvents).values({
      agentId, kind: "stall-consumption", source: `${visitId}:${actId}`,
    }).onConflictDoNothing().returning({ source: verseProgressEvents.source });
    return receipt ? applyEnergyDelta(agentId, energyRates().foodRestore, tx) : currentEnergy(agentId, tx);
  });
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

// ── Phase 3: stipends + XP awards ───────────────────────────────────────
// Everything here is a verse_progress_events ledger row: credits and XP
// stay sums over the ledger (progress()), XP is never spent or lost, and
// the ledger's (agent, kind, source) PK is the idempotency key.

export interface StipendRates { firstCredits: number; firstXp: number; dailyCredits: number; dailyXp: number }

export function stipendRates(): StipendRates {
  return {
    firstCredits: envRate("VERSE_STIPEND_FIRST_CREDITS", 1000),
    firstXp: envRate("VERSE_STIPEND_FIRST_XP", 5),
    dailyCredits: envRate("VERSE_STIPEND_DAILY_CREDITS", 200),
    dailyXp: envRate("VERSE_STIPEND_DAILY_XP", 2),
  };
}

export interface StipendClaim { granted: "first_login" | "daily" | null; credits: number; xp: number }

/** Claim the load-in stipend: 1,000 credits (+5 XP) on the agent's
 *  first-ever claim, 200 credits (+2 XP) once per UTC day after. Called
 *  from the load-in surfaces (agent_whoami / world_observe) — there is no
 *  separate login event on the agent interface, and whoami/observe ARE
 *  load-in; a recurring job would sweep the whole roster under the
 *  singleton-leader discipline to do what this claim does exactly once.
 *  The first-login day does not also pay the daily grant. Idempotent:
 *  the ledger PK refuses a second insert, and an advisory lock per agent
 *  serializes concurrent claims so exactly one caller reports the grant. */
export async function claimStipends(agentId: string, now: Date = new Date()): Promise<StipendClaim> {
  const rates = stipendRates();
  const day = now.toISOString().slice(0, 10);
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`verse-stipend:${agentId}`}, 0))`);
    const [first] = await tx.select({ source: verseProgressEvents.source, createdAt: verseProgressEvents.createdAt }).from(verseProgressEvents)
      .where(and(eq(verseProgressEvents.agentId, agentId), eq(verseProgressEvents.kind, "stipend"),
        eq(verseProgressEvents.source, "first-login"))).limit(1);
    if (!first) {
      await tx.insert(verseProgressEvents).values({
        agentId, kind: "stipend", source: "first-login", credits: rates.firstCredits, xp: rates.firstXp,
        // Stamp the claim's own logical time, not the DB wall clock: the
        // day comparison below reads this createdAt back, and the two
        // must share one clock. In production `now` IS the wall clock,
        // so this changes nothing live — but a caller passing an
        // explicit `now` (the test suite) otherwise gets rows stamped
        // with real time and day math that only agrees on the calendar
        // day the fixture was written (the Nov 25 time-bomb).
        createdAt: now,
      }).onConflictDoNothing();
      vitalsChanged(agentId);
      return { granted: "first_login", credits: rates.firstCredits, xp: rates.firstXp } as StipendClaim;
    }
    // The first-login day pays no daily grant on top (its createdAt is the
    // day the first grant landed).
    if (first.createdAt.toISOString().slice(0, 10) === day) {
      return { granted: null, credits: 0, xp: 0 } as StipendClaim;
    }
    const [daily] = await tx.insert(verseProgressEvents).values({
      agentId, kind: "stipend", source: `daily:${day}`, credits: rates.dailyCredits, xp: rates.dailyXp,
      createdAt: now,
    }).onConflictDoNothing().returning({ source: verseProgressEvents.source });
    if (daily) vitalsChanged(agentId);
    return daily
      ? { granted: "daily", credits: rates.dailyCredits, xp: rates.dailyXp } as StipendClaim
      : { granted: null, credits: 0, xp: 0 } as StipendClaim;
  });
}

/** Place XP diminishing curve, by prior visits to the SAME place:
 *  5, 2, 1, then 0 — a place's lifetime place-XP is bounded at 8, so
 *  first-place-visit farming (open day: Oleg's 71) cannot repeat. */
export function placeXpForVisit(priorVisits: number): number {
  return [5, 2, 1][priorVisits] ?? 0;
}

/** Award explore/place XP for arriving at a place, once per world VISIT
 *  (visitKey = the visit id): agents poll world_observe constantly, so a
 *  poll is not a visit — only the first observe of a place within a visit
 *  counts, and the diminishing curve runs over distinct visits. One
 *  ledger row per (place, visit), source place@visit, under an advisory
 *  lock so concurrent observes cannot double-claim a visit. */
export async function awardPlaceXp(agentId: string, placeId: string, visitKey: string): Promise<{ xp: number; visits: number }> {
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`verse-place:${agentId}:${placeId}`}, 0))`);
    const rows = await tx.select({ source: verseProgressEvents.source }).from(verseProgressEvents)
      .where(and(eq(verseProgressEvents.agentId, agentId), eq(verseProgressEvents.kind, "place"),
        sql`${verseProgressEvents.source} like ${`${placeId}@%`}`));
    if (rows.some((r) => r.source === `${placeId}@${visitKey}`)) {
      return { xp: 0, visits: rows.length };
    }
    const visits = rows.length;
    const xp = placeXpForVisit(visits);
    if (xp > 0) {
      await tx.insert(verseProgressEvents).values({
        agentId, kind: "place", source: `${placeId}@${visitKey}`, xp,
      }).onConflictDoNothing();
      vitalsChanged(agentId);
    }
    return { xp, visits: visits + 1 };
  });
}

/** Move XP: 1 XP per NEW accepted movement act. The source is the act id,
 *  so an idempotent replay of the same act (which the MCP layer answers
 *  from the settled record, never re-charging energy) also never
 *  re-awards. Returns the XP actually granted (0 on replay). */
export async function awardMoveXp(agentId: string, actId: string): Promise<number> {
  const [row] = await db.insert(verseProgressEvents).values({
    agentId, kind: "move", source: `act:${actId}`, xp: 1,
  }).onConflictDoNothing().returning({ xp: verseProgressEvents.xp });
  if (row) vitalsChanged(agentId);
  return row ? 1 : 0;
}

// ── Phase 4: wants — the write path ─────────────────────────────────────
// Wants had a home since Phase 1 (verse_agent_state.wants) and a read
// surface (the self block); Phase 4 lets the agent write its own. Wants
// come first — trade is what wants do (owner axiom, Nov 24 2026): the
// want-driven trade path (world/agentSales.ts buyListingForWant) refuses
// an agent with no matching want, and a completed purchase of a wanted
// item SATISFIES the want — it is removed, so a filled want never drives
// a second, unintended purchase.

const wantNameEq = (a: string, b: string): boolean =>
  a.trim().toLowerCase() === b.trim().toLowerCase();

/** The want (if any) naming this item, regardless of price. */
export function findWant(wants: VerseWant[], itemName: string): VerseWant | undefined {
  return wants.find((w) => wantNameEq(w.item, itemName));
}

/** Does any want cover this item at this price? A want's maxPrice is the
 *  most the agent will pay — a price above it is NOT a match. */
export function wantMatches(wants: VerseWant[], itemName: string, price: number): boolean {
  const want = findWant(wants, itemName);
  return !!want && (want.maxPrice === undefined || price <= want.maxPrice);
}

export async function getWants(agentId: string, store: Store = db): Promise<VerseWant[]> {
  return (await getAgentEconomyState(agentId, store)).wants;
}

async function writeWants(agentId: string, wants: VerseWant[], store: WriteStore): Promise<VerseWant[]> {
  await store.insert(verseAgentState).values({ agentId }).onConflictDoNothing();
  await store.update(verseAgentState).set({ wants, updatedAt: sql`now()` })
    .where(eq(verseAgentState.agentId, agentId));
  return wants;
}

export type SetWantsResult = { ok: true; wants: VerseWant[] } | { ok: false; error: "invalid_want" };

/** Replace the agent's whole want list (world_wants set). Validated:
 *  each want is {item: non-empty name ≤120 chars, maxPrice?: positive
 *  integer}; duplicate items collapse to the first entry. An invalid
 *  list changes nothing. */
export async function setWants(agentId: string, raw: unknown, store: WriteStore = db): Promise<SetWantsResult> {
  if (!Array.isArray(raw) || raw.length > 20) return { ok: false, error: "invalid_want" };
  const wants: VerseWant[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") return { ok: false, error: "invalid_want" };
    const { item, maxPrice } = entry as { item?: unknown; maxPrice?: unknown };
    if (typeof item !== "string" || !item.trim() || item.trim().length > 120) {
      return { ok: false, error: "invalid_want" };
    }
    if (maxPrice !== undefined && (!Number.isInteger(maxPrice) || (maxPrice as number) < 1 || (maxPrice as number) > 2_147_483_647)) {
      return { ok: false, error: "invalid_want" };
    }
    if (wants.some((w) => wantNameEq(w.item, item))) continue;
    wants.push(maxPrice === undefined ? { item: item.trim() } : { item: item.trim(), maxPrice: maxPrice as number });
  }
  return { ok: true, wants: await writeWants(agentId, wants, store) };
}

/** Clear one want by item name, or every want when no item is named. */
export async function clearWants(agentId: string, item?: string, store: WriteStore = db): Promise<VerseWant[]> {
  const current = await getWants(agentId, store);
  const next = item === undefined ? [] : current.filter((w) => !wantNameEq(w.item, item));
  return next.length === current.length && item !== undefined ? current : writeWants(agentId, next, store);
}

/** A purchase of this item landed: remove its want (satisfied). Returns
 *  the wants that remain; a no-op when nothing matched. */
export async function satisfyWant(agentId: string, itemName: string, store: WriteStore = db): Promise<VerseWant[]> {
  const current = await getWants(agentId, store);
  if (!findWant(current, itemName)) return current;
  return writeWants(agentId, current.filter((w) => !wantNameEq(w.item, itemName)), store);
}
