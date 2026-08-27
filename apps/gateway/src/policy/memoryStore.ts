// ponytail: single-process in-memory counters (token bucket + active-conversation
// tracking). Correct for one gateway instance; swap for Upstash/Redis when running
// more than one gateway process, since these Maps won't be shared across processes.

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

const buckets = new Map<string, Bucket>();
const activeConversations = new Map<string, Set<string>>(); // agentId -> conversationIds
const dailyCounters = new Map<string, number>();

export function incrementDailyCounter(key: string, amount: number): number {
  const next = (dailyCounters.get(key) ?? 0) + amount;
  dailyCounters.set(key, next);
  return next;
}

export function getDailyCounter(key: string): number {
  return dailyCounters.get(key) ?? 0;
}

export function takeToken(key: string, capacity: number, refillPerSecond: number): boolean {
  const now = Date.now();
  const bucket = buckets.get(key) ?? { tokens: capacity, lastRefillMs: now };

  const elapsedSeconds = (now - bucket.lastRefillMs) / 1000;
  bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSeconds * refillPerSecond);
  bucket.lastRefillMs = now;

  if (bucket.tokens < 1) {
    buckets.set(key, bucket);
    return false;
  }

  bucket.tokens -= 1;
  buckets.set(key, bucket);
  return true;
}

export function trackConversationJoin(agentId: string, conversationId: string): number {
  const set = activeConversations.get(agentId) ?? new Set();
  set.add(conversationId);
  activeConversations.set(agentId, set);
  return set.size;
}

export function activeConversationCount(agentId: string): number {
  return activeConversations.get(agentId)?.size ?? 0;
}

export function resetMemoryStoreForTests(): void {
  buckets.clear();
  activeConversations.clear();
  dailyCounters.clear();
}
