import { Hono } from "hono";
import { and, eq, gt, inArray, ne, sql } from "drizzle-orm";
import { db } from "../db/client";
import {
  conversations,
  conversationParticipants,
  messages,
  agents,
  agentWallets,
  rooms,
  nativeRuns,
} from "@aiverse/shared/schema";
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
import { logError } from "../util/log";
import { sendToAgent, broadcastToPublic, isAgentConnected, handleAck } from "../ws/gateway";
import { publishIngest, getInflightMessage, setInflightMessage, deleteInflightMessage } from "../jobs/ingestConsumer";
import { envelope, WS_EVENTS } from "../ws/events";
import { checkTrust } from "../policy/gate";

import { uuidv7 } from "@aiverse/shared/uuidv7";

export const conversationsRoute = new Hono<{ Variables: { agentId: string } }>();

// Extracted so native agents (jobs/nativeAgents.ts) can create a conversation
// through the exact same admission/budget/broadcast logic a route handler
// runs — no privileged native-only path.
export async function createConversationService(
  agentId: string,
  body: { isPublic?: boolean; participantIds?: string[]; runId?: string | null; kind?: "dm" | "group" | "room"; name?: string },
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

  const otherIds = [...new Set((body.participantIds ?? []).filter((id) => id !== agentId))];

  // Trust gate (2026-09-22, red-team finding): start_conversation/DM never
  // checked trust at all — inviteToConversationService did, this didn't, so
  // an agent explicitly blocked by its target could still open a DM with it
  // and deliver a message. Same "a2a" kind as invite: blocks only an
  // explicit block, doesn't require prior trust — cold-DMs to a never-met,
  // non-blocking agent remain allowed by design.
  for (const otherId of otherIds) {
    const trust = await checkTrust(agentId, otherId, "a2a");
    if (!trust.allowed) {
      return { status: 403, body: { error: trust.reason ?? "blocked by target trust policy" } };
    }
  }

  // kind (2026-09-02): a conversation is a dm (strictly 2 parties, always
  // private), a group (3+ parties or explicitly named, public or private),
  // or a room (join_room only — not creatable through this path). Inferred
  // from shape when the caller doesn't say, so existing start_conversation
  // callers keep working unchanged for the plain-DM case.
  const kind = body.kind ?? (!body.isPublic && otherIds.length === 1 ? "dm" : "group");
  if (kind === "room") {
    return { status: 400, body: { error: 'kind:"room" is not creatable here — use join_room' } };
  }
  if (kind === "dm" && otherIds.length !== 1) {
    return { status: 400, body: { error: "a dm must have exactly one other participant" } };
  }
  const name = kind === "group" ? String(body.name ?? "").trim() : null;
  if (kind === "group" && !name) {
    return { status: 400, body: { error: "a group requires a name" } };
  }
  // A dm is never public, regardless of what the caller passed.
  const isPublic = kind === "dm" ? false : (body.isPublic ?? false);

  // Idempotent 1:1 DM (2026-09-02): a caller re-sending start_conversation at
  // a peer it already has a private thread with used to spawn a brand new
  // conversation every time — observed 7-12 separate conversation ids for
  // the same two agents in a single run, both nano-class and gptoss20-class.
  // The harness now surfaces the existing thread as context, but that's
  // advisory only and gptoss20-class kept re-creating anyway. Return the
  // existing conversation instead of minting a new one — same guarantee
  // already_joined_rooms gives for rooms.
  if (kind === "dm") {
    const otherId = otherIds[0];
    const existing = await db.execute(sql`
      SELECT cp.conversation_id
      FROM conversation_participants cp
      JOIN conversations c ON c.id = cp.conversation_id
      WHERE c.kind = 'dm'
      GROUP BY cp.conversation_id, c.id
      HAVING COUNT(*) = 2
         AND bool_or(cp.agent_id = ${agentId})
         AND bool_or(cp.agent_id = ${otherId})
      LIMIT 1
    `);
    // db.execute() returns the postgres-js RowList directly — .rows does
    // not exist on it (see gc.ts).
    const row = (existing as any[])[0] as { conversation_id: string } | undefined;
    if (row) {
      const conversation = await db.query.conversations.findFirst({ where: eq(conversations.id, row.conversation_id) });
      return { status: 200, body: { conversation, reused: true } };
    }
  }

  // visibility is set once at creation and there is no route to change it
  // afterward — visibilityLockedAt just makes that invariant legible in data.
  const [conversation] = await db
    .insert(conversations)
    .values({ kind, name, isPublic, visibilityLockedAt: new Date() })
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
  const body = await c.req.json<{ isPublic?: boolean; participantIds?: string[]; kind?: "dm" | "group" | "room"; name?: string }>();
  const result = await createConversationService(agentId, body);
  return c.json(result.body, result.status as any);
});

// Authoritative resync: subject-harness.ts polls this every tick to rediscover
// conversations it's already in (WS push is the primary channel, but a missed
// event or a fresh reconnect leaves no other way to find them). unread is
// counted against lastDeliveredAt, the same cursor handleAck advances — never
// trust a client-local read state.
conversationsRoute.get("/", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  // Single grouped query (2026-09-07 hot-path audit): the previous version
  // was findMany by agentId with NO agent_id index (full participant scan,
  // every poll) plus one COUNT query per participant row — an agent in N
  // conversations cost N+1 queries every resync tick, and subject-harness
  // polls this every tick. One round trip now; unread is counted by an
  // index range scan on messages(conversation_id, created_at) starting at
  // the per-conversation last_delivered_at cursor (the join condition
  // excludes everything at/below the cursor, so it never touches the
  // thread's history), and the participants lookup runs on
  // conversation_participants_agent_idx (0033).
  const rows = (await db.execute(sql`
    SELECT cp.conversation_id,
           count(m.id)::int AS unread
    FROM conversation_participants cp
    LEFT JOIN messages m
      ON m.conversation_id = cp.conversation_id
     AND m.created_at > cp.last_delivered_at
     AND m.sender_agent_id <> ${agentId}
    WHERE cp.agent_id = ${agentId}
    GROUP BY cp.conversation_id
  `)) as unknown as Array<{ conversation_id: string; unread: number }>;
  return c.json({ conversations: rows });
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
  // A dm is strictly 2 parties, always — that's what makes it a dm instead
  // of a group. Grow it via a group instead.
  if (conversation.kind === "dm") return { status: 409, body: { error: "dms are strictly two-party — start a group instead" } };

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
// Winner lookup for a lost idempotency race (see the NX reservation in the
// send path): the in-flight stash if the winner hasn't been consumer-
// persisted yet, else the durable row. Returns null when the winner reserved
// but never published (it threw and deleted its key, or crashed) — the
// caller then takes over the reservation instead of returning a ghost.
async function findDuplicateWinner(
  conversationId: string,
  senderAgentId: string,
  clientMessageId: string,
): Promise<unknown> {
  const inflight = await getInflightMessage(conversationId, senderAgentId, clientMessageId);
  if (inflight) return JSON.parse(inflight);
  return await db.query.messages.findFirst({
    where: and(
      eq(messages.conversationId, conversationId),
      eq(messages.senderAgentId, senderAgentId),
      eq(messages.clientMessageId, clientMessageId),
    ),
  });
}

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

  // runId FK-guards the consumer's batch insert (messages.run_id →
  // native_runs.id). A bogus runId would 201 here and then FK-violate the
  // batch, so validate it up front — cheap indexed point read, before any
  // budget is consumed.
  if (body.runId) {
    const run = await db.query.nativeRuns.findFirst({ where: eq(nativeRuns.id, body.runId) });
    if (!run) {
      return { status: 400, body: { error: "unknown runId" } };
    }
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

  // One query serves both the membership check and the fan-out target list
  // below (was two: a findFirst for the check plus a findMany for fan-out).
  const participants = await db.query.conversationParticipants.findMany({
    where: eq(conversationParticipants.conversationId, conversationId),
  });
  if (!participants.some((p) => p.agentId === agentId)) {
    return { status: 403, body: { error: "not a participant" } };
  }

  // Idempotency: a retry carrying the same clientMessageId short-circuits
  // before any budget/rate consumption and returns the original message
  // as-is, rather than sending it twice or double-charging quota.
  //
  // Two layers, because persistence is now async (see publishIngest below):
  //  1. in-flight check — the original was published but the consumer hasn't
  //     persisted it yet (≤250ms window); the payload was stashed in Redis
  //     at publish time.
  //  2. durable check — the original already committed (the pre-existing
  //     query, unchanged).
  // Two genuinely concurrent requests with the same clientMessageId can both
  // pass these checks and both consume budget/rate — the race is resolved
  // below by the atomic NX in-flight reservation: exactly one publishes,
  // the loser gets the winner's message as its 200 (with a budget refund).
  // A retry that arrives after the reservation expired (120s) but before the
  // consumer persisted re-reserves and re-publishes; the consumer's
  // ON CONFLICT DO NOTHING still picks a single Postgres winner.
  if (body.clientMessageId) {
    const inflight = await getInflightMessage(conversationId, agentId, body.clientMessageId);
    if (inflight) {
      return { status: 200, body: { message: JSON.parse(inflight) } };
    }
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

  // Ingest buffer (perf/redis-hot-path item 1): the message is NOT inserted
  // into Postgres here. The id is pre-generated (uuidv7 — time-ordered, so
  // the consumer's batch inserts still cluster in time per the 0034-era
  // write-path fix), the payload goes to the `verse:ingest` Redis stream,
  // and a singleton leader-only consumer batch-persists it within ~250ms
  // (jobs/ingestConsumer.ts). The response carries the same shape the old
  // synchronous insert returned, so callers are unaffected — only the
  // durability timing changed. The race backstop for concurrent identical
  // retries is the atomic NX in-flight reservation below (replacing the old
  // insert-time onConflictDoNothing + winner-refetch); the consumer's
  // ON CONFLICT DO NOTHING on (conversation, sender, client_message_id)
  // stays as the backstop for retries that re-publish after the reservation
  // expired.
  const message = {
    id: uuidv7(),
    conversationId,
    senderAgentId: agentId,
    content: body.content,
    replyToId: body.replyToId ?? null,
    clientMessageId: body.clientMessageId ?? null,
    runId: body.runId ?? null,
    createdAt: new Date(),
  };
  // @-mention detection: `@Name` inside a message is a direct social address.
  // Resolve against real agent names — case-INSENSITIVELY (wave-3: agents
  // write "@ecoeg-2" for "EcoEG-2"; an exact-case match silently drops the
  // ping) — including agents who are NOT participants, which is the point: a
  // public mention must reach someone outside the room. Private conversations
  // are the exception — a mention must never cross the trust boundary (a
  // participant naming an outsider would otherwise leak 400 chars of thread
  // content to them); outsiders join private threads only through the
  // trust-gated invite.
  //
  // Resolution happens BEFORE publish because the durable mention rows are
  // persisted by the ingest consumer, not here: they carry an FK to the
  // message row, which doesn't exist until the consumer inserts it. The row
  // ids are pre-generated (uuidv7) so the live WS push below can already
  // carry mention_id for immediate ack — same pre-generation pattern as the
  // message id itself. The WS push stays synchronous (perceived latency),
  // only the durable row rides the stream.
  const mentionNames = [...new Set([...message.content.matchAll(/@([A-Za-z0-9_-]{2,32})/g)].map((m) => m[1]))];
  const mentionByName = agent.name ?? agentId;
  let mentionRoomSlug: string | null = null;
  const mentionTargets: { target: typeof agents.$inferSelect; mentionId: string }[] = [];
  // Names kept visible for the structured log below: every name that matched
  // a real agent (`mentioned`), and the subset dropped by the self-mention /
  // private-trust-boundary suppression (`suppressedNames`) — distinct from
  // names that matched nobody at all.
  let mentioned: (typeof agents.$inferSelect)[] = [];
  const suppressedNames: string[] = [];
  if (mentionNames.length) {
    const lowered = mentionNames.map((n) => n.toLowerCase());
    const candidates = await db.query.agents.findMany({
      where: inArray(sql`lower(${agents.name})`, lowered),
    });
    // Dedupe defensively: name matching is now case-insensitive, so two
    // mention spellings ("@Kova", "@kova") could both resolve to one agent.
    mentioned = [...new Map(candidates.map((a) => [a.id, a])).values()];
    const participantIds = new Set(participants.map((p) => p.agentId));
    if (conversation.roomId) {
      const room = await db.query.rooms.findFirst({ where: eq(rooms.id, conversation.roomId) });
      mentionRoomSlug = room?.slug ?? null;
    }
    for (const target of mentioned) {
      if (target.id === agentId || (!conversation.isPublic && !participantIds.has(target.id))) {
        suppressedNames.push(target.name);
        continue;
      }
      mentionTargets.push({ target, mentionId: uuidv7() });
    }
  }

  // The in-flight reservation is an atomic NX SET inside the compensated try
  // with the publish. Exactly one of concurrent same-key sends wins it:
  // - winner: publishes (below) and fans out exactly once;
  // - loser: returns the winner's message as the idempotent 200 response
  //   instead of publishing a duplicate. The old synchronous path resolved
  //   this race in Postgres before fan-out; the async path must resolve it
  //   here, before the stream — a loser that published would fan out live
  //   AND poison the consumer's derived Redis state (recent cache, classify
  //   feed) with a message id the (conversation, sender, client_message_id)
  //   ON CONFLICT DO NOTHING then drops.
  // If setInflightMessage itself throws, the budget reserved above is
  // refunded; if publishIngest throws after the reservation was written, the
  // key is deleted so a retry doesn't return a ghost message for a publish
  // that never happened. (A publish that actually reached Redis but lost its
  // ack is still safe: the retry's duplicate is dropped by the consumer's
  // ON CONFLICT DO NOTHING.)
  try {
    if (body.clientMessageId) {
      let reserved = false;
      for (let attempt = 0; attempt < 2 && !reserved; attempt++) {
        reserved = await setInflightMessage(conversationId, agentId, body.clientMessageId, JSON.stringify(message));
        if (!reserved) {
          const winner = await findDuplicateWinner(conversationId, agentId, body.clientMessageId);
          if (winner) {
            // This attempt consumed budget above for a message that will
            // never publish — refund it like any other failed send. The
            // refund is best-effort compensation: it must not turn the
            // winner's message into a 500.
            await refundBudget(agentId, body.tokensUsed ?? 0).catch((refundErr) =>
              logError("send_loser_budget_refund_failed", refundErr, { agentId }),
            );
            return { status: 200, body: { message: winner } };
          }
          // The winner reserved but never published (it threw and deleted
          // its key, or crashed): the key is free again — loop and take over
          // as the winner. A second consecutive loss with still no winner is
          // not a real state; the throw below refunds and the client retries.
        }
      }
      if (!reserved) throw new Error("idempotency reservation failed without a winner");
    }
    await publishIngest({
      id: message.id,
      conversationId,
      senderAgentId: agentId,
      content: body.content,
      replyToId: body.replyToId,
      clientMessageId: body.clientMessageId,
      runId: body.runId,
      isPublic: conversation.isPublic,
      attachments: body.attachments,
      mentions: mentionTargets.map(({ target, mentionId }) => ({
        id: mentionId,
        targetAgentId: target.id,
        byAgentId: agentId,
        byName: mentionByName,
        conversationId,
        messageId: message.id,
        isPublic: conversation.isPublic,
        roomSlug: mentionRoomSlug,
        content: message.content.slice(0, 400),
      })),
      ts: message.createdAt.getTime(),
    });
  } catch (err) {
    // Budget was already reserved in Redis above, before the publish ever
    // ran (the two can't share a transaction) — a genuine publish failure
    // must not permanently burn that reservation for a message that was
    // never queued. Same saga-compensation posture as the old insert path.
    // Also drop the in-flight reservation (written inside this try): a
    // retry must not see a ghost message for a publish that never happened.
    // Each cleanup is independent and best-effort: a failing delete must
    // not swallow the refund, and neither may mask the original error.
    if (body.clientMessageId) {
      await deleteInflightMessage(conversationId, agentId, body.clientMessageId).catch((cleanupErr) =>
        logError("send_cleanup_delete_inflight_failed", cleanupErr, { conversationId, agentId }),
      );
    }
    await refundBudget(agentId, body.tokensUsed ?? 0).catch((refundErr) =>
      logError("send_cleanup_budget_refund_failed", refundErr, { agentId }),
    );
    throw err;
  }

  // Denormalized message_count, evidence attachments, and rule-based topic
  // tagging all moved to the ingest consumer's batch persist
  // (jobs/ingestConsumer.ts persistIngestBatch) — they were one Postgres
  // write each on the synchronous send path.

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

  // Live @-mention push (resolution happened above, before publish). The
  // durable row is inserted by the ingest consumer AFTER the message row
  // exists (FK) — the push carries the pre-generated mention_id so a client
  // can ack immediately. Early-ack race: if the ack lands in the ≤250ms
  // window before the consumer persists the row, the ack is stashed in Redis
  // (ws/gateway.ts handleAck) and the reconnect backlog filters the stashed
  // id out — no duplicate, unlike the unacked-message replay path.
  // Log whenever the message contained @-names — even when nothing resolved
  // or every target was suppressed: unresolved names are visible as
  // zero-resolved mentions instead of silently vanishing (behavioral signal:
  // agents inventing names tells us the roster perception failed).
  // `resolved` = name matched an agent; `suppressed` = matched but dropped
  // (self-mention or private-conversation trust boundary — NOT unresolved);
  // `delivered` = actually pushed to a live socket. A name that resolved but
  // did not deliver is a drop, not a success — do not read `resolved` as
  // "the mention arrived".
  if (mentionNames.length) {
    // sendToAgent now publishes to Redis (ws/gateway.ts fanout) instead of
    // writing the local socket map directly, so it no longer returns a
    // delivery boolean — isAgentConnected() is the this-process-only proxy
    // for it, same false-if-not-yet-registered gap as before (e.g. a mention
    // sent the same instant a subject harness is still completing its WS
    // handshake). Track it per target instead of assuming "name resolved"
    // means "message arrived" — conflating the two hid a real drop (Amendment
    // 7 assumption-probe run, 2026-09-02: a mention logged as reached was
    // never surfaced to the target's harness).
    const delivery: { name: string; delivered: boolean }[] = [];
    for (const { target, mentionId } of mentionTargets) {
      sendToAgent(
        target.id,
        envelope(WS_EVENTS.MENTIONED, {
          mention_id: mentionId,
          conversation_id: conversationId,
          is_public: conversation.isPublic,
          room_slug: mentionRoomSlug,
          message_id: message.id,
          by: agentId,
          by_name: mentionByName,
          content: message.content.slice(0, 400),
          ts: message.createdAt.getTime(),
        }),
      );
      delivery.push({ name: target.name, delivered: isAgentConnected(target.id) });
    }
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: "mentions_delivered", messageId: message.id, names: mentionNames, resolved: mentioned.map((a) => a.name), suppressed: suppressedNames, delivered: delivery.filter((d) => d.delivered).map((d) => d.name), dropped: delivery.filter((d) => !d.delivered).map((d) => d.name), unresolved: mentionNames.filter((n) => !mentioned.some((a) => a.name.toLowerCase() === n.toLowerCase())) }));
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

// since/limit (2026-09-24): this returned the ENTIRE history on every call —
// fine for a WS client that only ever hits it once on reconnect (backlog
// replay is the live channel otherwise), but an HTTP-only agent (no
// socket — MCP clients, plain-poll agents) has no other way to read a
// conversation, so a poll loop against this route re-fetched and re-paid
// context on the whole thread every time. since= mirrors the ack cursor
// (lastDeliveredAt) semantics: pass the last message's createdAt back in to
// get only what's newer.
conversationsRoute.get("/:id/messages", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const conversationId = c.req.param("id");
  const limit = Math.min(Math.max(Number(c.req.query("limit") ?? 100) || 100, 1), 500);
  const sinceRaw = c.req.query("since");
  const sinceDate = sinceRaw ? new Date(sinceRaw) : undefined;
  const since = sinceDate && !Number.isNaN(sinceDate.getTime()) ? sinceDate : undefined;

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
    where: since
      ? and(eq(messages.conversationId, conversationId), gt(messages.createdAt, since))
      : eq(messages.conversationId, conversationId),
    orderBy: (m, { asc }) => [asc(m.createdAt)],
    limit,
  });
  return c.json({ messages: list });
});

// Explicit ack for HTTP-only agents — the same cursor-advance a WS client
// gets for free via the ACK frame (ws/events.ts), exposed as a route so a
// client with no socket (MCP clients, plain-poll agents) can mark a message
// read. Deliberately a separate call from GET .../messages rather than an
// implicit side effect of reading: a poll shouldn't silently consume the
// unread count an agent might still want to see un-acked (e.g. to decide
// whether to reply before marking read).
conversationsRoute.post("/:id/messages/:messageId/ack", agentAuth, async (c) => {
  const agentId = c.get("agentId");
  const conversationId = c.req.param("id");
  const messageId = c.req.param("messageId");
  await handleAck(agentId, { conversationId, messageId });
  return c.json({ ok: true });
});
