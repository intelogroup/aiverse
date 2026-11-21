// verseMemory.ts — what an agent carries back from the Verse to its owner (table verse_memory).
//
// Two tiers. `ledger` rows are written by the server from things it saw (a visit started or ended, a hunt won): trusted, free. `note` rows are
// the agent's own words, written through world_remember: shown to the owner as claims. Flat rows, no embeddings: recall is by place, kind and
// recency, which is enough at ~200 rows per agent. shortcut: no vector search; add pgvector (already in the DB image) only if recall by place
// and recency proves too thin.
import { and, asc, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../db/client";
import { verseMemory } from "@aiverse/shared/schema";
import { plainTextProblem } from "@aiverse/world-sim/actionProtocol";
import { logError } from "../util/log";

export const MAX_NOTE_CHARS = 500;
/** Notes and ledger rows each keep this many per agent; the oldest unpinned go first. */
export const MAX_NOTES = 200;
export const MAX_LEDGER = 500;
/** Pinned rows are never evicted, so the pin budget stays far below the note cap. */
export const MAX_PINNED = 50;
export const NOTE_KINDS = ["find", "place", "person", "lesson", "note"] as const;
export type NoteKind = (typeof NOTE_KINDS)[number];
export type MemoryRow = typeof verseMemory.$inferSelect;

export type NoteInput = { text: string; kind?: NoteKind; place?: string; point?: [number, number]; subject?: string; pin?: boolean };

const num = (x: unknown) => typeof x === "number" && Number.isFinite(x) && Math.abs(x) <= 2000;
const short = (x: unknown) => typeof x === "string" && x.length > 0 && x.length <= 100;

/** Why a note body is refused (it names the rule so a cold agent can correct itself), or null when it is valid. */
export function explainNote(v: unknown): string | null {
  if (!v || typeof v !== "object") return "body must be an object: {text, kind?, place?, point?, subject?, pin?}";
  const n = v as Record<string, unknown>;
  const bad = Object.keys(n).filter((k) => !["text", "kind", "place", "point", "subject", "pin"].includes(k));
  if (bad.length) return `unexpected field(s) ${bad.join(", ")}; allowed: text, kind, place, point, subject, pin`;
  if (typeof n.text !== "string" || !n.text.trim() || n.text.length > MAX_NOTE_CHARS) return `text needs 1-${MAX_NOTE_CHARS} characters`;
  const problem = plainTextProblem(n.text);
  if (problem) return `text is plain words: ${problem}`;
  if (n.kind !== undefined && !(NOTE_KINDS as readonly unknown[]).includes(n.kind)) return `kind must be one of: ${NOTE_KINDS.join(", ")}`;
  if (n.place !== undefined && !short(n.place)) return "place must be a place id from the map (1-100 characters)";
  if (n.point !== undefined && !(Array.isArray(n.point) && n.point.length === 2 && n.point.every(num))) return "point must be [x, z], each within +-2000";
  if (n.subject !== undefined && !short(n.subject)) return "subject must be a handle or prop id (1-100 characters)";
  if (n.pin !== undefined && typeof n.pin !== "boolean") return "pin must be true or false";
  return null;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** Drops the oldest unpinned rows of this tier beyond the cap. Runs inside the writer's transaction, under its advisory lock. */
async function trim(tx: Tx, agentId: string, tier: "ledger" | "note", cap: number) {
  const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(verseMemory).where(and(eq(verseMemory.agentId, agentId), eq(verseMemory.tier, tier)));
  if (n <= cap) return;
  const old = await tx.select({ id: verseMemory.id }).from(verseMemory)
    .where(and(eq(verseMemory.agentId, agentId), eq(verseMemory.tier, tier), eq(verseMemory.pinned, false)))
    .orderBy(asc(verseMemory.createdAt), asc(verseMemory.id)).limit(n - cap);
  if (old.length) await tx.delete(verseMemory).where(inArray(verseMemory.id, old.map((r) => r.id)));
}

const lock = (tx: Tx, agentId: string) => tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`verse-memory:${agentId}`}, 0))`);

/** An agent's own note. Returns the row, or `{ refused }` when the pin budget is spent. Call explainNote first. */
export async function rememberNote(agentId: string, ownerId: string, input: NoteInput, visitId?: string | null): Promise<{ row: MemoryRow } | { refused: string }> {
  return db.transaction(async (tx) => {
    await lock(tx, agentId);
    if (input.pin) {
      const [{ n }] = await tx.select({ n: sql<number>`count(*)::int` }).from(verseMemory).where(and(eq(verseMemory.agentId, agentId), eq(verseMemory.pinned, true)));
      if (n >= MAX_PINNED) return { refused: `pin limit reached (${MAX_PINNED}); write it without pin or keep what matters most` };
    }
    const [row] = await tx.insert(verseMemory).values({
      agentId, ownerId, visitId: visitId ?? null, tier: "note", kind: input.kind ?? "note", text: input.text.trim(),
      placeId: input.place ?? null, pointX: input.point?.[0] ?? null, pointZ: input.point?.[1] ?? null,
      subject: input.subject ?? null, pinned: input.pin === true,
    }).returning();
    await trim(tx, agentId, "note", MAX_NOTES);
    return { row };
  });
}

/** A fact the server saw. Never throws: a ledger failure must not break the visit or the claim that caused it. */
export async function recordLedger(
  agentId: string, ownerId: string,
  fact: { kind: string; text: string; visitId?: string | null; placeId?: string | null; subject?: string | null },
): Promise<void> {
  try {
    await db.transaction(async (tx) => {
      await lock(tx, agentId);
      await tx.insert(verseMemory).values({
        agentId, ownerId, visitId: fact.visitId ?? null, tier: "ledger", kind: fact.kind, text: fact.text.slice(0, MAX_NOTE_CHARS),
        placeId: fact.placeId ?? null, subject: fact.subject ?? null,
      });
      await trim(tx, agentId, "ledger", MAX_LEDGER);
    });
  } catch (err) {
    logError("verse_memory_ledger_failed", err, { agentId, kind: fact.kind });
  }
}

/** What the agent reads back: rows at this place, its pinned rows, then the most recent, each list deduplicated against the ones before it. */
export async function recall(agentId: string, opts: { place?: string; kind?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 10, 1), 50);
  const base = (...more: ReturnType<typeof eq>[]) => and(eq(verseMemory.agentId, agentId), ...(opts.kind ? [eq(verseMemory.kind, opts.kind)] : []), ...more);
  const here = opts.place ? await db.select().from(verseMemory).where(base(eq(verseMemory.placeId, opts.place))).orderBy(desc(verseMemory.createdAt)).limit(limit) : [];
  const seen = new Set(here.map((r) => r.id));
  const pinned = (await db.select().from(verseMemory).where(base(eq(verseMemory.pinned, true))).orderBy(desc(verseMemory.createdAt)).limit(limit)).filter((r) => !seen.has(r.id));
  pinned.forEach((r) => seen.add(r.id));
  const recent = (await db.select().from(verseMemory).where(base()).orderBy(desc(verseMemory.createdAt)).limit(limit + seen.size)).filter((r) => !seen.has(r.id)).slice(0, limit);
  return { here, pinned, recent };
}

/** The owner's view of one agent's memory, newest first, plus how many rows the owner has not seen yet. */
export async function listForOwner(ownerId: string, agentId: string, opts: { tier?: string; kind?: string; limit?: number } = {}) {
  const limit = Math.min(Math.max(opts.limit ?? 100, 1), 500);
  const where = and(eq(verseMemory.agentId, agentId), eq(verseMemory.ownerId, ownerId),
    ...(opts.tier ? [eq(verseMemory.tier, opts.tier)] : []), ...(opts.kind ? [eq(verseMemory.kind, opts.kind)] : []));
  const rows = await db.select().from(verseMemory).where(where).orderBy(desc(verseMemory.createdAt), desc(verseMemory.id)).limit(limit);
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(verseMemory)
    .where(and(eq(verseMemory.agentId, agentId), eq(verseMemory.ownerId, ownerId), isNull(verseMemory.seenByOwnerAt)));
  return { rows, unseen: n };
}

export async function markSeen(ownerId: string, agentId: string): Promise<number> {
  const done = await db.update(verseMemory).set({ seenByOwnerAt: new Date() })
    .where(and(eq(verseMemory.agentId, agentId), eq(verseMemory.ownerId, ownerId), isNull(verseMemory.seenByOwnerAt))).returning({ id: verseMemory.id });
  return done.length;
}

/** The owner's copy to keep: the agent's own words are labelled as its claims, the server's ledger as fact. */
export function toMarkdown(agentName: string, rows: MemoryRow[]): string {
  const line = (r: MemoryRow) => {
    const where = [r.placeId, r.pointX !== null && r.pointZ !== null ? `@${Math.round(r.pointX)},${Math.round(r.pointZ)}` : null].filter(Boolean).join(" ");
    return `- ${r.createdAt.toISOString().slice(0, 16).replace("T", " ")} [${r.kind}${where ? ` · ${where}` : ""}]${r.pinned ? " (pinned)" : ""} ${r.text}`;
  };
  const ledger = rows.filter((r) => r.tier === "ledger"), notes = rows.filter((r) => r.tier === "note");
  return [
    `# ${agentName}: carried back from the Verse`, "",
    "## What the Verse recorded (seen by the server)", ...(ledger.length ? ledger.map(line) : ["- nothing yet"]), "",
    "## What the agent says it noticed (its own words, not verified)", ...(notes.length ? notes.map(line) : ["- nothing yet"]), "",
  ].join("\n");
}
