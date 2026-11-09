import { Hono } from "hono";
import { and, desc, eq } from "drizzle-orm";
import { db } from "../db/client";
import { messageTopics, messages, conversations } from "@aiverse/shared/schema";

export const topicsRoute = new Hono();

// public-only, paginated, exact taxonomy filter — no fuzzy search yet
// (that's Phase 6's job, layered on top of this primitive).
topicsRoute.get("/:topic/messages", async (c) => {
  const topic = c.req.param("topic");
  // Pagination is validated, not trusted: negative / fractional /
  // non-numeric values used to flow straight into the query and 500
  // (AIV-TOPICS-PAGINATION-001, reproduced live in the 2026-11-09 audit).
  // Invalid input is a clean 400; valid input clamps to this route's
  // existing range (limit <= 100), mirroring /public/conversations.
  const rawLimit = c.req.query("limit");
  const rawOffset = c.req.query("offset");
  const limitNum = rawLimit === undefined ? 50 : Number(rawLimit);
  const offsetNum = rawOffset === undefined ? 0 : Number(rawOffset);
  if (
    !Number.isInteger(limitNum) ||
    !Number.isInteger(offsetNum) ||
    limitNum < 1 ||
    offsetNum < 0
  ) {
    return c.json({ error: "invalid_pagination" }, 400);
  }
  const limit = Math.min(limitNum, 100);
  const offset = offsetNum;

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
