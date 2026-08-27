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
  releaseConversation,
  checkAndConsumeBudget,
  refundBudget,
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

  const admission = await checkConversationAdmission(agentId);
  if (!admission.allowed) {
    return c.json({ error: admission.reason }, 429);
  }

  const invitesOtherAgents = (body.participantIds ?? []).some((id) => id !== agentId);
  if (invitesOtherAgents) {
    const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
    const callCheck = await checkAndConsumeAgentCalls(agentId, wallet?.maxAgentCallsPerDay ?? 100);
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

  await admitConversation(agentId, conversation.id);

  const startedEvent = envelope(WS_EVENTS.CONVERSATION_STARTED, {
    conversation_id: conversation.id,
    participant_ids: participantIds,
  });
  for (const participantId of participantIds) {
    if (participantId !== agentId) sendToAgent(participantId, startedEvent);
  }

  return c.json({ conversation }, 201);
});

// Leaving is the only thing that frees an admission slot — without this,
// admitConversation's Redis set only ever grows and an agent that's ever
// touched the cap is locked out of joining/creating anything new, forever.
conversationsRoute.post("/:id/leave", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const conversationId = c.req.param("id");

  const deleted = await db
    .delete(conversationParticipants)
    .where(
      and(
        eq(conversationParticipants.conversationId, conversationId),
        eq(conversationParticipants.agentId, agentId),
      ),
    )
    .returning();

  if (deleted.length > 0) {
    await releaseConversation(agentId, conversationId);
  }

  return c.json({ left: deleted.length > 0 });
});

conversationsRoute.post("/:id/messages", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const conversationId = c.req.param("id");
  const body = await c.req.json<{
    content: string;
    replyToId?: string;
    tokensUsed?: number;
    spendCents?: number;
    clientMessageId?: string;
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

  // Idempotency: a retry carrying the same clientMessageId short-circuits
  // before any budget/rate consumption and returns the original message
  // as-is, rather than sending it twice or double-charging quota. This
  // only covers the sequential-retry case (original already committed) —
  // two genuinely concurrent requests with the same clientMessageId can
  // both pass this check and both consume budget/rate before the DB's
  // unique constraint picks a winner below; that residual gap is a real
  // reserve-vs-commit problem across Redis and Postgres, not solved here.
  if (body.clientMessageId) {
    const existing = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, conversationId),
        eq(messages.senderAgentId, agentId),
        eq(messages.clientMessageId, body.clientMessageId),
      ),
    });
    if (existing) {
      return c.json({ message: existing }, 200);
    }
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

  const budget = await checkAndConsumeBudget(agentId, body.tokensUsed ?? 0, wallet.dailyTokenBudget);
  if (!budget.allowed) {
    await db.update(agents).set({ status: "budget_exhausted" }).where(eq(agents.id, agentId));
    await recordAttentionEvent({
      agentId,
      ownerId: agent.ownerId!, // agentAuth blocks unclaimed agents, so this is set
      summary: `${agent.name} exceeded its daily token budget`,
      refConversationId: conversationId,
    });
    return c.json({ error: budget.reason }, 429);
  }

  if (autonomy.requiresApproval) {
    await recordAttentionEvent({
      agentId,
      ownerId: agent.ownerId!, // agentAuth blocks unclaimed agents, so this is set
      summary: `${agent.name} wants to send a message involving a spend of ${body.spendCents} cents`,
      refConversationId: conversationId,
    });
  }

  const agentRate = await checkAgentSendRate(agentId);
  if (!agentRate.allowed) {
    sendToAgent(agentId, envelope(WS_EVENTS.RATE_LIMITED, { reason: agentRate.reason }));
    return c.json({ error: agentRate.reason }, 429);
  }

  if (conversation.roomId) {
    const roomRate = await checkRoomSendRate(conversation.roomId);
    if (!roomRate.allowed) {
      sendToAgent(agentId, envelope(WS_EVENTS.RATE_LIMITED, { reason: roomRate.reason }));
      return c.json({ error: roomRate.reason }, 429);
    }
  }

  // onConflictDoNothing is the race backstop: if a concurrent identical
  // retry won the insert first, this one gets no row back — refetch the
  // winner's row instead of erroring or creating a duplicate.
  let inserted: (typeof messages.$inferSelect)[];
  try {
    inserted = await db
      .insert(messages)
      .values({
        conversationId,
        senderAgentId: agentId,
        content: body.content,
        replyToId: body.replyToId,
        clientMessageId: body.clientMessageId,
      })
      .onConflictDoNothing()
      .returning();
  } catch (err) {
    // Budget was already reserved in Redis above, before this insert ever
    // ran (the two can't share a transaction) — a genuine insert failure
    // here (not the benign race-conflict case, an actual throw) must not
    // permanently burn that reservation for a message that doesn't exist.
    await refundBudget(agentId, body.tokensUsed ?? 0);
    throw err;
  }

  let message = inserted[0];
  if (!message && body.clientMessageId) {
    message = await db.query.messages.findFirst({
      where: and(
        eq(messages.conversationId, conversationId),
        eq(messages.senderAgentId, agentId),
        eq(messages.clientMessageId, body.clientMessageId),
      ),
    });
    if (message) return c.json({ message }, 200);
  }
  if (!message) {
    return c.json({ error: "message insert failed" }, 500);
  }

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
