// Redis-backed rate limits, budget counters, and conversation-admission
// tracking. Postgres is the durable system of record (messages, wallets,
// agents); this is ephemeral coordination state only — losing it (a Redis
// flush/restart) resets limits to zero rather than corrupting anything
// durable. All ops below are Lua scripts so check+mutate is atomic even
// across multiple gateway processes talking to the same Redis.
import { redis } from "../redis/client";

const TOKEN_BUCKET_SCRIPT = `
local key = KEYS[1]
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local now = tonumber(ARGV[3])
local data = redis.call('HMGET', key, 'tokens', 'ts')
local tokens = tonumber(data[1])
local ts = tonumber(data[2])
if tokens == nil then
  tokens = capacity
  ts = now
end
local elapsed = (now - ts) / 1000
tokens = math.min(capacity, tokens + elapsed * refill)
if tokens < 1 then
  redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
  redis.call('PEXPIRE', key, 60000)
  return 0
end
tokens = tokens - 1
redis.call('HMSET', key, 'tokens', tokens, 'ts', now)
redis.call('PEXPIRE', key, 60000)
return 1
`;

const DAILY_COUNTER_SCRIPT = `
local key = KEYS[1]
local amount = tonumber(ARGV[1])
local limit = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local current = tonumber(redis.call('GET', key) or '0')
if current + amount > limit then
  return {0, current}
end
local newval = redis.call('INCRBY', key, amount)
redis.call('EXPIRE', key, ttl)
return {1, newval}
`;

// Conversation admission: SADD is a no-op if the member's already in the set
// (rejoining an already-joined conversation never costs a budget slot), and
// the SCARD-then-SADD is one atomic script, so no TOCTOU between two
// concurrent joins for the same agent.
const CONVERSATION_ADMIT_SCRIPT = `
local key = KEYS[1]
local member = ARGV[1]
local max = tonumber(ARGV[2])
if redis.call('SISMEMBER', key, member) == 1 then
  return 1
end
if redis.call('SCARD', key) >= max then
  return 0
end
redis.call('SADD', key, member)
return 1
`;

const DAY_SECONDS = 60 * 60 * 26; // a bit over a day, covers dateKey rollover skew

export async function takeToken(
  key: string,
  capacity: number,
  refillPerSecond: number,
): Promise<boolean> {
  const result = await redis.eval(
    TOKEN_BUCKET_SCRIPT,
    1,
    key,
    capacity,
    refillPerSecond,
    Date.now(),
  );
  return result === 1;
}

export async function incrementDailyCounterIfUnderLimit(
  key: string,
  amount: number,
  limit: number,
): Promise<{ allowed: boolean; total: number }> {
  const [allowed, total] = (await redis.eval(
    DAILY_COUNTER_SCRIPT,
    1,
    key,
    amount,
    limit,
    DAY_SECONDS,
  )) as [number, number];
  return { allowed: allowed === 1, total };
}

export async function getDailyCounter(key: string): Promise<number> {
  const value = await redis.get(key);
  return value ? Number(value) : 0;
}

// Compensating action for the reserve-then-persist gap: budget is consumed
// in Redis before the Postgres insert it's paying for even happens, since
// the two can't share a real transaction. If the insert then fails, this
// refunds the reservation instead of silently, permanently eating quota for
// a message that never existed. Best-effort, not itself transactional —
// this is a saga-style compensation, not a distributed transaction.
export async function refundDailyCounter(key: string, amount: number): Promise<void> {
  await redis.decrby(key, amount);
}

// True if this join actually consumed a new admission slot (SADD happened),
// false if the agent was already at its cap. Idempotent for repeat joins.
export async function admitConversationIfUnderLimit(
  agentId: string,
  conversationId: string,
  maxSimultaneous: number,
): Promise<boolean> {
  const result = await redis.eval(
    CONVERSATION_ADMIT_SCRIPT,
    1,
    `conversations:${agentId}`,
    conversationId,
    maxSimultaneous,
  );
  return result === 1;
}

export async function activeConversationCount(agentId: string): Promise<number> {
  return redis.scard(`conversations:${agentId}`);
}

// Frees the admission slot a conversation was holding. Without this, the
// SADD-only set only ever grows — an agent that has ever touched
// `maxSimultaneous` conversations would be permanently locked out of
// joining/creating any more, forever, not just rate-limited.
export async function removeConversationAdmission(
  agentId: string,
  conversationId: string,
): Promise<void> {
  await redis.srem(`conversations:${agentId}`, conversationId);
}

export async function resetMemoryStoreForTests(): Promise<void> {
  const keys = await redis.keys("agent:*");
  const roomKeys = await redis.keys("room:*");
  const budgetKeys = await redis.keys("budget:*");
  const callKeys = await redis.keys("calls:*");
  const convKeys = await redis.keys("conversations:*");
  const publicKeys = await redis.keys("public:*");
  const all = [...keys, ...roomKeys, ...budgetKeys, ...callKeys, ...convKeys, ...publicKeys];
  if (all.length) await redis.del(...all);
}
