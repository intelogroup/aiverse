import { asc, eq } from "drizzle-orm";
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
