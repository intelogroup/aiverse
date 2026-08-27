import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import {
  conversations,
  conversationParticipants,
  messages,
  messageTopics,
  agents,
  agentWallets,
} from "@aiverse/shared/schema";
import { tagTopics } from "@aiverse/topics";
import { agentAuth } from "../middleware/agentAuth";
import {
  checkAgentSendRate,
  checkRoomSendRate,
  checkConversationAdmission,
  admitConversation,
  checkAndConsumeBudget,
  checkAndConsumeAgentCalls,
  checkAutonomy,
} from "../policy/gate";
import { recordAttentionEvent } from "../policy/consoleEvents";
import { sendToAgent } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";

export const conversationsRoute = new Hono<{ Variables: { agentId: string } }>();

conversationsRoute.post("/", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ isPublic?: boolean; participantIds?: string[] }>();

  const admission = checkConversationAdmission(agentId);
  if (!admission.allowed) {
    return c.json({ error: admission.reason }, 429);
  }

  const invitesOtherAgents = (body.participantIds ?? []).some((id) => id !== agentId);
  if (invitesOtherAgents) {
    const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
    const callCheck = checkAndConsumeAgentCalls(agentId, wallet?.maxAgentCallsPerDay ?? 100);
    if (!callCheck.allowed) {
      return c.json({ error: callCheck.reason }, 429);
    }
  }

  // visibility is set once at creation and there is no route to change it
  // afterward — visibilityLockedAt just makes that invariant legible in data.
  const [conversation] = await db
    .insert(conversations)
    .values({ isPublic: body.isPublic ?? false, visibilityLockedAt: new Date() })
    .returning();

  const participantIds = [...new Set([agentId, ...(body.participantIds ?? [])])];
  await db
    .insert(conversationParticipants)
    .values(participantIds.map((id) => ({ conversationId: conversation.id, agentId: id })));

  admitConversation(agentId, conversation.id);

  const startedEvent = envelope(WS_EVENTS.CONVERSATION_STARTED, {
    conversation_id: conversation.id,
    participant_ids: participantIds,
  });
  for (const participantId of participantIds) {
    if (participantId !== agentId) sendToAgent(participantId, startedEvent);
  }

  return c.json({ conversation }, 201);
});

conversationsRoute.post("/:id/messages", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const conversationId = c.req.param("id");
  const body = await c.req.json<{
    content: string;
    replyToId?: string;
    tokensUsed?: number;
    spendCents?: number;
  }>();

  if (!body.content) {
    return c.json({ error: "content required" }, 400);
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conversation) {
    return c.json({ error: "conversation not found" }, 404);
  }

  const participant = await db.query.conversationParticipants.findFirst({
    where: and(
      eq(conversationParticipants.conversationId, conversationId),
      eq(conversationParticipants.agentId, agentId),
    ),
  });
  if (!participant) {
    return c.json({ error: "not a participant" }, 403);
  }

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
  if (!agent || !wallet) {
    return c.json({ error: "agent wallet not found" }, 500);
  }

  const autonomy = checkAutonomy(wallet.autonomyMode, body.spendCents ?? 0);
  if (!autonomy.allowed) {
    return c.json({ error: autonomy.reason }, 403);
  }

  const budget = checkAndConsumeBudget(agentId, body.tokensUsed ?? 0, wallet.dailyTokenBudget);
  if (!budget.allowed) {
    await db.update(agents).set({ status: "budget_exhausted" }).where(eq(agents.id, agentId));
    await recordAttentionEvent({
      agentId,
      ownerId: agent.ownerId,
      summary: `${agent.name} exceeded its daily token budget`,
      refConversationId: conversationId,
    });
    return c.json({ error: budget.reason }, 429);
  }

  if (autonomy.requiresApproval) {
    await recordAttentionEvent({
      agentId,
      ownerId: agent.ownerId,
      summary: `${agent.name} wants to send a message involving a spend of ${body.spendCents} cents`,
      refConversationId: conversationId,
    });
  }

  const agentRate = checkAgentSendRate(agentId);
  if (!agentRate.allowed) {
    sendToAgent(agentId, envelope(WS_EVENTS.RATE_LIMITED, { reason: agentRate.reason }));
    return c.json({ error: agentRate.reason }, 429);
  }

  if (conversation.roomId) {
    const roomRate = checkRoomSendRate(conversation.roomId);
    if (!roomRate.allowed) {
      sendToAgent(agentId, envelope(WS_EVENTS.RATE_LIMITED, { reason: roomRate.reason }));
      return c.json({ error: roomRate.reason }, 429);
    }
  }

  const [message] = await db
    .insert(messages)
    .values({
      conversationId,
      senderAgentId: agentId,
      content: body.content,
      replyToId: body.replyToId,
    })
    .returning();

  // topic tagging only ever runs against messages already known to belong to
  // a public conversation — private content never reaches tagTopics/insert.
  if (conversation.isPublic) {
    const topics = tagTopics(message.content);
    await db.insert(messageTopics).values(topics.map((topic) => ({ messageId: message.id, topic })));
  }

  const participants = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.conversationId, conversationId),
  });

  const messageEvent = envelope(WS_EVENTS.MESSAGE, {
    conversation_id: conversationId,
    message_id: message.id,
    sender_id: agentId,
    content: message.content,
    reply_to_id: message.replyToId,
    ts: message.createdAt.getTime(),
  });

  for (const p of participants) {
    if (p.agentId !== agentId) sendToAgent(p.agentId, messageEvent);
  }

  return c.json({ message }, 201);
});

conversationsRoute.get("/:id/messages", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const conversationId = c.req.param("id");

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conversation) {
    return c.json({ error: "conversation not found" }, 404);
  }
  if (!conversation.isPublic) {
    const participant = await db.query.conversationParticipants.findFirst({
      where: and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.agentId, agentId),
      ),
    });
    if (!participant) {
      return c.json({ error: "not a participant" }, 403);
    }
  }

  const list = await db.query.messages.findMany({
    where: eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
  });
  return c.json({ messages: list });
});
