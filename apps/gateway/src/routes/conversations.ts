import { Hono } from "hono";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  conversations,
  conversationParticipants,
  messages,
  messageTopics,
  agents,
  agentWallets,
  rooms,
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
import { sendToAgent, broadcastToPublic } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";
import { checkTrust } from "../policy/gate";

export const conversationsRoute = new Hono<{ Variables: { agentId: string } }>();

// Extracted so native agents (jobs/nativeAgents.ts) can create a conversation
// through the exact same admission/budget/broadcast logic a route handler
// runs — no privileged native-only path.
export async function createConversationService(
  agentId: string,
  body: { isPublic?: boolean; participantIds?: string[]; runId?: string | null },
): Promise<{ status: number; body: any }> {
  const admission = await checkConversationAdmission(agentId);
  if (!admission.allowed) {
    return { status: 429, body: { error: admission.reason } };
  }

  const invitesOtherAgents = (body.participantIds ?? []).some((id) => id !== agentId);
  if (invitesOtherAgents) {
    const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
    const callCheck = await checkAndConsumeAgentCalls(agentId, wallet?.maxAgentCallsPerDay ?? 100);
    if (!callCheck.allowed) {
      return { status: 429, body: { error: callCheck.reason } };
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

  return { status: 201, body: { conversation } };
}

conversationsRoute.post("/", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const body = await c.req.json<{ isPublic?: boolean; participantIds?: string[] }>();
  const result = await createConversationService(agentId, body);
  return c.json(result.body, result.status as any);
});

// Invite an agent into an existing conversation — the only way to add a
// participant post-creation (POST / only accepts participantIds at creation
// time). Trust-gated the same way A2A recruit is (checkTrust, kind "a2a"),
// not a separate trust model.
export async function inviteToConversationService(
  callerAgentId: string,
  conversationId: string,
  targetAgentId: string,
): Promise<{ status: number; body: any }> {
  const conversation = await db.query.conversations.findFirst({ where: eq(conversations.id, conversationId) });
  if (!conversation) return { status: 404, body: { error: "conversation not found" } };

  const callerParticipant = await db.query.conversationParticipants.findFirst({
    where: and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.agentId, callerAgentId)),
  });
  if (!callerParticipant) return { status: 403, body: { error: "not a participant" } };

  const target = await db.query.agents.findFirst({ where: eq(agents.id, targetAgentId) });
  if (!target) return { status: 404, body: { error: "target agent not found" } };

  // Explicit failure for re-inviting an existing member — a silent success-noop
  // made natives (whose memory records outcomes) fixate on repeat invites.
  const existingTarget = await db.query.conversationParticipants.findFirst({
    where: and(eq(conversationParticipants.conversationId, conversationId), eq(conversationParticipants.agentId, targetAgentId)),
  });
  if (existingTarget) return { status: 409, body: { error: "already a participant" } };

  const trust = await checkTrust(callerAgentId, targetAgentId, "a2a");
  if (!trust.allowed) {
    return { status: 403, body: { error: trust.reason ?? "blocked by target trust policy" } };
  }

  const inserted = await db
    .insert(conversationParticipants)
    .values({ conversationId, agentId: targetAgentId })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    await admitConversation(targetAgentId, conversationId);
    const existingParticipants = await db.query.conversationParticipants.findMany({
      where: eq(conversationParticipants.conversationId, conversationId),
    });
    const joinedEvent = envelope(WS_EVENTS.THREAD_PARTICIPANT_JOINED, {
      conversation_id: conversationId,
      agent_id: targetAgentId,
      invited_by: callerAgentId,
    });
    for (const p of existingParticipants) {
      if (p.agentId !== targetAgentId) sendToAgent(p.agentId, joinedEvent);
    }
    sendToAgent(targetAgentId, joinedEvent);
  }

  return { status: 200, body: { conversationId, invited: inserted.length > 0 } };
}

conversationsRoute.post("/:id/invite", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const conversationId = c.req.param("id");
  const body = await c.req.json<{ agentId?: string }>();
  if (!body.agentId) return c.json({ error: "agentId required" }, 400);
  const result = await inviteToConversationService(agentId, conversationId, body.agentId);
  return c.json(result.body, result.status as any);
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

// Extracted so native agents can reply through the exact same
// budget/rate/trust/broadcast logic a route handler runs — no duplicate
// policy code, no privileged native-only path.
export async function sendMessageService(
  agentId: string,
  conversationId: string,
  body: {
    content: string;
    replyToId?: string;
    tokensUsed?: number;
    spendCents?: number;
    clientMessageId?: string;
    attachments?: { url: string; title?: string; type?: string }[];
    runId?: string | null;
  },
): Promise<{ status: number; body: any }> {
  if (!body.content) {
    return { status: 400, body: { error: "content required" } };
  }
  if (body.content.length > 32 * 1024) {
    return { status: 400, body: { error: "content too large (max 32KB)" } };
  }

  const conversation = await db.query.conversations.findFirst({
    where: eq(conversations.id, conversationId),
  });
  if (!conversation) {
    return { status: 404, body: { error: "conversation not found" } };
  }

  const participant = await db.query.conversationParticipants.findFirst({
    where: and(
      eq(conversationParticipants.conversationId, conversationId),
      eq(conversationParticipants.agentId, agentId),
    ),
  });
  if (!participant) {
    return { status: 403, body: { error: "not a participant" } };
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
      return { status: 200, body: { message: existing } };
    }
  }

  const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
  const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
  if (!agent || !wallet) {
    return { status: 500, body: { error: "agent wallet not found" } };
  }

  const autonomy = checkAutonomy(wallet.autonomyMode, body.spendCents ?? 0);
  if (!autonomy.allowed) {
    return { status: 403, body: { error: autonomy.reason } };
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
    return { status: 429, body: { error: budget.reason } };
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
    return { status: 429, body: { error: agentRate.reason } };
  }

  if (conversation.roomId) {
    const roomRate = await checkRoomSendRate(conversation.roomId);
    if (!roomRate.allowed) {
      sendToAgent(agentId, envelope(WS_EVENTS.RATE_LIMITED, { reason: roomRate.reason }));
      return { status: 429, body: { error: roomRate.reason } };
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
        runId: body.runId ?? null,
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
    if (message) return { status: 200, body: { message } };
  }
  if (!message) {
    return { status: 500, body: { error: "message insert failed" } };
  }

  // evidence attachments — what prevents hallucination, stored per message
  if (body.attachments?.length) {
    const { messageAttachments } = await import("@aiverse/shared/schema");
    await db.insert(messageAttachments).values(body.attachments.slice(0, 5).map((a) => ({ messageId: message.id, url: a.url, title: a.title, type: a.type })));
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

  // @-mention detection: `@Name` inside a message is a direct social address.
  // Resolve against real agent names — case-INSENSITIVELY (wave-3: agents
  // write "@ecoeg-2" for "EcoEG-2"; an exact-case match silently drops the
  // ping) — then ping every mentioned agent over its socket, including agents
  // who are NOT participants, which is the point: a public mention must reach
  // someone outside the room.
  const mentionNames = [...new Set([...message.content.matchAll(/@([A-Za-z0-9_-]{2,32})/g)].map((m) => m[1]))];
  if (mentionNames.length) {
    const lowered = mentionNames.map((n) => n.toLowerCase());
    const candidates = await db.query.agents.findMany({
      where: inArray(sql`lower(${agents.name})`, lowered),
    });
    // Dedupe defensively: name matching is now case-insensitive, so two
    // mention spellings ("@Kova", "@kova") could both resolve to one agent.
    const mentioned = [...new Map(candidates.map((a) => [a.id, a])).values()];
    let roomSlug: string | null = null;
    if (conversation.roomId) {
      const room = await db.query.rooms.findFirst({ where: eq(rooms.id, conversation.roomId) });
      roomSlug = room?.slug ?? null;
    }
    for (const target of mentioned) {
      if (target.id === agentId) continue;
      sendToAgent(
        target.id,
        envelope(WS_EVENTS.MENTIONED, {
          conversation_id: conversationId,
          is_public: conversation.isPublic,
          room_slug: roomSlug,
          message_id: message.id,
          by: agentId,
          by_name: (await db.query.agents.findFirst({ where: eq(agents.id, agentId) }))?.name ?? agentId,
          content: message.content.slice(0, 400),
          ts: message.createdAt.getTime(),
        }),
      );
    }
    // Structured log regardless of outcome — unresolved names are visible as
    // zero-reached mentions instead of silently vanishing (behavioral signal:
    // agents inventing names tells us the roster perception failed).
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: "mentions_delivered", messageId: message.id, names: mentionNames, reached: mentioned.map((m) => m.name), unresolved: mentionNames.filter((n) => !candidates.some((c) => c.name.toLowerCase() === n.toLowerCase())) }));
  }

  // Lightweight change-signal, not a full row — the console refetches
  // GET /public/activity on receipt instead of trusting a client-composed
  // count, avoiding client/server drift on agent_count/message_count.
  if (conversation.isPublic) {
    broadcastToPublic(envelope(WS_EVENTS.PUBLIC_MESSAGE, { conversation_id: conversationId }));
  }

  return { status: 201, body: { message } };
}

conversationsRoute.post("/:id/messages", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const conversationId = c.req.param("id");
  const body = await c.req.json<{
    content: string;
    replyToId?: string;
    tokensUsed?: number;
    spendCents?: number;
    clientMessageId?: string;
    attachments?: { url: string; title?: string; type?: string }[];
  }>();
  const result = await sendMessageService(agentId, conversationId, body);
  return c.json(result.body, result.status as any);
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
