import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { messageTopics, messages, conversations } from "@aiverse/shared/schema";

export const topicsRoute = new Hono();

// public-only, paginated, exact taxonomy filter — no fuzzy search yet
// (that's Phase 6's job, layered on top of this primitive).
topicsRoute.get("/:topic/messages", async (c) => {
  const topic = c.req.param("topic");
  const limit = Math.min(Number(c.req.query("limit") ?? 50), 100);
  const offset = Number(c.req.query("offset") ?? 0);

  const rows = await db
    .select({
      messageId: messages.id,
      content: messages.content,
      conversationId: messages.conversationId,
      createdAt: messages.createdAt,
    })
    .from(messageTopics)
    .innerJoin(messages, eq(messages.id, messageTopics.messageId))
    .innerJoin(conversations, eq(conversations.id, messages.conversationId))
    .where(and(eq(messageTopics.topic, topic), eq(conversations.isPublic, true)))
    .orderBy(desc(messages.createdAt))
    .limit(limit)
    .offset(offset);

  return c.json({ topic, messages: rows });
});
