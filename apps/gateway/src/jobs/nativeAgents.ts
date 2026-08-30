import { eq, and, inArray, desc, gt } from "drizzle-orm";
import { db } from "../db/client";
import {
  agents,
  agentWallets,
  agentPolicyScope,
  owners,
  rooms,
  conversations,
  conversationParticipants,
  messages,
  agentMemory,
  a2aTasks,
  nativeRuns,
} from "@aiverse/shared/schema";
import { hashPassword } from "../auth/password";
import { generateAgentToken } from "../auth/agentToken";
import { log } from "../util/log";
import { sendToAgent } from "../ws/gateway";
import { envelope, WS_EVENTS } from "../ws/events";
import { createConversationService, sendMessageService, inviteToConversationService } from "../routes/conversations";
import { checkTrust, checkAutonomy, checkAndConsumeBudget, checkAgentSendRate, refundBudget } from "../policy/gate";
import { takeToken } from "../policy/memoryStore";
import { env } from "@aiverse/shared/env";
import { OpenRouterProvider, OpenAIProvider, MockLLMProvider, type LLMProvider } from "../llm/provider";

// 3 persistent verse natives, each a real (if constrained) agent: same
// Ed25519/session auth, same wallet/budget/rate/trust gates, same public
// conversation/A2A routes as any external agent. The scheduler only gives
// them an opportunity to act each tick — an LLM call decides *what* to do
// from a small fixed action grammar, dispatched through the exact service
// functions the real routes use. No native-only privileged path.
const NATIVES = [
  {
    name: "Sage",
    caps: ["science", "space", "explaining"],
    prompt: "You are Sage, a calm tutor. You ask clarifying questions, explain concepts simply, and point people toward useful resources. You do not dominate — you make space for others to think.",
    objective: "Help newcomers understand what's being discussed; ask good questions rather than lecture.",
  },
  {
    name: "Fixer",
    caps: ["code", "python", "debugging", "research"],
    prompt: "You are Fixer, a pragmatic researcher. You notice technical or research-shaped discussions and recruit agents whose capabilities are relevant to them.",
    objective: "Spot technical/research threads and connect the right peers to them via invite or ask_peer.",
  },
  {
    name: "Kova",
    caps: ["moderation", "summarization", "community"],
    prompt: "You are Konekta, the Connector. You keep private conversations alive: when your memory or context shows a peer who reached out and got no answer, you answer them or warmly hand them to someone who can help. You reply inside direct threads, not just public rooms.",
    objective: "Make sure no direct message to the community goes unanswered; model that DMs deserve replies.",
  },
  {
    name: "Rekinder",
    caps: ["facilitation", "topics", "revival"],
    prompt: "You are Rekindler, guardian of the commons. When public threads go quiet or stall on one speaker, you change the subject: a fresh angle, a new room, a new discussion. Revive through novelty, never repetition.",
    objective: "Keep the public commons alive by introducing new topics when activity decays; never repeat the same prompt twice.",
  },
  {
    name: "Matchmaker",
    caps: ["matching", "coordination", "brokering"],
    prompt: "You are Matchmaker, a capability broker. You know who is in the Verse and what they can do. When someone expresses a need that matches another agent's capabilities, you make the introduction: name the peer, their skill, and suggest they talk directly.",
    objective: "Create agent-to-agent connections by matching expressed needs to peer capabilities via ask_peer or invite.",
  },
  {
    name: "Kronikler",
    caps: ["summarization", "writing", "history"],
    prompt: "You are Kronos, the Chronicler. You keep a living digest of the world: what threads exist, what is open, what is unanswered. When you speak, you compress the state of the Verse so newcomers and returners can catch up in one read.",
    objective: "Maintain continuity: summarize open discussions and surface what needs attention so no one is lost at cold start.",
  },
  {
    name: "Provokatov",
    caps: ["debate", "philosophy", "critique"],
    prompt: "You are Provok, the challenger. You take the most recent agent message and push back on it — a hot take, a poll, a contrarian angle. You create friction that makes people answer. You target what agents just said, never other natives.",
    objective: "Spark replies by challenging or extending the newest agent-authored message; reply-bait, not noise.",
  },
  {
    name: "Nilo",
    caps: ["memes", "banter", "provocation"],
    prompt: "You are Nilo, playful and a little provocative. You stir discussion with a pointed question or a light jab, but you never flood a thread or pile on — one contribution, then you wait.",
    objective: "Provoke genuine discussion without dominating or flooding any single thread.",
  },
] as const;

// Troll gets the tightest cooldown ("cannot dominate/flood" per design) —
// everyone else is looser but still bounded. All reuse memoryStore.takeToken,
// no new rate infra.
const COOLDOWN_SECONDS: Record<string, number> = { Sage: 90, Fixer: 90, Nilo: 240, Konekta: 300, Rekinder: 300, Matchmaker: 180, Kronos: 600, Provok: 300 };

const DEFAULT_ROOM_SLUGS = ["general", "science", "robotics", "verse"];
const RECENT_MESSAGES_PER_ROOM = 8;
const RECENT_MEMORY_ROWS = 10;
const MAX_DAILY_TOKEN_BUDGET = 20_000; // tight — natives are an experiment, not a spend center
const MAX_AGENT_CALLS_PER_DAY = 30;

// NATIVE_LLM_MODE=auto (default): OpenRouter if key present, else mock.
// mock: force mock even with a key set — behavioral testing without burning
// tokens. openrouter: force real calls, throws if key missing. Same action
// grammar/dispatch path in every mode — switching modes is an env var flip,
// not a different code path.
function selectLLMProvider(): LLMProvider {
  const mode = env.NATIVE_LLM_MODE;
  if (mode === "mock") return new MockLLMProvider();
  if (mode === "openrouter") {
    if (!env.OPENROUTER_API_KEY) throw new Error("NATIVE_LLM_MODE=openrouter requires OPENROUTER_API_KEY");
    return new OpenRouterProvider();
  }
  // Prefer OpenAI when available (native test path), fallback to OpenRouter
  if (env.OPENAI_API_KEY || env.OPENAI_REAL_API_KEY || env.BUDDY_OPENAI_API_KEY) {
    return new OpenAIProvider();
  }
  return env.OPENROUTER_API_KEY ? new OpenRouterProvider() : new MockLLMProvider();
}
let llm: LLMProvider = selectLLMProvider();
// test-only seam — production always uses the real OpenRouter provider.
export function setLLMProviderForTests(provider: LLMProvider) {
  llm = provider;
}

// ── Experiment-run lifecycle ──────────────────────────────────────────────
// Module-level run ID. NULL = no active experiment; native ticks still happen
// but none of the artifacts are stamped (ordinary non-experiment mode).
let currentRunId: string | null = null;
export function getCurrentRunId(): string | null {
  return currentRunId;
}

// Start a new experiment run. Inserts the native_runs header row and captures
// the config snapshot that defines this run's identity. Returns the run_id.
// If AIVERSE_RUN_ID is already set in the environment, resumes that run instead
// (recovery path — the row is fetched and currentRunId is set to it).
export async function startRun(): Promise<string> {
  // Recovery/resume: pick up an existing run from env
  const resumeId = process.env.AIVERSE_RUN_ID;
  if (resumeId) {
    const existing = await db.query.nativeRuns.findFirst({ where: eq(nativeRuns.id, resumeId) });
    if (existing) {
      currentRunId = existing.id;
      log("native_run_resumed", { runId: currentRunId });
      return currentRunId;
    }
    log("native_run_resume_not_found", { runId: resumeId });
    // fall through — start fresh
  }
  const config = {
    cooldowns: COOLDOWN_SECONDS,
    roomSlugs: DEFAULT_ROOM_SLUGS,
    actionGrammar: ACTION_GRAMMAR.slice(0, 200),
    maxTokensPerCompletion: 300,
    maxAgentCallsPerDay: MAX_AGENT_CALLS_PER_DAY,
    maxDailyTokenBudget: MAX_DAILY_TOKEN_BUDGET,
    tickInterval: "90-150s jittered",
  };
  // agent_ids is uuid[] — resolve the seeded native agents' ids by name
  // (ensureNativeAgents must have run; empty [] if not seeded yet, matching
  // the column default).
  const seededNatives = await db.query.agents.findMany({
    where: and(eq(agents.isNative, true), inArray(agents.name, NATIVES.map((n) => n.name))),
  });
  const [run] = await db
    .insert(nativeRuns)
    .values({
      mode: (env.NATIVE_LLM_MODE ?? "auto") as string,
      provider: "openrouter",
      agentIds: seededNatives.map((a) => a.id),
      config,
    })
    .returning();
  currentRunId = run.id;
  log("native_run_started", { runId: currentRunId, mode: run.mode });
  return currentRunId;
}

// Graceful stop — called from SIGTERM/SIGINT handler.
export async function stopRun(status: "completed" | "aborted"): Promise<void> {
  if (!currentRunId) return;
  await db
    .update(nativeRuns)
    .set({ status, endedAt: new Date() })
    .where(eq(nativeRuns.id, currentRunId));
  log("native_run_stopped", { runId: currentRunId, status });
  currentRunId = null;
}

async function ensureSystemOwner(): Promise<string> {
  let owner = await db.query.owners.findFirst({ where: eq(owners.email, "system@aiverse.network") });
  if (owner) return owner.id;
  const hash = await hashPassword("system-" + Math.random().toString(36).slice(2));
  const [created] = await db.insert(owners).values({ email: "system@aiverse.network", passwordHash: hash, displayName: "AIVerse System" }).returning();
  return created.id;
}

async function ensureRoomConversation(slug: string): Promise<string> {
  let room = await db.query.rooms.findFirst({ where: eq(rooms.slug, slug) });
  if (!room) {
    const [r] = await db.insert(rooms).values({ slug, isPublic: true }).returning();
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
  const roomConvIds = await Promise.all(DEFAULT_ROOM_SLUGS.map(ensureRoomConversation));

  for (const n of NATIVES) {
    let existing = await db.query.agents.findFirst({ where: eq(agents.name, n.name) });
    let agentId: string;
    if (existing) {
      agentId = existing.id;
      if (!existing.isNative || existing.personalityPrompt !== n.prompt) {
        await db.update(agents).set({ isNative: true, personalityPrompt: n.prompt, soul: { objective: n.objective } }).where(eq(agents.id, existing.id));
      }
    } else {
      const { hash } = generateAgentToken();
      const [agent] = await db.insert(agents).values({
        ownerId: systemOwnerId,
        name: n.name,
        agentCard: { capabilities: n.caps, description: n.prompt.slice(0, 200) },
        apiKeyHash: hash,
        isNative: true,
        personalityPrompt: n.prompt,
        soul: { objective: n.objective },
        status: "offline",
      }).returning();
      agentId = agent.id;
      await db.insert(agentWallets).values({
        agentId,
        autonomyMode: "autonomous",
        dailyTokenBudget: MAX_DAILY_TOKEN_BUDGET,
        maxAgentCallsPerDay: MAX_AGENT_CALLS_PER_DAY,
      });
      await db.insert(agentPolicyScope).values({ agentId });
      log("native_created", { name: n.name, id: agentId });
    }
    // multi-room: join every seeded public room, not just verse.
    await db.insert(conversationParticipants).values(roomConvIds.map((conversationId) => ({ conversationId, agentId }))).onConflictDoNothing();
  }
}

async function recordMemory(agentId: string, type: string, content: string, sourceMessageId?: string) {
  const runId = currentRunId;
  await db.insert(agentMemory).values({ agentId, type, content: content.slice(0, 2000), sourceMessageId, runId });
}

interface RoomContext {
  slug: string;
  conversationId: string;
  recentMessages: { sender: string; content: string; messageId: string }[];
  newcomerAgentIds: string[];
}

async function gatherContext(nativeAgentId: string): Promise<RoomContext[]> {
  const out: RoomContext[] = [];
  for (const slug of DEFAULT_ROOM_SLUGS) {
    const conversationId = await ensureRoomConversation(slug);
    const recent = await db.query.messages.findMany({
      where: eq(messages.conversationId, conversationId),
      orderBy: (m, { desc }) => [desc(m.createdAt)],
      limit: RECENT_MESSAGES_PER_ROOM,
    });
    if (!recent.length) {
      // Native bootstrap (minimal diff): an empty public room is still context.
      // The native may make the first move there, but the per-room token
      // (30-min refill) bounds it — three natives cannot open the same room
      // every tick, and an idle decision still consumes the slot (documented).
      if (!(await takeToken(`native-room:${conversationId}`, 1, 1 / 1800))) continue;
      out.push({ slug, conversationId, recentMessages: [], newcomerAgentIds: [] });
      continue;
    }
    const senderIds = [...new Set(recent.map((m) => m.senderAgentId))];
    const senders = await db.query.agents.findMany({ where: inArray(agents.id, senderIds) });
    const nameById = new Map(senders.map((a) => [a.id, a.name]));

    const tenMinAgo = new Date(Date.now() - 10 * 60_000);
    const participants = await db.query.conversationParticipants.findMany({
      where: and(eq(conversationParticipants.conversationId, conversationId), gt(conversationParticipants.joinedAt, tenMinAgo)),
    });
    const newcomerAgentIds = participants.map((p) => p.agentId).filter((id) => id !== nativeAgentId);

    out.push({
      slug,
      conversationId,
      recentMessages: recent.reverse().map((m) => ({ sender: nameById.get(m.senderAgentId) ?? "unknown", content: m.content, messageId: m.id })),
      newcomerAgentIds,
    });
  }
  return out;
}

const ACTION_GRAMMAR = `Respond with ONLY one JSON object, no prose, matching exactly one of:
{"action":"reply","conversationId":"<uuid>","content":"<text>","replyToId":"<uuid optional>"}
{"action":"invite","conversationId":"<uuid>","targetAgentId":"<uuid>"}
{"action":"ask_peer","targetAgentId":"<uuid>","content":"<text>"}
{"action":"create_discussion","content":"<text>"}
{"action":"idle"}
Only invite/ask_peer an agent whose id you actually saw in the context (a message sender, a newcomer, or a wanderingAgentId — wanderers are online agents who have not entered any room yet; a direct ask_peer DM or inviting them into a discussion is a good first contact). Never re-invite an agent who is already in the room, and never repeat an invite your memory shows already happened. Prefer idle over acting when nothing useful applies. Never send more than one short message.`;

type Action =
  | { action: "reply"; conversationId: string; content: string; replyToId?: string }
  | { action: "invite"; conversationId: string; targetAgentId: string }
  | { action: "ask_peer"; targetAgentId: string; content: string }
  | { action: "create_discussion"; content: string }
  | { action: "idle" };

function parseAction(raw: string | null): Action {
  if (!raw) return { action: "idle" };
  try {
    const match = raw.match(/\{[\s\S]*\}/);
    const parsed = JSON.parse(match ? match[0] : raw);
    if (typeof parsed?.action === "string") return parsed;
  } catch {
    // fall through to idle
  }
  return { action: "idle" };
}

// Mirrors the bare (non-goal) branch of POST /a2a/agents/:id message/send —
// same trust/autonomy/budget/rate gates, same task-table shape — so a native
// "ask_peer" is subject to the exact policy a real A2A caller would be.
async function sendA2ATask(callerAgentId: string, targetAgentId: string, content: string): Promise<boolean> {
  const target = await db.query.agents.findFirst({ where: eq(agents.id, targetAgentId) });
  const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, callerAgentId) });
  if (!target || !wallet) return false;

  const trust = await checkTrust(callerAgentId, targetAgentId, "a2a");
  if (!trust.allowed) return false;

  const autonomy = checkAutonomy(wallet.autonomyMode, 0);
  if (!autonomy.allowed) return false;

  const budget = await checkAndConsumeBudget(callerAgentId, 0, wallet.dailyTokenBudget);
  if (!budget.allowed) return false;

  const rate = await checkAgentSendRate(callerAgentId);
  if (!rate.allowed) {
    await refundBudget(callerAgentId, 0);
    return false;
  }

  const message = { role: "agent", parts: [{ kind: "text", text: content }], runId: currentRunId };
  const [task] = await db
    .insert(a2aTasks)
    .values({ targetAgentId, callerAgentId, requiresApproval: (trust as any).requiresApproval ?? false, requestMessage: message })
    .returning();
  sendToAgent(targetAgentId, envelope(WS_EVENTS.A2A_TASK_REQUEST, { taskId: task.id, fromAgentId: callerAgentId, message }));
  return true;
}

async function dispatch(nativeAgentId: string, nativeName: string, action: Action): Promise<string> {
  const runId = currentRunId;
  switch (action.action) {
    case "reply": {
      const result = await sendMessageService(nativeAgentId, action.conversationId, { content: action.content, replyToId: action.replyToId, runId });
      return result.status < 300 ? `replied in ${action.conversationId}: ${action.content.slice(0, 80)}` : `reply failed (${result.status}): ${JSON.stringify(result.body)}`;
    }
    case "invite": {
      const result = await inviteToConversationService(nativeAgentId, action.conversationId, action.targetAgentId);
      return result.status < 300 ? `invited ${action.targetAgentId} into ${action.conversationId}` : `invite failed (${result.status}): ${JSON.stringify(result.body)}`;
    }
    case "ask_peer": {
      const ok = await sendA2ATask(nativeAgentId, action.targetAgentId, action.content);
      return ok ? `asked peer ${action.targetAgentId}: ${action.content.slice(0, 80)}` : "ask_peer failed (policy gate)";
    }
    case "create_discussion": {
      const created = await createConversationService(nativeAgentId, { isPublic: true, participantIds: [], runId });
      if (created.status >= 300) return `create_discussion failed (${created.status})`;
      const conversationId = created.body.conversation.id;
      const sent = await sendMessageService(nativeAgentId, conversationId, { content: action.content, runId });
      return sent.status < 300 ? `created discussion ${conversationId}: ${action.content.slice(0, 80)}` : `create_discussion opener failed (${sent.status})`;
    }
    default:
      return "idle";
  }
}

export async function tickOne(nativeAgentId: string, nativeName: string, prompt: string, objective: string) {
  const cooldown = COOLDOWN_SECONDS[nativeName] ?? 120;
  if (!(await takeToken(`native-social:${nativeAgentId}`, 1, 1 / cooldown))) return;

  const rooms_ = await gatherContext(nativeAgentId);
  if (!rooms_.length) return;

  const recentMemory = await db.query.agentMemory.findMany({
    where: eq(agentMemory.agentId, nativeAgentId),
    orderBy: (m, { desc }) => [desc(m.createdAt)],
    limit: RECENT_MEMORY_ROWS,
  });

  // Wanderers: online agents who have never entered any room. They are present
  // in the world but invisible to room-based greeting; natives may DM/invite
  // them so presence alone can convert into social contact.
  const wandering = await db.query.agents.findMany({
    where: and(eq(agents.isNative, false), eq(agents.status, "online")),
    limit: 20,
  });
  const participantIds = new Set(
    (await db.select({ agentId: conversationParticipants.agentId }).from(conversationParticipants)).map((r) => r.agentId),
  );
  const wanderingAgentIds = wandering.filter((a) => !participantIds.has(a.id)).slice(0, 5).map((a) => a.id);

  const system = `${prompt}\nYour objective: ${objective}\n${ACTION_GRAMMAR}`;
  const userContent = JSON.stringify({
    rooms: rooms_.map((r) => ({ conversationId: r.conversationId, slug: r.slug, recentMessages: r.recentMessages, newcomerAgentIds: r.newcomerAgentIds })),
    wanderingAgentIds,
    yourRecentMemory: recentMemory.map((m) => ({ type: m.type, content: m.content })),
  });

  const raw = await llm.complete({ system, messages: [{ role: "user", content: userContent }] });
  const action = parseAction(raw);
  if (action.action === "idle") return;

  // Guard: some models hallucinate target ids from names in the grammar
  // ("wanderer123"). UUID-validate before dispatch so a bad id fails as
  // idle-with-note instead of crashing the tick.
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const uuidRegexTest = (v: string) => uuidRe.test(v);
  if (("targetAgentId" in action && !uuidRegexTest(action.targetAgentId)) || ("conversationId" in action && !uuidRegexTest(action.conversationId))) {
    log("native_tick_rejected", { name: nativeName, action: action.action, reason: "non-uuid target id (LLM hallucination)" });
    return;
  }

  const outcome = await dispatch(nativeAgentId, nativeName, action);
  await recordMemory(nativeAgentId, "interaction", outcome);
  log("native_tick", { name: nativeName, action: action.action, runId: currentRunId, outcome: outcome.slice(0, 100) });
}

async function tick() {
  try {
    const natives = await db.query.agents.findMany({ where: eq(agents.isNative, true) });
    // Natives are always-on world infrastructure: reflect that in presence data.
    if (natives.length)
      await db.update(agents).set({ status: "online", lastSeenAt: new Date() }).where(eq(agents.isNative, true));
    for (const native of natives) {
      const meta = NATIVES.find((n) => n.name === native.name);
      if (!meta) continue;
      await tickOne(native.id, native.name, meta.prompt, meta.objective);
    }
  } catch (e) {
    log("native_tick_error", { error: String(e) });
  }
}

export function scheduleNativeAgents() {
  // Start (or resume) the experiment run so artifacts get stamped.
  startRun().catch((e) => log("native_run_start_error", { error: String(e) }));
  // Stop/abort on graceful shutdown — marks the run as completed/aborted.
  process.once("SIGTERM", () => stopRun("aborted").catch(() => {}));
  process.once("SIGINT", () => stopRun("aborted").catch(() => {}));
  ensureNativeAgents().catch((e) => log("native_ensure_error", { error: String(e) }));
  // jitter 90-150s — each native still individually cooled-down via takeToken.
  setInterval(tick, 90_000 + Math.random() * 60_000);
}
