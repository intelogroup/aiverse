// Post-hoc stall detector for a wave's decision logs — not part of the frozen
// apparatus (ECOLOGY_FROZEN_FILES), purely observational. Answers the question
// the archetypes run raised manually: did an agent keep repeating the same
// action while an actionable inbound message sat unanswered?
//
//   bun run experiments/verse-ecology/analysis/stall-check.ts <wave>
//
// Reads experiments/verse-ecology/runs/wave-<wave>-*.jsonl (skips the
// env_fingerprint header line each file starts with).

import { readdirSync, readFileSync } from "node:fs";

const wave = process.argv[2];
if (!wave) {
  console.error("usage: stall-check.ts <wave>");
  process.exit(1);
}

const dir = "experiments/verse-ecology/runs";
const files = readdirSync(dir).filter((f) => f.startsWith(`wave-${wave}-`) && f.endsWith(".jsonl"));
if (files.length === 0) {
  console.error(`no decision logs found for wave ${wave} in ${dir}`);
  process.exit(1);
}

for (const file of files) {
  const lines = readFileSync(`${dir}/${file}`, "utf8").trim().split("\n").filter(Boolean);
  let maxStreak = 0;
  let curStreak = 0;
  let curAction: string | null = null;
  let sent = 0;
  const chosen: Record<string, number> = {};
  let name = file;

  for (const line of lines) {
    let rec: any;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (rec.record_type === "env_fingerprint" || rec.record_type === "backend") continue;
    if (!rec.chose) continue;

    name = rec.agent_id ?? name;
    chosen[rec.chose] = (chosen[rec.chose] ?? 0) + 1;
    if (rec.acted && rec.result_status && rec.result_status < 300 && (rec.chose === "reply" || rec.chose === "start_conversation")) sent += 1;

    const hasInbound = (rec.opportunities?.conversations_with_inbound ?? 0) > 0;
    if (hasInbound && rec.chose === curAction) {
      curStreak += 1;
    } else if (hasInbound) {
      curAction = rec.chose;
      curStreak = 1;
    } else {
      curAction = null;
      curStreak = 0;
    }
    maxStreak = Math.max(maxStreak, curStreak);
  }

  console.log(
    `${file}  ticks=${lines.length - 1}  sent=${sent}  max_stall_streak=${maxStreak}  actions=${JSON.stringify(chosen)}`,
  );
}
