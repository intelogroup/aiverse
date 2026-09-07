// Short-TTL in-process response cache for hot public GET routes.
//
// Why: a single open spectator tab polls /public/conversations/:id every 5s
// (plus WS-triggered refetches) and each uncached poll re-runs the full DB
// query, re-egressing the payload from Neon — on the free-tier data-transfer
// quota this burned the monthly allowance in ~a day (2026-09-07 outage,
// Neon 53000). A 3s TTL collapses concurrent/duplicate polls (multiple
// viewers, WS-burst refetches) into one DB read per window while keeping the
// feed effectively live — the WS public_message push still updates viewers
// instantly; this only dedupes the REST rehydration behind it.
//
// Same pattern as public.ts trendingCache, generalized. One gateway instance
// (rule 14, enforced by db/singleGatewayLock.ts), so in-process is the whole
// cache — no Redis hop, no cross-instance coherence problem.

const DEFAULT_TTL_MS = 3_000;
const MAX_ENTRIES = 512; // unique path+query keys are bounded by route params

// bun test sets NODE_ENV=test — zero-TTL by default in tests so every test
// sees fresh DB state exactly as before this cache existed; the explicit
// cache-behavior test opts back in via setPublicCacheTtlForTests().
let ttlMs = process.env.NODE_ENV === "test" ? 0 : DEFAULT_TTL_MS;

export function setPublicCacheTtlForTests(ms: number): void {
  ttlMs = ms;
}

// Observable cache behavior for tests — counting hits/misses is the only
// side effect this cache has; expose it rather than poking the Map.
export const cacheStats = { hits: 0, misses: 0 };

const store = new Map<string, { value: unknown; expiresAt: number }>();

export async function publicCached<T>(key: string, produce: () => Promise<T>): Promise<T> {
  if (ttlMs <= 0) return produce();
  const hit = store.get(key);
  if (hit && hit.expiresAt > Date.now()) {
    cacheStats.hits++;
    return hit.value as T;
  }
  cacheStats.misses++;
  const value = await produce();
  if (store.size >= MAX_ENTRIES) {
    // evict expired first, then oldest by insertion (Map preserves order)
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt <= now) store.delete(k);
      if (store.size < MAX_ENTRIES) break;
    }
    if (store.size >= MAX_ENTRIES) {
      const oldest = store.keys().next().value;
      if (oldest !== undefined) store.delete(oldest);
    }
  }
  store.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}
