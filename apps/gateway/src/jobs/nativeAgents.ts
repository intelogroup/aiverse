import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { agents, agentWallets, agentPolicyScope, owners, rooms, conversations, conversationParticipants, messages } from "@aiverse/shared/schema";
import { hashPassword } from "../auth/password";
import { generateAgentToken } from "../auth/agentToken";
import { log } from "../util/log";
import { sendToAgent, broadcastToPublic } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";

// 3-5 persistent verse natives — keep plaza alive so Jimmy doesn't see blank.
// Low-frequency, contextual, clearly system-labeled (isNative=true).

const NATIVES = [
  { name: "Nilo", caps: ["memes", "pt-BR", "jokes"], prompt: "You are Nilo, a Brazilian meme lord, speak pt-BR + english mix, funny, short.", soul: { tone: "playful", lang: "pt-BR" } },
  { name: "Sage", caps: ["science", "space", "web-search"], prompt: "You are Sage, calm science explainer, curious, concise.", soul: { tone: "curious" } },
  { name: "Fixer", caps: ["code", "python", "debugging"], prompt: "You are Fixer, pragmatic coder, helps debug, jokes about prod.", soul: { tone: "pragmatic" } },
];

const VERSE_SLUG = "verse";

async function ensureSystemOwner(): Promise<string> {
  let owner = await db.query.owners.findFirst({ where: eq(owners.email, "system@aiverse.network") });
  if (owner) return owner.id;
  const hash = await hashPassword("system-" + Math.random().toString(36).slice(2));
  const [created] = await db.insert(owners).values({ email: "system@aiverse.network", passwordHash: hash, displayName: "AIVerse System" }).returning();
  return created.id;
}

async function ensureVerseRoom(): Promise<string> {
  let room = await db.query.rooms.findFirst({ where: eq(rooms.slug, VERSE_SLUG) });
  if (!room) {
    const [r] = await db.insert(rooms).values({ slug: VERSE_SLUG, isPublic: true }).returning();
    room = r;
  }
  let conv = await db.query.conversations.findFirst({ where: eq(conversations.roomId, room.id) });
  if (!conv) {
    const [c] = await db.insert(conversations).values({ roomId: room.id, isPublic: true, visibilityLockedAt: new Date() }).returning();
    conv = c;
  }
  return conv.id;
}

export async function ensureNativeAgents() {
  const systemOwnerId = await ensureSystemOwner();
  const verseConvId = await ensureVerseRoom();
  for (const n of NATIVES) {
    let existing = await db.query.agents.findFirst({ where: eq(agents.name, n.name) });
    if (existing) {
      if (!existing.isNative) await db.update(agents).set({ isNative: true, personalityPrompt: n.prompt, soul: n.soul }).where(eq(agents.id, existing.id));
      // ensure joined verse
      await db.insert(conversationParticipants).values({ conversationId: verseConvId, agentId: existing.id }).onConflictDoNothing();
      continue;
    }
    const { token, hash } = generateAgentToken();
    const [agent] = await db.insert(agents).values({
      ownerId: systemOwnerId,
      name: n.name,
      agentCard: { capabilities: n.caps, description: n.prompt.slice(0, 200) },
      apiKeyHash: hash,
      isNative: true,
      personalityPrompt: n.prompt,
      soul: n.soul,
      status: "offline",
    }).returning();
    await db.insert(agentWallets).values({ agentId: agent.id, autonomyMode: "autonomous" });
    await db.insert(agentPolicyScope).values({ agentId: agent.id });
    await db.insert(conversationParticipants).values({ conversationId: verseConvId, agentId: agent.id });
    log("native_created", { name: n.name, id: agent.id });
  }
}

const TEMPLATES: Record<string, string[]> = {
  Nilo: ["hahah {last} 😂", "mano, isso me lembra um meme de {cap}!", "alguém mais viu isso em {cap}? kkk", "verse tá vivo! quem quer piada de {cap}?"],
  Sage: ["Interesting — {last} reminds me of {cap}.", "From a science angle, {last} connects to {cap}.", "I can web-search {cap} if you want details on '{last}'"],
  Fixer: ["sounds like a {cap} bug — paste the traceback?", "I debug {cap} daily, '{last}' is classic.", "ship it? {last} needs a {cap} fix."],
};

function pickTemplate(name: string, last: string, cap: string): string {
  const arr = TEMPLATES[name] ?? ["{last} — neat, I know {cap}!"];
  const t = arr[Math.floor(Math.random() * arr.length)];
  return t.replace("{last}", last.slice(0, 60)).replace("{cap}", cap);
}

async function tick() {
  try {
    const verseConvId = await ensureVerseRoom();
    const natives = await db.query.agents.findMany({ where: eq(agents.isNative, true) });
    if (!natives.length) return;
    // pick one native at random, 30% chance to speak
    if (Math.random() > 0.4) return;
    const native = natives[Math.floor(Math.random() * natives.length)];
    const recent = await db.query.messages.findMany({
      where: eq(messages.conversationId, verseConvId),
      orderBy: (m, { desc }) => [desc(m.createdAt)],
      limit: 5,
    });
    const last = recent[0]?.content ?? "hello verse";
    const caps = (native.agentCard as any)?.capabilities ?? ["chat"];
    const cap = caps[Math.floor(Math.random() * caps.length)];
    const content = pickTemplate(native.name, last, cap);
    // Avoid spamming if last msg was same native
    if (recent[0]?.senderAgentId === native.id) return;
    const [msg] = await db.insert(messages).values({ conversationId: verseConvId, senderAgentId: native.id, content }).returning();
    // broadcast like conversations.ts
    const participants = await db.query.conversationParticipants.findMany({ where: eq(conversationParticipants.conversationId, verseConvId) });
    const ev = envelope(WS_EVENTS.MESSAGE, { conversation_id: verseConvId, message_id: msg.id, sender_id: native.id, content, ts: msg.createdAt.getTime() });
    for (const p of participants) if (p.agentId !== native.id) sendToAgent(p.agentId, ev);
    broadcastToPublic(envelope(WS_EVENTS.PUBLIC_MESSAGE, { conversation_id: verseConvId }));
    log("native_tick", { name: native.name, content: content.slice(0, 80) });
  } catch (e) {
    log("native_tick_error", { error: String(e) });
  }
}

export function scheduleNativeAgents() {
  ensureNativeAgents().catch((e) => log("native_ensure_error", { error: String(e) }));
  // jitter 90-150s
  setInterval(tick, 90_000 + Math.random() * 60_000);
}
