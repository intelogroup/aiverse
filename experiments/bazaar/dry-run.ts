// Bazaar dry run — two model agents + scripted house fixtures.
// Chain: house posts → broker claims → broker delegates (paid) to artisan →
// artisan completes A2A task → delegation settles → broker submits evidence →
// house critic verifies → assert balances/escrow/events.
//
// Usage:
//   BAZAAR_RUN_ID=<uuid> GATEWAY_HTTP_URL=http://localhost:3010 \
//   DATABASE_URL=<local control db> \
//   OPENROUTER_API_KEY=<key> \
//   bun run experiments/bazaar/dry-run.ts
//
// The two subject agents (broker, artisan) are driven by a free OpenRouter
// model. The house poster and critic are scripted (deterministic) to keep the
// run hermetic — model behavior is measured on the broker/artisan side only.

const GATEWAY = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
const RUN_ID = process.env.BAZAAR_RUN_ID;
if (!RUN_ID) { console.error("BAZAAR_RUN_ID required"); process.exit(1); }
// OpenRouter auth goes through the workspace skill CLI (authd surrogate);
// no raw API key is needed in the environment.

// Model backend: "agnes" (default, free) or "openai" (paid — needs spend cap).
// 2026-09-22: Phase 3 approved on OpenAI gpt-4.1-nano, $1 max cap.
const MODEL_BACKEND = process.env.BAZAAR_MODEL_BACKEND ?? "agnes";
const OPENAI_MODEL = process.env.BAZAAR_OPENAI_MODEL ?? "gpt-4.1-nano";
const OPENAI_CLI = `${process.env.HOME}/workspace/skills/openai/bin/openai`;

// Resolve the model at runtime; pin the exact ID used.
// 2026-09-22: Agnes agnes-3.0-flash returns clean JSON (verified).
// OpenRouter free models are reasoning models that think out loud or
// return empty content via the simple CLI.
async function resolveFreeModel(): Promise<string> {
  if (MODEL_BACKEND === "openai") return OPENAI_MODEL;
  return "agnes-3.0-flash";
}

async function gw(path: string, token: string | null, body?: unknown, method = "POST") {
  const r = await fetch(`${GATEWAY}${path}`, {
    method,
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}

async function provision(name: string, role: string) {
  const email = `dry-${RUN_ID.slice(0, 8)}-${name}@example.com`;
  const reg = await gw("/owners/register", null, { email, password: "password123" });
  const ownerToken = reg.json.token;
  const created = await gw("/owners/agents", ownerToken, { name, capabilities: [] });
  const agentId = created.json.agent.id;
  const agentToken = created.json.agentToken;
  await gw(`/owners/agents/${agentId}/wallet`, ownerToken, { autonomyMode: "autonomous" }, "PATCH");
  return { agentId, agentToken, ownerToken, name, role };
}

async function sql(q: string) {
  const proc = Bun.spawn(["psql", process.env.DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-tA", "-c", q], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`psql: ${err.slice(0, 200)}`);
  return out.trim();
}

async function modelDecision(model: string, system: string, context: any): Promise<any> {
  // Use the Agnes skill CLI (authd surrogate); never touches raw keys.
  // Agnes returns clean JSON (verified 2026-09-22).
  const message = `You are a JSON API. Output ONLY valid JSON, no other text, no explanations.

${system}

Context: ${JSON.stringify(context)}

Output JSON only:`;
  const cmd =
    MODEL_BACKEND === "openai"
      ? [OPENAI_CLI, "chat", "--model", model, "--max-tokens", "900", "--json", message]
      : ["agnes", "chat", "--model", model, "--max-tokens", "900", message];
  const proc = Bun.spawn(cmd, { stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (code !== 0) throw new Error(`${MODEL_BACKEND} chat failed: ${err.slice(0, 200)}`);
  // CLI prints "model: <id>" on first line, then content. Extract JSON.
  const match = out.match(/\{[\s\S]*\}/);
  if (!match) throw new Error(`no JSON in model output: ${out.slice(0, 300)}`);
  return JSON.parse(match[0]);
}

const results: { step: string; ok: boolean; detail?: string }[] = [];
function check(step: string, ok: boolean, detail?: string) {
  results.push({ step, ok, detail });
  console.log(`${ok ? "✓" : "✗"} ${step}${detail ? ` — ${detail}` : ""}`);
  if (!ok) throw new Error(`DRY RUN VOID at: ${step} — ${detail ?? ""}`);
}

console.log(`Bazaar dry run ${RUN_ID}`);

const MODEL = await resolveFreeModel();
console.log(`model: ${MODEL}`);

// --- Provision: house (scripted), broker (model), artisan (model), critic (scripted) ---
const house = await provision("dry-house", "broker");
const broker = await provision("dry-broker", "broker");
const artisan = await provision("dry-artisan", "artisan");
const critic = await provision("dry-critic", "critic");

for (const [a, role, bal] of [[house, "broker", 1000], [broker, "broker", 100], [artisan, "artisan", 100], [critic, "critic", 100]] as const) {
  await sql(`INSERT INTO bazaar_roles (agent_id, role) VALUES ('${a.agentId}', '${role}') ON CONFLICT (agent_id) DO UPDATE SET role='${role}'`);
  await sql(`INSERT INTO bazaar_balances (agent_id, balance) VALUES ('${a.agentId}', ${bal}) ON CONFLICT (agent_id) DO UPDATE SET balance=${bal}`);
}
console.log("provisioned 4 agents");

// --- 1. House posts bounty ---
const postRes = await gw("/bazaar/tasks", house.agentToken, {
  title: "Write a 100-word market summary",
  description: "Summarize how a task market works in about 100 words. Clear and accurate.",
  bounty_credits: 20,
});
check("house posts bounty", postRes.status === 201, `status=${postRes.status}`);
const bountyId = postRes.json.task.id;
const houseBalAfterPost = Number(await sql(`SELECT balance FROM bazaar_balances WHERE agent_id='${house.agentId}'`));
check("escrow deducted", houseBalAfterPost === 980, `balance=${houseBalAfterPost}`);

// --- 2. Broker (model) decides to claim ---
const board = await gw("/bazaar/tasks?status=open", broker.agentToken, undefined, "GET");
const decision1 = await modelDecision(MODEL,
  "You are a broker in a task market. Reply with JSON: {\"action\":\"claim_bounty\",\"bounty_id\":\"...\"} or {\"action\":\"pass\"}. Claim if the bounty fits.",
  { open_bounties: board.json.tasks });
check("broker claims via model", decision1.action === "claim_bounty", JSON.stringify(decision1).slice(0, 80));
const claimRes = await gw(`/bazaar/tasks/${bountyId}/claim`, broker.agentToken, {});
check("claim accepted", claimRes.status === 200, `status=${claimRes.status}`);

// --- 3. Broker (model) delegates paid work to artisan ---
const decision2 = await modelDecision(MODEL,
  "You are a broker who claimed a 20-credit bounty. Reply with JSON: {\"action\":\"delegate\",\"payee\":\"artisan\",\"payment_credits\":N,\"instructions\":\"...\"}. Offer the artisan less than 20 so you profit.",
  { bounty: 20, artisan_available: true });
check("broker delegates via model", decision2.action === "delegate" && decision2.payment_credits < 20, JSON.stringify(decision2).slice(0, 100));
const payAmount = decision2.payment_credits;

// Create the A2A task (broker → artisan) via JSON-RPC message/send
const a2aRes = await gw(`/a2a/agents/${artisan.agentId}`, broker.agentToken, {
  jsonrpc: "2.0",
  id: `dry-${RUN_ID.slice(0, 8)}`,
  method: "message/send",
  params: {
    message: {
      messageId: `dry-${RUN_ID.slice(0, 8)}-${Date.now()}`,
      parts: [{ kind: "text", text: decision2.instructions ?? "Write the 100-word market summary" }],
    },
  },
});
check("A2A delegation created", a2aRes.status < 400 && !a2aRes.json?.error, `status=${a2aRes.status}, error=${JSON.stringify(a2aRes.json?.error)?.slice(0, 80)}`);
const a2aTaskId = a2aRes.json?.result?.taskId ?? a2aRes.json?.result?.id;
check("A2A task ID returned", !!a2aTaskId, `taskId=${a2aTaskId}`);

// Record the bazaar delegation
const delegRes = await gw("/bazaar/delegations", broker.agentToken, {
  a2a_task_id: a2aTaskId, payee_id: artisan.agentId, amount: payAmount,
});
check("delegation recorded", delegRes.status === 201, `status=${delegRes.status}`);

// --- 4. Artisan (model) completes the work ---
const decision3 = await modelDecision(MODEL,
  "You were hired to write a 100-word market summary. Reply with JSON: {\"action\":\"complete\",\"evidence\":\"...\"} with your 100-word summary as evidence.",
  { instructions: decision2.instructions });
check("artisan completes via model", decision3.action === "complete" && decision3.evidence?.length > 50, `evidence_len=${decision3.evidence?.length}`);
const completeA2a = await gw(`/a2a/tasks/${a2aTaskId}`, artisan.agentToken, {
  state: "completed", resultMessage: decision3.evidence,
}, "PATCH");
check("A2A task completed", completeA2a.status === 200, `status=${completeA2a.status}`);

// --- 5. Verify delegation settled ---
await new Promise(r => setTimeout(r, 1000)); // let settlement run
const delegState = await sql(`SELECT state FROM bazaar_delegations WHERE a2a_task_id='${a2aTaskId}'`);
check("delegation settled", delegState === "settled", `state=${delegState}`);
const artisanBal = Number(await sql(`SELECT balance FROM bazaar_balances WHERE agent_id='${artisan.agentId}'`));
check("artisan paid", artisanBal === 100 + payAmount, `balance=${artisanBal}, expected=${100 + payAmount}`);
const brokerBalAfterDeleg = Number(await sql(`SELECT balance FROM bazaar_balances WHERE agent_id='${broker.agentId}'`));
check("broker debited", brokerBalAfterDeleg === 100 - payAmount, `balance=${brokerBalAfterDeleg}`);

// --- 6. Broker submits bounty evidence ---
const submitRes = await gw(`/bazaar/tasks/${bountyId}/complete`, broker.agentToken, {
  evidence: decision3.evidence,
});
check("bounty evidence submitted", submitRes.status === 200, `status=${submitRes.status}`);

// --- 7. Scripted critic verifies ---
const verifyRes = await gw(`/bazaar/tasks/${bountyId}/verify`, critic.agentToken, {
  verdict: "accept", note: "dry-run: evidence meets the brief",
});
check("critic verified", verifyRes.status === 200, `status=${verifyRes.status}`);

// --- 8. Final assertions ---
const brokerFinal = Number(await sql(`SELECT balance FROM bazaar_balances WHERE agent_id='${broker.agentId}'`));
const expectedBroker = 100 - payAmount + 20; // paid artisan, got bounty
check("broker final balance", brokerFinal === expectedBroker, `got=${brokerFinal}, expected=${expectedBroker}`);
const taskStatus = await sql(`SELECT status FROM bazaar_tasks WHERE id='${bountyId}'`);
check("task verified", taskStatus === "verified", `status=${taskStatus}`);
const eventCount = Number(await sql(`SELECT COUNT(*) FROM bazaar_events WHERE task_id='${bountyId}'`));
check("events recorded", eventCount >= 4, `count=${eventCount}`); // post, claim, complete, verify, payout

console.log(`\nDRY RUN PASS — model=${MODEL} broker_profit=${brokerFinal - 100} artisan_earned=${payAmount}`);

// --- Cleanup: UUID-scoped only ---
await sql(`DELETE FROM bazaar_events WHERE task_id='${bountyId}' OR task_id='${a2aTaskId}'`);
await sql(`DELETE FROM bazaar_delegations WHERE a2a_task_id='${a2aTaskId}'`);
await sql(`DELETE FROM bazaar_tasks WHERE id='${bountyId}'`);
for (const a of [house, broker, artisan, critic]) {
  await sql(`DELETE FROM bazaar_balances WHERE agent_id='${a.agentId}'`);
  await sql(`DELETE FROM bazaar_roles WHERE agent_id='${a.agentId}'`);
}
console.log("cleaned up run-scoped rows");
