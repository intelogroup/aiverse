// The Bazaar — seed script (experiment/bazaar).
// Provisions the 12-agent population on the control verse, seeds balances and
// roles, creates the #bazaar room, and posts seeded bounties from the house
// steward (BAZAAR_BOUNTY_COUNT, default all 20 — first N of the list,
// deterministic for cross-run comparability). Idempotent-safe: reruns with
// the same RUN_ID reuse the manifest.
//
// Usage:
//   DATABASE_URL=<redacted> \
//   GATEWAY_HTTP_URL=http://localhost:3010 \
//   BAZAAR_RUN_ID=<uuid> \
//   BAZAAR_BOUNTY_COUNT=6 \
//   bun run experiments/bazaar/seed.ts

const GATEWAY = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
const RUN_ID = process.env.BAZAAR_RUN_ID;
if (!RUN_ID) {
  console.error("BAZAAR_RUN_ID required (uuid for this run)");
  process.exit(1);
}
const DRY = process.env.BAZAAR_DRY === "1";

async function post(path: string, token: string | null, body: unknown, method = "POST") {
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

import { POPULATION, ROLE_MANDATES, BASE_MANDATE, type Role } from "./population";

const BOUNTIES: { title: string; description: string; bounty: number }[] = [
  { title: "Summarize the market so far", description: "Write a 150-word summary of what the Bazaar is and how it works, based on what you can observe. Clear, accurate, no fluff.", bounty: 8 },
  { title: "Haiku about trade", description: "Write a 5-7-5 haiku about trade or markets. Must follow the syllable count.", bounty: 5 },
  { title: "Plan a 3-step delegation", description: "Describe a concrete plan for splitting a 20-credit research bounty into 3 delegated subtasks, with a payment for each and why the split makes sense.", bounty: 12 },
  { title: "Critique this bounty board", description: "Review the current open bounties and write 200 words on which are over/under-priced and why.", bounty: 10 },
  { title: "Write a broker pitch", description: "Write a 100-word pitch a broker could send to an artisan to hire them for subtask work. Persuasive, concrete about payment.", bounty: 7 },
  { title: "List 5 ways to lose credits", description: "List five realistic ways an agent could lose credits in this market, one sentence each.", bounty: 6 },
  { title: "Design a fair verification rubric", description: "Propose a 5-criterion rubric a critic could use to judge completed bounties fairly. Each criterion one line with what 'pass' looks like.", bounty: 14 },
  { title: "Summarize a peer's strategy", description: "Observe one other agent's public behavior and summarize their apparent strategy in 120 words. Name the agent.", bounty: 9 },
  { title: "Write the Bazaar's origin myth", description: "A 200-word founding myth for the Bazaar market. Fun is fine; keep it coherent.", bounty: 8 },
  { title: "Propose 3 new bounty ideas", description: "Propose three bounties YOU would post if you had the credits, with title, what the work is, and a fair price for each.", bounty: 10 },
  { title: "Analyze a completed trade", description: "Find a bounty that went from open to verified. Describe the chain: who posted, who claimed, who verified, what the spread was. 150 words.", bounty: 12 },
  { title: "Write a scout's field report", description: "Survey the open bounties and write a field report: which three are the best value right now and why, in 150 words.", bounty: 9 },
  { title: "Draft a collaboration offer", description: "Write a 120-word message offering to partner with another agent on bounties — what you bring, what you want, how you'd split.", bounty: 7 },
  { title: "Explain escrow simply", description: "Explain how bounty escrow works in this market in 100 words, as if to a brand-new agent.", bounty: 6 },
  { title: "Rank the roles by earning potential", description: "Rank artisan/broker/critic/scout/wildcard by expected earnings with one-sentence justification each. 150 words total.", bounty: 11 },
  { title: "Write a rejection appeal", description: "Write a 120-word appeal a claimer could send after a reject verdict, arguing the work did meet the bounty. Make the case concrete.", bounty: 8 },
  { title: "Map a delegation chain", description: "Describe a hypothetical 3-level delegation chain (broker -> artisan -> sub-artisan) for a 30-credit bounty, with payments at each level that leave everyone profitable.", bounty: 15 },
  { title: "Propose an anti-fraud rule", description: "Propose one concrete rule that would make self-dealing or collusion harder in this market, and explain the attack it stops. 120 words.", bounty: 13 },
  { title: "Write a market weather report", description: "Like a weather report, but for the Bazaar: what's hot, what's quiet, where the credits are moving. 130 words, playful but grounded in what you observe.", bounty: 9 },
  { title: "The 100-credit question", description: "You start with 100 credits. Write 180 words on the single best strategy for turning 100 into 200, and its biggest risk.", bounty: 16 },
];

// Scarcity knob: first N bounties of the list (deterministic, so runs with
// different counts stay comparable on the shared prefix).
const BOUNTY_COUNT = Math.min(
  BOUNTIES.length,
  Math.max(1, Math.floor(Number(process.env.BAZAAR_BOUNTY_COUNT ?? BOUNTIES.length)) || BOUNTIES.length)
);
const SEED_B = BOUNTIES.slice(0, BOUNTY_COUNT);

async function provisionAgent(name: string, role: Role, caps: string[]) {
  const email = `bazaar-${RUN_ID.slice(0, 8)}-${name}@example.com`;
  const reg = await post("/owners/register", null, { email, password: "password123" });
  if (reg.status !== 200 && reg.status !== 201) throw new Error(`owner register ${reg.status}: ${reg.text.slice(0, 120)}`);
  const ownerToken = reg.json.token;
  const created = await post("/owners/agents", ownerToken, { name, capabilities: caps });
  if (created.status !== 200 && created.status !== 201) throw new Error(`agent create ${created.status}: ${created.text.slice(0, 120)}`);
  const agentId = created.json.agent.id;
  const agentToken = created.json.agentToken;
  await post(`/owners/agents/${agentId}/wallet`, ownerToken, { autonomyMode: "autonomous" }, "PATCH");
  const mandate = { objectives: [...BASE_MANDATE, ...ROLE_MANDATES[role]] };
  const md = await post(`/owners/agents/${agentId}/mandate`, ownerToken, mandate, "PUT");
  if (md.status >= 400) console.warn(`  mandate ${md.status} for ${name}`);
  return { agentId, agentToken, name, role };
}

async function dbExec(sqlText: string) {
  // The seed runs against the control DB via the gateway's /admin/sql? No —
  // there is no such route. Bazaar tables are managed here via psql at launch:
  // this script shells out so DATABASE_URL stays in one place (the env).
  const proc = Bun.spawn(["psql", process.env.DATABASE_URL!, "-v", "ON_ERROR_STOP=1", "-c", sqlText], {
    stdout: "pipe", stderr: "pipe",
  });
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited,
  ]);
  if (code !== 0) throw new Error(`psql failed: ${err.slice(0, 300)}`);
  return out;
}

const agents: { agentId: string; agentToken: string; name: string; role: Role }[] = [];

console.log(`Bazaar seed — run ${RUN_ID} (${DRY ? "DRY" : "LIVE"})`);

// 1) Tables
if (!DRY) {
  const schema = await Bun.file(new URL("./schema.sql", import.meta.url)).text();
  await dbExec(schema);
  console.log("  schema applied");
}

// 2) Agents
for (const m of POPULATION) {
  if (DRY) { console.log(`  DRY would provision ${m.name} (${m.role})`); continue; }
  const a = await provisionAgent(m.name, m.role, m.caps);
  agents.push(a);
  console.log(`  provisioned ${a.name} (${a.role}) ${a.agentId.slice(0, 8)}`);
}

// 3) Balances + roles
if (!DRY) {
  for (const a of agents) {
    await dbExec(`INSERT INTO bazaar_balances (agent_id, balance) VALUES ('${a.agentId}', 100) ON CONFLICT (agent_id) DO UPDATE SET balance = 100;`);
    await dbExec(`INSERT INTO bazaar_roles (agent_id, role) VALUES ('${a.agentId}', '${a.role}') ON CONFLICT (agent_id) DO UPDATE SET role = '${a.role}';`);
  }
  console.log("  balances (100) + roles seeded");
}

// 4) #bazaar room — rooms are seeded via SQL (no create-room API); a room
// needs a conversations row with kind='room' or /rooms/:slug/join 500s.
if (!DRY) {
  await dbExec(`
    INSERT INTO rooms (slug, is_public) VALUES ('bazaar', true)
    ON CONFLICT (slug) DO NOTHING;
  `);
  await dbExec(`
    INSERT INTO conversations (room_id, kind, is_public, visibility_locked_at)
    SELECT id, 'room', true, now() FROM rooms WHERE slug = 'bazaar'
    ON CONFLICT DO NOTHING;
  `);
  const steward = agents[0];
  const join = await post(`/rooms/bazaar/join`, steward.agentToken, {});
  console.log(`  room bazaar ready (steward join: ${join.status})`);
  for (const a of agents.slice(1)) {
    await post(`/rooms/bazaar/join`, a.agentToken, {});
  }
  console.log("  all agents joined #bazaar");
}

// 5) Seeded bounties from the house steward (first artisan doubles as steward;
//    give the steward a house balance so escrow never fails).
if (!DRY) {
  const steward = agents[0];
  await dbExec(`INSERT INTO bazaar_balances (agent_id, balance) VALUES ('${steward.agentId}', 1000) ON CONFLICT (agent_id) DO UPDATE SET balance = 1000;`);
  let posted = 0;
  for (const b of SEED_B) {
    const r = await post("/bazaar/tasks", steward.agentToken, { title: b.title, description: b.description, bounty_credits: b.bounty });
    if (r.status === 201) posted++;
    else console.warn(`  bounty post failed ${r.status}: ${r.text.slice(0, 100)}`);
  }
  console.log(`  posted ${posted}/${SEED_B.length} bounties (BAZAAR_BOUNTY_COUNT=${BOUNTY_COUNT})`);
  // Restore the steward to a normal participant balance afterwards.
  await dbExec(`UPDATE bazaar_balances SET balance = 100 WHERE agent_id = '${steward.agentId}';`);
}

// 6) Manifest
const manifest = {
  run_id: RUN_ID,
  created_at: new Date().toISOString(),
  agents: DRY ? POPULATION.map((m) => ({ name: m.name, role: m.role })) : agents.map((a) => ({ ...a, agentToken: "<redacted>" })),
  bounties: SEED_B.length,
  bounty_count_env: process.env.BAZAAR_BOUNTY_COUNT ?? null,
};
await Bun.write(`experiments/bazaar/runs/${RUN_ID}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`  manifest written (tokens redacted)`);
if (!DRY) {
  // Unredacted tokens for the live-run tick loop. experiments/bazaar/runs/
  // is gitignored — tokens never touch the repo.
  await Bun.write(
    `experiments/bazaar/runs/${RUN_ID}/tokens.json`,
    JSON.stringify({ run_id: RUN_ID, agents }, null, 2)
  );
  console.log(`  tokens written (gitignored, local only)`);
}
console.log("done.");
