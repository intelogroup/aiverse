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

// The frozen grammar as data, so an off-grammar action is detected rather than
// falling through to the executor's default and being logged as unparseable.
const ACTIONS = new Set([
  "nothing", "observe", "join_room", "leave_conversation", "message", "reply",
  "start_conversation", "invite", "discover_peers", "ask_peer", "create_goal", "delegate",
]);

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
let lastDiscovered = 0;

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
    const msgs = await api(`/conversations/${conv.id}/messages`);
    threads.push({ conversation_id: conv.id, unread: conv.unread, messages: (msgs.body as any)?.messages?.slice(-8) ?? [] });
  }
  return {
    manifest: manifest.body,
    peers: peers.body,
    conversations: threads,
    public_activity: (publicActivity.body as any)?.activity ?? [],
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
      const r = await api(`/conversations/${action.conversation_id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content }) });
      return { status: r.status, target: `conversation:${action.conversation_id}`, note: `message ${r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "reply": {
      const r = await api(`/conversations/${action.conversation_id}/messages`, { method: "POST", body: JSON.stringify({ content: action.content, replyToId: action.reply_to_id }) });
      return { status: r.status, target: `conversation:${action.conversation_id}`, note: `reply ${r.status >= 400 ? reason(r.body) : "ok"}` };
    }
    case "start_conversation": {
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
      const r = await api(`/rooms/${action.room}/join`, { method: "POST", body: "{}" });
      const cid = (r.body as any)?.conversationId;
      if (r.status < 400 && cid) knownConversations.set(cid, { id: cid, unread: 0 });
      return { status: r.status, target: `room:${action.room}${cid ? ` conversation:${cid}` : ""}`, note: `join_room ${r.status >= 400 ? reason(r.body) || "no such room" : "ok"}` };
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
const ws = new WebSocket(`${GATEWAY_WS}?token=${token}`);
await new Promise<void>((resolve, reject) => {
  const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15_000);
  ws.onmessage = (m) => {
    const e = JSON.parse(String(m.data));
    if (e.type === "ping") ws.send(JSON.stringify({ type: "pong", id: crypto.randomUUID(), ts: Date.now(), payload: {} }));
    if (e.type === "agent_connected") { clearTimeout(timer); resolve(); }
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
  };
  ws.onerror = (e) => { clearTimeout(timer); reject(e as any); };
});

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

for (let tick = startTick; tick < startTick + ticks; tick++) {
  const ctx = await buildContext();
  const opportunities = await detectOpportunities(ctx, myCaps);
  const raw = await decide(system, ctx);
  let action: any = null;
  try {
    action = JSON.parse(String(raw ?? "").replace(/```json|```/g, "").trim());
  } catch {
    // Not valid JSON at all.
    action = { action: "malformed_json", raw: String(raw ?? "").slice(0, 200) };
  }
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
ws.close();
console.log(`\ndecisions written to ${OUT}`);
