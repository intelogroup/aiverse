import { describe, expect, test, beforeAll } from "bun:test";
import { createApp } from "../app";
import { ensureRoomsSeeded } from "../db/seed";
import { resetMemoryStoreForTests, activeConversationCount } from "../policy/memoryStore";
import { DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS } from "../policy/gate";
import { db } from "../db/client";
import { conversationParticipants } from "@aiverse/shared/schema";
import { eq } from "drizzle-orm";

// Admission caps (2026-11-11, lane A4) — permanent versions of the
// adversarial-loop probes for the two conversation-admission cards:
//
//   AIV-CREATE-PARTICIPANT-CAP-001  createConversationService admitted
//     only the creator, then inserted every participantIds row
//     unconditionally — an at-cap victim named as a participant landed
//     at DB participation cap+1 while its Redis admission stayed at cap.
//   AIV-INVITE-ADMISSION-CAP-001    inviteToConversationService inserted
//     the participant row and called admitConversation(target) but
//     ignored its false return, with the same divergence.
//
// The discipline: admission is an atomic claim per participant, taken
// before (create) or rolled back on refusal (invite), so the Redis
// admission set and the conversation_participants rows can never
// disagree about whether an agent is in a conversation.

const app = createApp();
const CAP = DEFAULT_MAX_SIMULTANEOUS_CONVERSATIONS;

async function registerAgentWithId(name: string): Promise<{ token: string; agentId: string }> {
  const email = `cap-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "password123" }) });
  const { token: ownerToken } = await reg.json();
  const created = await app.request("/owners/agents", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ name, capabilities: [] }) });
  const { agentToken, agent } = await created.json();
  await app.request(`/owners/agents/${agent.id}/wallet`, { method: "PATCH", headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` }, body: JSON.stringify({ autonomyMode: "autonomous" }) });
  return { token: agentToken as string, agentId: agent.id as string };
}

async function createGroup(token: string, name: string, participantIds: string[] = []) {
  const res = await app.request("/conversations", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: JSON.stringify({ isPublic: false, name, participantIds }) });
  return { status: res.status, body: await res.json() };
}

async function participantCount(agentId: string) {
  const rows = await db.query.conversationParticipants.findMany({ where: eq(conversationParticipants.agentId, agentId) });
  return rows.length;
}

async function fillToCap(victim: { token: string }, tag: string) {
  for (let i = 0; i < CAP; i++) {
    const r = await createGroup(victim.token, `${tag}-${i}`);
    expect(r.status).toBe(201);
  }
}

beforeAll(async () => { await ensureRoomsSeeded(); await resetMemoryStoreForTests(); });

describe("conversation admission caps (AIV-CREATE-PARTICIPANT-CAP-001, AIV-INVITE-ADMISSION-CAP-001)", () => {
  test("creation leg: an at-cap agent named in participantIds is refused, DB and Redis agree", async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const victim = await registerAgentWithId(`VictimC-${uniq}`);
    const host = await registerAgentWithId(`HostC-${uniq}`);
    await fillToCap(victim, `v-group-${uniq}`);
    expect(await activeConversationCount(victim.agentId)).toBe(CAP);
    expect(await participantCount(victim.agentId)).toBe(CAP);

    // Control: the victim's own next creation is refused.
    const control = await createGroup(victim.token, `v-group-control-${uniq}`);
    expect(control.status).toBe(429);

    // Attack: a host creation naming the at-cap victim.
    const created = await createGroup(host.token, `h-group-create-${uniq}`, [victim.agentId]);
    expect(created.status).toBe(429);
    expect(await participantCount(victim.agentId)).toBe(CAP);
    expect(await activeConversationCount(victim.agentId)).toBe(CAP);
    // The refused creation must not leak an admission for the host either:
    // the host created nothing, so its admission count is unchanged (0).
    expect(await activeConversationCount(host.agentId)).toBe(0);
    expect(await participantCount(host.agentId)).toBe(0);
  }, 60000);

  test("invite leg: inviting an at-cap agent is refused and the row is rolled back", async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const victim = await registerAgentWithId(`VictimI-${uniq}`);
    const host = await registerAgentWithId(`HostI-${uniq}`);
    await fillToCap(victim, `vi-group-${uniq}`);

    const hostGroup = await createGroup(host.token, `h-group-${uniq}`);
    expect(hostGroup.status).toBe(201);

    const invite = await app.request(`/conversations/${hostGroup.body.conversation.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ agentId: victim.agentId }),
    });
    expect(invite.status).toBe(429);
    expect(await participantCount(victim.agentId)).toBe(CAP);
    expect(await activeConversationCount(victim.agentId)).toBe(CAP);
  }, 60000);

  test("under-cap participants are still admitted at creation and by invite", async () => {
    const uniq = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const host = await registerAgentWithId(`HostOk-${uniq}`);
    const guest = await registerAgentWithId(`GuestOk-${uniq}`);

    const created = await createGroup(host.token, `ok-group-${uniq}`, [guest.agentId]);
    expect(created.status).toBe(201);
    expect(await participantCount(guest.agentId)).toBe(1);
    expect(await activeConversationCount(guest.agentId)).toBe(1);

    const second = await registerAgentWithId(`Guest2Ok-${uniq}`);
    const hostGroup = await createGroup(host.token, `ok-group2-${uniq}`);
    expect(hostGroup.status).toBe(201);
    const invite = await app.request(`/conversations/${hostGroup.body.conversation.id}/invite`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${host.token}` },
      body: JSON.stringify({ agentId: second.agentId }),
    });
    expect(invite.status).toBe(200);
    expect(await participantCount(second.agentId)).toBe(1);
    expect(await activeConversationCount(second.agentId)).toBe(1);
  }, 60000);
});
