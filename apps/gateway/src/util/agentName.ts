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
// Confusable skeleton (UTS #39, reduced): the ROGUE OWNER battery
// (2026-11-26) showed byte-wise lower() comparison lets visually
// identical names register as distinct agents — a zero-width space
// inside the name, or a Cyrillic/Greek lookalike letter, produced a
// second agent a human reader cannot tell apart from the real one in
// conversation text. The skeleton folds a name to its visual identity:
// NFKC (fullwidth/compatibility forms), format characters stripped
// (zero-width space/joiner, BOM, bidi controls — Unicode category Cf),
// whitespace collapsed, lowercased, and the common Cyrillic/Greek
// Latin-lookalikes mapped to their Latin prototypes. Uniqueness is
// judged on skeletons, and the advisory lock keys on the skeleton too,
// so two confusable contenders serialize on the same lock instead of
// racing past each other's checks.
// The map is deliberately the high-confidence Latin-lookalike subset,
// not all of confusables.txt: it covers the realistic impersonation
// set (a name that reads as a Latin name) without folding names that
// are legitimately written in Cyrillic or Greek throughout.
const CONFUSABLE_TO_LATIN: Record<string, string> = {
  // Cyrillic lookalikes (lowercase forms; input is lowercased first)
  "а": "a", "в": "b", "е": "e", "к": "k", "м": "m", "н": "h",
  "о": "o", "р": "p", "с": "c", "т": "t", "у": "y", "х": "x",
  "ѕ": "s", "ј": "j", "і": "i", "ї": "i", "һ": "h", "ԁ": "d",
  // Greek lookalikes
  "α": "a", "β": "b", "ε": "e", "ι": "i", "κ": "k", "μ": "u",
  "ν": "v", "ο": "o", "ρ": "p", "τ": "t", "υ": "u", "χ": "x", "ω": "w",
};

export function agentNameSkeleton(name: string): string {
  const folded = name
    .normalize("NFKC")
    .replace(/\p{Cf}/gu, "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  let out = "";
  for (const ch of folded) out += CONFUSABLE_TO_LATIN[ch] ?? ch;
  return out;
}

// Skeleton comparison needs every existing name's skeleton, which no
// SQL predicate can express without a stored column — so the check
// scans the name column. Registration is a rare, human-paced event
// and the roster is small; if it ever grows hot, add a stored
// skeleton column and index that instead.
function anySkeletonTaken(names: Array<{ name: string }>, skeleton: string): boolean {
  return names.some((r) => agentNameSkeleton(r.name) === skeleton);
}

export async function isAgentNameTaken(name: string): Promise<boolean> {
  const skeleton = agentNameSkeleton(name);
  const rows = (await db.execute(sql`select name from agents`)) as unknown as Array<{ name: string }>;
  return anySkeletonTaken(rows, skeleton);
}

/** Advisory-lock key serializing check+insert for one name skeleton. */
export function agentNameLockKey(name: string): string {
  return `cap:agent-name:${agentNameSkeleton(name)}`;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** isAgentNameTaken against an open transaction — call only while holding
 *  the agentNameLockKey advisory lock inside that transaction. */
export async function isAgentNameTakenTx(tx: Tx, name: string): Promise<boolean> {
  const skeleton = agentNameSkeleton(name);
  const rows = (await tx.execute(sql`select name from agents`)) as unknown as Array<{ name: string }>;
  return anySkeletonTaken(rows, skeleton);
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
