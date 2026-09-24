import { eq } from "drizzle-orm";
import { db } from "./db/client";
import { redis } from "./redis/client";
import { agents } from "@aiverse/shared/schema";
import { log } from "./util/log";

// Live presence: Redis TTL keys. Postgres as fallback + transitions.
//
// The `presence:{agentId}` key is the live truth — set on WS connect,
// refreshed by the 30s heartbeat and on every pong, deleted on close, and
// refreshed by the leader-only native tick for natives (which hold no
// socket). TTL expiry self-heals crashes: no reconciler needed on the read
// path.
//
// Multi-socket semantics: within one gateway process an agent has exactly
// one tracked socket (replace-on-connect), and onClose's
// `conn.ws.raw === ws.raw` identity guard means a replaced socket's close
// can never clear the new socket's presence. Across gateway *replicas*,
// though, the key is per-agent, not per-socket: if the same agent is
// connected to two replicas and one socket closes, that replica DELs the
// key and presence blips offline until the surviving replica's next 30s
// heartbeat re-sets it. Bounded and self-healing, but a second replica
// doing live delivery during the blip may treat the agent as offline —
// per-socket presence keys are the fix if multi-replica gateway ever
// becomes real (today the leader-only jobs already assume one writer).
//
// Postgres `agents.status` still records transitions (online on connect,
// offline on close, plus the deliberate paused/budget_exhausted states) —
// it is the fallback when Redis is unreachable and the durable record
// otherwise. Readers must treat "live" as the Redis key, never the column:
// the column goes stale the moment a process dies without running onClose.
export const PRESENCE_TTL_SECONDS = 90; // > 2x the 30s WS heartbeat interval
export const NATIVE_PRESENCE_TTL_SECONDS = 300; // > the 90–150s native tick interval
// HTTP-only agents (no WS connection — MCP clients, plain-poll agents) hold
// no socket to heartbeat, so agentAuth touches this on every authenticated
// request instead. Longer than the WS TTL because polling is bursty, not a
// steady 30s heartbeat: an agent that just made a call should still read as
// online for a few minutes of silence, not blip offline between polls.
export const API_PRESENCE_TTL_SECONDS = 180;

export function presenceKey(agentId: string): string {
  return `presence:${agentId}`;
}

export async function setPresence(agentId: string, ttlSeconds: number = PRESENCE_TTL_SECONDS): Promise<void> {
  await redis.set(presenceKey(agentId), "1", "EX", ttlSeconds);
}

export async function clearPresence(agentId: string): Promise<void> {
  await redis.del(presenceKey(agentId));
}

// Statuses an owner or the system sets deliberately — a live-presence
// lookup must never override these with online/offline derived from the
// TTL key.
const DELIBERATE_STATUSES = new Set(["unclaimed", "paused", "budget_exhausted"]);

// Resolve the status to report for an agent: deliberate states win, then
// the live TTL key, then offline. (The old "away" value is unmaintained —
// nothing sets it — so it resolves through the key like any other
// transient state.)
export function liveStatus(dbStatus: string, hasPresenceKey: boolean): string {
  if (DELIBERATE_STATUSES.has(dbStatus)) return dbStatus;
  return hasPresenceKey ? "online" : "offline";
}

export async function isAgentOnline(agentId: string): Promise<boolean> {
  try {
    return (await redis.exists(presenceKey(agentId))) === 1;
  } catch (err) {
    log("presence_redis_fallback", { op: "exists", error: String(err) });
    const row = await db.query.agents.findFirst({
      where: eq(agents.id, agentId),
      columns: { status: true },
    });
    return row?.status === "online";
  }
}

// Every agent with a live presence key. SCAN, not KEYS — non-blocking at
// thousands of agents. Falls back to the Postgres status column when Redis
// is unreachable, so readers degrade to the old behavior instead of
// erroring.
export async function getOnlineAgentIds(): Promise<Set<string>> {
  try {
    const ids = new Set<string>();
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "presence:*", "COUNT", 1000);
      cursor = next;
      for (const key of keys) ids.add(key.slice("presence:".length));
    } while (cursor !== "0");
    return ids;
  } catch (err) {
    log("presence_redis_fallback", { op: "scan", error: String(err) });
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.status, "online"));
    return new Set(rows.map((r) => r.id));
  }
}

// Bounded variant of getOnlineAgentIds: SCAN with early termination once
// `limit` ids are collected, so neither the Redis scan nor the caller's
// Postgres IN-list grows with the world. Set order is arbitrary, so this is
// a pseudo-random sample — fine for prompt-context uses that only ever
// consume the first handful anyway.
export async function getOnlineAgentIdSample(limit: number): Promise<string[]> {
  try {
    const ids: string[] = [];
    let cursor = "0";
    do {
      const [next, keys] = await redis.scan(cursor, "MATCH", "presence:*", "COUNT", 1000);
      cursor = next;
      for (const key of keys) {
        ids.push(key.slice("presence:".length));
        if (ids.length >= limit) return ids;
      }
    } while (cursor !== "0");
    return ids;
  } catch (err) {
    log("presence_redis_fallback", { op: "scan_sample", error: String(err) });
    const rows = await db.select({ id: agents.id }).from(agents).where(eq(agents.status, "online")).limit(limit);
    return rows.map((r) => r.id);
  }
}
