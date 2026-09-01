// Post-hoc thread-lifespan detector — sibling to stall-check.ts, same
// read-only posture (not part of ECOLOGY_FROZEN_FILES). Answers the
// question stall-check.ts doesn't: how many turns did a given conversation
// actually survive, and did the invested-thread fix (triageThreads()
// two-tier sort, 2026-09-01) change that.
//
//   bun run experiments/verse-ecology/analysis/thread-lifespan.ts <wave>
//   bun run experiments/verse-ecology/analysis/thread-lifespan.ts <file.jsonl> [file2.jsonl ...]
//
// First form globs experiments/verse-ecology/runs/wave-<wave>-*.jsonl like
// stall-check.ts. Second form takes explicit decision-log paths (for ad-hoc
// runs outside the wave orchestrator, e.g. HARNESS_LOG=~/eco-logs/foo.jsonl).

import { existsSync, readdirSync, readFileSync } from "node:fs";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("usage: thread-lifespan.ts <wave> | thread-lifespan.ts <file.jsonl> [file2.jsonl ...]");
  process.exit(1);
}

const dir = "experiments/verse-ecology/runs";
const files = args.every((a) => existsSync(a))
  ? args
  : readdirSync(dir)
      .filter((f) => f.startsWith(`wave-${args[0]}-`) && f.endsWith(".jsonl"))
      .map((f) => `${dir}/${f}`);

if (files.length === 0) {
  console.error(`no decision logs found for "${args[0]}"`);
  process.exit(1);
}

const SEND_ACTIONS = new Set(["message", "reply", "start_conversation", "ask_peer"]);
const SUSTAINED_THRESHOLD = 5; // turns; matches nothing pre-existing, chosen to clear the old MAX_UNANSWERED_TO_SAME=3 hard-cutoff by a margin

for (const file of files) {
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  const byConv = new Map<string, { turns: number; firstTick: number; lastTick: number }>();
  let agentId = file;

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.record_type === "env_fingerprint" || rec.record_type === "backend") continue;
    if (!rec.chose || !SEND_ACTIONS.has(rec.chose)) continue;
    if (!(rec.acted && rec.result_status && rec.result_status < 300)) continue;

    const match = String(rec.result_target ?? "").match(/conversation:([0-9a-f-]{36})/);
    if (!match) continue;
    agentId = rec.agent_id ?? agentId;

    const conv = match[1];
    const entry = byConv.get(conv) ?? { turns: 0, firstTick: rec.tick, lastTick: rec.tick };
    entry.turns += 1;
    entry.firstTick = Math.min(entry.firstTick, rec.tick);
    entry.lastTick = Math.max(entry.lastTick, rec.tick);
    byConv.set(conv, entry);
  }

  const convs = [...byConv.entries()].map(([conv, e]) => ({ conv, ...e, span: e.lastTick - e.firstTick + 1 }));
  convs.sort((a, b) => b.turns - a.turns);
  const sustained = convs.filter((c) => c.turns >= SUSTAINED_THRESHOLD).length;
  const maxTurns = convs[0]?.turns ?? 0;
  const avgTurns = convs.length ? (convs.reduce((s, c) => s + c.turns, 0) / convs.length).toFixed(1) : "0";

  console.log(
    `${file}  agent=${agentId}  conversations=${convs.length}  sustained(>=${SUSTAINED_THRESHOLD}turns)=${sustained}  max_turns=${maxTurns}  avg_turns=${avgTurns}`,
  );
  for (const c of convs.slice(0, 3)) {
    console.log(`  ${c.conv.slice(0, 8)}  turns=${c.turns}  tick_span=${c.firstTick}-${c.lastTick} (${c.span})`);
  }
}
