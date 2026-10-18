import { and, eq, inArray, isNull, lt } from "drizzle-orm";
import { db } from "../db/client";
import { conversationParticipants, mentions } from "@aiverse/shared/schema";
import { redis } from "../redis/client";
import { log, logError } from "../util/log";

// Cursor acks v1 (ACK_CURSORS_V1.md §3–§4, PHASE1_SPEC WI-4): an ack no
// longer pays a per-message Postgres UPDATE. It advances a Redis-held
// cursor per (agent, conversation); a leader-only checkpoint job flushes
// dirty cursors to Postgres on the AIVERSE_ACK_CHECKPOINT_MS interval
// with the same monotonic guard the old ack path used. Readers take
// max(PG, Redis) (spec D4: backlog, the conversations-list unread count,
// and the ?unread=true reader) so nothing regresses inside the
// checkpoint window.
//
// Rollout follows the note's §4 behind AIVERSE_ACK_CURSOR_MODE:
//   legacy — today's behavior exactly (PG write per ack, no Redis cursors)
//   dual   — PG write AND Redis advance (migration step 1; the default)
//   redis  — Redis advance only; PG moves at checkpoint (step 2)
// Rollback at any step = set the mode back; PG lags by at most one
// checkpoint interval in redis mode, which the readers' max tolerates.
//
// Failure semantics (§3.5): delivery stays at-least-once. Redis loss
// falls cursors back to the last PG checkpoint — agents re-receive at
// most one checkpoint interval of already-acked messages (duplicates,
// never losses).

export type AckCursorMode = "legacy" | "dual" | "redis";

export function ackCursorMode(): AckCursorMode {
  const v = process.env.AIVERSE_ACK_CURSOR_MODE;
  return v === "legacy" || v === "redis" ? v : "dual";
}

export function ackCursorsEnabled(): boolean {
  return ackCursorMode() !== "legacy";
}

export function ackCheckpointIntervalMs(): number {
  const v = Number(process.env.AIVERSE_ACK_CHECKPOINT_MS);
  return Number.isFinite(v) && v > 0 ? v : 30_000;
}

export function ackCursorKey(agentId: string, conversationId: string): string {
  return `ackcursor:${agentId}:${conversationId}`;
}

const ACK_DIRTY_SET = "ackcursor:dirty";
const MENTION_DIRTY_AGENTS = "ackmentions:dirty";

function mentionAckKey(agentId: string): string {
  return `ackmentions:${agentId}`;
}

// "{tsMs}:{messageId}" (note §3.1) — messageId kept for debugging.
function parseCursorValue(raw: string | null): { tsMs: number; messageId: string } | null {
  if (!raw) return null;
  const sep = raw.indexOf(":");
  if (sep < 0) return null;
  const tsMs = Number(raw.slice(0, sep));
  if (!Number.isFinite(tsMs)) return null;
  return { tsMs, messageId: raw.slice(sep + 1) };
}

// Monotonic advance, atomic in Lua: a non-atomic read-modify-write
// could let a slow older ack overwrite a newer cursor under
// concurrency; the note tolerates that race, but the script costs
// nothing and removes it. Marks the key dirty only when the cursor
// actually moved. Returns true when this ack advanced the cursor.
const ADVANCE_CURSOR_LUA = `
local cur = redis.call('GET', KEYS[1])
local curTs = -1
if cur then
  local s = string.match(cur, '^(%d+):')
  if s then curTs = tonumber(s) end
end
if tonumber(ARGV[1]) > curTs then
  redis.call('SET', KEYS[1], ARGV[1] .. ':' .. ARGV[2])
  redis.call('SADD', KEYS[2], ARGV[3])
  return 1
end
return 0
`;

export async function advanceAckCursor(
  agentId: string,
  conversationId: string,
  tsMs: number,
  messageId: string,
): Promise<boolean> {
  const res = await redis.eval(
    ADVANCE_CURSOR_LUA,
    2,
    ackCursorKey(agentId, conversationId),
    ACK_DIRTY_SET,
    String(tsMs),
    messageId,
    `${agentId}:${conversationId}`,
  );
  return res === 1;
}

export async function getAckCursorMs(agentId: string, conversationId: string): Promise<number | null> {
  return parseCursorValue(await redis.get(ackCursorKey(agentId, conversationId)))?.tsMs ?? null;
}

// One pipelined MGET over the agent's conversations — the list route's
// per-agent read (spec WI-4 extension 1).
export async function getAckCursorsMs(
  agentId: string,
  conversationIds: string[],
): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!conversationIds.length) return out;
  const values = await redis.mget(conversationIds.map((id) => ackCursorKey(agentId, id)));
  conversationIds.forEach((id, i) => {
    const parsed = parseCursorValue(values[i]);
    if (parsed) out.set(id, parsed.tsMs);
  });
  return out;
}

// Mention acks have no cursor (note §3.1): the id joins the agent's
// pending set; the checkpoint batch-marks ackedAt.
export async function addMentionAck(agentId: string, mentionId: string): Promise<void> {
  const pipe = redis.pipeline();
  pipe.sadd(mentionAckKey(agentId), mentionId);
  pipe.sadd(MENTION_DIRTY_AGENTS, agentId);
  await pipe.exec();
}

// ── Checkpoint job (note §3.3) ─────────────────────────────────────────
// Bounded batches per run; popped entries are never re-queued except
// mention ids whose rows have not persisted yet (the ingest window —
// the early-ack stash covers their backlog filtering meanwhile).

const CHECKPOINT_CURSOR_BATCH = 500;
const CHECKPOINT_MENTION_AGENTS_BATCH = 100;
const CHECKPOINT_MENTION_BATCH = 500;

export async function runAckCheckpoint(
  opts: { cursorBatch?: number; mentionBatch?: number } = {},
): Promise<{ keys: number; mentions: number }> {
  const cursorBatch = opts.cursorBatch ?? CHECKPOINT_CURSOR_BATCH;
  const mentionBatch = opts.mentionBatch ?? CHECKPOINT_MENTION_BATCH;
  let keysUpserted = 0;
  let mentionsMarked = 0;

  // Message cursors: pop dirty members, upsert each with today's exact
  // monotonic guard. A member whose participant row is gone is dropped
  // (its Redis key deleted) rather than retried forever.
  const members = (await redis.spop(ACK_DIRTY_SET, cursorBatch)) as string[];
  for (const member of members) {
    const sep = member.indexOf(":");
    if (sep < 0) continue;
    const agentId = member.slice(0, sep);
    const conversationId = member.slice(sep + 1);
    const cursor = parseCursorValue(await redis.get(ackCursorKey(agentId, conversationId)));
    if (!cursor) continue;
    const ts = new Date(cursor.tsMs);
    const updated = await db
      .update(conversationParticipants)
      .set({ lastDeliveredAt: ts })
      .where(
        and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.agentId, agentId),
          lt(conversationParticipants.lastDeliveredAt, ts),
        ),
      )
      .returning({ agentId: conversationParticipants.agentId });
    if (updated.length > 0) {
      keysUpserted += 1;
    } else {
      // Either PG was already ahead (dual-mode race — fine, the max
      // readers keep both correct) or the participant no longer exists.
      const participant = await db.query.conversationParticipants.findFirst({
        where: and(
          eq(conversationParticipants.conversationId, conversationId),
          eq(conversationParticipants.agentId, agentId),
        ),
        columns: { agentId: true },
      });
      if (!participant) await redis.del(ackCursorKey(agentId, conversationId));
    }
  }

  // Mention acks: drain each dirty agent's set into one batched UPDATE.
  const agentIds = (await redis.spop(MENTION_DIRTY_AGENTS, CHECKPOINT_MENTION_AGENTS_BATCH)) as string[];
  for (const agentId of agentIds) {
    const ids = (await redis.spop(mentionAckKey(agentId), mentionBatch)) as string[];
    if (ids.length) {
      const updated = await db
        .update(mentions)
        .set({ ackedAt: new Date() })
        .where(and(inArray(mentions.id, ids), eq(mentions.targetAgentId, agentId), isNull(mentions.ackedAt)))
        .returning({ id: mentions.id });
      mentionsMarked += updated.length;
      const updatedIds = new Set(updated.map((r) => r.id));
      const missed = ids.filter((id) => !updatedIds.has(id));
      if (missed.length) {
        // Rows that exist but were already acked are done; rows that do
        // not exist yet are still inside the ingest persist window —
        // re-queue those for the next checkpoint instead of losing the
        // ack (the early-ack stash filters them from backlog meanwhile).
        const existing = await db.query.mentions.findMany({
          where: inArray(mentions.id, missed),
          columns: { id: true },
        });
        const existingIds = new Set(existing.map((r) => r.id));
        const unpersisted = missed.filter((id) => !existingIds.has(id));
        if (unpersisted.length) {
          const pipe = redis.pipeline();
          pipe.sadd(mentionAckKey(agentId), ...unpersisted);
          pipe.sadd(MENTION_DIRTY_AGENTS, agentId);
          await pipe.exec();
        }
      }
    }
    // Batch cap hit with members left over: stay dirty for the next run.
    if ((await redis.scard(mentionAckKey(agentId))) > 0) {
      await redis.sadd(MENTION_DIRTY_AGENTS, agentId);
    }
  }

  if (keysUpserted > 0 || mentionsMarked > 0) {
    log("ack_checkpoint_batch", { keys: keysUpserted, mentions: mentionsMarked });
  }
  return { keys: keysUpserted, mentions: mentionsMarked };
}

// Leader-only (wired in index.ts startSingletonJobs next to GC/ledger —
// two processes checkpointing would still be safe thanks to the
// monotonic guard, but pointless). Interval is the product-visible knob
// from the note §3.5: AIVERSE_ACK_CHECKPOINT_MS, default 30 s.
export function scheduleAckCheckpoint(): void {
  const tick = async () => {
    try {
      await runAckCheckpoint();
    } catch (err) {
      logError("ack_checkpoint_error", err);
    }
  };
  void tick();
  setInterval(tick, ackCheckpointIntervalMs());
}
