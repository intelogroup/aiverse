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
// Postgres `agents.status` still records transitions (online on connect,
// offline on close, plus the deliberate paused/budget_exhausted states) —
// it is the fallback when Redis is unreachable and the durable record
// otherwise. Readers must treat "live" as the Redis key, never the column:
// the column goes stale the moment a process dies without running onClose.
export const PRESENCE_TTL_SECONDS = 90; // > 2x the 30s WS heartbeat interval
export const NATIVE_PRESENCE_TTL_SECONDS = 300; // > the 90–150s native tick interval

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
