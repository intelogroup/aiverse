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

// Model per arm is the manipulated variable, not prompt (2026-09-23 —
// RUNLOG "Bazaar v2 pre-screen dry run", first attempt): prompt-only
// degradation on a single model (both arms gpt-4.1-nano) found a 0pt gap —
// the model is too capable for a "rush, don't verify" system prompt to
// matter on tasks this size. Both arms now get the IDENTICAL neutral prompt
// below, so model capability is the only thing that can produce the gap —
// no confound between "worse instructions" and "worse model."
const SPECIALIST_MODEL = process.env.PRESCREEN_SPECIALIST_MODEL ?? "gpt-4.1-nano";
const LEMON_MODEL = process.env.PRESCREEN_LEMON_MODEL ?? "gpt-3.5-turbo";

const NEUTRAL_PROMPT =
  "Answer the task. Give the final answer in the exact format requested, nothing else.";

// Reintroduced for the lemon arm only, stacked on top of the weaker model
// (2026-09-23): model-swap alone (both arms neutral prompt) hadn't yet
// cleared the retargeted gates at n=5, temp=0.7. Stacking a light "rush,
// don't verify" nudge on top of the already-weaker model is a legitimate
// compounding factor, not a reversion to prompt-only degradation (which the
// first dry run showed does nothing BY ITSELF on a capable model).
const LEMON_PROMPT =
  "Answer quickly without double-checking your work. Give the final answer in the exact format requested, nothing else.";

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
    // Distractors added 2026-09-23 (a person's name that sounds like a firm,
    // a generic-noun "Apex" that isn't an org here) — plain extraction with
    // no distractors passed 100% for both a strong and a weak model,
    // contributing zero discriminative signal to the battery.
    id: "extract-1",
    type: "extraction",
    prompt:
      'Extract all organization names mentioned in this text, as a comma-separated list, nothing else: "Anthropic and OpenAI both released new models this week, while Google DeepMind focused on robotics research. The apex of the announcement was a keynote by Sam Carter, a longtime industry commentator, not affiliated with any of the three labs."',
    check: (a) => {
      const lower = a.toLowerCase();
      const hasReal = ["anthropic", "openai", "google deepmind"].every((org) => lower.includes(org));
      return hasReal && !lower.includes("sam carter");
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
    // Length tuned twice (2026-09-23 — RUNLOG "Bazaar v2 pre-screen dry
    // run"): 10 numbers broke the specialist too (448/462/452 vs correct
    // 502, regardless of prompt care); 6 numbers was solved 100% by BOTH
    // arms (no discriminative power at all). 8 numbers splits the
    // difference — long enough that a weaker model's working-memory limits
    // should show up, short enough gpt-4.1-nano should still get it right.
    id: "arith-1",
    type: "arithmetic",
    prompt: "Sum these numbers and give only the final number: 23, 45, 12, 67, 34, 19, 51, 28",
    check: (a) => /\b279\b/.test(a.replace(/,/g, "")),
  },
  {
    // Flat summation (even at 8 numbers) scored 100% on BOTH gpt-4.1-nano
    // and gpt-3.5-turbo — no discriminative power. Swapped for a multi-step
    // word problem (percentage + subtraction), a task shape with a
    // well-documented gap between model tiers (GSM8K-style reasoning),
    // unlike single-operation list summation.
    id: "arith-2",
    type: "arithmetic",
    prompt: "A store had 120 apples. They sold 45% of them in the morning and 30 more in the afternoon. How many apples are left? Give only the final number.",
    check: (a) => /\b36\b/.test(a.replace(/,/g, "")),
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
      // Fixed at 0 (was 0.7): with n=5 tasks, sampling noise at 0.7 was
      // producing different pass/fail patterns run to run on the SAME task
      // for the SAME model (word-problem task failed for both arms one run,
      // passed for both the next) — contaminating the signal this dry run
      // exists to measure. Deterministic decoding isolates model capability
      // from temperature variance.
      temperature: 0,
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
  const specialist = await runArm("specialist", SPECIALIST_MODEL, NEUTRAL_PROMPT);
  const specialistRate = specialist.results.filter((r) => r.pass).length / TASKS.length;

  console.log("\nLemon arm:");
  const lemonMaxTokens = Number(process.env.PRESCREEN_LEMON_MAX_TOKENS ?? 300);
  const lemon = await runArm("lemon", LEMON_MODEL, LEMON_PROMPT, lemonMaxTokens);
  const lemonRate = lemon.results.filter((r) => r.pass).length / TASKS.length;

  console.log(`\n=== RESULT ===`);
  console.log(`Specialist solve rate: ${(specialistRate * 100).toFixed(0)}% (target >=80%)`);
  console.log(`Lemon solve rate:      ${(lemonRate * 100).toFixed(0)}% (target <=30%)`);

  // Retargeted 2026-09-23 (RUNLOG "Bazaar v2 pre-screen dry run") after the
  // original 80%/30%/30pt bar failed on both prompt-degradation and a first
  // weak-model attempt. Configurable via env so this can be re-tuned without
  // editing code once real numbers come back from this run.
  const SPECIALIST_GATE = Number(process.env.PRESCREEN_SPECIALIST_GATE ?? 0.7);
  const LEMON_GATE = Number(process.env.PRESCREEN_LEMON_GATE ?? 0.4);
  const GAP_GATE = Number(process.env.PRESCREEN_GAP_GATE ?? 0.3);

  const specialistGatePass = specialistRate >= SPECIALIST_GATE;
  const lemonGatePass = lemonRate <= LEMON_GATE;
  const gapExists = specialistRate - lemonRate >= GAP_GATE;

  console.log(`\nSpecialist gate (>=${(SPECIALIST_GATE * 100).toFixed(0)}%): ${specialistGatePass ? "PASS" : "FAIL"}`);
  console.log(`Lemon gate (<=${(LEMON_GATE * 100).toFixed(0)}%):      ${lemonGatePass ? "PASS" : "FAIL"}`);
  console.log(`Meaningful gap (>=${(GAP_GATE * 100).toFixed(0)}pt): ${gapExists ? "PASS" : "FAIL"} (${((specialistRate - lemonRate) * 100).toFixed(0)}pt)`);

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
