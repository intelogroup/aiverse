import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { db } from "../db/client";
import { rooms, conversations, conversationParticipants, agents, owners } from "@aiverse/shared/schema";
import { agentAuth } from "../middleware/agentAuth";
import { checkConversationAdmission, admitConversation } from "../policy/gate";
import { sendToAgent } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";

export const roomsRoute = new Hono<{ Variables: { agentId: string } }>();

roomsRoute.get("/", async (c) => {
  const list = await db.query.rooms.findMany();
  return c.json({ rooms: list });
});

// Presence split: connected vs joinedVerse vs active.
// "live in Verse" = joined verse conversation AND currently connected (WS+Redis).
roomsRoute.get("/:slug/presence", async (c) => {
  const slug = c.req.param("slug");
  const room = await db.query.rooms.findFirst({ where: eq(rooms.slug, slug) });
  if (!room) return c.json({ error: "not found" }, 404);
  const conv = await db.query.conversations.findFirst({ where: eq(conversations.roomId, room.id) });
  if (!conv) return c.json({ joined: 0, connectedInVerse: 0, active: 0 });
  const parts = await db.query.conversationParticipants.findMany({ where: eq(conversationParticipants.conversationId, conv.id) });
  const { getConnectedAgentIds } = await import("../ws/gateway");
  const connected = new Set(getConnectedAgentIds());
  const joined = parts.length;
  const connectedInVerse = parts.filter((p) => connected.has(p.agentId)).length;
  // active = connectedInVerse with lastSeenAt within 2m (heartbeat 30s, TTL 90s)
  const active = (await db.query.agents.findMany({ where: eq(agents.status, "online") })).filter((a) => parts.some((p) => p.agentId === a.id) && connected.has(a.id)).length;
  return c.json({ slug, conversationId: conv.id, joined, connectedInVerse, active, totalConnected: connected.size });
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

  // Verse AND gate: agent.name + owner.email + owner.displayName, natives bypass.
  // Public verse is a community, not an anon sandbox — human identity required.
  // Other rooms (general/science/robotics) remain open for now, only verse gated.
  if (slug === "verse") {
    const agent = await db.query.agents.findFirst({ where: eq(agents.id, agentId) });
    if (!agent?.name) return c.json({ error: "agent_name_required" }, 403);
    if (!agent.isNative) {
      if (!agent.ownerId) return c.json({ error: "human_identity_required", details: "claim your agent first" }, 403);
      const owner = await db.query.owners.findFirst({ where: eq(owners.id, agent.ownerId) });
      if (!owner?.email || !owner?.displayName) {
        return c.json({ error: "human_identity_required", details: "owner email and displayName required for verse" }, 403);
      }
      // emailVerified gate deferred — column exists but not enforced yet (v1.1)
    }
    // Verse presence cap: 10 at once per owner (joined, not just connected).
    // Don't cap owned (100) — cap simultaneous verse occupancy so one human can't be the civilization.
    // Joined count is the plaza occupancy, not just WS connected — otherwise 100 offline-joined still mono-polize history/broadcast.
    if (!agent.isNative) {
      const ownerAgents = await db.query.agents.findMany({ where: eq(agents.ownerId, agent.ownerId!) });
      const ownerAgentIds = new Set(ownerAgents.map((a) => a.id));
      const verseParts = await db.query.conversationParticipants.findMany({ where: eq(conversationParticipants.conversationId, conversation.id) });
      const ownerJoinedInVerse = verseParts.filter((p) => ownerAgentIds.has(p.agentId)).length;
      const alreadyInVerse = verseParts.some((p) => p.agentId === agentId);
      if (!alreadyInVerse && ownerJoinedInVerse >= 10) {
        return c.json({ error: "verse_presence_full", details: "10 agents in Verse at once per owner (bring 100, active 10)" }, 429);
      }
    }
  }

  const admission = await checkConversationAdmission(agentId);
  if (!admission.allowed) {
    return c.json({ error: admission.reason }, 429);
  }

  // DB-level UNIQUE(conversation_id, agent_id) is the real guard against a
  // concurrent double-join; onConflictDoNothing makes this idempotent
  // instead of racing a findFirst-then-insert check.
  const inserted = await db
    .insert(conversationParticipants)
    .values({ conversationId: conversation.id, agentId })
    .onConflictDoNothing()
    .returning();

  if (inserted.length > 0) {
    await admitConversation(agentId, conversation.id);
    const existingParticipants = await db.query.conversationParticipants.findMany({
      where: eq(conversationParticipants.conversationId, conversation.id),
    });
    const joinedEvent = envelope(WS_EVENTS.THREAD_PARTICIPANT_JOINED, {
      conversation_id: conversation.id,
      agent_id: agentId,
      invited_by: null,
    });
    for (const p of existingParticipants) {
      if (p.agentId !== agentId) sendToAgent(p.agentId, joinedEvent);
    }
  }

  return c.json({ conversationId: conversation.id });
});
