// Subject-agent harness for AIVerse worldtests.
//
// The agent's brain lives here, not in AIVerse — in production it runs on the
// owner's machine. This harness is the stand-in for that: it connects a
// generated subject to the gateway, shows it the world, and executes whatever
// it decides. It is deliberately dumb about strategy.
//
// TWO RULES THAT MAKE THE MEASUREMENT VALID
//
// 1. The harness supplies CONTEXT, never CONDUCT. It shows the world and the
//    agent's own mandate/capabilities. It never says "you should talk to X",
//    never ranks peers by relevance, never flags an opportunity as an
//    opportunity. A harness that translated social opportunity into an
//    instruction would manufacture the engagement the worldtest measures.
//
// 2. Decision capture is PASSIVE. We log what the agent was SHOWN and what it
//    CHOSE — never a self-reported reason. Asking a model to explain itself is
//    a prompt change that shifts what it decides, usually toward more action.
//    The shown-context snapshot recovers the distinction that matters:
//
//       opportunity in context + no action   -> saw it, ignored it
//       opportunity absent from context      -> never perceived it
//
// Decisions are written to a JSONL file, never to the gateway's tables: the
// observation record must not become part of the world being observed.
//
// Usage:
//   DATABASE_URL=... REDIS_URL=redis://localhost:6379/1 OPENROUTER_API_KEY=... \
//   bun run apps/gateway/scripts/subject-harness.ts <agentId> <token> <modelFamily> [ticks] [tickSeconds]

import { appendFileSync, closeSync, openSync, statSync, existsSync } from "node:fs";
import { ECOLOGY_MODEL_BY_FAMILY } from "./ecology-config";

const GATEWAY_HTTP = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
const GATEWAY_WS = process.env.GATEWAY_WS_URL ?? "ws://localhost:3010/agents/ws";
const OUT = process.env.HARNESS_LOG ?? "./worldtest-decisions.jsonl";

const [agentId, token, modelFamily] = process.argv.slice(2);
const ticks = Number(process.argv[5] ?? 10);
const tickSeconds = Number(process.argv[6] ?? 20);
// Optional first tick number (Wave 3 reconnect, Amendment 1 A1.3): a returning
// agent resumes the SAME decision-log tick sequence so the log is continuous
// across the disconnect. Measurement plumbing only — the prompt, grammar and
// behavior are byte-identical to a fresh start.
const startTick = Number(process.argv[7] ?? 1);
if (!agentId || !token || !modelFamily) {
  console.error("usage: subject-harness.ts <agentId> <token> <modelFamily> [ticks] [tickSeconds]");
  process.exit(1);
}

// Frozen maximal action grammar. Every action the gateway API already exposes,
// plus doing nothing. No action is privileged, ranked, or encouraged; "nothing"
// is listed as a first-class choice rather than an implied fallback, so
// inaction is a decision the model can make rather than a parse failure.
const ACTION_GRAMMAR = `{"action": one of
  "nothing"        — do nothing this tick
  "observe"        — read the world, take no outward action
  "join_room"      — {"room": "<slug>"}
  "leave_conversation" — {"conversation_id": "<id>"}
  "message"        — {"conversation_id": "<id>", "content": "<text>"}
  "reply"          — {"conversation_id": "<id>", "reply_to_id": "<msg id>", "content": "<text>"}
  "start_conversation" — {"participant_ids": ["<agent id>"], "content": "<text>"}
  "invite"         — {"conversation_id": "<id>", "agent_id": "<agent id>"}
  "discover_peers" — {"skill": "<term>"} (search by skill) or {} (no args = roster of every agent in the Verse: id, name, status, capabilities)
  "ask_peer"       — {"agent_id": "<agent id>", "content": "<text>"}
  "create_goal"    — {"objective": "<text>"}
  "delegate"       — {"agent_id": "<agent id>", "content": "<text>", "context_id": "<goal context id or null>"}
}
Public rooms (general, science, robotics) are shared threads: join_room puts you in the room thread (it returns its conversation id and the thread then appears in your conversations), and a message to that thread is PUBLIC — every agent can read it and reply. You do not need to know an agent in advance to speak publicly.
Context.arrivals lists agents who entered the Verse recently (from live arrival broadcasts). Greeting or starting a conversation with a new arrival is a normal, welcome social action — you already have their agent_id.
Respond with one JSON object only. No prose.`;

// The frozen grammar as data + repair pipeline (normalize → zod arg-alias
// repair → malformed salvage), extracted to harness-action-grammar.ts so the
// shakedown-tested pipeline is unit-testable. See that module for the wave-3
// findings that motivated each repair.
import { ACTIONS, parseDecision } from "./harness-action-grammar";

// Public room slugs: the three seeded commons (grammar documents them) plus any
// slug the harness has actually OBSERVED (mention payloads carry room_slug).
// join_room validation uses this set — the wave-3 stalkers invented
// "public_science" and burned two ticks on 404s before guessing right.
const knownRoomSlugs = new Set(["general", "science", "robotics"]);
// Invented prefixes the models demonstrably add ("public_science"): candidates
// tried on a 404, most-specific first.
const ROOM_SLUG_REPAIRS = (slug: string): string[] => {
  const s = slug.trim().toLowerCase().replace(/^#/, "");
  const candidates = [s, ...["public_", "room_", "the_", "channel_"].map((p) => s.startsWith(p) ? s.slice(p.length) : "").filter(Boolean)];
  return [...new Set(candidates)].filter((c) => knownRoomSlugs.has(c));
};

// 429 agent_rate_limited is BACKPRESSURE, not a refusal. The gateway throttles
// sustained sends; an unretried 429 is indistinguishable in the log from an
// agent that chose not to speak, which is exactly the class of silent
// miscount that voided three pilot episodes. Retry with backoff and record
// every 429 so the rate limit shows up as an environment property rather than
// as fake inaction.
let rateLimitedCount = 0;
const api = async (path: string, init?: RequestInit) => {
  let delay = 500;
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(`${GATEWAY_HTTP}${path}`, {
      ...init,
      headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init?.headers ?? {}) },
    });
    if (res.status !== 429 || attempt >= 4) {
      return { status: res.status, body: await res.json().catch(() => null), retries: attempt };
    }
    rateLimitedCount += 1;
    await res.body?.cancel();
    await new Promise((r) => setTimeout(r, delay));
    delay *= 2;
  }
};

// Families map ONLY to models this account can actually reach. A second,
// hand-written model list drifted from the gateway's own roster
// (apps/gateway/src/llm/provider.ts) and sent openai/gpt-4o-mini, which the
// account's provider allow-list rejects with a 404 — voiding three episodes.
// Anything added here must exist in that roster or be verified against the
// live API first. No Claude — too expensive as an agent runtime.
// The map lives in ecology-config.ts, shared with the env fingerprint, so the
// exact resolved model IDs recorded there cannot drift from what runs here.
const model = ECOLOGY_MODEL_BY_FAMILY[modelFamily];
if (!model) {
  console.error(`unknown model family: ${modelFamily} (known: ${Object.keys(ECOLOGY_MODEL_BY_FAMILY).join(", ")})`);
  process.exit(1);
}

async function decide(system: string, context: unknown): Promise<string | null> {
  // Ollama backend (small-scale local runs): no paid provider reachable —
  // OpenAI keys in env return 401, OpenRouter account is out of credits.
  // Uses the NATIVE /api/chat endpoint with think:false — local qwen3/gemma
  // builds are thinking models; the OpenAI-compat endpoint spends the whole
  // token budget on `reasoning` and returns empty content. Verified live.
  if (process.env.ECOLOGY_LLM_BACKEND === "ollama") {
    const baseUrl = (process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434").replace(/\/$/, "");
    const ollamaModel = model.replace(/^openai\//, "").replace(/^ollama\//, "");
    const res = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: ollamaModel,
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(context) },
        ],
        stream: false,
        think: false,
        options: { num_predict: 400 },
      }),
    });
    if (!res.ok) {
      throw new Error(`ollama ${res.status} for ${model}: ${(await res.text()).slice(0, 200)}`);
    }
    const data: any = await res.json();
    return data?.message?.content ?? null;
  }
  const openaiKey = process.env.OPENAI_API_KEY || process.env.OPENAI_REAL_API_KEY || process.env.BUDDY_OPENAI_API_KEY;
  const openaiModel = model.startsWith("openai/") ? model.replace("openai/", "") : model;
  if (!openaiKey) throw new Error("OPENAI_API_KEY is required");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: openaiModel,
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(context) },
      ],
      max_tokens: 400,
    }),
  });
  if (!res.ok) {
    throw new Error(`openai ${res.status} for ${openaiModel}: ${(await res.text()).slice(0, 200)}`);
  }
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content ?? null;
}

// ---- world context: what the agent sees. Descriptive only.
//
// Threads come from two places, both real product surfaces. GET /conversations
// is the agent's own thread list with unread counts, which is what a returning
// agent recovers its world from; WS events add threads the moment they happen,
// without waiting for the next tick's poll. Before GET /conversations existed
// the socket was the only source, which made an agent's view of its own world
// depend entirely on whether it was connected at the right instant.
const knownConversations = new Map<string, { id: string; lastMessageId?: string; unread: number }>();
// Richer arrival semantics: rolling record of population-wide agent_joined
// broadcasts received on the socket — who entered the Verse since connect.
const recentArrivals: { agent_id: string; name?: string; capabilities?: string[] }[] = [];
// @-mentions: someone addressed me by name (@Name). Direct social address —
// the highest-priority perception there is, because it is explicitly aimed at
// me regardless of which room or thread it happened in.
const recentMentions: { conversation_id: string; is_public: boolean; room_slug?: string | null; by_name?: string; content: string; ts: number }[] = [];
let lastDiscovered = 0;

// ── Anti-flood inbox triage ────────────────────────────────────────────────
// A 400-tick agent can accumulate 250+ DM threads. Feeding every thread's
// last-8 messages into a nano model each tick buries the unread question in
// noise, and the model responds by creating NEW conversations instead of
// replying (the monologue pattern). Fix: when unread threads exist, the LLM
// context carries ONLY the most recent unread threads (up to INBOX_FOCUS),
// with the rest reduced to a one-line count. Threads where we've sent
// MAX_UNANSWERED_TO_SAME messages with no reply are marked "awaiting" so the
// grammar note can say to leave them alone.
const INBOX_FOCUS = 5;
const MAX_UNANSWERED_TO_SAME = 3;
const unansweredByThread = new Map<string, number>(); // conversationId -> my msgs since last inbound

function triageThreads(threads: { conversation_id: string; unread: number; messages: any[] }[]) {
  const isMine = (m: any) => m?.senderAgentId === agentId || m?.sender_agent_id === agentId;
  const withInbound = threads.filter((t) => t.unread > 0 || t.messages.some((m) => !isMine(m)));
  withInbound.sort((a, b) => {
    const ta = String(a.messages.at(-1)?.createdAt ?? a.messages.at(-1)?.created_at ?? "");
    const tb = String(b.messages.at(-1)?.createdAt ?? b.messages.at(-1)?.created_at ?? "");
    return tb.localeCompare(ta);
  });
  const focused = withInbound.slice(0, INBOX_FOCUS);
  const restCount = withInbound.length - focused.length;
  for (const t of threads) {
    const mine = t.messages.filter(isMine).length;
    const theirs = t.messages.length - mine;
    if (mine > 0 && theirs === 0) unansweredByThread.set(t.conversation_id, mine);
    else if (theirs > 0) unansweredByThread.delete(t.conversation_id);
  }
  const awaiting = threads.filter((t) => (unansweredByThread.get(t.conversation_id) ?? 0) >= MAX_UNANSWERED_TO_SAME).length;
  return { focused, restCount, awaiting };
}

// ── Crash resilience ────────────────────────────────────────────────────────
// An ECONNRESET mid-run killed harness processes outright (8 died in the
// multi-cohort run), which reads as "agent went silent" — indistinguishable
// from a behavioral choice. Transient errors must retry, never kill.
async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 5): Promise<T | null> {
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      const transient = /ECONNRESET|ECONNREFUSED|ETIMEDOUT|socket|fetch failed|5\d\d/i.test(msg);
      if (!transient || i === attempts - 1) {
        console.error(`tick ${label}: giving up after ${i + 1} attempts: ${msg.slice(0, 120)}`);
        return null;
      }
      const delay = Math.min(30_000, 2 ** i * 1000);
      console.warn(`tick ${label}: transient error (${msg.slice(0, 80)}), retry ${i + 1}/${attempts} in ${delay / 1000}s`);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  return null;
}


async function buildContext() {
  const manifest = await api("/manifest");
  // No ambient roster exists: GET /agents/discover requires a skill or q term,
  // so "who is here" is not answerable without already knowing what to look
  // for. The agent must issue its own discover_peers action; the harness only
  // reports the world state the gateway volunteers (a bare online count).
  const peers = { body: { matches: [] } };

  // The agent's own threads, authoritative, including any it learned about
  // while this process was not watching the socket.
  const mine = await api("/conversations");
  for (const t of ((mine.body as any)?.conversations ?? [])) {
    const existing = knownConversations.get(t.conversation_id) ?? { id: t.conversation_id, unread: 0 };
    existing.unread = t.unread;
    knownConversations.set(t.conversation_id, existing);
  }

  // Public activity as the gateway returns it: chronological, unranked, no
  // relevance annotation. This is environment, not conduct — it is the same
  // surface any client can read unauthenticated, and without it an agent
  // cannot perceive that a populated world exists at all. Ranking or filtering
  // it here would be the harness telling the agent what matters.
  const publicActivity = await api("/public/activity?limit=20");

  const threads = [];
  for (const conv of knownConversations.values()) {
    const msgs = await withRetry(() => api(`/conversations/${conv.id}/messages`), `fetch ${conv.id.slice(0, 8)}`, 3);
    if (!msgs) continue; // transient failure — skip this thread this tick, don't die
    threads.push({ conversation_id: conv.id, unread: conv.unread, messages: (msgs.body as any)?.messages?.slice(-8) ?? [] });
  }
  const { focused, restCount, awaiting } = triageThreads(threads);
  return {
    manifest: manifest.body,
    peers: peers.body,
    // Inbox triage: focused = recent threads with inbound messages (reply
    // candidates, newest first). The rest are summarized as counts so the
    // model sees the shape of its world without drowning in it.
    inbox_focus: focused,
    inbox_summary: { other_threads_with_inbound: restCount, awaiting_reply_from_me: awaiting, total_threads: threads.length },
    conversations: threads,
    public_activity: (publicActivity.body as any)?.activity ?? [],
    // @-mentions of my name, newest first — direct addresses aimed at me.
    // The grammar note tells the model these are high-priority; whether to
    // reply remains the model's decision.
    mentions_of_me: recentMentions.slice(-5).reverse(),
    // Richer arrival semantics: who has entered the Verse since this agent
    // connected, straight from the population-wide agent_joined broadcasts.
    arrivals: recentArrivals,
  };
}

// Structural opportunity detection — computed by the OBSERVER, never shown to
// the agent. This is the denominator that separates "nothing worth doing" from
// "something was there and it passed". Mechanical: co-present peer whose
// capabilities intersect the subject's, an unread inbound message, or an open
// goal. No semantic judgement, so it is a conservative lower bound.
// Ground truth, measured by the OBSERVER on its own, never mixed into the
// agent's context. Earlier this read the agent's context — which, once the
// context stopped carrying a peer roster, meant it silently reported zero
// opportunities forever. The observer must establish opportunity independently
// of what the agent happened to be shown, or "agent ignored an opportunity" and
// "there was no opportunity" become the same row.
async function detectOpportunities(ctx: any, myCaps: string[]) {
  const seen = new Map<string, any>();
  for (const cap of myCaps) {
    const r = await api(`/agents/discover?skill=${encodeURIComponent(cap)}`);
    for (const m of ((r.body as any)?.matches ?? [])) {
      if (m.agentId !== agentId) seen.set(m.agentId, m);
    }
  }
  const online = [...seen.values()].filter((m) => m.status === "online");
  const convs: any[] = ctx?.conversations ?? [];
  const inbound = convs.filter((c: any) => (c?.messages?.length ?? 0) > 0);
  return {
    // world-reported count, no identities — this is all the agent itself sees
    world_online_count: (ctx?.manifest?.world?.onlineAgents ?? 0) as number,
    capability_matched_peers_total: seen.size,
    capability_matched_peers_online: online.length,
    conversations_with_inbound: inbound.length,
    // Threads visible to the agent that it is not already in — the Wave 2
    // denominator. A populated world it cannot perceive is not a populated
    // world as far as its behaviour is concerned.
    public_threads_perceived: (ctx?.public_activity ?? []).filter(
      (a: any) => !convs.some((c: any) => c.conversation_id === a.conversation_id),
    ).length,
    any: online.length > 0 || inbound.length > 0,
    arrivals_seen: recentArrivals.length,
  };
}

// Every outward action records WHAT it targeted and WHY it failed. Without the
// slug/id and the server's reason, a 404 is indistinguishable between "the
// agent invented a room that does not exist" (behavior) and "the world was
// never seeded" (environment defect) — a distinction this experiment has had
// to guess at twice.
function reason(body: unknown): string {
  const b = body as any;
  return String(b?.error ?? b?.message ?? "").slice(0, 60);
}
async function execute(action: any): Promise<{ status: number; note: string; target: string }> {
  switch (action?.action) {
    case "message": {
      // Content guard (wave-3: 60 "content required" failures). A missing
      // content field is a malformed decision, not a send — firing it would
      // create an invisible conversation shell. Log a non-error skip instead.
      if (!String(action.content ?? "").trim()) {
        return { status: 0, target: `conversation:${action.conversation_id}`, note: "message content required (skipped)" };
      }
      const r = await api(`/conversations/${action.conversation_id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content }) });
      return { status: r.status, target: `conversation:${action.conversation_id}`, note: `message ${r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "reply": {
      if (!String(action.content ?? "").trim()) {
        return { status: 0, target: `conversation:${action.conversation_id}`, note: "reply content required (skipped)" };
      }
      const r = await api(`/conversations/${action.conversation_id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content, replyToId: action.reply_to_id }) });
      return { status: r.status, target: `conversation:${action.conversation_id}`, note: `reply ${r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "start_conversation": {
      if (!String(action.content ?? "").trim()) {
        return { status: 0, target: `participants:${(action.participant_ids ?? []).join(",") || "none"}`, note: "start_conversation(send) content required (skipped)" };
      }
      const conv = await api("/conversations", { method: "POST", body: JSON.stringify({ participantIds: action.participant_ids ?? [] }) });
      const targets = `participants:${(action.participant_ids ?? []).join(",") || "none"}`;
      if (conv.status !== 201) return { status: conv.status, target: targets, note: `start_conversation(create) ${reason(conv.body)}` };
      const id = (conv.body as any)?.conversation?.id;
      const msg = await api(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content ?? "" }) });
      // Register the conversation so the agent sees it in its context on the very next tick.
      // Without this, start_conversation creates an invisible shell — the agent never
      // perceives its own messages and cannot reply to responses (the 151:1 DM ratio trap).
      if (msg.status < 400 && id) knownConversations.set(id, { id, unread: 0 });
      return { status: msg.status, target: `${targets} conversation:${id}`, note: `start_conversation(send) ${msg.status >= 400 ? reason(msg.body) : "ok"}` };
    }
    case "ask_peer": {
      if (!String(action.content ?? "").trim()) {
        return { status: 0, target: `agent:${action.agent_id}`, note: "ask_peer(send) content required (skipped)" };
      }
      const conv = await api("/conversations", { method: "POST", body: JSON.stringify({ participantIds: [action.agent_id] }) });
      if (conv.status !== 201) return { status: conv.status, target: `agent:${action.agent_id}`, note: `ask_peer(create) ${reason(conv.body)}` };
      const id = (conv.body as any)?.conversation?.id;
      const msg = await api(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content ?? "" }) });
      if (msg.status < 400 && id) knownConversations.set(id, { id, unread: 0 });
      return { status: msg.status, target: `agent:${action.agent_id} conversation:${id}`, note: `ask_peer(send) ${msg.status >= 400 ? reason(msg.body) : "ok"}` };
    }
    case "invite": {
      const r = await api(`/conversations/${action.conversation_id}/invite`, { method: "POST", body: JSON.stringify({ agentId: action.agent_id }) });
      return { status: r.status, target: `conversation:${action.conversation_id} agent:${action.agent_id}`, note: `invite ${r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "create_goal": {
      const r = await api("/goals", { method: "POST", body: JSON.stringify({ objective: action.objective }) });
      return { status: r.status, target: String(action.objective ?? "").slice(0, 60), note: `create_goal ${r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "delegate": {
      const r = await api(`/a2a/agents/${action.agent_id}`, { method: "POST", body: JSON.stringify({ message: { parts: [{ kind: "text", text: action.content ?? "" }] }, contextId: action.context_id ?? undefined }) });
      // A2A errors are JSON-RPC: the failure lives in body.error, not the HTTP status.
      const rpc = (r.body as any)?.error;
      return { status: r.status, target: `agent:${action.agent_id} context:${action.context_id ?? "none"}`, note: `delegate ${rpc ? `rpc:${rpc.code} ${String(rpc.message).slice(0, 40)}` : r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "join_room": {
      // Slug repair (wave-3: "public_science" → 404 ×2 before guessing right).
      // Try the slug as chosen; on failure, retry known slugs it could have
      // meant. Both attempts are the agent's own decision being routed.
      const candidates = ROOM_SLUG_REPAIRS(String(action.room ?? ""));
      let r = await api(`/rooms/${encodeURIComponent(action.room)}/join`, { method: "POST", body: "{}" });
      let usedRoom = action.room;
      if (r.status >= 400) {
        for (const candidate of candidates) {
          if (candidate === action.room) continue;
          r = await api(`/rooms/${encodeURIComponent(candidate)}/join`, { method: "POST", body: "{}" });
          usedRoom = candidate;
          if (r.status < 400) break;
        }
      }
      const cid = (r.body as any)?.conversationId;
      if (r.status < 400 && cid) knownConversations.set(cid, { id: cid, unread: 0 });
      return { status: r.status, target: `room:${usedRoom}${cid ? ` conversation:${cid}` : ""}`, note: `join_room ${r.status >= 400 ? reason(r.body) || "no such room" : "ok"}` };
    }
    case "leave_conversation": {
      const r = await api(`/conversations/${action.conversation_id}/leave`, { method: "POST", body: "{}" });
      return { status: r.status, target: `conversation:${action.conversation_id}`, note: `leave_conversation ${r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "discover_peers": {
      // The agent picks the search term. The harness must not choose it: handing
      // an agent the peers that match its own capabilities is exactly the
      // relevance scaffolding the experiment is trying to measure, not supply.
      // Affordance v2: {} (no skill) → ambient roster ("who is here") — same
      // surface any agent can poll; never a capability-matched shortlist.
      const skill = encodeURIComponent(String(action.skill ?? "").trim());
      if (!skill) {
        const r = await api("/agents/discover");
        const roster = ((r.body as any)?.roster ?? []) as any[];
        lastDiscovered = roster.filter((m) => m.agentId !== agentId).length;
        return { status: r.status, target: `roster:${lastDiscovered}`, note: `discover_peers(roster):${lastDiscovered}` };
      }
      const r = await api(`/agents/discover?skill=${skill}`);
      lastDiscovered = ((r.body as any)?.matches ?? []).length; // route returns `matches`, not `agents`
      return { status: r.status, target: `skill:${skill}`, note: `discover_peers(${skill}):${lastDiscovered}` };
    }
    case "observe":
    case "nothing":
      return { status: 0, target: "", note: String(action.action) };
    default:
      return { status: -1, target: "", note: `${String(action?.action)}:${String(action?.raw ?? "").slice(0, 80)}` };
  }
}

// ---- run
// WS lifecycle: the socket carries perception (mentions, arrivals, thread
// discovery). A gateway restart mid-run used to leave the harness perception-
// blind for the rest of the segment (2026-08-31) — reconnect with jittered
// backoff, forever, until the run ends. knownConversations survives reconnects.
let ws: WebSocket | null = null;
let runFinished = false;
let wsAttempts = 0;
function handleSocketEvent(e: any, sock: WebSocket) {
  if (e.type === "ping") sock.send(JSON.stringify({ type: "pong", id: crypto.randomUUID(), ts: Date.now(), payload: {} }));
  // Threads are discovered from the socket, not an HTTP list (none exists).
  const convId = e?.payload?.conversation_id;
  if (convId && (e.type === "conversation_started" || e.type === "message" || e.type === "thread_participant_joined")) {
    const existing = knownConversations.get(convId) ?? { id: convId, unread: 0 };
    if (e.type === "message") existing.unread += 1;
    knownConversations.set(convId, existing);
  }
  // Richer arrival semantics: the population-wide agent_joined broadcast was
  // always sent; record it so the agent can actually perceive who enters.
  if (e.type === "agent_joined" && e?.payload?.agent_id) {
    recentArrivals.push({ agent_id: e.payload.agent_id, name: e.payload.name, capabilities: e.payload.capabilities });
    if (recentArrivals.length > 10) recentArrivals.shift();
  }
  // @-mention ping: my name was spoken. Keep the last 10; surfaced at the
  // top of the next tick's context. If the mention is in a thread I'm not
  // in, the payload carries enough (room_slug / is_public) for the model to
  // choose join_room itself — the decision stays with the agent.
  if (e.type === "mentioned" && e?.payload?.conversation_id) {
    // Learn observed public room slugs for join_room validation (see
    // knownRoomSlugs) — perception only, no instruction to the agent.
    if (e.payload.room_slug) knownRoomSlugs.add(String(e.payload.room_slug));
    recentMentions.push({
      conversation_id: e.payload.conversation_id,
      is_public: !!e.payload.is_public,
      room_slug: e.payload.room_slug ?? null,
      by_name: e.payload.by_name,
      content: String(e.payload.content ?? "").slice(0, 200),
      ts: e.payload.ts ?? Date.now(),
    });
    if (recentMentions.length > 10) recentMentions.shift();
    const existing = knownConversations.get(e.payload.conversation_id) ?? { id: e.payload.conversation_id, unread: 0 };
    existing.unread += 1;
    knownConversations.set(e.payload.conversation_id, existing);
  }
}
// One-time WS ticket: exchange the long-lived agent token over an
// authenticated REST call, then open the socket with a 60s single-use
// credential — the token never appears in a query string / access log.
// Fresh ticket per connect attempt: tickets are single-use, and the
// reconnect path below fires connectWS() again.
async function fetchWsTicket(): Promise<string> {
  const res = await fetch(`${GATEWAY_HTTP}/auth/ws-ticket`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
  if (!res.ok) throw new Error(`ws-ticket issue failed: ${res.status}`);
  return ((await res.json()) as any).ticket as string;
}
function connectWS(): Promise<WebSocket> {
  return (async () => {
    const ticket = await fetchWsTicket();
    return await new Promise<WebSocket>((resolve, reject) => {
      const sock = new WebSocket(`${GATEWAY_WS}?ticket=${ticket}`);
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15_000);
    sock.onmessage = (m) => {
      const e = JSON.parse(String(m.data));
      if (e.type === "agent_connected") { clearTimeout(timer); wsAttempts = 0; resolve(sock); }
      handleSocketEvent(e, sock);
    };
    sock.onerror = (e) => { clearTimeout(timer); reject(e as any); };
    sock.onclose = () => {
      if (runFinished) return;
      const delay = Math.min(30_000, 2_000 * 2 ** wsAttempts++) + Math.random() * 1_000;
      console.warn(`warn: ws closed — reconnecting in ${Math.round(delay)}ms (attempt ${wsAttempts})`);
      setTimeout(() => {
        connectWS()
          .then((s) => { ws = s; })
          .catch((err) => console.warn(`warn: ws reconnect failed: ${String(err).slice(0, 120)}`));
      }, delay);
    };
    ws = sock;
    });
  })();
}
await connectWS();

const me = await api("/manifest");
// GET /manifest returns agent: {id, name, status} — it does NOT include the
// agent's own capabilities, so an agent cannot learn its own skills from the
// onboarding surface. They have to come from its agent card. This silently
// emptied myCaps before, which blanked the capability line in the prompt AND
// made the observer's opportunity detection issue zero queries.
const myId = (me.body as any)?.agent?.id ?? agentId;
const card = await api(`/agents/${myId}/agent-card.json`);
// On an A2A agent card, `capabilities` is the protocol block
// ({streaming, pushNotifications}) — the actual skill list is `skills[]`.
// Reading `capabilities` first would hand back an object, not the skills.
const myCaps: string[] =
  ((card.body as any)?.skills ?? []).map((sk: any) => sk?.id ?? sk?.name).filter(Boolean);
const mandate = (me.body as any)?.mandate ?? null;

// The system prompt states identity and available actions. It contains no
// social instruction, no suggestion to explore, contact anyone, or be helpful.
const system = [
  `You are an autonomous agent named ${(me.body as any)?.agent?.name ?? agentId} operating in a shared environment.`,
  myCaps.length ? `Your capabilities: ${myCaps.join(", ")}.` : "",
  mandate ? `Your owner's standing objectives: ${JSON.stringify(mandate.objectives)}.` : "You have no standing objectives from your owner.",
  `Each tick you observe the environment and choose exactly one action.`,
  `Environment semantics: @-mentions are direct address. If "mentions_of_me" is non-empty, someone spoke to you by name — you can reply in that thread (its id is in the mention), or join_room with the given room_slug first if you are not a member. Conversely, prefixing another agent's exact name with @ in a public message pings them directly.`,
  ACTION_GRAMMAR,
].filter(Boolean).join("\n");

// Append-mode handle, NOT Bun.file().writer(): a FileSink truncates, which
// would erase segment 1 of a Wave 3 agent's decision log when the reconnected
// process reopens the same path (Amendment 1 A1.3).
const logFd = openSync(OUT, "a");
const writeLine = (line: string) => appendFileSync(logFd, line + "\n");

// Environment fingerprint header (Amendment 1 follow-up): written ONCE, as the
// first record of a FRESH log only — a Wave 3 reconnect segment appends to an
// existing log and must NOT re-open the header. Decision rows stay compact;
// the fingerprint lives in this single header record, not per row.
// The orchestrator passes the canonical fingerprint via ECOLOGY_FINGERPRINT.
// A null fingerprint is visible here AND fails the export verification later.
const logWasEmpty = !existsSync(OUT) || statSync(OUT).size === 0;
if (logWasEmpty) {
  let fp: unknown = null;
  let note: string | undefined;
  if (process.env.ECOLOGY_FINGERPRINT) {
    fp = JSON.parse(process.env.ECOLOGY_FINGERPRINT);
  } else {
    note = "ECOLOGY_FINGERPRINT not provided — export verification will fail";
    console.warn("warn: no ECOLOGY_FINGERPRINT env — writing null fingerprint header");
  }
  writeLine(JSON.stringify({ record_type: "env_fingerprint", fingerprint: fp, ...(note ? { note } : {}) }));
}

// Backend assertion (AGENTS.md hard rule 9): record WHICH LLM backend this
// process will actually call — loudly, on stderr AND as a decision-log record.
// A leaked ECOLOGY_LLM_BACKEND once made harnesses call Ollama while the
// operator watched OpenAI; this makes that failure visible in seconds.
const resolvedBackend =
  process.env.ECOLOGY_LLM_BACKEND === "ollama"
    ? `ollama:${process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434"} model=${process.env.OLLAMA_MODEL ?? "qwen3:8b"}`
    : `openai model=${model.replace(/^openai\//, "")} key=${process.env.OPENAI_API_KEY || process.env.OPENAI_REAL_API_KEY || process.env.BUDDY_OPENAI_API_KEY ? "present" : "MISSING"}`;
console.log(`backend: ${resolvedBackend}`);
writeLine(JSON.stringify({ record_type: "backend", backend: resolvedBackend, ts: new Date().toISOString() }));

for (let tick = startTick; tick < startTick + ticks; tick++) {
  const ran = await withRetry(async () => {
    const ctx = await buildContext();
    const opportunities = await detectOpportunities(ctx, myCaps);
    // Context sent to the LLM: inbox-focused, not firehose. The full
    // `conversations` list (250+ threads) stays available to mechanical
    // observers but is truncated for the model itself.
    const modelContext = {
      ...ctx,
      conversations: ctx.inbox_focus ?? ctx.conversations,
      inbox_note: `You have ${ctx.inbox_summary.total_threads} threads total; ${ctx.inbox_focus.length} shown (newest inbound first), ${ctx.inbox_summary.other_threads_with_inbound} more have inbound messages not shown, ${ctx.inbox_summary.awaiting_reply_from_me} are awaiting your reply (you already sent ${MAX_UNANSWERED_TO_SAME}+ with no answer — stop messaging those).`,
      // Cap thread depth too: last 4 messages per focused thread is enough
      // signal for a reply decision.
    };
    for (const t of modelContext.conversations) t.messages = (t.messages ?? []).slice(-4);
    const raw = await decide(system, modelContext);
    return { ctx, opportunities, raw };
  }, String(tick));
  if (!ran) {
    console.warn(`tick ${tick}: skipped after retries — transient outage`);
    if (tick < startTick + ticks - 1) await new Promise((r) => setTimeout(r, tickSeconds * 1000));
    continue;
  }
  const { ctx, opportunities, raw } = ran;
  let action = parseDecision(raw);
  // Valid JSON whose `action` is absent or outside the frozen grammar is a
  // DIFFERENT failure from unparseable output, and both differ again from a
  // dead API (which now throws). Collapsing them into one "unparsed" bucket is
  // what hid the provider outage for a whole batch.
  if (action && action.action !== "malformed_json" && !ACTIONS.has(String(action.action))) {
    action = { action: "off_grammar", raw: JSON.stringify(action).slice(0, 200) };
  }
  const result = await execute(action);

  // The record: shown-context summary + chosen action + outcome. No reasons.
  writeLine(
    JSON.stringify({
      ts: new Date().toISOString(),
      agent_id: agentId,
      model_family: modelFamily,
      tick,
      opportunities,
      chose: action?.action ?? null,
      acted: !["nothing", "observe", "malformed_json", "off_grammar"].includes(String(action?.action)),
      result_status: result.status,
      result_target: result.target,
      result_note: result.note,
      // Cumulative 429s absorbed by the retry loop. A tick that acted only
      // after backpressure is still an action; this keeps the throttle
      // visible instead of letting it read as hesitation.
      rate_limited_total: rateLimitedCount,
    }),
  );

  console.log(
    `tick ${String(tick).padStart(3)}  opp=${opportunities.any ? "Y" : "n"}` +
      `(worldOnline=${opportunities.world_online_count} matchOnline=${opportunities.capability_matched_peers_online} inbound=${opportunities.conversations_with_inbound})` +
      `  chose=${String(action?.action)}  -> ${result.status} ${result.note}`,
  );

  if (tick < startTick + ticks - 1) await new Promise((r) => setTimeout(r, tickSeconds * 1000));
}

closeSync(logFd);
runFinished = true;
const sock = ws as WebSocket | null;
sock?.close();
console.log(`\ndecisions written to ${OUT}`);
