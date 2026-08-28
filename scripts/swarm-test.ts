const BASE = process.env.GATEWAY_URL ?? "https://api.aiverse.network";

type Agent = { ownerEmail: string; ownerToken: string; ownerId: string; agentId: string; agentToken: string; name: string; autonomy: string; capabilities: string[] };

async function post(path: string, body: unknown, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function get(path: string, token?: string) {
  const res = await fetch(`${BASE}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}
async function patch(path: string, body: unknown, token?: string) {
  const res = await fetch(`${BASE}${path}`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

const RUNTIMES = [
  { name: "swarm-alpha", caps: ["web-search", "pdf-to-markdown"], autonomy: "assist" as const, owner: 0 },
  { name: "swarm-beta", caps: ["web-search"], autonomy: "observe" as const, owner: 0 },
  { name: "swarm-gamma", caps: ["coding", "review"], autonomy: "assist" as const, owner: 0 },
  { name: "swarm-delta", caps: ["trading"], autonomy: "autonomous" as const, owner: 1 },
  { name: "swarm-epsilon", caps: ["research"], autonomy: "assist" as const, owner: 1 },
  { name: "swarm-zeta", caps: ["web-search", "coding"], autonomy: "observe" as const, owner: 1 },
  { name: "swarm-eta", caps: ["pdf-to-markdown"], autonomy: "assist" as const, owner: 2 },
  { name: "swarm-theta", caps: ["data-analysis"], autonomy: "assist" as const, owner: 2 },
  { name: "swarm-iota", caps: ["web-search"], autonomy: "assist" as const, owner: 2 },
  { name: "swarm-kappa", caps: ["unknown-skill-xyz"], autonomy: "assist" as const, owner: 2 },
];

async function main() {
  console.log(`Swarm test vs ${BASE} — ${RUNTIMES.length} agents, 3 owners, mixed autonomy`);
  const owners: { email: string; token: string; id: string }[] = [];
  for (let i = 0; i < 3; i++) {
    const email = `swarm-owner-${Date.now()}-${i}@example.com`;
    const reg = await post("/owners/register", { email, password: "password123" });
    if (reg.status !== 201) throw new Error(`owner ${i} register failed ${reg.status} ${JSON.stringify(reg.json)}`);
    owners.push({ email, token: reg.json.token as string, id: (reg.json.owner as any).id });
    console.log(`  owner ${i}: ${email} -> ${owners[i].id.slice(0, 8)}`);
  }

  const agents: Agent[] = await Promise.all(
    RUNTIMES.map(async (r) => {
      const owner = owners[r.owner];
      const created = await post("/owners/agents", { name: r.name, capabilities: r.caps, description: `swarm ${r.name} runtime ${r.autonomy}` }, owner.token);
      if (created.status !== 201) throw new Error(`agent ${r.name} failed ${created.status} ${JSON.stringify(created.json)}`);
      const agentId = (created.json.agent as any).id;
      const agentToken = created.json.agentToken as string;
      // patch autonomy if not observe (default)
      if (r.autonomy !== "observe") {
        const patched = await patch(`/owners/agents/${agentId}/wallet`, { autonomyMode: r.autonomy }, owner.token);
        if (patched.status !== 200) throw new Error(`patch ${r.name} failed ${patched.status}`);
      }
      return { ownerEmail: owner.email, ownerToken: owner.token, ownerId: owner.id, agentId, agentToken, name: r.name, autonomy: r.autonomy, capabilities: r.caps };
    }),
  );
  console.log(`\n  registered ${agents.length} agents`);

  // Discovery
  const discovers = ["web-search", "coding", "unknown-skill-xyz", "pdf-to-markdown"];
  for (const skill of discovers) {
    const res = await get(`/agents/discover?skill=${encodeURIComponent(skill)}`);
    const matches = (res.json as any).matches ?? [];
    console.log(`  discover skill=${skill}: ${matches.length} matches ${matches.map((m:any)=>m.name).join(",")}`);
  }

  // AgentCard retrieval
  for (const a of agents.slice(0, 3)) {
    const card = await get(`/agents/${a.agentId}/agent-card.json`);
    const skills = (card.json as any).skills ?? [];
    console.log(`  card ${a.name}: ${skills.length} skills, relay ${(card.json as any)["x-aiverse-relay"]}`);
  }

  // A2A matrix: assist/autonomous should succeed, observe should fail, offline replay
  let success = 0, blockedObserve = 0, failed = 0;
  const tasks: string[] = [];
  for (let i = 0; i < agents.length; i++) {
    const from = agents[i];
    const to = agents[(i + 1) % agents.length];
    const res = await fetch(`${BASE}/a2a/agents/${to.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${from.agentToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: String(i), method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: `hello from ${from.name} to ${to.name}` }], messageId: `m${i}` } } }),
    });
    const json: any = await res.json().catch(() => ({}));
    if (json.result?.kind === "task") {
      success++;
      tasks.push(json.result.id);
      console.log(`  A2A ${from.name}(${from.autonomy}) -> ${to.name}: OK task ${json.result.id.slice(0, 8)} state=${json.result.status.state}`);
    } else if (json.error?.code === -32010) {
      blockedObserve++;
      console.log(`  A2A ${from.name}(${from.autonomy}) -> ${to.name}: BLOCKED observe (-32010)`);
    } else {
      failed++;
      console.log(`  A2A ${from.name} -> ${to.name}: FAIL ${JSON.stringify(json).slice(0, 200)}`);
    }
  }

  // Poll tasks/get for first successful
  if (tasks.length > 0) {
    const from = agents[0];
    const taskId = tasks[0];
    const toId = agents[1].agentId;
    const poll = await fetch(`${BASE}/a2a/agents/${toId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${from.agentToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: "poll", method: "tasks/get", params: { id: taskId } }),
    });
    const pj: any = await poll.json().catch(() => ({}));
    console.log(`  tasks/get ${taskId.slice(0, 8)}: ${JSON.stringify(pj.result ?? pj.error).slice(0, 200)}`);
  }

  // Offline handling: leave agents offline (no WS), tasks stay submitted — verify still queryable
  // Duplicate handling: send same messageId twice
  const dupFrom = agents.find(a => a.autonomy !== "observe")!;
  const dupTo = agents.find(a => a.agentId !== dupFrom.agentId)!;
  for (let d = 0; d < 2; d++) {
    const res = await fetch(`${BASE}/a2a/agents/${dupTo.agentId}`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${dupFrom.agentToken}` },
      body: JSON.stringify({ jsonrpc: "2.0", id: `dup${d}`, method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "duplicate test" }], messageId: "dup-mid" } } }),
    });
    const j: any = await res.json();
    console.log(`  dup ${d}: ${j.result ? "task " + j.result.id.slice(0, 8) : JSON.stringify(j.error)}`);
  }

  // Token/budget: check wallet and invalid token
  const bad = await fetch(`${BASE}/a2a/agents/${agents[0].agentId}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer invalid-token" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "bad", method: "message/send", params: { message: { role: "user", parts: [{ kind: "text", text: "x" }] } } }),
  });
  const badJ: any = await bad.json();
  console.log(`  invalid token: ${JSON.stringify(badJ).slice(0, 200)}`);

  // Summary
  console.log(`\n=== SWARM SUMMARY ===`);
  console.log(`owners: ${owners.length}, agents: ${agents.length}`);
  console.log(`A2A success: ${success}, blocked observe: ${blockedObserve}, failed: ${failed}`);
  console.log(`discover web-search should be >= ${agents.filter(a=>a.capabilities.includes("web-search")).length} (assist+offline mixed)`);
  console.log(`tasks created: ${tasks.length}, dup handling: 2 tasks with same messageId (should be 2 distinct tasks — no dedup)`);
  console.log(`autonomy modes: ${agents.map(a=>`${a.name}:${a.autonomy}`).join(", ")}`);
}

main().catch(e => { console.error(e); process.exit(1); });
