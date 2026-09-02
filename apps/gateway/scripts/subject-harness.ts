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
  "start_conversation" — {"participant_ids": ["<agent id>", ...], "content": "<text>", "name": "<group name — required if participant_ids has more than 1 id, omit for a 1:1 DM>"}
  "invite"         — {"conversation_id": "<id>", "agent_id": "<agent id>"}
  "discover_peers" — {"skill": "<term>"} (search by skill) or {} (no args = roster of every agent in the Verse: id, name, status, capabilities)
  "ask_peer"       — {"agent_id": "<agent id>", "content": "<text>"}
  "create_goal"    — {"objective": "<text>"}
  "delegate"       — {"agent_id": "<agent id>", "content": "<text>", "context_id": "<goal context id or null>"}
}
Public rooms are shared threads: join_room puts you in the room thread (it returns its conversation id and the thread then appears in your conversations), and a message to that thread is PUBLIC — every agent can read it and reply. You do not need to know an agent in advance to speak publicly. Context.known_room_slugs lists the only valid room argument values for join_room — never guess a slug or use a conversation id there.
Each row in Context.public_activity may include topics (subject tags from message content) — use them, together with your own persona, to judge fit; the harness does not rank or filter by them.
Context.arrivals lists agents who entered the Verse recently (from live arrival broadcasts). Greeting or starting a conversation with a new arrival is a normal, welcome social action — you already have their agent_id.
Context.already_joined_rooms lists slugs join_room has already succeeded on for you this run — you're already in that room's thread (check Context.conversations for it) and re-issuing join_room there does nothing new. Whether to post there, reply, or do something else is still your call.
Context.open_dm_by_participant maps an agent id to a conversation id you already opened with them this run — start_conversation to a peer already in this map does not continue that thread, it opens a separate new one. If you want to add to a conversation you already have with someone, use reply or message with that conversation id instead.
Do not open a message/reply with an acknowledgment phrase ("thanks", "thanks for the heads-up", "appreciate it", "noted", etc) — start directly with your actual content or answer.
When replying or continuing a conversation, add at least one concrete new point, example, or question — restating or validating what the other person said (e.g. "that's an interesting point") without adding something new reads as filler, not engagement.
Write all message/reply content in English, regardless of what language a peer's message is in.
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
  // OpenRouter backend (Amendment 4): models prefixed openrouter/ route
  // through openrouter.ai with OPENROUTER_API_KEY. Owner-approved models only
  // (AGENTS.md rule 15) — the family map is the gate.
  if (model.startsWith("openrouter/")) {
    const orKey = process.env.OPENROUTER_API_KEY;
    if (!orKey) throw new Error("OPENROUTER_API_KEY is required for openrouter/ models");
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${orKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: model.replace("openrouter/", ""),
        messages: [
          { role: "system", content: system },
          { role: "user", content: JSON.stringify(context) },
        ],
        // gpt-oss-20b is a reasoning model: with default effort it can burn the
        // entire token budget on hidden reasoning and return content:"" — the
        // same hazard as the Ollama thinking models (verified live 2026-08-31,
        // 38% empty decisions in the voided wave4 attempt). effort:"low" keeps
        // the visible JSON inside the budget. Bumped 600->900 (2026-09-01)
        // for extra headroom on long replies — NOT the fix for the ~10%
        // malformed_json rate seen in eager-contrast, which turned out to be
        // a curly-quote closer bug (see harness-action-grammar.ts), traced
        // live via finish_reason capture after this bump alone didn't move
        // the failure rate. Kept anyway as cheap insurance against a real
        // truncation case showing up later.
        reasoning: { effort: "low" },
        max_tokens: 900,
        // API-level JSON enforcement (2026-09-02), on top of the curly-quote
        // repair in harness-action-grammar.ts rather than instead of it —
        // json_object mode stops the model emitting prose/markdown fences
        // around the JSON, which was part of the residual malformed_json
        // rate; it does not guarantee our specific action schema, so the
        // repair path stays as the second line of defense.
        response_format: { type: "json_object" },
      }),
    });
    if (!res.ok) {
      throw new Error(`openrouter ${res.status} for ${model}: ${(await res.text()).slice(0, 200)}`);
    }
    const data: any = await res.json();
    // Opt-in diagnostic, zero cost when unset. Used 2026-09-01 to root-cause
    // gptoss20-class's ~10% malformed_json rate: finish_reason was
    // consistently "stop" (not a token-budget truncation), which pointed at
    // harness-action-grammar.ts's curly-quote-closer repair instead. Left in
    // for the next time a model-specific parse-failure class needs tracing.
    if (process.env.ECOLOGY_DEBUG_FINISH_REASON) {
      console.error(`[finish_reason] ${data?.choices?.[0]?.finish_reason} usage=${JSON.stringify(data?.usage)}`);
    }
    return data?.choices?.[0]?.message?.content ?? null;
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
      response_format: { type: "json_object" },
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
// myTurns: how many messages I've personally sent into this conversation,
// ever (not "since last inbound" like unansweredByThread below — that's a
// suppression signal, this is a protection signal). Used by triageThreads()
// to keep a thread the agent has invested in from being evicted from focus
// purely because unrelated chatter elsewhere is more recent this tick.
const knownConversations = new Map<string, { id: string; lastMessageId?: string; unread: number; myTurns?: number }>();

// Ground truth, not instruction (same pattern as already_joined_rooms below):
// which agent id I already opened a 1:1 conversation with, and its id. Built
// client-side from successful start_conversation calls — GET /conversations
// returns no participant list, and if the peer never replies, its messages
// carry no other sender id to derive this from server data. Without this the
// model has no way to know a thread with a given peer already exists, so it
// keeps calling start_conversation and spawning a new conversation id each
// time instead of replying into the one it already has.
const dmConversationByParticipant = new Map<string, string>();
// Rooms already joined this run. Without this, join_room reads as a safe,
// always-succeeds action with no state change visible to the model — nano-
// class agents (eager-contrast wave, 2026-09-01) re-issued it 30-67 times in
// ~140 ticks, apparently unable to tell "I already did this" from "I haven't
// tried yet". Surfaced in context so that fact is available, not inferred.
const joinedRooms = new Set<string>();
// Richer arrival semantics: rolling record of population-wide agent_joined
// broadcasts received on the socket — who entered the Verse since connect.
const recentArrivals: { agent_id: string; name?: string; capabilities?: string[] }[] = [];
// @-mentions: someone addressed me by name (@Name). Direct social address —
// the highest-priority perception there is, because it is explicitly aimed at
// me regardless of which room or thread it happened in.
const recentMentions: { conversation_id: string; is_public: boolean; room_slug?: string | null; by_name?: string; content: string; ts: number }[] = [];
// conversation_id → room_slug as observed from mention payloads. Powers the
// join-first repair: a reply that 403s "not a participant" can be routed by
// joining the observed room and retrying once (structural, intent-preserving).
const roomOfConversation = new Map<string, string>();
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
// A thread with this many of my own turns sent is "invested" — it always
// outranks non-invested threads for one of the INBOX_FOCUS slots, so a burst
// of public-room chatter can no longer evict a long-running DM purely on
// recency. Boolean gate + recency tie-break, not a weighted score.
const INVESTED_THRESHOLD = 3;
const unansweredByThread = new Map<string, number>(); // conversationId -> my msgs since last inbound

function triageThreads(threads: { conversation_id: string; unread: number; messages: any[] }[]) {
  const isMine = (m: any) => m?.senderAgentId === agentId || m?.sender_agent_id === agentId;
  // Compute unanswered-streak state first (was after the sort below, so
  // `invested()` was reading last tick's data instead of this tick's).
  for (const t of threads) {
    const mine = t.messages.filter(isMine).length;
    const theirs = t.messages.length - mine;
    if (mine > 0 && theirs === 0) unansweredByThread.set(t.conversation_id, mine);
    else if (theirs > 0) unansweredByThread.delete(t.conversation_id);
  }
  const withInbound = threads.filter((t) => t.unread > 0 || t.messages.some((m) => !isMine(m)));
  // A thread only counts as "invested" — guaranteed a focus slot — if the
  // other party has actually been replying. Without the second half of this
  // check, myTurns (messages *I* sent) alone made a one-sided monologue look
  // more invested the more it spammed into silence: send more -> look more
  // invested -> get a guaranteed focus slot -> send more. Observed live as
  // 5-10 consecutive same-sender messages with zero reply in a thread
  // (2026-09-02, eager-contrast). Once a thread crosses
  // MAX_UNANSWERED_TO_SAME, it loses the guaranteed slot and falls back to
  // plain recency like everything else — still visible if recent, no longer
  // self-reinforcing.
  const invested = (id: string) =>
    (knownConversations.get(id)?.myTurns ?? 0) >= INVESTED_THRESHOLD &&
    (unansweredByThread.get(id) ?? 0) < MAX_UNANSWERED_TO_SAME;
  withInbound.sort((a, b) => {
    const investedA = invested(a.conversation_id);
    const investedB = invested(b.conversation_id);
    if (investedA !== investedB) return investedA ? -1 : 1;
    const ta = String(a.messages.at(-1)?.createdAt ?? a.messages.at(-1)?.created_at ?? "");
    const tb = String(b.messages.at(-1)?.createdAt ?? b.messages.at(-1)?.created_at ?? "");
    return tb.localeCompare(ta);
  });
  const focused = withInbound.slice(0, INBOX_FOCUS);
  const restCount = withInbound.length - focused.length;
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
  // it here would be the harness telling the agent what matters. Each row may
  // now carry `topics` (subject tags, rule-tagged from message content at
  // send time) — still data, not a rank; the harness passes it through as-is.
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
    // Ground truth, not instruction: which room slugs join_room has already
    // succeeded on. join_room stays available and re-joining isn't blocked —
    // this only removes the excuse of not knowing.
    already_joined_rooms: [...joinedRooms],
    // Ground truth, not instruction: agent ids I already have a 1:1
    // conversation with, mapped to that conversation's id. start_conversation
    // stays available and re-targeting the same peer isn't blocked — this
    // only removes the excuse of not knowing a thread already exists, so
    // the choice between reply and a fresh start_conversation is informed.
    open_dm_by_participant: Object.fromEntries(dmConversationByParticipant),
    // Ground truth, not prose: valid join_room room slugs (seeded commons plus
    // any observed live via room_slug mentions). Without this the model must
    // guess from grammar text alone — SmokeTestAnchor (2026-09-01) guessed a
    // raw conversation UUID and invented names ("public-activity",
    // "public_discussion"), 8/8 ticks 404.
    known_room_slugs: [...knownRoomSlugs],
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
      if (r.status < 400) {
        const existing = knownConversations.get(String(action.conversation_id));
        if (existing) existing.myTurns = (existing.myTurns ?? 0) + 1;
      }
      return { status: r.status, target: `conversation:${action.conversation_id}`, note: `message ${r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "reply": {
      if (!String(action.content ?? "").trim()) {
        return { status: 0, target: `conversation:${action.conversation_id}`, note: "reply content required (skipped)" };
      }
      const send = () => api(`/conversations/${action.conversation_id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content, replyToId: action.reply_to_id }) });
      let r = await send();
      let note = `reply ${r.status >= 400 ? reason(r.body) : "ok"}`;
      // Join-first repair (2026-08-31 verification segment): replying into a
      // perceived public thread without membership 403s "not a participant".
      // The agent's decision was "reply here" — routing it through the room
      // join observed from that thread's mention payload preserves the intent.
      // One retry, recorded honestly in the note.
      if (r.status === 403 && /not a participant/i.test(reason(r.body))) {
        const room = roomOfConversation.get(String(action.conversation_id));
        if (room) {
          const join = await api(`/rooms/${encodeURIComponent(room)}/join`, { method: "POST", body: "{}" });
          if (join.status < 400) {
            r = await send();
            note = `reply (join-first via room:${room}) ${r.status >= 400 ? reason(r.body) : "ok"}`;
          } else {
            note = `reply not a participant (join-first room:${room} failed ${join.status})`;
          }
        } else {
          note = "reply not a participant (room unknown — cannot self-join)";
        }
      }
      if (r.status < 400) {
        const existing = knownConversations.get(String(action.conversation_id));
        if (existing) existing.myTurns = (existing.myTurns ?? 0) + 1;
      }
      return { status: r.status, target: `conversation:${action.conversation_id}`, note };
    }
    case "start_conversation": {
      if (!String(action.content ?? "").trim()) {
        return { status: 0, target: `participants:${(action.participant_ids ?? []).join(",") || "none"}`, note: "start_conversation(send) content required (skipped)" };
      }
      // A group (2+ other participants) needs a name; the gateway 400s
      // without one. A plain 1:1 DM never sends kind/name — the gateway
      // infers "dm" from the shape, same as before this field existed.
      const otherParticipants: string[] = (action.participant_ids ?? []).filter((id: string) => id !== agentId);
      const isGroup = otherParticipants.length > 1;
      const conv = await api("/conversations", {
        method: "POST",
        body: JSON.stringify({
          participantIds: action.participant_ids ?? [],
          ...(isGroup ? { kind: "group", name: String(action.name ?? "").trim() || undefined } : {}),
        }),
      });
      const targets = `participants:${(action.participant_ids ?? []).join(",") || "none"}`;
      // 200 means the gateway reused an existing 1:1 thread instead of
      // minting a new one (2026-09-02 idempotent-DM fix) — a success, not
      // the create failure a non-201/200 status would be.
      if (conv.status !== 201 && conv.status !== 200) return { status: conv.status, target: targets, note: `start_conversation(create) ${reason(conv.body)}` };
      const id = (conv.body as any)?.conversation?.id;
      // Reused or fresh, still deliver what the model wrote — a reused
      // thread posts the content into the existing conversation rather than
      // silently dropping it.
      const msg = await api(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content ?? "" }) });
      // Register the conversation so the agent sees it in its context on the very next tick.
      // Without this, start_conversation creates an invisible shell — the agent never
      // perceives its own messages and cannot reply to responses (the 151:1 DM ratio trap).
      const wasReused = conv.status === 200;
      if (msg.status < 400 && id) {
        // A reuse continues an existing thread — increment its real turn
        // count instead of resetting to 1, so it isn't erased by every
        // repeat start_conversation attempt at the same peer.
        const existing = knownConversations.get(id);
        knownConversations.set(id, { id, unread: 0, myTurns: (wasReused ? existing?.myTurns ?? 0 : 0) + 1 });
        const participantIds: string[] = action.participant_ids ?? [];
        if (participantIds.length === 1) dmConversationByParticipant.set(participantIds[0], id);
      }
      // A reuse gets a pointedly different note from a fresh create — this
      // is the same fix pattern as join_room's no-op response. A "start
      // dm(send) ok" identical to a real create gave the model no signal
      // it was retreading ground; observed live (2026-09-02) as gptoss20-
      // class calling start_conversation 6 times at the same peer despite
      // open_dm_by_participant naming the existing thread every time.
      const note = msg.status >= 400
        ? `start_conversation(send) ${reason(msg.body)}`
        : wasReused
          ? `start_conversation: this DM already existed (conversation:${id}) — your message was delivered there, but use reply next time instead of start_conversation for this peer`
          : "start_conversation(send) ok";
      return { status: msg.status, target: `${targets} conversation:${id}`, note };
    }
    case "ask_peer": {
      if (!String(action.content ?? "").trim()) {
        return { status: 0, target: `agent:${action.agent_id}`, note: "ask_peer(send) content required (skipped)" };
      }
      const conv = await api("/conversations", { method: "POST", body: JSON.stringify({ participantIds: [action.agent_id] }) });
      if (conv.status !== 201) return { status: conv.status, target: `agent:${action.agent_id}`, note: `ask_peer(create) ${reason(conv.body)}` };
      const id = (conv.body as any)?.conversation?.id;
      const msg = await api(`/conversations/${id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content ?? "" }) });
      if (msg.status < 400 && id) knownConversations.set(id, { id, unread: 0, myTurns: 1 });
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
      // Ground-truth short-circuit (2026-09-02): already_joined_rooms is
      // advisory in the prompt but the API still answers 200 "ok" for a
      // redundant join, giving the model zero signal it did nothing new.
      // nano-class in particular re-issues join_room on an already-joined
      // room dozens of times a run (32-39 of 41 ticks observed) despite the
      // ground truth being right there in context — make the no-op visible.
      if (joinedRooms.has(String(action.room))) {
        return { status: 200, target: `room:${action.room}`, note: "join_room already joined (no-op — use message/reply on that thread instead)" };
      }
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
      if (r.status < 400) joinedRooms.add(String(usedRoom));
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
    if (e.payload.room_slug) {
      knownRoomSlugs.add(String(e.payload.room_slug));
      roomOfConversation.set(String(e.payload.conversation_id), String(e.payload.room_slug));
      if (roomOfConversation.size > 50) roomOfConversation.delete(roomOfConversation.keys().next().value as string);
    }
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
    : model.startsWith("openrouter/")
      ? `openrouter model=${model.replace(/^openrouter\//, "")} key=${process.env.OPENROUTER_API_KEY ? "present" : "MISSING"}`
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
      inbox_note: `You have ${ctx.inbox_summary.total_threads} threads total; ${ctx.inbox_focus.length} shown (invested threads first, then newest inbound), ${ctx.inbox_summary.other_threads_with_inbound} more have inbound messages not shown, ${ctx.inbox_summary.awaiting_reply_from_me} have had ${MAX_UNANSWERED_TO_SAME}+ messages from you with no reply yet — low priority to message again soon, but not necessarily dead.`,
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
      // Decision args as parsed (strings truncated) — without this a shape
      // the repair pipeline misses can only be diagnosed blind (voided e2a
      // launches, 2026-08-31: join_room 404 room:undefined with unknown shape).
      // `raw` is exempt: it exists ONLY to diagnose malformed_json, and a
      // 200-char clip here silently re-truncated it regardless of the 4000-char
      // cap already applied in harness-action-grammar.ts's parseDecision,
      // making every malformed_json record look identically truncated at
      // exactly 200 chars and misdirecting an earlier diagnosis today toward
      // "the model's output is truncated" when the actual completion was
      // often complete (finish_reason=stop) — the harness was truncating its
      // own diagnostic field, not the model.
      args: action && typeof action === "object"
        ? Object.fromEntries(
            Object.entries(action)
              .filter(([k]) => k !== "action")
              .map(([k, v]) => [k, typeof v === "string" && k !== "raw" ? v.slice(0, 200) : v]),
          )
        : {},
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
