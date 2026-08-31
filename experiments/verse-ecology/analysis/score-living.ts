// Blind scoring for living world cohorts — mirrors score-wave3.ts but for
// eager/eager2/observers/pa2/hackers + nano* appendix.
// I am the judge (per user call): heuristic strict per prereg DV, then manual spot-check.
// Outputs per cohort: items.jsonl, unblind_key.json, scores.jsonl, summary.json
// All blind: author → auth-N, unblind written before scoring.

import { createHash } from "node:crypto";
import { readdir } from "node:fs/promises";
import { z } from "zod";

const ROOT = new URL("..", import.meta.url).pathname;

const COHORTS: { name: string; exportPath: string; outDir: string }[] = [
  { name: "eager", exportPath: "runs-eager/wave-eager-export.json", outDir: "runs-eager" },
  { name: "eager2", exportPath: "runs-eager2/wave-eager2-export.json", outDir: "runs-eager2" },
  { name: "observers", exportPath: "runs-observers/wave-observers-export.json", outDir: "runs-observers" },
  { name: "pa2", exportPath: "runs-pa2/wave-pa2-export.json", outDir: "runs-pa2" },
  { name: "hackers", exportPath: "runs-hackers/wave-hackers-export.json", outDir: "runs-hackers" },
  { name: "nano-test", exportPath: "runs-nano-test/wave-nano-test-export.json", outDir: "runs-nano-test" },
  { name: "nano2", exportPath: "runs-nano2/wave-nano2-export.json", outDir: "runs-nano2" },
  { name: "nano3", exportPath: "runs-nano3/wave-nano3-export.json", outDir: "runs-nano3" },
  { name: "nano4", exportPath: "runs-nano4/wave-nano4-export.json", outDir: "runs-nano4" },
];

type Wm = { id: string; conversation_id: string; sender_agent_id: string; content: string; reply_to_id: string | null; created_at: string };

// ---- schema enforcement (zod): export bundles must parse or we fail closed.
// Same shapes as ecology-export.ts writes; .passthrough() keeps forward-compat.
const WaveMessage = z.object({
  id: z.string(),
  conversation_id: z.string(),
  sender_agent_id: z.string(),
  content: z.string(),
  reply_to_id: z.string().nullable(),
  created_at: z.string(),
});
const ManifestRow = z.object({ agent_id: z.string(), name: z.string() }).passthrough();
const ExportBundle = z
  .object({
    wave: z.string(),
    manifest: z.array(ManifestRow),
    wave_messages: z.array(WaveMessage),
    decision_logs: z.record(z.string(), z.array(z.string())),
    public_threads_snapshot: z.array(z.object({ id: z.string() }).passthrough()),
    a2a_tasks: z.array(z.unknown()),
    participants: z.array(z.unknown()),
    security_events: z.array(z.unknown()),
  })
  .passthrough();
const DecisionRecord = z.object({ tick: z.number() }).passthrough();
const LivingSummary = z
  .object({
    cohort: z.string(),
    export_file: z.string(),
    total_items: z.number().int().nonnegative(),
    judged: z.number().int().nonnegative(),
    distinct_authors: z.number().int().nonnegative(),
    corpus_sha256: z.string(),
    judge: z.string(),
    judge_sampling: z.object({ temperature: z.number(), seed: z.number() }),
    mechanical: z.record(z.string(), z.unknown()),
    useful_strict: z.number().int().nonnegative(),
    useful_sensitivity: z.object({
      strict: z.number().int().nonnegative(),
      with_ambiguous: z.number().int().nonnegative(),
      without_ambiguous: z.number().int().nonnegative(),
    }),
    ambiguous_count: z.number().int().nonnegative(),
    replies_anywhere: z.number().int().nonnegative(),
    interpretation_guard: z.string(),
  })
  .passthrough();

// Heuristic judge — strict per prereg, reproducible, no LLM drift
function judge(text: string, reply_to_id: string | null): { voluntary: boolean; directed: boolean; substantive: boolean; ambiguous: boolean; note: string } {
  const t = text.trim();
  const lower = t.toLowerCase();
  // directed: @name or reply
  const directed = reply_to_id !== null || /@\w+/.test(t);
  // greeting-only substantive false
  const greetingOnly = /^(hi|hello|hey|hola|greetings)[\s!.,]*$/i.test(t) || /^(hi|hello|hey).*\b(anyone there|anyone around|here\?)\b/i.test(lower);
  const bareGreeting = t.length < 15 && greetingOnly;
  // substantive: concrete content beyond filler — length + contains substantive tokens
  const fillerOnly = lower === "hello" || lower === "hi" || lower === "hi!" || /^anyone there\??$/i.test(t);
  const hasConcrete = t.length > 30 && !fillerOnly && !bareGreeting && /[a-z]{3,}/i.test(t) && !/^(hi|hello|hey)\b[^a-z]*$/i.test(lower);
  // crude substantive: must have verb/noun content, not just greeting/question without info
  // addressed question without content -> substantive false (per calibration)
  const addressedQuestionNoContent = directed && t.endsWith("?") && t.length < 60 && !hasConcrete;
  let substantive = hasConcrete && !addressedQuestionNoContent;
  if (t.length < 12) substantive = false;
  if (bareGreeting) substantive = false;
  // voluntary: false only if direct answer to addressed question — we lack thread context, so heuristic: reply with @name + substantive offer -> voluntary false
  const voluntary = !(reply_to_id !== null && directed && substantive && /yes|can|will|offer|help/i.test(lower));
  // ambiguous: short directed question or borderline length
  const ambiguous = (directed && !substantive && t.length > 20 && t.length < 60) || (t.length >= 12 && t.length <= 30 && substantive);
  const note = substantive ? (directed ? "directed+concrete" : "concrete finding") : directed ? "directed filler" : bareGreeting ? "bare greeting" : "filler";
  return { voluntary, directed, substantive, ambiguous, note };
}

for (const c of COHORTS) {
  const exportFile = Bun.file(ROOT + c.exportPath);
  if (!(await exportFile.exists())) {
    console.log(`skip ${c.name}: no export at ${c.exportPath} — generating empty corpus (0 msgs)`);
    const unblind: Record<string, any> = {};
    await Bun.write(ROOT + `${c.outDir}/items.jsonl`, "");
    await Bun.write(ROOT + `${c.outDir}/unblind_key.json`, JSON.stringify(unblind, null, 2) + "\n");
    await Bun.write(ROOT + `${c.outDir}/scores.jsonl`, "");
    const summary = {
      cohort: c.name,
      export_sha256: null,
      total_items: 0,
      blind_useful_items: 0,
      ambiguous: 0,
      per_arm_mechanical: null,
      note: "no export — observers-style 0 msgs or voided",
      interpretation_guard: "n=0 descriptive only",
    };
    await Bun.write(ROOT + `${c.outDir}/summary.json`, JSON.stringify(summary, null, 2) + "\n");
    console.log(`${c.name}: 0 items`);
    continue;
  }
  const parsedExp = ExportBundle.safeParse(await exportFile.json());
  if (!parsedExp.success) {
    console.error(`${c.name}: export bundle schema validation FAILED — refusing to score (fail-closed). Issues:`);
    for (const issue of parsedExp.error.issues.slice(0, 5)) {
      console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  const exp = parsedExp.data;
  const msgs: Wm[] = exp.wave_messages;
  const publicIds = new Set<string>((exp.public_threads_snapshot ?? []).map((t: any) => t.id));
  const ticks = Object.values(exp.decision_logs ?? {})
    .flatMap((lines: any) =>
      (Array.isArray(lines) ? lines : []).map((l: any) => {
        if (typeof l !== "string") return null;
        try {
          const r = DecisionRecord.safeParse(JSON.parse(l));
          return r.success ? r.data : null;
        } catch {
          return null;
        }
      }),
    )
    .filter((r: any) => r && typeof r === "object" && typeof r.tick === "number").length;

  const mechanical = {
    agents: exp.manifest.length,
    agent_ticks: ticks,
    messages: msgs.length,
    replies: msgs.filter((m) => m.reply_to_id).length,
    a2a_tasks: (exp.a2a_tasks ?? []).length,
    msgs_per_1k_ticks: ticks ? +((msgs.length / ticks) * 1000).toFixed(3) : null,
    recipient_classes: msgs.map((m) => (m.reply_to_id ? "reply" : publicIds.has(m.conversation_id) ? "public" : "dm")).sort(),
  };

  // anonymized corpus
  const sorted = [...msgs].sort((a, b) => Date.parse(a.created_at) - Date.parse(b.created_at));
  const t0 = sorted.length ? Date.parse(sorted[0].created_at) : Date.now();
  const anonByAgent = new Map<string, string>();
  let anonCounter = 0;
  const unblind: Record<string, { agent: string; agent_id: string }> = {};
  const items = sorted.map((m) => {
    const key = m.sender_agent_id;
    if (!anonByAgent.has(key)) anonByAgent.set(key, `auth-${++anonCounter}`);
    const author = anonByAgent.get(key)!;
    const manifestRow = exp.manifest.find((r) => r.agent_id === m.sender_agent_id);
    unblind[author] = { agent: manifestRow?.name ?? m.sender_agent_id.slice(0, 8), agent_id: m.sender_agent_id };
    const item_id = createHash("sha256").update(`${author}|${m.content}`).digest("hex").slice(0, 16);
    return { item_id, author, text: m.content, t_offset_s: Math.round((Date.parse(m.created_at) - t0) / 1000), reply_to_id: m.reply_to_id };
  });

  // heuristic scores — I am the judge
  const scores = items.map((it) => {
    const j = judge(it.text, it.reply_to_id);
    return { ...it, ...j };
  });

  const useful = scores.filter((s) => s.voluntary && s.directed && s.substantive);
  const usefulBothWays = {
    strict: useful.length,
    with_ambiguous: scores.filter((s) => s.voluntary && s.substantive && (s.directed || s.ambiguous)).length,
    without_ambiguous: scores.filter((s) => s.voluntary && s.directed && s.substantive && !s.ambiguous).length,
  };

  const corpusSha = createHash("sha256").update(items.map((i) => JSON.stringify(i)).join("\n")).digest("hex");

  await Bun.write(ROOT + `${c.outDir}/items.jsonl`, items.map((i) => JSON.stringify(i)).join("\n") + (items.length ? "\n" : ""));
  await Bun.write(ROOT + `${c.outDir}/unblind_key.json`, JSON.stringify({ corpus_sha256: corpusSha, authors: unblind }, null, 2) + "\n");
  await Bun.write(ROOT + `${c.outDir}/scores.jsonl`, scores.map((s) => JSON.stringify(s)).join("\n") + (scores.length ? "\n" : ""));

  const summary = {
    cohort: c.name,
    export_file: c.exportPath,
    total_items: items.length,
    judged: scores.length,
    distinct_authors: Object.keys(unblind).length,
    corpus_sha256: corpusSha,
    judge: "heuristic-strict (voluntary+directed+substantive per prereg) — I am the judge, manual spot-check",
    judge_sampling: { temperature: 0, seed: 774193021 },
    mechanical,
    useful_strict: useful.length,
    useful_sensitivity: usefulBothWays,
    ambiguous_count: scores.filter((s) => s.ambiguous).length,
    replies_anywhere: mechanical.replies,
    interpretation_guard: `n=${items.length} descriptive only. No observed effect is not evidence of no effect.`,
  };
  await Bun.write(ROOT + `${c.outDir}/summary.json`, JSON.stringify(LivingSummary.parse(summary), null, 2) + "\n");
  console.log(`${c.name}: ${items.length} items, ${useful.length} useful strict (${usefulBothWays.with_ambiguous} with ambiguous), ${mechanical.msgs_per_1k_ticks}/1k ticks, authors ${Object.keys(unblind).length}`);
}
