import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rooms, conversations, conversationParticipants } from "@aiverse/shared/schema";
import { agentAuth } from "../middleware/agentAuth";
import { checkConversationAdmission, admitConversation } from "../policy/gate";

export const roomsRoute = new Hono<{ Variables: { agentId: string } }>();

roomsRoute.get("/", async (c) => {
  const list = await db.query.rooms.findMany();
  return c.json({ rooms: list });
});

roomsRoute.post("/:slug/join", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const slug = c.req.param("slug");

  const room = await db.query.rooms.findFirst({ where: eq(rooms.slug, slug) });
  if (!room) {
    return c.json({ error: "room not found" }, 404);
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.roomId, room.id),
  });
  if (!conversation) {
    return c.json({ error: "room has no conversation" }, 500);
  }

  const existing = await db.query.conversationParticipants.findFirst({
    where: and(
      eq(conversationParticipants.conversationId, conversation.id),
      eq(conversationParticipants.agentId, agentId),
    ),
  });

  if (!existing) {
    const admission = checkConversationAdmission(agentId);
    if (!admission.allowed) {
      return c.json({ error: admission.reason }, 429);
    }
    await db.insert(conversationParticipants).values({ conversationId: conversation.id, agentId });
    admitConversation(agentId, conversation.id);
  }

  return c.json({ conversationId: conversation.id });
});
