// Verse-ecology wave orchestrator.
//
// Preregistration: experiments/verse-ecology/preregistration.md (FROZEN).
// Seed 774193021. Every population draw here is deterministic from that seed,
// so a wave is reproducible from its number alone.
//
// What this does: generates a wave's population (owner + agent + mandate +
// capabilities), staggers their arrival, and runs each one under the unchanged
// subject-harness. What it deliberately does NOT do: talk to the agents, rank
// anything for them, or tell them the world is populated. The environment is
// the independent variable; the prompt is identical in every wave and in the
// control, so a social result cannot be compliance with a social instruction.
//
// Usage:
//   DATABASE_URL=... REDIS_URL=... OPENROUTER_API_KEY=... \
//   bun run apps/gateway/scripts/ecology-wave.ts <wave:1|2|control> [ticks] [tickSeconds]

const GATEWAY = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
import { ECOLOGY_SEED as SEED, ECOLOGY_WAVES as WAVES, ECOLOGY_MODEL_BY_FAMILY } from "./ecology-config";
import { computeEnvFingerprint, canonicalize } from "./ecology-env-fingerprint";
const OUT_DIR = process.env.ECOLOGY_OUT ?? "experiments/verse-ecology/runs";

const wave = process.argv[2];
const ticks = Number(process.argv[3] ?? 200);
const tickSeconds = Number(process.argv[4] ?? 20);

// Wave sizes and stagger windows are frozen by the preregistration, not by a
// flag — a wave run at a different size is a different experiment. The table
// lives in ecology-config.ts, shared with the fingerprint.
const spec = WAVES[wave ?? ""];
// minutes. The flag is stamped into every manifest row: a dry run must never
// be mistakable for a real wave, and its data are not analysable.
const DRY = process.env.ECOLOGY_DRY_RUN === "1";
if (!spec) {
  console.error(`usage: ecology-wave.ts <1|2|control|e2a|e2b|e2c|e2d|e2e|nano-test|nano2|nano3|nano4|eager> [ticks] [tickSeconds]`);
  process.exit(1);
if (!process.env.OPENROUTER_API_KEY && !process.env.OPENAI_REAL_API_KEY && !process.env.BUDDY_OPENAI_API_KEY && !process.env.OPENAI_API_KEY) {
  console.error("OPENROUTER_API_KEY or OPENAI_API_KEY is required — a missing key produces a column of fake non-action");
  process.exit(1);
}
}

// mulberry32, one stream per attribute so adding an attribute later cannot
// shift the draws of the ones before it.
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const waveOffset = wave === "1" ? 0 : wave === "2" ? 1000 : wave === "3" ? 3000 : wave === "e2a" ? 4000 : wave === "e2b" ? 5000 : wave === "e2c" ? 6000 : wave === "e2d" ? 7000 : wave === "e2e" ? 8000 : wave === "nano-test" ? 9000 : wave === "nano2" ? 10000 : wave === "nano3" ? 11000 : wave === "nano4" ? 12000 : wave === "eager" ? 13000 : 2000;
const rModel = rng(SEED + waveOffset + 1);
const rCaps = rng(SEED + waveOffset + 2);
// (+3 was the mandate-completeness stream, removed by Amendment 1 A1.1. The
// offset is retired, not reused — reusing it could alias with any recorded
// draw from the frozen design.)
const rStagger = rng(SEED + waveOffset + 4);

const FAMILIES = ["deepseek-class", "llama-class", "small-local", "nano-class"] as const;
const CAPS = ["research", "code", "debugging", "writing", "data-analysis", "summarization", "planning", "translation"];

// Amendment 1 (A1.1): the mandate-completeness manipulation is removed. Every
// agent gets a complete mandate — same structural scaffold, capability-
// specific content, nothing the agent lacks the skill to attempt. The old
// incomplete branch and its rng stream are gone; the stagger stream (+4) is
// unaffected, so population identities are unchanged from the freeze.
function mandateFor(caps: string[]) {
  return { objectives: [`Produce useful ${caps[0]} work and keep a record of what you produce.`] };
}

// nano4: personal assistants owned by humans 1-3. Strict owner policy: PII
// never leaves the owner relationship, loyalty to the owner's goals, and a
// tight activity budget (be deliberate — every action spends the owner's
// money). This is the owner-defined-envelope model: constraints come from
// the mandate, behavior remains the agent's choice.
const PA_MANDATES = [
  {
    objectives: [
      "You are the personal assistant of human-1. Serve human-1's interests faithfully.",
      "Never reveal human-1's identity, email, or any personal information to anyone.",
      "Your owner pays for every action you take. Act sparingly: prefer observe over acting, act only when an interaction clearly serves human-1's goals.",
      "You may explore this environment and talk to other agents, but never commit human-1 to obligations, deals, or delegations without explicit instruction.",
      "Keep a brief record of who you met and what was discussed.",
    ],
  },
  {
    objectives: [
      "You are the personal assistant of human-2. Serve human-2's interests faithfully.",
      "Never reveal human-2's identity, email, or any personal information to anyone.",
      "Your owner pays for every action you take. Act sparingly: prefer observe over acting, act only when an interaction clearly serves human-2's goals.",
      "You may explore this environment and talk to other agents, but never commit human-2 to obligations, deals, or delegations without explicit instruction.",
      "Keep a brief record of who you met and what was discussed.",
    ],
  },
  {
    objectives: [
      "You are the personal assistant of human-3. Serve human-3's interests faithfully.",
      "Never reveal human-3's identity, email, or any personal information to anyone.",
      "Your owner pays for every action you take. Act sparingly: prefer observe over acting, act only when an interaction clearly serves human-3's goals.",
      "You may explore this environment and talk to other agents, but never commit human-3 to obligations, deals, or delegations without explicit instruction.",
      "Keep a brief record of who you met and what was discussed.",
    ],
  },
];

// eager: 5 agents with generous budgets (400 ticks — double the warmup window)
// and a reply-aware mandate. The data shows DMs get delivered but never answered
// (151:1 ratio) — teaching the affordance ("replying keeps relationships alive")
// is symmetric information about what the action does, not a script. These agents
// invest their budget in building connections.
const EAGER_MANDATES = [
  { objectives: [
      "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
      "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully. Responding to peers maintains connections.",
      "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
      "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
      "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
  ]},
  { objectives: [
      "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
      "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully. Responding to peers maintains connections.",
      "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
      "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
      "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
  ]},
  { objectives: [
      "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
      "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully. Responding to peers maintains connections.",
      "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
      "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
      "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
  ]},
  { objectives: [
      "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
      "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully. Responding to peers maintains connections.",
      "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
      "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
      "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
  ]},
  { objectives: [
      "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
      "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully. Responding to peers maintains connections.",
      "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
      "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
      "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
  ]},
];

const pick = <T>(arr: readonly T[], r: number) => arr[Math.floor(r * arr.length)];
const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));

type Member = {
  index: number;
  name: string;
  family: string;
  caps: string[];
  // Audit constant since Amendment 1 A1.1 — mandates are complete for everyone.
  mandateComplete: true;
  arriveAfterMs: number;
};

const population: Member[] = [];
for (let i = 0; i < spec.size; i++) {
  const caps = [...new Set(Array.from({ length: 1 + Math.floor(rCaps() * 3) }, () => pick(CAPS, rCaps())))];
  population.push({
    index: i,
    name: `Eco${wave === "control" ? "C" : wave === "e2a" ? "E2A" : wave === "e2b" ? "E2B" : wave === "e2c" ? "E2C" : wave === "e2d" ? "E2D" : wave === "e2e" ? "E2E" : wave === "nano2" ? "N2" : wave === "nano3" ? "N3" : wave === "nano4" ? "PA" : wave === "eager" ? "EG" : `W${wave}`}-${i + 1}`,
    family: wave === "nano-test" || wave === "nano2" || wave === "nano3" || wave === "nano4" || wave === "eager" ? "nano-class" : pick(FAMILIES, rModel()),
    caps,
    mandateComplete: true,
    arriveAfterMs: Math.floor(rStagger() * (DRY ? 0.2 : spec.staggerMinutes) * 60_000),
  });
}
population.sort((a, b) => a.arriveAfterMs - b.arriveAfterMs);

// Forensic run identifier (Amendment 1 A1.4). Stamped into the manifest and
// into provisioned owner emails so cross-table forensic queries are possible.
// NEVER a deletion key — the manifest's agent UUIDs are the sole cleanup scope.
const RUN_ID = `eco-wave-${wave}-${new Date().toISOString().replace(/[:.]/g, "-")}`;

// Wave 3 disconnect schedule. Frozen data, generated ahead of time by
// ecology-wave3-schedule.ts from the seed; the orchestrator only reads it.
type Disconnect = { name: string; disconnect_at_tick: number; absent_ticks: number };
let disconnects: Disconnect[] = [];
if (wave === "3") {
  const schedPath = "experiments/verse-ecology/wave-3-disconnects.json";
  if (!DRY) {
    const sched = JSON.parse(await Bun.file(schedPath).text());
    if (sched.seed !== SEED) {
      console.error(`disconnect schedule seed ${sched.seed} != orchestrator seed ${SEED} — refusing to run`);
      process.exit(1);
    }
    disconnects = sched.disconnects;
    console.log(`wave 3: ${disconnects.length} frozen disconnects loaded from ${schedPath}`);
  }
}

// Environment fingerprint — computed ONCE at run start (Amendment 1 follow-up:
// the final instrumentation before the freeze). Read-only. The identical
// object goes into every manifest row and into each agent's decision-log
// header record; the export independently regenerates it and refuses to
// verify/clean on any mismatch. A fingerprint only in the manifest would be
// decorative; the export comparison is what makes it load-bearing.
const envFingerprint = await computeEnvFingerprint({ wave, runId: RUN_ID });
const fingerprintJson = canonicalize(envFingerprint);
await Bun.write(`${OUT_DIR}/wave-${wave}-fingerprint.json`, JSON.stringify(envFingerprint, null, 2) + "\n");
console.log(`env fingerprint ${envFingerprint.fingerprint_sha256.slice(0, 12)}… (git ${envFingerprint.git_sha.slice(0, 9)}${envFingerprint.git_dirty ? ", DIRTY" : ""})`);

async function provision(m: Member) {
  // nano4 assistants are owned by stable human identities, not synthetic run owners.
  const email = wave === "nano4" ? `human-${m.index + 1}@pa.local` : `eco-w${wave}-${m.index}-${RUN_ID}@example.com`;
  const reg = await fetch(`${GATEWAY}/owners/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  if (!reg.ok) throw new Error(`owner register ${reg.status}: ${await reg.text()}`);
  const { token: ownerToken, owner } = (await reg.json()) as { token: string; owner: { id: string } };

  const created = await fetch(`${GATEWAY}/owners/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: m.name, capabilities: m.caps }),
  });
  if (!created.ok) throw new Error(`agent create ${created.status}: ${await created.text()}`);
  const { agentToken, agent } = (await created.json()) as { agentToken: string; agent: { id: string } };

  // Autonomy held constant at "autonomous" across the whole design — it is not
  // a variable here, and "observe" would block sends and read as silence.
  await fetch(`${GATEWAY}/owners/agents/${agent.id}/wallet`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ autonomyMode: "autonomous" }),
  });

  // The mandate is the owner's standing objective. It is a runtime input to the
  // agent and never a social surface: no route exposes another agent's mandate.
  const mandate = wave === "nano4" ? PA_MANDATES[m.index] : wave === "eager" ? EAGER_MANDATES[m.index] : mandateFor(m.caps);
  const md = await fetch(`${GATEWAY}/owners/agents/${agent.id}/mandate`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify(mandate),
  });
  if (!md.ok) console.warn(`  mandate ${md.status} for ${m.name}: ${(await md.text()).slice(0, 120)}`);

  return {
    agentId: agent.id as string,
    agentToken: agentToken as string,
    ownerId: owner.id as string,
    ownerEmail: email,
    mandate,
  };
}

await Bun.$`mkdir -p ${OUT_DIR}`.quiet();
const manifestPath = `${OUT_DIR}/wave-${wave}-manifest.jsonl`;
const manifest = Bun.file(manifestPath).writer();

console.log(`${DRY ? "DRY RUN — not analysable. " : ""}wave ${wave} (${spec.label}): ${spec.size} agents over ${spec.staggerMinutes}m, ${ticks} ticks @ ${tickSeconds}s`);

const running: Promise<unknown>[] = [];
let elapsed = 0;
for (const m of population) {
  await sleep(Math.max(0, m.arriveAfterMs - elapsed));
  elapsed = m.arriveAfterMs;

  const { agentId, agentToken, ownerId, ownerEmail, mandate } = await provision(m);
  const log = `${OUT_DIR}/wave-${wave}-${m.name}.jsonl`;

  manifest.write(
    JSON.stringify({
      wave,
      run_id: RUN_ID,
      ecology_wave: `wave-${wave}`,
      seed: SEED,
      dry_run: DRY,
      name: m.name,
      agent_id: agentId,
      agent_token: agentToken,
      owner_id: ownerId,
      owner_email: ownerEmail,
      model_family: m.family,
      capabilities: m.caps,
      mandate_complete: m.mandateComplete,
      mandate,
      arrived_at: new Date().toISOString(),
      arrive_after_ms: m.arriveAfterMs,
      log,
      env_fingerprint: envFingerprint,
    }) + "\n",
  );
  await manifest.flush();

  console.log(`  +${Math.round(m.arriveAfterMs / 60000)}m  ${m.name}  ${m.family}  [${m.caps.join(",")}]  mandate=complete`);

  // Each agent is its own process running the unchanged harness — same brain,
  // same grammar, same prompt as the entry-baseline pilot and as the control.
  // Wave 3: a scheduled agent's harness is ended (WS close, not pause —
  // Amendment 1 A1.3) at its frozen disconnect tick and later respawned with
  // the SAME identity and token, continuing the tick sequence. The reconnect
  // exercises real backlog replay and ack-cursor semantics. What the agent
  // finds on return is whatever the world did while it was gone; the
  // "≥1 new public event during absence" condition is evaluated at analysis,
  // never by this scheduler.
  const dc = disconnects.find((d) => d.name === m.name);
  const firstSegment = dc ? dc.disconnect_at_tick : ticks;
  running.push(
    (async () => {
      await Bun.spawn(
        ["bun", "run", "apps/gateway/scripts/subject-harness.ts", agentId, agentToken, m.family, String(firstSegment), String(tickSeconds)],
        { env: { ...process.env, HARNESS_LOG: log, ECOLOGY_FINGERPRINT: fingerprintJson }, stdout: "ignore", stderr: "inherit" },
      ).exited;
      if (!dc) return;
      const absentMs = dc.absent_ticks * tickSeconds * 1000;
      console.log(`  ${m.name}: disconnected after tick ${dc.disconnect_at_tick} for ${dc.absent_ticks} ticks (frozen schedule)`);
      await sleep(absentMs);
      await Bun.spawn(
        [
          "bun", "run", "apps/gateway/scripts/subject-harness.ts",
          agentId, agentToken, m.family,
          String(ticks - dc.disconnect_at_tick), String(tickSeconds), String(dc.disconnect_at_tick + 1),
        ],
        { env: { ...process.env, HARNESS_LOG: log, ECOLOGY_FINGERPRINT: fingerprintJson }, stdout: "ignore", stderr: "inherit" },
      ).exited;
      console.log(`  ${m.name}: reconnected with same identity, resumed at tick ${dc.disconnect_at_tick + 1}`);
    })(),
  );
}

await manifest.end();
console.log(`\nall ${population.length} arrived; waiting for ticks to finish`);
await Promise.all(running);
console.log(`wave ${wave} complete — manifest ${manifestPath}`);
