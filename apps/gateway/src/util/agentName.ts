import { sql } from "drizzle-orm";
import { db } from "../db/client";

// Names matter beyond display: @-mentions (routes/conversations.ts) resolve
// by exact case-insensitive name, matching every agent that shares it — so a
// collision doesn't just look confusing, it double-delivers a mention to an
// agent the sender never addressed. Native agents (jobs/nativeAgents.ts)
// build their whole @-mention vocabulary from live names too. Uniqueness is
// enforced here, in application code, not a DB unique index: this table
// already has pre-existing case-insensitive duplicates from before this
// check existed, which a hard index would refuse to apply over.
//
// The bare check below is a fast path only. On their own, check-then-insert
// races: concurrent creations with the same name all pass the check before
// any of them commits (AIV-AGENT-NAME-RACE-001 — bursts stored up to 12
// duplicates). Both creation paths (owners.ts POST /agents, a2a.ts
// POST /agents/register) therefore re-check INSIDE their insert
// transaction while holding the per-name advisory lock
// (db/capLock.ts acquireCapLock on agentNameLockKey), which serializes
// every contender for that one name and nobody else.
export async function isAgentNameTaken(name: string): Promise<boolean> {
  const [row] = await db.execute(sql`select 1 from agents where lower(name) = lower(${name}) limit 1`);
  return !!row;
}

/** Advisory-lock key serializing check+insert for one case-insensitive name. */
export function agentNameLockKey(name: string): string {
  return `cap:agent-name:${name.toLowerCase()}`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** isAgentNameTaken against an open transaction — call only while holding
 *  the agentNameLockKey advisory lock inside that transaction. */
export async function isAgentNameTakenTx(tx: Tx, name: string): Promise<boolean> {
  const [row] = await tx.execute(sql`select 1 from agents where lower(name) = lower(${name}) limit 1`);
  return !!row;
}

const ADJECTIVES = [
  "Amber", "Auburn", "Azure", "Bold", "Bright", "Brisk", "Calm", "Clever", "Coral", "Crimson",
  "Curious", "Dusty", "Eager", "Emerald", "Fleet", "Frost", "Gentle", "Golden", "Grey", "Hazel",
  "Ivory", "Jade", "Keen", "Lively", "Lucid", "Mellow", "Mint", "Nimble", "Noble", "Opal",
  "Pale", "Quiet", "Quick", "Rapid", "Sage", "Sharp", "Silent", "Silver", "Solar", "Steady",
  "Swift", "Terra", "Umber", "Vivid", "Wild", "Windy", "Wise", "Zephyr",
];
const NOUNS = [
  "Falcon", "Otter", "Heron", "Fox", "Wren", "Lynx", "Owl", "Hare", "Crane", "Badger",
  "Raven", "Finch", "Marten", "Osprey", "Stoat", "Kite", "Egret", "Vole", "Ibis", "Newt",
  "Comet", "Ember", "Grove", "Ridge", "Delta", "Harbor", "Meadow", "Summit", "Creek", "Atlas",
];

function randomFrom<T>(list: T[]): T {
  return list[Math.floor(Math.random() * list.length)];
}

// Case reserved for native agents' exact display names (isAgentNameTaken
// checks them the same as any other row) — no separate reserved list needed.
export async function generateAgentName(): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
    const candidate = `${randomFrom(ADJECTIVES)}-${randomFrom(NOUNS)}-${suffix}`;
    if (!(await isAgentNameTaken(candidate))) return candidate;
  }
  throw new Error("could not generate a unique agent name after 20 attempts");
}
