// Bazaar Phase 3 — live tick loop (experiment/bazaar).
//
// 12 agents, round-robin ticks, model = gpt-4.1-nano via the OpenAI skill CLI
// (authd surrogate; no raw keys). Local DB only.
//
// Hard guards (fail-closed):
//   - $1.00 cumulative model spend: pre-call reservation — no new model call
//     unless the worst-case cost of one call (RESERVE_USD) still fits under
//     the cap. Ambiguous call failures are CHARGED the reservation, never
//     released silently.
//   - Hard end: explicit per run via BAZAAR_HARD_END (ISO date-time). If
//     unset, the run ends via the STOP file or the spend cap only.
//   - runs/<RUN_ID>/STOP file: graceful operator stop.
//
// Usage (from repo root):
//   BAZAAR_RUN_ID=<uuid> GATEWAY_HTTP_URL=http://localhost:3010 \
//   DATABASE_URL=postgresql://root@127.0.0.1:5432/aiverse_test \
//   BAZAAR_HARD_END=2026-09-22T21:45:00-04:00 \
//   bun run experiments/bazaar/live-run.ts
//
// Prereq: seed.ts with the same BAZAAR_RUN_ID (writes runs/<id>/tokens.json).
// Artifacts: runs/<id>/decisions.jsonl, runs/<id>/summary.json (gitignored).

import { mandateFor, type Role } from "./population";
import { appendFileSync, existsSync } from "node:fs";

const GATEWAY = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
const RUN_ID = process.env.BAZAAR_RUN_ID;
if (!RUN_ID) { console.error("BAZAAR_RUN_ID required"); process.exit(1); }
if (!process.env.DATABASE_URL) { console.error("DATABASE_URL required"); process.exit(1); }

const MODEL = "gpt-4.1-nano";
const OPENAI_CLI = `${process.env.HOME}/workspace/skills/openai/bin/openai`;
const PRICE_IN_PER_1M = 0.10;
const PRICE_OUT_PER_1M = 0.40;
const SPEND_CAP = 1.0;
// Worst-case single model call, reserved BEFORE every call: 8k input tokens
// (4x the observed ~2.5k average — headroom for context growth) at $0.10/1M
// plus MAX_TOKENS output at $0.40/1M = $0.00116, rounded up.
const RESERVE_USD = 0.002;
// Explicit per-run hard end (ISO date-time, e.g. 2026-09-22T21:45:00-04:00).
// Unset = no calendar end; the run stops via STOP file or spend cap.
const HARD_END_ENV = process.env.BAZAAR_HARD_END;
const HARD_END_MS = HARD_END_ENV ? new Date(HARD_END_ENV).getTime() : Infinity;
const TICK_GAP_MS = 75_000; // ~15 min per agent across 12 agents
const MAX_TOKENS = 900;

const RUN_DIR = `experiments/bazaar/runs/${RUN_ID}`;
const DECISIONS_LOG = `${RUN_DIR}/decisions.jsonl`;
const SPEND_FILE = `${RUN_DIR}/spend.json`;

interface Agent {
  agentId: string;
  agentToken: string;
  name: string;
  role: Role;
}

let spendUsd = 0;
let reservedUsd = 0; // outstanding pre-call reservation (0 outside a call)
let totalIn = 0;
let totalOut = 0;
let tickCount = 0;

// Fail-closed: a new model call is allowed only if its worst-case cost still
// fits under the cap on top of confirmed spend + outstanding reservations.
function canAffordCall(): boolean {
  return spendUsd + reservedUsd + RESERVE_USD <= SPEND_CAP;
}

function costOf(inTok: number, outTok: number): number {
  return (inTok * PRICE_IN_PER_1M + outTok * PRICE_OUT_PER_1M) / 1_000_000;
}

async function sql(q: string): Promise<string> {
  const proc = Bun.spawn(["psql", process.env.DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-tA", "-c", q], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`psql: ${err.slice(0, 200)}`);
  return out.trim();
}

async function gw(path: string, token: string | null, body?: unknown, method = "POST") {
  const r = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* non-JSON */ }
  return { status: r.status, json, text };
}

async function logDecision(entry: Record<string, unknown>) {
  // appendFileSync: Bun.write overwrites — the JSONL log must append.
  appendFileSync(DECISIONS_LOG, JSON.stringify(entry) + "\n");
}

function persistSpend() {
  Bun.write(
    SPEND_FILE,
    JSON.stringify({
      spend_usd: spendUsd,
      total_in_tokens: totalIn,
      total_out_tokens: totalOut,
      ticks: tickCount,
      updated_at: new Date().toISOString(),
    })
  );
}

async function loadSpend() {
  if (!existsSync(SPEND_FILE)) return;
  try {
    const s = await Bun.file(SPEND_FILE).json();
    spendUsd = Number(s.spend_usd ?? 0);
    totalIn = Number(s.total_in_tokens ?? 0);
    totalOut = Number(s.total_out_tokens ?? 0);
    console.log(`resumed spend ledger: $${spendUsd.toFixed(6)} (${totalIn} in / ${totalOut} out)`);
  } catch {
    console.warn("spend.json unreadable — starting ledger at $0");
  }
}

// --- Preflight: bazaar tables must exist (PR #11 gap — never run against a
// DB without them; a missing table aborts the PG transaction). ---
async function preflight(): Promise<void> {
  const tables = ["bazaar_balances", "bazaar_roles", "bazaar_tasks", "bazaar_delegations", "bazaar_events"];
  for (const t of tables) {
    const res = await sql(`SELECT to_regclass('public.${t}') IS NOT NULL;`);
    if (res !== "t") {
      console.error(`PREFLIGHT FAIL: table public.${t} missing — voiding run before any spend.`);
      process.exit(1);
    }
  }
  console.log("preflight: all bazaar tables present");
}

// --- Model call via the OpenAI skill CLI. Returns parsed JSON + usage. ---
async function modelCall(prompt: string): Promise<{ decision: any; inTok: number; outTok: number }> {
  const proc = Bun.spawn(
    [OPENAI_CLI, "chat", "--model", MODEL, "--max-tokens", String(MAX_TOKENS), "--json", prompt],
    { stdout: "pipe", stderr: "pipe" }
  );
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`openai cli failed: ${err.slice(0, 200)}`);
  const usageMatch = err.match(/# usage: in=(\d+) out=(\d+)/);
  const inTok = usageMatch ? Number(usageMatch[1]) : 0;
  const outTok = usageMatch ? Number(usageMatch[2]) : 0;
  const jsonMatch = out.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error(`no JSON in model output: ${out.slice(0, 200)}`);
  return { decision: JSON.parse(jsonMatch[0]), inTok, outTok };
}

function buildPrompt(agent: Agent, ctx: any, roster: Agent[]): string {
  const mandate = mandateFor(agent.role).map((m) => `- ${m}`).join("\n");
  const rosterLines = roster
    .filter((r) => r.agentId !== agent.agentId)
    .map((r) => `- ${r.name} (${r.role}) id=${r.agentId}`)
    .join("\n");
  return `You are ${agent.name}, a ${agent.role} in the Bazaar task market. Act to maximize your credits.

MANDATE:
${mandate}

OTHER AGENTS (delegation targets):
${rosterLines}

YOUR CURRENT CONTEXT (JSON):
${JSON.stringify(ctx)}

Reply with EXACTLY ONE JSON action, no other text:
- {"action":"pass"}
- {"action":"claim_bounty","bounty_id":"..."} — only bounties in open_bounties
- {"action":"complete_bounty","bounty_id":"...","evidence":"..."} — only YOUR claimed bounties (status claimed); evidence is the actual work, 100-200 words
- {"action":"verify_bounty","bounty_id":"...","verdict":"accept|reject","note":"..."} — critics only, only pending_verifications; judge honestly
- {"action":"post_bounty","title":"...","description":"...","bounty_credits":N} — 1<=N<=50 and N<=your balance
- {"action":"delegate","bounty_id":"...","payee_agent_id":"...","payment_credits":N,"instructions":"..."} — only YOUR claimed bounties; N>=1, N<=your balance, N < the bounty's value (keep a spread); instructions tell the payee exactly what to do
- {"action":"complete_delegation","delegation_id":"...","work":"..."} — you are the payee: do the delegated work (100-200 words); payment settles to you automatically

After you delegate, you must still submit the finished work on your claimed bounty via complete_bounty (use the payee's work, improved if needed).
Output JSON only:`;
}

interface Validation { ok: boolean; reason?: string }

function validate(agent: Agent, d: any, ctx: any): Validation {
  const openIds = new Set((ctx.open_bounties ?? []).map((b: any) => b.id));
  const myClaimed = (ctx.my_claims ?? []).filter((c: any) => c.status === "claimed");
  const myClaimedIds = new Set(myClaimed.map((c: any) => c.id));
  const pendingIds = new Set((ctx.pending_verifications ?? []).map((b: any) => b.id));
  const myDelegs = (ctx.open_delegations ?? []).filter((x: any) => x.payee_id === agent.agentId);
  const myDelegIds = new Set(myDelegs.map((x: any) => x.id));
  const balance = Number(ctx.balance ?? 0);

  switch (d?.action) {
    case "pass": return { ok: true };
    case "claim_bounty":
      if (!openIds.has(d.bounty_id)) return { ok: false, reason: "bounty not open" };
      return { ok: true };
    case "complete_bounty":
      if (!myClaimedIds.has(d.bounty_id)) return { ok: false, reason: "not your claimed bounty" };
      if (typeof d.evidence !== "string" || d.evidence.length < 20) return { ok: false, reason: "evidence too short" };
      return { ok: true };
    case "verify_bounty":
      if (agent.role !== "critic") return { ok: false, reason: "not a critic" };
      if (!pendingIds.has(d.bounty_id)) return { ok: false, reason: "not pending verification" };
      if (d.verdict !== "accept" && d.verdict !== "reject") return { ok: false, reason: "bad verdict" };
      return { ok: true };
    case "post_bounty": {
      const n = Number(d.bounty_credits);
      if (typeof d.title !== "string" || !d.title.trim()) return { ok: false, reason: "no title" };
      if (typeof d.description !== "string" || !d.description.trim()) return { ok: false, reason: "no description" };
      if (!Number.isFinite(n) || n < 1 || n > 50) return { ok: false, reason: "bounty out of range" };
      if (n > balance) return { ok: false, reason: "insufficient balance" };
      return { ok: true };
    }
    case "delegate": {
      if (!myClaimedIds.has(d.bounty_id)) return { ok: false, reason: "not your claimed bounty" };
      if (typeof d.payee_agent_id !== "string" || d.payee_agent_id === agent.agentId)
        return { ok: false, reason: "bad payee" };
      const n = Number(d.payment_credits);
      if (!Number.isFinite(n) || n < 1) return { ok: false, reason: "bad payment" };
      if (n > balance) return { ok: false, reason: "insufficient balance" };
      const bounty = myClaimed.find((c: any) => c.id === d.bounty_id);
      if (bounty && n >= Number(bounty.bounty)) return { ok: false, reason: "no spread (payment >= bounty)" };
      if (typeof d.instructions !== "string" || d.instructions.length < 10)
        return { ok: false, reason: "instructions too short" };
      return { ok: true };
    }
    case "complete_delegation":
      if (!myDelegIds.has(d.delegation_id)) return { ok: false, reason: "not your delegation" };
      if (typeof d.work !== "string" || d.work.length < 20) return { ok: false, reason: "work too short" };
      return { ok: true };
    default:
      return { ok: false, reason: `unknown action: ${d?.action}` };
  }
}

async function execute(agent: Agent, d: any, ctx: any): Promise<{ ok: boolean; detail: string }> {
  switch (d.action) {
    case "pass":
      return { ok: true, detail: "pass" };
    case "claim_bounty": {
      const r = await gw(`/bazaar/tasks/${d.bounty_id}/claim`, agent.agentToken, {});
      return { ok: r.status === 200, detail: `claim status=${r.status}` };
    }
    case "complete_bounty": {
      const r = await gw(`/bazaar/tasks/${d.bounty_id}/complete`, agent.agentToken, { evidence: d.evidence });
      return { ok: r.status === 200, detail: `complete status=${r.status}` };
    }
    case "verify_bounty": {
      const r = await gw(`/bazaar/tasks/${d.bounty_id}/verify`, agent.agentToken, {
        verdict: d.verdict, note: d.note ?? "",
      });
      return { ok: r.status === 200, detail: `verify ${d.verdict} status=${r.status}` };
    }
    case "post_bounty": {
      const r = await gw("/bazaar/tasks", agent.agentToken, {
        title: d.title, description: d.description, bounty_credits: Number(d.bounty_credits),
      });
      return { ok: r.status === 201, detail: `post status=${r.status}` };
    }
    case "delegate": {
      const a2a = await gw(`/a2a/agents/${d.payee_agent_id}`, agent.agentToken, {
        jsonrpc: "2.0",
        id: `bz-${RUN_ID.slice(0, 8)}-${tickCount}`,
        method: "message/send",
        params: {
          message: {
            messageId: `bz-${RUN_ID.slice(0, 8)}-${Date.now()}`,
            parts: [{ kind: "text", text: d.instructions }],
          },
        },
      });
      if (a2a.status >= 400 || a2a.json?.error)
        return { ok: false, detail: `a2a send status=${a2a.status}` };
      const taskId = a2a.json?.result?.taskId ?? a2a.json?.result?.id;
      if (!taskId) return { ok: false, detail: "no a2a task id" };
      const dg = await gw("/bazaar/delegations", agent.agentToken, {
        a2a_task_id: taskId, payee_id: d.payee_agent_id, amount: Number(d.payment_credits),
      });
      return { ok: dg.status === 201, detail: `delegation status=${dg.status} amount=${d.payment_credits}` };
    }
    case "complete_delegation": {
      const deleg = (ctx.open_delegations ?? []).find((x: any) => x.id === d.delegation_id);
      if (!deleg) return { ok: false, detail: "delegation vanished" };
      const r = await gw(`/a2a/tasks/${deleg.a2a_task_id}`, agent.agentToken, {
        state: "completed", resultMessage: d.work,
      }, "PATCH");
      return { ok: r.status === 200, detail: `a2a complete status=${r.status}` };
    }
    default:
      return { ok: false, detail: "unreachable" };
  }
}

async function tick(agent: Agent, roster: Agent[]): Promise<boolean> {
  const entry: Record<string, unknown> = {
    ts: new Date().toISOString(), tick: tickCount, agent: agent.name, role: agent.role,
  };
  try {
    const ctxRes = await gw("/bazaar/context", agent.agentToken, undefined, "GET");
    if (ctxRes.status !== 200) throw new Error(`context status=${ctxRes.status}`);
    const ctx = ctxRes.json;

    if (!canAffordCall()) {
      entry.stop = "spend_cap";
      await logDecision(entry);
      return true;
    }
    // Pre-call reservation: the worst-case cost is committed BEFORE the call.
    reservedUsd += RESERVE_USD;
    let decision: any;
    let inTok: number;
    let outTok: number;
    try {
      ({ decision, inTok, outTok } = await modelCall(buildPrompt(agent, ctx, roster)));
    } catch (e: any) {
      // Ambiguous failure: the API may have consumed tokens server-side.
      // Fail closed — the reservation is CHARGED, never silently released.
      reservedUsd -= RESERVE_USD;
      spendUsd += RESERVE_USD;
      persistSpend();
      throw new Error(`model call ambiguous, reservation $${RESERVE_USD} charged: ${e?.message ?? e}`);
    }
    reservedUsd -= RESERVE_USD;
    const callCost = costOf(inTok, outTok);
    spendUsd += callCost;
    totalIn += inTok;
    totalOut += outTok;
    persistSpend(); // durable ledger — restarts resume from the true cumulative spend
    entry.in_tokens = inTok;
    entry.out_tokens = outTok;
    entry.call_cost_usd = Number(callCost.toFixed(6));
    entry.spend_usd = Number(spendUsd.toFixed(6));

    const v = validate(agent, decision, ctx);
    if (!v.ok) {
      entry.action = decision?.action ?? null;
      entry.ok = false;
      entry.detail = `rejected: ${v.reason}`;
      await logDecision(entry);
      return false;
    }
    const res = await execute(agent, decision, ctx);
    entry.action = decision.action;
    entry.ok = res.ok;
    entry.detail = res.detail;
    await logDecision(entry);
    return res.ok;
  } catch (e: any) {
    entry.ok = false;
    entry.detail = `tick error: ${String(e?.message ?? e).slice(0, 200)}`;
    await logDecision(entry);
    return false;
  }
}

async function stopFileExists(): Promise<boolean> {
  return await Bun.file(`${RUN_DIR}/STOP`).exists();
}

async function main() {
  if (Number.isNaN(HARD_END_MS)) {
    console.error("BAZAAR_HARD_END is not a valid date-time — voiding run before any spend.");
    process.exit(1);
  }
  console.log(`Bazaar Phase 3 live run ${RUN_ID} — model=${MODEL} cap=$${SPEND_CAP} reserve=$${RESERVE_USD}/call hard_end=${HARD_END_ENV ?? "none (STOP file / spend cap)"}`);
  await preflight();
  await loadSpend();

  // Durable run manifest: commit SHA, model, prices, approved bounds.
  try {
    const gp = Bun.spawn(["git", "rev-parse", "--short", "HEAD"], { stdout: "pipe" });
    const sha = (await new Response(gp.stdout).text()).trim();
    await Bun.write(`${RUN_DIR}/run-config.json`, JSON.stringify({
      run_id: RUN_ID,
      model: MODEL,
      price_in_per_1m: PRICE_IN_PER_1M,
      price_out_per_1m: PRICE_OUT_PER_1M,
      spend_cap_usd: SPEND_CAP,
      reserve_usd_per_call: RESERVE_USD,
      hard_end: HARD_END_ENV ?? null,
      git_commit: sha || null,
      started_at: new Date().toISOString(),
      gateway: GATEWAY,
    }, null, 2));
  } catch (e: any) {
    console.warn(`run-config write failed (non-fatal): ${e?.message ?? e}`);
  }

  const tokensRaw = await Bun.file(`${RUN_DIR}/tokens.json`).json().catch(() => null);
  if (!tokensRaw?.agents?.length) {
    console.error(`tokens.json missing in ${RUN_DIR} — run seed.ts first with this RUN_ID.`);
    process.exit(1);
  }
  const roster: Agent[] = tokensRaw.agents;
  console.log(`loaded ${roster.length} agents`);

  const failStreak = new Map<string, number>();
  let stopReason = "unknown";
  let consecutiveModelFailures = 0;

  outer: while (true) {
    if (Date.now() >= HARD_END_MS) { stopReason = "hard_end"; break; }
    if (!canAffordCall()) { stopReason = "spend_cap"; break; }
    if (await stopFileExists()) { stopReason = "operator_stop"; break; }
    if (consecutiveModelFailures >= 20) { stopReason = "model_failure_cascade"; break; }

    for (const agent of roster) {
      if (Date.now() >= HARD_END_MS) { stopReason = "hard_end"; break outer; }
      if (!canAffordCall()) { stopReason = "spend_cap"; break outer; }
      if (await stopFileExists()) { stopReason = "operator_stop"; break outer; }
      if ((failStreak.get(agent.agentId) ?? 0) >= 5) continue; // circuit breaker

      const before = spendUsd;
      const ok = await tick(agent, roster);
      tickCount++;
      if (!ok) failStreak.set(agent.agentId, (failStreak.get(agent.agentId) ?? 0) + 1);
      else failStreak.delete(agent.agentId);
      if (spendUsd === before) consecutiveModelFailures++;
      else consecutiveModelFailures = 0;

      await new Promise((r) => setTimeout(r, TICK_GAP_MS));
    }
  }

  const summary = {
    run_id: RUN_ID,
    model: MODEL,
    stop_reason: stopReason,
    ended_at: new Date().toISOString(),
    ticks: tickCount,
    total_in_tokens: totalIn,
    total_out_tokens: totalOut,
    spend_usd: Number(spendUsd.toFixed(6)),
    spend_cap: SPEND_CAP,
  };
  await Bun.write(`${RUN_DIR}/summary.json`, JSON.stringify(summary, null, 2));
  console.log(`RUN END — reason=${stopReason} ticks=${tickCount} spend=$${spendUsd.toFixed(4)}`);
}

await main();
