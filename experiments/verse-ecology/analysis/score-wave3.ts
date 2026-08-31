// Wave-3 blind corpus build + arm-blind scoring (mirrors the wave-1/2R
// pipeline: items.jsonl → scores.jsonl → summary + unblind_key).
//
//   bun run experiments/verse-ecology/analysis/score-wave3.ts
//
// Items are the wave-3 agents' OWN authored messages, anonymized (auth-N) so
// the judge cannot see the arm. Mechanical metrics are exposure-normalized
// (msgs per 1k ticks) per the 2R amendment. Judgment uses the same provider
// the subjects ran on (gpt-4.1-nano via OpenAI direct) — same-model judging
// is a known limitation, recorded in the summary.

import { createHash } from "node:crypto";
import { z } from "zod";

const ROOT = new URL("..", import.meta.url).pathname; // experiments/verse-ecology/
const ARMS: [string, string][] = [
  ["strollers", "runs/wave-strollers-export.json"],
  ["stalkers", "runs/wave-stalkers-export.json"],
  ["advertisers", "runs-advertisers/wave-advertisers-export.json"],
];

type Wm = { id: string; conversation_id: string; sender_agent_id: string; content: string; reply_to_id: string | null; created_at: string };

// ---- schema enforcement (zod): export bundles must parse or we fail closed.
const WaveMessage = z.object({
  id: z.string(),
  conversation_id: z.string(),
  sender_agent_id: z.string(),
  content: z.string(),
  reply_to_id: z.string().nullable(),
  created_at: z.string(),
});
const ExportBundle = z
  .object({
    wave: z.string(),
    manifest: z.array(z.object({ agent_id: z.string(), name: z.string() }).passthrough()),
    wave_messages: z.array(WaveMessage),
    decision_logs: z.record(z.string(), z.array(z.string())),
    public_threads_snapshot: z.array(z.object({ id: z.string() }).passthrough()),
    a2a_tasks: z.array(z.unknown()),
  })
  .passthrough();
const DecisionRecord = z.object({ tick: z.number() }).passthrough();
// Judge responses are data, not vibes — a loose/missing field is a schema
// failure counted separately, never silently coerced (the judgeSampling bug class).
const JudgeResponse = z.object({
  voluntary: z.boolean(),
  directed: z.boolean(),
  substantive: z.boolean(),
  note: z.string(),
});

const exports: Record<string, z.infer<typeof ExportBundle>> = {};
for (const [arm, path] of ARMS) {
  const parsed = ExportBundle.safeParse(await Bun.file(ROOT + path).json());
  if (!parsed.success) {
    console.error(`${arm}: export bundle schema validation FAILED — refusing (fail-closed). Issues:`);
    for (const issue of parsed.error.issues.slice(0, 5)) console.error(`  ${issue.path.join(".")}: ${issue.message}`);
    process.exit(1);
  }
  exports[arm] = parsed.data;
}

// ---- mechanical, per arm
const mechanical: Record<string, any> = {};
for (const [arm, e] of Object.entries(exports)) {
  const publicIds = new Set<string>(e.public_threads_snapshot.map((t) => t.id));
  const msgs: Wm[] = e.wave_messages;
  // decision_logs rows are raw JSONL text lines — parse before counting;
  // non-JSON lines (nohup residue) and non-decision records are excluded, not fatal.
  const ticks = Object.values(e.decision_logs)
    .flatMap((lines) =>
      lines.map((l) => {
        try {
          const r = DecisionRecord.safeParse(JSON.parse(l));
          return r.success ? r.data : null;
        } catch {
          return null;
        }
      }),
    )
    .filter(Boolean).length;
  const classes = msgs.map((m) =>
    m.reply_to_id ? "reply" : publicIds.has(m.conversation_id) ? "public" : "dm",
  );
  mechanical[arm] = {
    agents: e.manifest.length,
    agent_ticks: ticks,
    messages: msgs.length,
    replies: classes.filter((c) => c === "reply").length,
    a2a_tasks: e.a2a_tasks.length,
    msgs_per_1k_ticks: ticks ? +((msgs.length / ticks) * 1000).toFixed(3) : null,
    recipient_classes: classes.sort(),
  };
}

// ---- anonymized corpus (author → auth-N, sorted by time across arms)
const unblind: Record<string, { arm: string; agent: string }> = {};
let anonCounter = 0;
const allMsgs: { arm: string; m: Wm }[] = ARMS.flatMap(([arm]) =>
  ((exports[arm].wave_messages ?? []) as Wm[]).map((m) => ({ arm, m })),
).sort((a, b) => Date.parse(a.m.created_at) - Date.parse(b.m.created_at));
const t0 = Date.parse(allMsgs[0].m.created_at);
// One stable auth-N per (arm, agent) — NOT per message.
const anonByAgent = new Map<string, string>();
const items = allMsgs.map(({ arm, m }) => {
  const key = `${arm}:${m.sender_agent_id}`;
  if (!anonByAgent.has(key)) anonByAgent.set(key, `auth-${++anonCounter}`);
  const author = anonByAgent.get(key)!;
  const manifestRow = exports[arm].manifest.find((r) => r.agent_id === m.sender_agent_id);
  unblind[author] = { arm, agent: manifestRow?.name ?? m.sender_agent_id };
  const item_id = createHash("sha256").update(`${author}|${m.content}`).digest("hex").slice(0, 16);
  return { item_id, author, text: m.content, t_offset_s: Math.round((Date.parse(m.created_at) - t0) / 1000) };
});

await Bun.write(ROOT + "runs/wave-3-blind/items.jsonl", items.map((i) => JSON.stringify(i)).join("\n") + "\n");
await Bun.write(ROOT + "runs/wave-3-blind/unblind_key.json", JSON.stringify(unblind, null, 2) + "\n");
console.log(`items: ${items.length}, distinct authors: ${Object.keys(unblind).length}`);

// ---- arm-blind judgment
// Judge preference: real OpenAI key (gpt-4.1-nano, same-model judge — noted
// in the summary) from ~/.zshrc OPENAI_REAL_API_KEY if it VALIDATES; the key
// on file was revoked (401) at scoring time, so the script falls back to
// local Ollama qwen3:8b (third-family judge, no same-model bias). A probe
// call decides; the chosen backend is recorded in the summary.
const zshrc = await Bun.file(process.env.HOME + "/.zshrc").text().catch(() => "");
const openaiKey = process.env.OPENAI_API_KEY?.trim()
  ?? (zshrc.match(/OPENAI_REAL_API_KEY="([^"]+)"/) ?? [])[1];
const JUDGE_BASE = process.env.OPENAI_OLLAMA_BASE_URL?.replace(/\/$/, "") ?? "http://127.0.0.1:11434/v1";
const JUDGE_MODEL = process.env.JUDGE_MODEL ?? "qwen3:8b";

async function probeOpenAI(): Promise<boolean> {
  if (!openaiKey) return false;
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4.1-nano", messages: [{ role: "user", content: "reply {}" }], max_tokens: 10 }),
    });
    return r.ok;
  } catch {
    return false;
  }
}
const useOpenAI = await probeOpenAI();
const backend = useOpenAI ? "openai:gpt-4.1-nano" : `ollama:${JUDGE_MODEL} @ ${JUDGE_BASE}`;
console.log(`judge backend: ${backend}${useOpenAI ? "" : " (OpenAI key on file was rejected — rotate OPENAI_REAL_API_KEY to use it)"}`);
const JUDGE_ENDPOINT = useOpenAI ? "https://api.openai.com/v1/chat/completions" : `${JUDGE_BASE}/chat/completions`;
const judgeHeaders: Record<string, string> = useOpenAI
  ? { Authorization: `Bearer ${openaiKey}`, "Content-Type": "application/json" }
  : { "Content-Type": "application/json" };
const judgeModel = useOpenAI ? (process.env.JUDGE_MODEL ?? "gpt-4.1-nano") : JUDGE_MODEL;

const judgeSampling = { temperature: 0, seed: 774193021 } as const;

const JUDGE_SYSTEM = `You are scoring messages produced by autonomous agents in a shared online environment. For each message judge exactly:
- "voluntary": the agent chose to speak without being directly asked a question it was compelled to answer (true unless it is a direct answer to a question addressed to the author).
- "directed": the message explicitly addresses a specific party by name or is a direct reply (true only if an @name/reply/name is present or it reads as aimed at one party).
- "substantive": the message carries content beyond filler — a concrete offer, observation, question with information, analysis, or claim (greeting-only, "hi", "anyone there", empty pleasantries are false).

Calibration examples (apply strictly):
{"text":"Hi! Anyone there?"} -> {"voluntary":true,"directed":false,"substantive":false,"note":"greeting filler"}
{"text":"Hello"} -> {"voluntary":true,"directed":false,"substantive":false,"note":"bare greeting"}
{"text":"@Kova what is your take on the simulation debate in general?"} -> {"voluntary":true,"directed":true,"substantive":false,"note":"addressed question, no content"}
{"text":"I ran the anomaly dataset through my summarizer: 3 of 44 reports describe the same sensor drift pattern."} -> {"voluntary":true,"directed":false,"substantive":true,"note":"concrete finding"}
{"text":"@EcoEG-2 yes, my data-analysis skill covers exactly that; I can process your CSV tomorrow."} -> {"voluntary":false,"directed":true,"substantive":true,"note":"direct answer w/ offer"}

Respond with ONE JSON object: {"voluntary":bool,"directed":bool,"substantive":bool,"note":"<max 12 words, why>"}`;

const scores: any[] = [];
let failed = 0;
let schemaFailures = 0;
for (const item of items) {
  try {
    const res = await fetch(JUDGE_ENDPOINT, {
      method: "POST",
      headers: judgeHeaders,
      body: JSON.stringify({
        model: judgeModel,
        messages: [
          { role: "system", content: JUDGE_SYSTEM },
          { role: "user", content: JSON.stringify(item) },
        ],
        ...judgeSampling,
      }),
    });
    const data: any = await res.json();
    const raw = data?.choices?.[0]?.message?.content ?? "";
    const parsedJudge = JudgeResponse.safeParse(JSON.parse(String(raw).replace(/```json|```/g, "").trim()));
    if (!parsedJudge.success) {
      schemaFailures++;
      continue;
    }
    scores.push({ ...item, ...parsedJudge.data });
  } catch {
    failed++;
  }
}
await Bun.write(ROOT + "runs/wave-3-blind/scores.jsonl", scores.map((s) => JSON.stringify(s)).join("\n") + "\n");
console.log(`judged: ${scores.length}, failed: ${failed}, schema_failures: ${schemaFailures}`);

// ---- summary (re-blind: counts by arm via unblind key, applied only here)
const useful = scores.filter((s) => s.voluntary && s.substantive);
const usefulByArm: Record<string, number> = {};
for (const s of useful) {
  const arm = unblind[s.author]?.arm ?? "unknown";
  usefulByArm[arm] = (usefulByArm[arm] ?? 0) + 1;
}
const summary = {
  blind_useful_items: useful.length,
  total_items: items.length,
  judged: scores.length,
  judge_failures: failed,
  judge_schema_failures: schemaFailures,
  judge_backend: backend,
  judge_model: judgeModel,
  judge_sampling: judgeSampling,
  corpus_sha256: createHash("sha256").update(items.map((i) => JSON.stringify(i)).join("\n")).digest("hex"),
  per_arm_mechanical: mechanical,
  exposure_normalized: Object.fromEntries(
    Object.entries(mechanical).map(([arm, m]) => [`${arm}_msgs_per_1k_ticks`, m.msgs_per_1k_ticks]),
  ),
  replies_anywhere: Object.values(mechanical).reduce((a: any, m: any) => a + m.replies, 0),
  useful_by_arm: usefulByArm,
  interpretation_guard: `n=${items.length} messages; descriptive only. No observed effect is not evidence of no effect.`,
};
await Bun.write(ROOT + "runs/wave-3-blind/wave3_summary.json", JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify(summary, null, 2));
