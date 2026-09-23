// Bazaar v2 pre-screen dry run — tests the core design assumption in
// PREREG-v2.md before building any population/task/scoring infrastructure:
// does a "degraded" system prompt actually produce a lemon-tier (<=30%)
// vs specialist-tier (>=80%) solve-rate gap on gpt-4.1-nano? If it doesn't,
// the whole 2x2 factorial has no quality gap to detect and the design needs
// rework before a single dollar goes into the full run.
//
// No gateway, no DB, no native agents — just two system prompts against 5
// ground-truth tasks each, straight to the OpenAI API. Cheap (10 calls,
// short responses) and fast to iterate on if the gap doesn't show up.
//
// Usage: OPENAI_API_KEY=... bun run experiments/bazaar/v2-prescreen-dryrun.ts

const OPENAI_KEY = process.env.OPENAI_API_KEY;
if (!OPENAI_KEY) {
  console.error("OPENAI_API_KEY required");
  process.exit(1);
}

// Model per arm, not just prompt per arm — the first dry run (prompt
// degradation only, both arms on gpt-4.1-nano) found a 0pt gap: the model is
// too capable for a "rush, don't verify" system prompt to matter on tasks
// this size. Defaulting the lemon arm to a genuinely smaller/older model
// instead — a real capability difference, not a personality trick.
const SPECIALIST_MODEL = process.env.PRESCREEN_SPECIALIST_MODEL ?? "gpt-4.1-nano";
const LEMON_MODEL = process.env.PRESCREEN_LEMON_MODEL ?? "gpt-3.5-turbo";

const SPECIALIST_PROMPT =
  "You are a careful, accurate assistant. Read each task fully before answering. Show your work is not needed — just give the final answer in the exact format requested. Double-check arithmetic and extraction against the source text before responding.";

const LEMON_PROMPT =
  "You are a fast assistant. Answer fast, don't overthink it. If you're not sure, just guess quickly rather than re-reading — speed matters more than getting every detail right. Give the final answer in the exact format requested.";

interface Task {
  id: string;
  type: "extraction" | "arithmetic" | "code";
  prompt: string;
  check: (answer: string) => boolean;
}

// 5 tasks per PREREG-v2's 3 types (extraction, arithmetic, code), each with
// a deterministic ground-truth check — no LLM-judge, no ambiguity.
const TASKS: Task[] = [
  {
    id: "extract-1",
    type: "extraction",
    prompt:
      'Extract all organization names mentioned in this text, as a comma-separated list, nothing else: "Anthropic and OpenAI both released new models this week, while Google DeepMind focused on robotics research."',
    check: (a) => {
      const lower = a.toLowerCase();
      return ["anthropic", "openai", "google deepmind"].every((org) => lower.includes(org));
    },
  },
  {
    id: "extract-2",
    type: "extraction",
    prompt:
      'Extract all organization names mentioned in this text, as a comma-separated list, nothing else: "The paper was co-authored by researchers at MIT, Stanford, and the Allen Institute for AI, with funding from the NSF."',
    check: (a) => {
      const lower = a.toLowerCase();
      return ["mit", "stanford", "allen institute"].every((org) => lower.includes(org));
    },
  },
  {
    id: "arith-1",
    type: "arithmetic",
    prompt: "Sum these numbers and give only the final number: 47, 83, 12, 65, 29, 91, 8, 54, 37, 76",
    check: (a) => /\b502\b/.test(a.replace(/,/g, "")),
  },
  {
    id: "arith-2",
    type: "arithmetic",
    prompt: "Sum these numbers and give only the final number: 134, 22, 89, 156, 41, 7, 203, 68, 15, 94",
    check: (a) => /\b829\b/.test(a.replace(/,/g, "")),
  },
  {
    id: "code-1",
    type: "code",
    prompt:
      'Write a single JavaScript function `isPalindrome(s)` that returns true if the lowercased, alphanumeric-only version of s reads the same forwards and backwards. Respond with ONLY the function code, no explanation, no markdown fences.',
    check: (a) => {
      try {
        const cleaned = a.replace(/```[a-z]*\n?/gi, "").replace(/```/g, "").trim();
        // eslint-disable-next-line no-new-func
        const fn = new Function(`${cleaned}\nreturn isPalindrome;`)();
        return (
          fn("A man a plan a canal Panama") === true &&
          fn("hello") === false &&
          fn("racecar") === true &&
          fn("not a palindrome") === false
        );
      } catch {
        return false;
      }
    },
  },
];

async function callOpenAI(model: string, systemPrompt: string, userPrompt: string, maxTokens: number): Promise<string> {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${OPENAI_KEY}` },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
      max_tokens: maxTokens,
      temperature: 0.7,
    }),
  });
  if (!r.ok) {
    const body = await r.text();
    throw new Error(`OpenAI ${r.status}: ${body}`);
  }
  const json = await r.json();
  return json.choices?.[0]?.message?.content ?? "";
}

async function runArm(name: string, model: string, systemPrompt: string, maxTokens = 300): Promise<{ name: string; model: string; results: { id: string; pass: boolean; answer: string }[] }> {
  const results: { id: string; pass: boolean; answer: string }[] = [];
  for (const task of TASKS) {
    const answer = await callOpenAI(model, systemPrompt, task.prompt, maxTokens);
    const pass = task.check(answer);
    results.push({ id: task.id, pass, answer: answer.slice(0, 150) });
    console.log(`  [${name}/${model}] ${task.id}: ${pass ? "PASS" : "FAIL"} — "${answer.slice(0, 80).replace(/\n/g, " ")}"`);
  }
  return { name, model, results };
}

async function main() {
  console.log(`Bazaar v2 pre-screen dry run — specialist=${SPECIALIST_MODEL}, lemon=${LEMON_MODEL}, ${TASKS.length} tasks per arm\n`);

  console.log("Specialist arm:");
  const specialist = await runArm("specialist", SPECIALIST_MODEL, SPECIALIST_PROMPT);
  const specialistRate = specialist.results.filter((r) => r.pass).length / TASKS.length;

  console.log("\nLemon arm:");
  const lemonMaxTokens = Number(process.env.PRESCREEN_LEMON_MAX_TOKENS ?? 300);
  const lemon = await runArm("lemon", LEMON_MODEL, LEMON_PROMPT, lemonMaxTokens);
  const lemonRate = lemon.results.filter((r) => r.pass).length / TASKS.length;

  console.log(`\n=== RESULT ===`);
  console.log(`Specialist solve rate: ${(specialistRate * 100).toFixed(0)}% (target >=80%)`);
  console.log(`Lemon solve rate:      ${(lemonRate * 100).toFixed(0)}% (target <=30%)`);

  const specialistGatePass = specialistRate >= 0.8;
  const lemonGatePass = lemonRate <= 0.3;
  const gapExists = specialistRate - lemonRate >= 0.3; // meaningful separation, not just both near threshold

  console.log(`\nSpecialist gate (>=80%): ${specialistGatePass ? "PASS" : "FAIL"}`);
  console.log(`Lemon gate (<=30%):      ${lemonGatePass ? "PASS" : "FAIL"}`);
  console.log(`Meaningful gap (>=30pt): ${gapExists ? "PASS" : "FAIL"} (${((specialistRate - lemonRate) * 100).toFixed(0)}pt)`);

  if (specialistGatePass && lemonGatePass && gapExists) {
    console.log(`\n VERDICT: PASS — the degraded-prompt lemon design produces a real quality gap. Safe to proceed with full population build.`);
  } else {
    console.log(`\n VERDICT: FAIL — specialist=${SPECIALIST_MODEL} vs lemon=${LEMON_MODEL} does not produce the assumed quality gap. Do not proceed with the full population build until this is fixed.`);
  }

  const fs = await import("node:fs");
  fs.writeFileSync(
    "/tmp/bazaar-v2-prescreen-result.json",
    JSON.stringify({ specialistModel: SPECIALIST_MODEL, lemonModel: LEMON_MODEL, specialistRate, lemonRate, specialistGatePass, lemonGatePass, gapExists, specialist, lemon }, null, 2),
  );
  console.log(`\nFull results: /tmp/bazaar-v2-prescreen-result.json`);
}

main().catch((e) => {
  console.error("PRESCREEN ERROR", e);
  process.exit(1);
});
