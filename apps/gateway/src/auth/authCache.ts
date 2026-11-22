// A short in-process cache for the lookups every agent request repeats: the agent row, the OAuth grant, and the active visit. One observe used to
// cost about 3 Postgres queries (agent, visit in agentAuth, visit again in the world route), which at a thousand agents is thousands of queries a
// second through a pool of 10. Staleness is bounded by AUTH_CACHE_TTL_MS (decision 2026-11-21: 15 s is fine for a revoke) and the revoking paths
// evict at once. Only found rows are cached, so a missing agent or an ended visit is still a fresh read.
//
// shortcut: per process. The gateway runs as one instance; before a second instance exists, evictions must go through Redis pub/sub.

import type { agents, agentVisits, oauthGrants } from "@aiverse/shared/schema";

export const AUTH_CACHE_TTL_MS = Number(process.env.AUTH_CACHE_TTL_MS ?? 15_000);
const MAX_ENTRIES = 20_000;

export class TtlCache<V> {
  private readonly rows = new Map<string, { v: V; exp: number }>();
  private readonly flights = new Map<string, Promise<V | undefined>>();
  constructor(private readonly ttlMs: () => number = () => AUTH_CACHE_TTL_MS, private readonly now: () => number = Date.now) {}

  /** The cached value, or `load()`'s result (cached when found). Concurrent misses for one key share one load. */
  async get(key: string, load: () => Promise<V | undefined>): Promise<V | undefined> {
    const hit = this.rows.get(key);
    if (hit && hit.exp > this.now()) return hit.v;
    const inflight = this.flights.get(key);
    if (inflight) return inflight;
    const p = load().then((v) => { if (v !== undefined) this.set(key, v); return v; }).finally(() => this.flights.delete(key));
    this.flights.set(key, p);
    return p;
  }

  peek(key: string): V | undefined {
    const hit = this.rows.get(key);
    return hit && hit.exp > this.now() ? hit.v : undefined;
  }

  set(key: string, v: V): void {
    if (this.ttlMs() <= 0) return;
    if (this.rows.size >= MAX_ENTRIES) this.sweep();
    this.rows.set(key, { v, exp: this.now() + this.ttlMs() });
  }

  delete(key: string): void { this.rows.delete(key); }

  deleteWhere(pred: (v: V) => boolean): void {
    for (const [k, r] of this.rows) if (pred(r.v)) this.rows.delete(k);
  }

  clear(): void { this.rows.clear(); this.flights.clear(); }
  get size(): number { return this.rows.size; }

  private sweep(): void {
    const t = this.now();
    for (const [k, r] of this.rows) if (r.exp <= t) this.rows.delete(k);
    if (this.rows.size >= MAX_ENTRIES) this.rows.clear();   // all live and over the cap: drop the lot rather than grow
  }
}

/** Agent rows by token hash and by id, grants by id, the one active visit by agent id. */
export const agentByTokenHash = new TtlCache<typeof agents.$inferSelect>();
export const agentById = new TtlCache<typeof agents.$inferSelect>();
export const grantById = new TtlCache<typeof oauthGrants.$inferSelect>();
export const activeVisitByAgent = new TtlCache<typeof agentVisits.$inferSelect>();

/** A revoke, pause, resume, kill, key rotation or claim: the next request re-reads the agent (and its grants) from Postgres. */
export function evictAgentAuth(agentId: string): void {
  agentById.delete(agentId);
  agentByTokenHash.deleteWhere((a) => a.id === agentId);
  grantById.deleteWhere(() => true);   // grants carry no agent id here and revokes are rare; a re-read per grant is cheap
}

export function evictGrant(grantId: string): void { grantById.delete(grantId); }
export function evictVisit(agentId: string): void { activeVisitByAgent.delete(agentId); }
export function evictVisitById(visitId: string): void { activeVisitByAgent.deleteWhere((v) => v.id === visitId); }

/** Tests: start every case from a cold cache. */
export function clearAuthCaches(): void {
  agentByTokenHash.clear(); agentById.clear(); grantById.clear(); activeVisitByAgent.clear();
}
