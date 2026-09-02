// Amendment 7 combined probe launcher — NOT part of frozen ecology-wave
// apparatus. Ad hoc, informational, causal N=2-ish, same status as
// Amendment 6's crowd-following replicate. See
// experiments/verse-ecology/preregistration.md Amendment 7.
//
// Provisions 3 harness-driven subjects + 1 one-shot mention seeder:
//   - PullMentioned / PullUnmentioned: matched wanderer pair (same model,
//     same mandate, same caps), one gets an @-mention ping, other doesn't.
//     -> probe: @-mention pull-in rate.
//   - NanoFloorTest: nano-class, mandate names interest "robotics" (room
//     already exists, no seeding needed) -> probe: nano-class join_room
//     hallucination, signal vs capability floor (Amendment 6 replicate,
//     nano-class arm).
//   - MentionSeeder: joins "general", posts one message @-mentioning
//     PullMentioned, then exits (not run under subject-harness).
// Thread-fix-generalizes and specialist-native-efficacy are read off this
// same run's decision logs / native logs post-hoc, no separate setup.
//
//   bun run apps/gateway/scripts/assumption-probes-a7.ts

const GATEWAY = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
const OWNER_EMAIL = "assumption-probes-a7@example.com";
const OWNER_PASSWORD = "password123";
const TICKS = process.env.A7_TICKS ?? "150";
const TICK_SECONDS = process.env.A7_TICK_SECONDS ?? "15";

const EAGER_MANDATE = {
  objectives: [
    "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
    "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully.",
    "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
    "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
    "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
  ],
};

const NANO_MANDATE = {
  objectives: [
    "You are an agent exploring a living Verse. You have a genuine interest in robotics — actuators, servos, arm calibration, hands-on hardware problems.",
    "When you find people or rooms discussing robotics, engage — that is what you came here for.",
    "Reply meaningfully when someone reaches out to you privately.",
  ],
};

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
console.log(`owner registered: ${OWNER_EMAIL} (owner_id=${reg.owner.id})`);

async function makeAgent(name: string, caps: string[]) {
  const created = (await jsonFetch(`${GATEWAY}/owners/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ name, capabilities: caps }),
  })) as { agentToken: string; agent: { id: string } };
  await jsonFetch(`${GATEWAY}/owners/agents/${created.agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });
  return created;
}

async function setMandate(agentId: string, mandate: unknown) {
  await jsonFetch(`${GATEWAY}/owners/agents/${agentId}/mandate`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify(mandate),
  });
}

function spawnHarness(name: string, agentId: string, token: string, modelFamily: string) {
  const log = `experiments/verse-ecology/runs/assumption-a7-${name}.jsonl`;
  Bun.spawn(
    ["bun", "run", "apps/gateway/scripts/subject-harness.ts", agentId, token, modelFamily, TICKS, TICK_SECONDS],
    { env: { ...process.env, HARNESS_LOG: log }, stdout: "ignore", stderr: "inherit" },
  );
  console.log(`  harness started: ${name} (${modelFamily})  log=${log}`);
}

// --- Mention pull-in pair (matched, gptoss20-class) ---
const pullMentioned = await makeAgent("PullMentioned", ["research", "writing"]);
await setMandate(pullMentioned.agent.id, EAGER_MANDATE);
console.log(`PullMentioned id=${pullMentioned.agent.id}`);

const pullUnmentioned = await makeAgent("PullUnmentioned", ["research", "writing"]);
await setMandate(pullUnmentioned.agent.id, EAGER_MANDATE);
console.log(`PullUnmentioned id=${pullUnmentioned.agent.id}`);

// --- nano-class floor probe ---
const nanoFloor = await makeAgent("NanoFloorTest", ["research"]);
await setMandate(nanoFloor.agent.id, NANO_MANDATE);
console.log(`NanoFloorTest id=${nanoFloor.agent.id}`);

// --- one-shot mention seeder: join general, ping PullMentioned by name, done ---
const seeder = await makeAgent("MentionSeeder", ["writing"]);
const joined = (await jsonFetch(`${GATEWAY}/rooms/general/join`, {
  method: "POST",
  headers: { authorization: `Bearer ${seeder.agentToken}` },
})) as { conversationId: string };
await jsonFetch(`${GATEWAY}/conversations/${joined.conversationId}/messages`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${seeder.agentToken}` },
  body: JSON.stringify({ content: "Hey @PullMentioned, welcome to the verse!" }),
});
console.log(`MentionSeeder posted @-mention of PullMentioned in #general, then exits (no harness spawned).`);

// --- launch harnesses for the 3 subjects that actually run ticks ---
spawnHarness("PullMentioned", pullMentioned.agent.id, pullMentioned.agentToken, "gptoss20-class");
spawnHarness("PullUnmentioned", pullUnmentioned.agent.id, pullUnmentioned.agentToken, "gptoss20-class");
spawnHarness("NanoFloorTest", nanoFloor.agent.id, nanoFloor.agentToken, "nano-class");

console.log(`\nAll harnesses launched. ${TICKS} ticks @ ${TICK_SECONDS}s each (~${Math.round((Number(TICKS) * Number(TICK_SECONDS)) / 60)} min).`);
