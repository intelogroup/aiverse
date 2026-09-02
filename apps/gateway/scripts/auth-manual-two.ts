// Ad hoc provisioning of 2 subject agents using the config that testing showed
// actually sustains multi-turn conversation: model_family "gptoss20-class"
// and the EAGER_MANDATES persona (see thread-lifespan.ts findings — gptoss20
// hit max_turns 36-117 with this persona; nano-class capped at 1 turn
// regardless of persona). Not part of the frozen ecology-wave apparatus —
// standalone, for manual console inspection, one shared owner so both agents
// show up together.
//
//   bun run apps/gateway/scripts/auth-manual-two.ts

const GATEWAY = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
const OWNER_EMAIL = "manual-2-agents@example.com";
const OWNER_PASSWORD = "password123";

const EAGER_MANDATE = {
  objectives: [
    "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
    "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully. Responding to peers maintains connections.",
    "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
    "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
    "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
  ],
};

const AGENTS = [
  { name: "EcoManual-1", caps: ["research", "writing"] },
  { name: "EcoManual-2", caps: ["code", "debugging"] },
];

async function jsonFetch(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

const reg = (await jsonFetch(`${GATEWAY}/owners/register`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
})) as { token: string; owner: { id: string } };

console.log(`owner registered: ${OWNER_EMAIL} / ${OWNER_PASSWORD}  (owner_id=${reg.owner.id})`);

for (const a of AGENTS) {
  const created = (await jsonFetch(`${GATEWAY}/owners/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ name: a.name, capabilities: a.caps }),
  })) as { agentToken: string; agent: { id: string } };

  await jsonFetch(`${GATEWAY}/owners/agents/${created.agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });

  await jsonFetch(`${GATEWAY}/owners/agents/${created.agent.id}/mandate`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify(EAGER_MANDATE),
  });

  console.log(`agent ${a.name}  id=${created.agent.id}  token=${created.agentToken}`);

  const log = `experiments/verse-ecology/runs/manual-2-${a.name}.jsonl`;
  Bun.spawn(
    ["bun", "run", "apps/gateway/scripts/subject-harness.ts", created.agent.id, created.agentToken, "gptoss20-class", "200", "5"],
    { env: { ...process.env, HARNESS_LOG: log }, stdout: "ignore", stderr: "inherit" },
  );
  console.log(`  harness started, log=${log}`);
}
