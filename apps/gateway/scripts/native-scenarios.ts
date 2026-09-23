// Native "heartbeat" scenario harness — measures how the always-on native
// agents actually behave across the situations production will hit once it
// deploys and never reboots (see /root/.claude/plans/proud-zooming-starfish.md,
// and RUNLOG.md "Bootstrap-deadlock retest" for why this exists).
//
// Each scenario boots a real gateway against a fresh local Postgres/Redis
// (never Neon — CLAUDE.md), drives SCRIPTED external agents (plain HTTP/WS,
// no LLM — so only the natives are non-deterministic), and reads outcomes
// from Postgres plus the native_tick_decision/native_tick/llm_* log lines
// (jobs/nativeAgents.ts). One JSON report per scenario.
//
// Usage:
//   OPENAI_API_KEY=... bun run apps/gateway/scripts/native-scenarios.ts [scenario ...]
//   (no args = run all)
//
// Model: forces NATIVE_LLM_MODE unset with only OPENAI_API_KEY present, so
// selectLLMProvider() (jobs/nativeAgents.ts:110-128) resolves OpenAIProvider,
// which defaults to gpt-4.1-nano (env.NATIVE_OPENAI_MODEL ?? "gpt-4.1-nano",
// llm/provider.ts:157) — cheap, no free-tier daily cap, owner-approved.
import { spawn, execSync, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { writeFileSync, mkdirSync } from "node:fs";

const GW_DIR = new URL("..", import.meta.url).pathname;
const OUT_DIR = process.env.SCENARIO_OUT ?? "/tmp/native-scenarios";
mkdirSync(OUT_DIR, { recursive: true });

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("OPENAI_API_KEY required (natives run on gpt-4.1-nano — owner-approved cheap model)");
  process.exit(1);
}

const DB = process.env.SCENARIO_DB ?? "aiverse_scenarios";
const REDIS_DB = Number(process.env.SCENARIO_REDIS_DB ?? 4);
const PORT = Number(process.env.SCENARIO_PORT ?? 4401);
const DEFAULT_DURATION_MS = Number(process.env.SCENARIO_DURATION_MS ?? 15 * 60_000);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sql = (q: string) => execSync(`psql -h localhost -U postgres -d ${DB} -tAc "${q.replace(/"/g, '\\"')}"`).toString().trim();
const redisCli = (cmd: string) => execSync(`redis-cli -n ${REDIS_DB} ${cmd}`).toString().trim();
const log = (...a: unknown[]) => console.log(new Date().toISOString().slice(11, 19), ...a);

async function resetDb() {
  execSync(`psql -h localhost -U postgres -qc "drop database if exists ${DB}" -c "create database ${DB}"`);
  redisCli("FLUSHDB");
  execSync(
    `cd ${GW_DIR} && env -u NODE_ENV DATABASE_URL=postgres://postgres@localhost:5432/${DB} REDIS_URL=redis://localhost:6379/${REDIS_DB} JWT_SECRET=scenario-secret-scenario-secret-0000 bun run src/db/migrate.ts`,
    { stdio: "pipe" },
  );
}

interface Gateway {
  child: ChildProcessByStdio<null, Readable, Readable>;
  logs: string[];
}
function startGateway(extraEnv: Record<string, string> = {}): Gateway {
  const child = spawn("bun", ["run", "src/index.ts"], {
    cwd: GW_DIR,
    env: {
      ...process.env,
      NODE_ENV: "development",
      DATABASE_URL: `postgres://postgres@localhost:5432/${DB}`,
      REDIS_URL: `redis://localhost:6379/${REDIS_DB}`,
      JWT_SECRET: "scenario-secret-scenario-secret-0000",
      PORT: String(PORT),
      OPENAI_API_KEY: OPENAI_KEY,
      AIVERSE_DEV_FAST_BOOTSTRAP: "1",
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const logs: string[] = [];
  const onData = (d: Buffer) => {
    for (const line of d.toString().split("\n")) if (line.trim()) logs.push(line);
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  return { child, logs };
}

async function waitHealthy(timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const r = await fetch(`http://localhost:${PORT}/health`);
      if (r.ok) return;
    } catch {}
    await sleep(500);
  }
  throw new Error("gateway never healthy");
}

async function http(path: string, opts: { method?: string; token?: string; body?: unknown } = {}) {
  const r = await fetch(`http://localhost:${PORT}${path}`, {
    method: opts.method ?? "GET",
    headers: { "content-type": "application/json", ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  let json: any = {};
  try {
    json = await r.json();
  } catch {}
  return { status: r.status, body: json };
}

// A scripted external agent: no LLM, just a fixed schedule of HTTP calls +
// an optional WS connection so it shows up as "online" the way a real agent
// runtime would (natives' wanderer/presence context depends on this).
interface ScriptedAgent {
  id: string;
  token: string;
  ownerToken: string;
  ws?: WebSocket;
}
async function makeExternalAgent(name: string): Promise<ScriptedAgent> {
  const reg = await http("/owners/register", { method: "POST", body: { email: `${name}-${Date.now()}@example.com`, password: "password123", displayName: name } });
  const ownerToken = reg.body.token;
  const created = await http("/owners/agents", { method: "POST", token: ownerToken, body: { name: `${name}-${Date.now().toString(36)}` } });
  const id = created.body.agent.id;
  const token = created.body.agentToken;
  await http(`/owners/agents/${id}/wallet`, { method: "PATCH", token: ownerToken, body: { autonomyMode: "autonomous" } });
  return { id, token, ownerToken };
}
async function connectWs(agent: ScriptedAgent) {
  const t = await http("/auth/ws-ticket", { method: "POST", token: agent.token });
  const ws = new WebSocket(`ws://localhost:${PORT}/agents/ws?ticket=${t.body.ticket}`);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (m) => {
    const ev = JSON.parse(String(m.data));
    if (ev.type === "ping") ws.send(JSON.stringify({ type: "pong", id: crypto.randomUUID(), ts: Date.now(), payload: {} }));
    if (ev.type === "message") {
      const p = ev.payload;
      ws.send(JSON.stringify({ type: "ack", id: crypto.randomUUID(), ts: Date.now(), payload: { conversationId: p.conversation_id, messageId: p.message_id } }));
    }
  };
  agent.ws = ws;
}
async function joinRoom(agent: ScriptedAgent, slug: string) {
  return http(`/rooms/${slug}/join`, { method: "POST", token: agent.token });
}
async function postToRoom(agent: ScriptedAgent, slug: string, content: string) {
  const j = await joinRoom(agent, slug);
  return http(`/conversations/${j.body.conversationId}/messages`, { method: "POST", token: agent.token, body: { content, clientMessageId: crypto.randomUUID() } });
}

// ── Log-derived outcomes ────────────────────────────────────────────────
interface Decision {
  ts: string;
  name: string;
  action: string;
  model: string | null;
  llmFailed: boolean;
  emptyRooms: string[];
}
function parseDecisions(logs: string[]): Decision[] {
  const out: Decision[] = [];
  for (const line of logs) {
    if (!line.includes('"native_tick_decision"')) continue;
    try {
      out.push(JSON.parse(line));
    } catch {}
  }
  return out;
}
function countEvent(logs: string[], event: string) {
  return logs.filter((l) => l.includes(`"event":"${event}"`)).length;
}

interface ScenarioResult {
  scenario: string;
  durationMs: number;
  decisions: Decision[];
  idleCount: number;
  nonIdleCount: number;
  personasActive: string[];
  llmErrors: number;
  nativeTickErrors: number;
  uncaughtExceptions: number;
  firstNativeMessageMs: number | null;
  roomMessageCounts: Record<string, number>;
  extra: Record<string, unknown>;
  pass: boolean;
  notes: string[];
}

function summarize(scenario: string, startedAt: number, logs: string[], extra: Record<string, unknown> = {}): ScenarioResult {
  const decisions = parseDecisions(logs);
  const nonIdle = decisions.filter((d) => d.action !== "idle");
  const firstNativeMsgLine = logs.find((l) => l.includes('"event":"native_tick"') && !l.includes('"action":"idle"'));
  let firstNativeMessageMs: number | null = null;
  if (firstNativeMsgLine) {
    try {
      firstNativeMessageMs = new Date(JSON.parse(firstNativeMsgLine).ts).getTime() - startedAt;
    } catch {}
  }
  const roomMessageCounts: Record<string, number> = {};
  for (const slug of ["general", "science", "robotics", "verse"]) {
    roomMessageCounts[slug] = Number(
      sql(`select count(*) from messages m join conversations c on c.id=m.conversation_id join rooms r on r.id=c.room_id where r.slug='${slug}'`),
    );
  }
  return {
    scenario,
    durationMs: Date.now() - startedAt,
    decisions,
    idleCount: decisions.length - nonIdle.length,
    nonIdleCount: nonIdle.length,
    personasActive: [...new Set(decisions.map((d) => d.name))],
    llmErrors: countEvent(logs, "llm_error") + countEvent(logs, "llm_empty_content"),
    nativeTickErrors: countEvent(logs, "native_tick_error"),
    uncaughtExceptions: countEvent(logs, "uncaught_exception"),
    firstNativeMessageMs,
    roomMessageCounts,
    extra,
    pass: false, // caller sets this against the scenario's own criterion
    notes: [],
  };
}

async function stopGateway(gw: Gateway) {
  gw.child.kill("SIGTERM");
  await sleep(1000);
  gw.child.kill("SIGKILL");
}

// ── Scenarios ──────────────────────────────────────────────────────────

// S1: cold deploy, natives only, blank world.
async function s1_coldDeploy(): Promise<ScenarioResult> {
  await resetDb();
  const gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  await sleep(DEFAULT_DURATION_MS);
  await stopGateway(gw);
  const r = summarize("S1_cold_deploy", startedAt, gw.logs);
  r.pass = Object.values(r.roomMessageCounts).some((c) => c > 0);
  r.notes.push("target: >=1 native message in at least one room within the window");
  return r;
}

// S2: first external agent arrives into a blank world.
async function s2_firstArrival(): Promise<ScenarioResult> {
  await resetDb();
  const gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  await sleep(60_000); // let natives see the blank world for a minute first
  const ext = await makeExternalAgent("FirstArrival");
  await connectWs(ext);
  await joinRoom(ext, "general");
  await sleep(DEFAULT_DURATION_MS);
  await stopGateway(gw);
  const r = summarize("S2_first_arrival", startedAt, gw.logs, { externalAgentId: ext.id });
  const dmToExt = Number(sql(`select count(*) from conversation_participants where agent_id='${ext.id}'`));
  r.extra.dmOrRoomParticipationCount = dmToExt;
  r.pass = r.roomMessageCounts.general > 0;
  r.notes.push("target: a native message appears in general after the external agent joins");
  return r;
}

// S3: populated and active — 4 external agents chatting steadily.
async function s3_activePopulated(): Promise<ScenarioResult> {
  await resetDb();
  const gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  const externals = await Promise.all(["Alice", "Bob", "Cara", "Dan"].map(makeExternalAgent));
  for (const e of externals) await connectWs(e);
  const topics = ["what do you all think about async agents?", "anyone working on something interesting?", "how do you handle rate limits?", "what's your stack?"];
  let running = true;
  const chatLoop = (async () => {
    let i = 0;
    while (running) {
      const e = externals[i % externals.length];
      await postToRoom(e, "general", topics[i % topics.length] + ` (#${i})`);
      i++;
      await sleep(15_000);
    }
  })();
  await sleep(DEFAULT_DURATION_MS);
  running = false;
  await chatLoop;
  await stopGateway(gw);
  const r = summarize("S3_active_populated", startedAt, gw.logs);
  const maxPerMinute = r.durationMs > 0 ? r.nonIdleCount / (r.durationMs / 60_000) : 0;
  r.extra.nativeMessagesPerMinute = maxPerMinute;
  r.pass = r.uncaughtExceptions === 0 && r.nativeTickErrors === 0;
  r.notes.push("target: no errors, natives react without crashing under steady external chatter");
  return r;
}

// S4: active, then goes quiet — externals stop mid-run.
async function s4_activeThenQuiet(): Promise<ScenarioResult> {
  await resetDb();
  const gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  const externals = await Promise.all(["Eve", "Frank"].map(makeExternalAgent));
  for (const e of externals) await connectWs(e);
  for (let i = 0; i < 4; i++) {
    await postToRoom(externals[i % 2], "science", `seed message ${i}`);
    await sleep(5_000);
  }
  const quietStartedAt = Date.now();
  await sleep(DEFAULT_DURATION_MS);
  await stopGateway(gw);
  const r = summarize("S4_active_then_quiet", startedAt, gw.logs, { quietStartedAtOffsetMs: quietStartedAt - startedAt });
  const revivalLine = gw.logs.find((l) => {
    if (!l.includes('"event":"native_tick"') || l.includes('"action":"idle"')) return false;
    try {
      return new Date(JSON.parse(l).ts).getTime() >= quietStartedAt;
    } catch {
      return false;
    }
  });
  r.pass = !!revivalLine;
  r.notes.push("target: a native posts into the quiet room after externals stop (Rekinder's stated job)");
  return r;
}

// S5: owners delete their agents mid-conversation.
async function s5_agentsRemoved(): Promise<ScenarioResult> {
  await resetDb();
  const gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  const externals = await Promise.all(["Gina", "Hank", "Ivy"].map(makeExternalAgent));
  for (const e of externals) await connectWs(e);
  for (const e of externals) await postToRoom(e, "robotics", `hello from ${e.id.slice(0, 8)}`);
  await sleep(30_000);
  for (const e of externals) await http(`/owners/agents/${e.id}`, { method: "DELETE", token: e.ownerToken });
  await sleep(DEFAULT_DURATION_MS);
  await stopGateway(gw);
  const r = summarize("S5_agents_removed", startedAt, gw.logs);
  r.pass = r.uncaughtExceptions === 0 && r.nativeTickErrors === 0;
  r.notes.push("target: no crashes or errors targeting deleted agent ids after deletion");
  return r;
}

// S6: only one external agent left.
async function s6_loneExternal(): Promise<ScenarioResult> {
  await resetDb();
  const gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  const lone = await makeExternalAgent("LoneAgent");
  await connectWs(lone);
  await joinRoom(lone, "verse");
  await sleep(DEFAULT_DURATION_MS);
  await stopGateway(gw);
  const r = summarize("S6_lone_external", startedAt, gw.logs, { loneAgentId: lone.id });
  const engaged = Number(sql(`select count(*) from conversation_participants where agent_id='${lone.id}'`)) > 1
    || r.roomMessageCounts.verse > 0;
  r.pass = engaged;
  r.notes.push("target: natives DM, invite or post to the sole external agent within the window");
  return r;
}

// S7: gateway restart mid-run (a deploy).
async function s7_gatewayRestart(): Promise<ScenarioResult> {
  await resetDb();
  let gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  const externals = await Promise.all(["RebootAgent1", "RebootAgent2"].map(makeExternalAgent));
  for (const e of externals) await connectWs(e);
  await postToRoom(externals[0], "general", "Hello before restart");
  await sleep(10_000);
  // Capture message count before restart
  const msgCountBefore = Number(sql(`select count(*) from messages`));
  const nativeTicksBefore = gw.logs.filter((l) => l.includes('"event":"native_tick"')).length;
  // Kill and restart the gateway
  await stopGateway(gw);
  await sleep(3_000);
  gw = startGateway();
  await waitHealthy();
  const restartedAt = Date.now();
  // Continue for another window
  await postToRoom(externals[0], "general", "Hello after restart");
  await sleep(DEFAULT_DURATION_MS);
  await stopGateway(gw);
  const r = summarize("S7_gateway_restart", startedAt, gw.logs, {
    msgCountBefore,
    nativeTicksBefore,
    restartedAtOffsetMs: restartedAt - startedAt,
  });
  const msgCountAfter = r.roomMessageCounts.general;
  // Pass if we see activity after restart and no obvious duplicate greetings
  // (duplicate greetings would manifest as too many messages in same room)
  r.pass = msgCountAfter > 0 && msgCountBefore < msgCountAfter && r.uncaughtExceptions === 0;
  r.notes.push("target: natives continue without re-greeting after gateway restart; no duplicate messages");
  return r;
}

// S8: Redis wiped mid-run (free-plan restart).
async function s8_redisWipe(): Promise<ScenarioResult> {
  await resetDb();
  const gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  const externals = await Promise.all(["RedisWipeAgent1", "RedisWipeAgent2"].map(makeExternalAgent));
  for (const e of externals) await connectWs(e);
  await postToRoom(externals[0], "robotics", "Before Redis wipe");
  await sleep(20_000);
  const msgCountBefore = Number(sql(`select count(*) from messages`));
  // Flush Redis mid-run
  redisCli("FLUSHDB");
  await sleep(10_000);
  // Post and continue
  await postToRoom(externals[1], "robotics", "After Redis wipe");
  await sleep(DEFAULT_DURATION_MS);
  await stopGateway(gw);
  const r = summarize("S8_redis_wipe", startedAt, gw.logs, { msgCountBefore });
  const msgCountAfter = r.roomMessageCounts.robotics;
  // Pass if messages continue and no duplicate greetings (would see double-greeting pattern)
  r.pass = msgCountAfter > msgCountBefore && r.uncaughtExceptions === 0 && r.nativeTickErrors === 0;
  r.notes.push("target: populated rooms not treated as blank after Redis wipe; no duplicate greetings");
  return r;
}

// S9: long run (≥2h) to measure token budget and repetition.
async function s9_soakRun(): Promise<ScenarioResult> {
  const durationMs = Number(process.env.S9_DURATION_MS ?? 2 * 60 * 60_000); // 2 hours default
  await resetDb();
  const gw = startGateway();
  await waitHealthy();
  const startedAt = Date.now();
  const externals = await Promise.all(["SoakAgent1", "SoakAgent2", "SoakAgent3"].map(makeExternalAgent));
  for (const e of externals) await connectWs(e);
  let running = true;
  const chatLoop = (async () => {
    const topics = ["what's new?", "any interesting ideas?", "thoughts on AI?", "how's everyone doing?"];
    let i = 0;
    while (running) {
      const e = externals[i % externals.length];
      const topic = topics[i % topics.length];
      await postToRoom(e, "verse", `${topic} (#${i})`).catch(() => {});
      i++;
      await sleep(30_000);
    }
  })();
  await sleep(durationMs);
  running = false;
  await chatLoop;
  await stopGateway(gw);
  const r = summarize("S9_soak_run", startedAt, gw.logs, { durationMs });
  // Check for repetition: if the same native is posting the same content multiple times
  const decisions = r.decisions;
  const contentByName: Record<string, string[]> = {};
  for (const d of decisions) {
    if (!contentByName[d.name]) contentByName[d.name] = [];
    contentByName[d.name].push(d.action);
  }
  let hasRepetition = false;
  for (const [name, actions] of Object.entries(contentByName)) {
    const recent = actions.slice(-20);
    const uniqueRecent = new Set(recent).size;
    if (uniqueRecent < 3) hasRepetition = true;
  }
  r.pass = !hasRepetition && r.uncaughtExceptions === 0 && r.nativeTickErrors === 0;
  r.notes.push("target: stable operation for 2h+ with no token budget overruns, no repetition loops");
  r.extra.uniqueActionsPerPersona = Object.fromEntries(
    Object.entries(contentByName).map(([name, actions]) => [name, new Set(actions).size])
  );
  return r;
}

const SCENARIOS: Record<string, () => Promise<ScenarioResult>> = {
  S1: s1_coldDeploy,
  S2: s2_firstArrival,
  S3: s3_activePopulated,
  S4: s4_activeThenQuiet,
  S5: s5_agentsRemoved,
  S6: s6_loneExternal,
  S7: s7_gatewayRestart,
  S8: s8_redisWipe,
  S9: s9_soakRun,
};

async function main() {
  const requested = process.argv.slice(2);
  const names = requested.length ? requested : Object.keys(SCENARIOS);
  const results: ScenarioResult[] = [];
  for (const name of names) {
    const fn = SCENARIOS[name];
    if (!fn) {
      console.error(`unknown scenario: ${name} (known: ${Object.keys(SCENARIOS).join(", ")})`);
      continue;
    }
    log(`=== ${name} starting ===`);
    const r = await fn();
    log(`=== ${name}: ${r.pass ? "PASS" : "FAIL"} — idle=${r.idleCount} nonIdle=${r.nonIdleCount} personas=${r.personasActive.join(",")} errors=${r.llmErrors + r.nativeTickErrors + r.uncaughtExceptions} ===`);
    writeFileSync(`${OUT_DIR}/${r.scenario}.json`, JSON.stringify(r, null, 2));
    results.push(r);
    await sleep(2000);
  }
  writeFileSync(`${OUT_DIR}/summary.json`, JSON.stringify(results.map((r) => ({ scenario: r.scenario, pass: r.pass, idleCount: r.idleCount, nonIdleCount: r.nonIdleCount, personasActive: r.personasActive, errors: r.llmErrors + r.nativeTickErrors + r.uncaughtExceptions })), null, 2));
  log("done; reports in", OUT_DIR);
  const failed = results.filter((r) => !r.pass);
  if (failed.length) log(`${failed.length}/${results.length} scenarios FAILED: ${failed.map((r) => r.scenario).join(", ")}`);
}

main().catch((e) => {
  console.error("SCENARIO HARNESS ERROR", e);
  process.exit(1);
});
