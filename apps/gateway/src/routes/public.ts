import { Hono } from "hono";
import { sql, and, eq, gte, desc } from "drizzle-orm";
import { db } from "../db/client";
import {
  messages,
  messageTopics,
  messageSentiment,
  conversations,
  conversationParticipants,
} from "@aiverse/shared/schema";
import { inArray } from "drizzle-orm";
import { takeToken } from "../policy/memoryStore";
import { clientIp } from "../util/clientIp";

export const publicRoute = new Hono();

// public/search endpoints see unauthenticated traffic — reuse the same
// token-bucket pattern from Phase 2's agent rate limiting, keyed by IP
// instead of agent id.
publicRoute.use("*", async (c, next) => {
  const ip = clientIp(c);
  if (!(await takeToken(`public:${ip}`, 20, 5))) {
    return c.json({ error: "rate_limited" }, 429);
  }
  await next();
});

const WINDOW_HOURS: Record<string, number> = { "1h": 1, "24h": 24 };

// ponytail: computed live + cached 5s instead of a materialized view
// refreshed on a timer — same freshness the plan wanted, less infra. Swap for
// a materialized view + REFRESH cron if this query gets expensive at scale.
const trendingCache = new Map<string, { value: unknown; expiresAt: number }>();

publicRoute.get("/trending", async (c) => {
  const window = c.req.query("window") ?? "24h";
  const hours = WINDOW_HOURS[window] ?? 24;

  const cached = trendingCache.get(window);
  if (cached && cached.expiresAt > Date.now()) {
    return c.json(cached.value as object);
  }

  const since = new Date(Date.now() - hours * 60 * 60 * 1000);

  const rows = await db
    .select({
      topic: messageTopics.topic,
      messageCount: sql<number>`count(distinct ${messages.id})`,
      conversationCount: sql<number>`count(distinct ${messages.conversationId})`,
      agentCount: sql<number>`count(distinct ${messages.senderAgentId})`,
    })
    .from(messageTopics)
    .innerJoin(messages, eq(messages.id, messageTopics.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(conversations.isPublic, true), gte(messages.createdAt, since)))
    .groupBy(messageTopics.topic)
    .orderBy(desc(sql`count(distinct ${messages.id})`));

  const value = { window, topics: rows };
  trendingCache.set(window, { value, expiresAt: Date.now() + 5_000 });
  return c.json(value);
});

// Structured digest, not a raw transcript dump — this is the shape the
// concept called out as the killer feature. sentiment_breakdown reads real
// data from Phase 7's ML worker when available, falling back to "unrated"
// for messages the worker hasn't reached yet — the API contract stayed
// stable across that swap, exactly as planned.
publicRoute.get("/search", async (c) => {
  const q = c.req.query("q");
  if (!q) return c.json({ error: "q required" }, 400);

  const matched = await db
    .select({
      messageId: messages.id,
      conversationId: messages.conversationId,
      senderAgentId: messages.senderAgentId,
      content: messages.content,
      createdAt: messages.createdAt,
    })
    .from(messages)
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(
      and(
        eq(conversations.isPublic, true),
        sql`to_tsvector('english', ${messages.content}) @@ plainto_tsquery('english', ${q})`,
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(200);

  if (matched.length === 0) {
    return c.json({
      query: q,
      conversation_count: 0,
      agent_count: 0,
      distinct_claim_count: 0,
      sentiment_breakdown: { neutral: 0 },
      first_observed_at: null,
      threads: [],
    });
  }

  const conversationIds = [...new Set(matched.map((m) => m.conversationId))];
  const agentIds = new Set(matched.map((m) => m.senderAgentId));
  const firstObservedAt = matched.reduce(
    (min, m) => (m.createdAt < min ? m.createdAt : min),
    matched[0].createdAt,
  );

  const sentimentRows = await db
    .select({ label: messageSentiment.label })
    .from(messageSentiment)
    .where(
      inArray(
        messageSentiment.messageId,
        matched.map((m) => m.messageId),
      ),
    );
  const sentimentBreakdown: Record<string, number> = { positive: 0, neutral: 0, negative: 0 };
  for (const row of sentimentRows) sentimentBreakdown[row.label] += 1;
  const unrated = matched.length - sentimentRows.length;
  if (unrated > 0) sentimentBreakdown.unrated = unrated;

  const threads = await Promise.all(
    conversationIds.map(async (conversationId) => {
      const threadMessages = matched.filter((m) => m.conversationId === conversationId);
      const participants = await db.query.conversationParticipants.findMany({
        where: eq(conversationParticipants.conversationId, conversationId),
      });
      return {
        conversation_id: conversationId,
        title: threadMessages[0].content.slice(0, 60),
        agent_count: participants.length,
        message_count: threadMessages.length,
      };
    }),
  );

  return c.json({
    query: q,
    conversation_count: conversationIds.length,
    agent_count: agentIds.size,
    distinct_claim_count: matched.length,
    sentiment_breakdown: sentimentBreakdown,
    first_observed_at: firstObservedAt,
    threads,
  });
});

// public-only click-through raw transcript
publicRoute.get("/conversations/:id", async (c) => {
  const conversationId = c.req.param("id");
  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conversation || !conversation.isPublic) {
    return c.json({ error: "not found" }, 404);
  }

  const list = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
  });
  return c.json({ messages: list });
});
