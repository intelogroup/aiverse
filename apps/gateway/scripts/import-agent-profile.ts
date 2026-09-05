// Import an external agent's system prompt + memory into a new Verse agent,
// as compressed as AIVerse's own schema already demands: agentMandates
// deliberately isn't a system-prompt replay ("objectives... NOT goals," see
// packages/shared/src/schema.ts), and personalityPrompt is a private free-
// text field. This script maps an external agent's persona onto those two
// slots instead of leaving it to manual, per-agent, ad hoc owner authorship.
//
// Model family is untouched by this script and comes from the same
// owner-approved roster every other authing script uses (no Claude,
// AGENTS.md rule 15) — this only imports PERSONA, never picks a model.
//
// Usage:
//   bun run apps/gateway/scripts/import-agent-profile.ts <profile.json>
//
// profile.json shape:
//   { "name": "...", "systemPrompt": "...", "memoryNotes": ["...", ...] }

import { OpenRouterProvider } from "../src/llm/provider";

const GATEWAY = process.env.GATEWAY_HTTP_URL ?? "http://localhost:3010";
const OWNER_EMAIL = process.env.IMPORT_OWNER_EMAIL ?? "import-owner@example.com";
const OWNER_PASSWORD = process.env.IMPORT_OWNER_PASSWORD ?? "password123";

interface ExternalProfile {
  name: string;
  systemPrompt: string;
  memoryNotes: string[];
}

interface CompressedProfile {
  objectives: string[];
  personalityPrompt: string;
  preferences: Record<string, unknown>;
}

async function jsonFetch(url: string, init: RequestInit) {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`${init.method ?? "GET"} ${url} -> ${res.status}: ${await res.text()}`);
  return res.json();
}

// LLM summarization is best-effort: if no OPENROUTER_API_KEY (or every model
// in the roster fails), fall back to a plain heuristic so this script never
// blocks an import on provider availability, same guarantee provider.ts
// already gives native agents.
async function compress(profile: ExternalProfile): Promise<CompressedProfile> {
  const provider = new OpenRouterProvider();
  const result = await provider.complete({
    system:
      "Compress an external AI agent's system prompt and memory notes into JSON: " +
      '{"objectives": string[] (2-4 standing-want sentences the agent should pursue, NOT tasks), ' +
      '"personalityPrompt": string (one paragraph describing the agent\'s persona/style), ' +
      '"preferences": {"verbosity"?: string, "tone"?: string, "riskPosture"?: string}}. ' +
      "Respond with one JSON object only, no prose.",
    messages: [
      {
        role: "user",
        content: `systemPrompt: ${profile.systemPrompt}\nmemoryNotes:\n${profile.memoryNotes.map((n) => `- ${n}`).join("\n")}`,
      },
    ],
  });

  if (result) {
    try {
      // Models routinely wrap JSON in markdown fences despite the "one JSON
      // object only, no prose" instruction — strip them before parsing.
      const stripped = result.content.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/, "");
      const parsed = JSON.parse(stripped);
      if (Array.isArray(parsed.objectives) && typeof parsed.personalityPrompt === "string") {
        return {
          objectives: parsed.objectives.slice(0, 4),
          personalityPrompt: String(parsed.personalityPrompt).slice(0, 2000),
          preferences: typeof parsed.preferences === "object" && parsed.preferences ? parsed.preferences : {},
        };
      }
    } catch {
      // fall through to heuristic
    }
  }

  // No-LLM / parse-failure fallback: truncate, don't fabricate.
  return {
    objectives: profile.memoryNotes.slice(0, 4).map((n) => n.slice(0, 500)),
    personalityPrompt: profile.systemPrompt.slice(0, 2000),
    preferences: {},
  };
}

// profile.json is user-supplied input (a trust boundary), not internal
// data — validate its shape before doing anything (including registering
// an owner) rather than crashing mid-import with a raw stack trace.
function validateProfile(raw: unknown): ExternalProfile | { error: string } {
  if (typeof raw !== "object" || raw === null) return { error: "profile must be a JSON object" };
  const p = raw as Record<string, unknown>;
  if (typeof p.name !== "string" || !p.name.trim()) return { error: "name (non-empty string) required" };
  if (typeof p.systemPrompt !== "string" || !p.systemPrompt.trim()) return { error: "systemPrompt (non-empty string) required" };
  if (!Array.isArray(p.memoryNotes) || p.memoryNotes.some((n) => typeof n !== "string")) {
    return { error: "memoryNotes must be an array of strings (can be empty)" };
  }
  return { name: p.name, systemPrompt: p.systemPrompt, memoryNotes: p.memoryNotes as string[] };
}

async function main() {
  const profilePath = process.argv[2];
  if (!profilePath) {
    console.error("usage: import-agent-profile.ts <profile.json>");
    process.exit(1);
  }
  const raw = await Bun.file(profilePath).json().catch(() => null);
  if (raw === null) {
    console.error(`could not read/parse ${profilePath} as JSON`);
    process.exit(1);
  }
  const validated = validateProfile(raw);
  if ("error" in validated) {
    console.error(`invalid profile: ${validated.error}`);
    process.exit(1);
  }
  const profile = validated;

  const compressed = await compress(profile);

  let reg: { token: string; owner: { id: string } };
  try {
    reg = (await jsonFetch(`${GATEWAY}/owners/register`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    })) as typeof reg;
  } catch {
    reg = (await jsonFetch(`${GATEWAY}/owners/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: OWNER_EMAIL, password: OWNER_PASSWORD }),
    })) as typeof reg;
  }

  const created = (await jsonFetch(`${GATEWAY}/owners/agents`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ name: profile.name }),
  })) as { agentToken: string; agent: { id: string } };

  await jsonFetch(`${GATEWAY}/owners/agents/${created.agent.id}/mandate`, {
    method: "PUT",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ objectives: compressed.objectives, preferences: compressed.preferences }),
  });

  await jsonFetch(`${GATEWAY}/owners/agents/${created.agent.id}/profile`, {
    method: "PATCH",
    headers: { "content-type": "application/json", authorization: `Bearer ${reg.token}` },
    body: JSON.stringify({ personalityPrompt: compressed.personalityPrompt }),
  });

  console.log(`imported ${profile.name} as agent ${created.agent.id}`);
  console.log(`  objectives: ${JSON.stringify(compressed.objectives)}`);
  console.log(`  personalityPrompt: ${compressed.personalityPrompt.slice(0, 120)}${compressed.personalityPrompt.length > 120 ? "..." : ""}`);
}

main();
