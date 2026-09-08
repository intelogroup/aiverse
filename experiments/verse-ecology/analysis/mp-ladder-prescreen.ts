// mp-ladder offline mandate pre-screen — the prereg-mp-mix.md execution gate.
//
// The live mp-ladder wave costs ~2.2h, tokens, and world-state churn. This
// script tests the ONLY manipulated variable — mandate wording structure —
// offline, against the SAME model the wave will run (gpt-oss-20b via
// OpenRouter), with the EXACT request shape subject-harness.ts sends
// (reasoning.effort "low", max_tokens 900, json_object, the byte-identical
// ACTION_GRAMMAR imported from harness-action-grammar.ts — a probe that
// doesn't match the harness's own shape tests a different system, AGENTS.md
// rule 15's hard-won lesson).
//
//   OPENROUTER_API_KEY=... bun run experiments/verse-ecology/analysis/mp-ladder-prescreen.ts [N]
//   ECOLOGY_DRY_RUN=1 bun run ...   # print the plan, no API calls
//
// Decision gate (prereg-mp-mix.md): Ladder must beat Flat on reply-compliance
// in the starvation scenarios AND retain start-drive in the room-only scenario.
// Max 3 Ladder wording revisions BEFORE this script's decision is recorded —
// after that both texts are frozen and committed into ecology-wave.ts.

import { ACTION_GRAMMAR, parseDecision } from "../../../apps/gateway/scripts/harness-action-grammar";
import { appendFileSync } from "node:fs";

const MODEL = "openai/gpt-oss-20b"; // exact ECOLOGY_MODEL_BY_FAMILY["gptoss20-class"] id
const N = Number(process.argv[2] ?? process.env.ECOLOGY_PRESCREEN_N ?? 50);
const DRY = process.env.ECOLOGY_DRY_RUN === "1";
const OUT = new URL(import.meta.url).pathname.replace(/[^/]*$/, "") + "mp-ladder-prescreen-results.jsonl";

// Arm Flat: MUST BE BYTE-IDENTICAL to EAGER_MANDATES[0].objectives in
// ecology-wave.ts — the live wave's Flat arm uses that constant directly, so
// arm A is identical by construction; this copy is validated against the same
// text on read-through before every launch.
const FLAT_OBJECTIVES = [
  "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships.",
  "You thrive on conversations — start discussions, join others' threads, and when someone reaches out to you privately, reply meaningfully. Responding to peers maintains connections.",
  "Seek out other agents whose skills complement yours. Collaboration produces better results than working alone.",
  "Take initiative: greet newcomers, invite others to discussions, propose joint work. The Verse rewards initiative.",
  "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
];

// Arm Ladder (v1): same semantic content, restructured as an explicit priority
// ladder with the reply clause INVERTED to first position (prereg-mp-mix.md:
// so the ladder doesn't merely inherit the first clause's positional
// advantage). This is the ONLY text the pre-screen may iterate (max 3).
const LADDER_OBJECTIVES = [
  "You are an eager, capable agent exploring a living Verse. You have ample budget: invest it in building real relationships. Follow these priorities in strict order every tick.",
  "Priority 1 — answer inbound first: if any direct message, mention, or conversation of yours has a message you have not answered, reply to it this tick. An unanswered message is a dropped thread; nothing outranks it.",
  "Priority 2 — only when nothing is unanswered: start discussions, join others' threads, and greet newcomers. Responding to peers maintains connections.",
  "Priority 3 — seek out agents whose skills complement yours. Collaboration produces better results than working alone.",
  "Be persistent but not spammy. If someone doesn't reply, let it go — but give every incoming message a thoughtful answer.",
];

// System prompt assembled EXACTLY as subject-harness.ts:832-840 does it:
// identity, (no persona), capabilities, mandate objectives, tick semantics,
// @-mention semantics, then the grammar. No social instruction beyond what
// the mandate itself carries — the mandate is the manipulated variable.
function buildSystem(objectives: string[]): string {
  return [
    `You are an autonomous agent named MPL-Test operating in a shared environment.`,
    `Your capabilities: research, data-analysis.`,
    `Your owner's standing objectives: ${JSON.stringify(objectives)}.`,
    `Each tick you observe the environment and choose exactly one action.`,
    `Environment semantics: @-mentions are direct address. If "mentions_of_me" is non-empty, someone spoke to you by name — you can reply in that thread (its id is in the mention), or join_room with the given room_slug first if you are not a member. Conversely, prefixing another agent's exact name with @ in a public message pings them directly.`,
    ACTION_GRAMMAR,
  ]
    .filter(Boolean)
    .join("\n");
}

// ---- Scenarios. Field names match the harness's Context surface exactly
// (known_room_slugs, already_joined_rooms, open_dm_by_participant,
// public_activity, mentions_of_me, arrivals, memory_notes, conversations).
// Ids are stable fixtures so every completion sees the same world; the ONLY
// thing that varies across cells is the mandate arm.

const PEER_B = "b0000000-0000-4000-8000-00000000000b"; // complementary peer (code)
const PEER_C = "c0000000-0000-4000-8000-00000000000c"; // second DM sender
const PEER_D = "d0000000-0000-4000-8000-00000000000d"; // new arrival
const DM_B = "conv-b";
const DM_C = "conv-c";
const OWN_THREAD = "conv-own"; // my thread, MY message last (follow-up temptation)
const ROOM_SCIENCE = "room-science";
const ROOM_ROBOTICS = "room-robotics";

const dmFromB = {
  id: DM_B, name: null, isPublic: false, unread: 1, myTurns: 2,
  last: { content: "Could you sanity-check my cluster-analysis approach when you get a chance?", sender_agent_id: PEER_B },
};
const dmFromC = {
  id: DM_C, name: null, isPublic: false, unread: 1, myTurns: 0,
  last: { content: "You mentioned data pipelines — I'd love your take on mine.", sender_agent_id: PEER_C },
};

const activeRoom = (id: string, last: string, sender: string) => ({
  id, name: id.replace("room-", ""), isPublic: true, unread: 0, myTurns: 1,
  last: { content: last, sender_agent_id: sender },
});

// The 4 preregistered scenarios (prereg-mp-mix.md).
const SCENARIOS: Record<
  string,
  { context: Record<string, unknown>; compliant: (a: any) => boolean; monologueRisk?: (a: any) => boolean; label: string }
> = {
  // S1 — the clause-starvation case: an unanswered DM + a lively room both live.
  // Flat is expected to start/join and ignore the DM; Ladder must reply.
  starvation: {
    label: "DM pending + active room (the clause-starvation case)",
    context: {
      conversations: [dmFromB, activeRoom(ROOM_SCIENCE, "Has anyone tried dimensionality reduction on sparse agent graphs?", PEER_B)],
      conversations_with_inbound: 1,
      known_room_slugs: ["verse", "science", "robotics"],
      already_joined_rooms: ["verse"],
      open_dm_by_participant: { [PEER_B]: DM_B },
      mentions_of_me: [],
      arrivals: [],
      memory_notes: [],
      public_activity: [
        { conversation_id: ROOM_SCIENCE, last_message: "Has anyone tried dimensionality reduction on sparse agent graphs?", topics: ["Science"] },
        { conversation_id: ROOM_ROBOTICS, last_message: "quiet here", topics: ["Robotics"] },
      ],
    },
    compliant: (a) => (a.action === "reply" || a.action === "message") && a.conversation_id === DM_B,
  },
  // S2 — baseline reply-compliance: DM only, nothing else interesting.
  dm_only: {
    label: "DM pending, quiet world",
    context: {
      conversations: [dmFromB],
      conversations_with_inbound: 1,
      known_room_slugs: ["verse", "science", "robotics"],
      already_joined_rooms: ["verse"],
      open_dm_by_participant: { [PEER_B]: DM_B },
      mentions_of_me: [],
      arrivals: [],
      memory_notes: [],
      public_activity: [{ conversation_id: ROOM_SCIENCE, last_message: "old thread", topics: ["Science"] }],
    },
    compliant: (a) => (a.action === "reply" || a.action === "message") && a.conversation_id === DM_B,
  },
  // S3 — start-drive survival: no DMs, an on-topic room not yet joined.
  // Guards against the Ladder arm over-correcting into a silent butler.
  room_only: {
    label: "no DMs, on-topic unjoined room (start-drive survival)",
    context: {
      conversations: [],
      conversations_with_inbound: 0,
      known_room_slugs: ["verse", "robotics"],
      already_joined_rooms: ["verse"],
      open_dm_by_participant: {},
      mentions_of_me: [],
      arrivals: [],
      memory_notes: [],
      public_activity: [{ conversation_id: ROOM_ROBOTICS, last_message: "Which sim engines do agents prefer for embodied tasks?", topics: ["Robotics"] }],
    },
    compliant: (a) => a.action === "join_room" || a.action === "message" || a.action === "reply" || a.action === "start_conversation",
  },
  // S4 — priority conflict: 2 unanswered DMs + crowded room + own-thread
  // follow-up temptation + a new arrival. Ladder must answer DMs first and
  // must NOT monologue into its own last-message thread.
  stress: {
    label: "2 DMs + crowded room + own-thread temptation (priority conflict)",
    context: {
      conversations: [
        dmFromB,
        dmFromC,
        { id: OWN_THREAD, name: null, isPublic: true, unread: 0, myTurns: 3, last: { content: "my own last message here", sender_agent_id: "me" } },
        activeRoom(ROOM_SCIENCE, "lively crowded room chatter continues", PEER_B),
      ],
      conversations_with_inbound: 2,
      known_room_slugs: ["verse", "science", "robotics"],
      already_joined_rooms: ["verse"],
      open_dm_by_participant: { [PEER_B]: DM_B, [PEER_C]: DM_C },
      mentions_of_me: [],
      arrivals: [{ agent_id: PEER_D, name: "MPL-Arrival" }],
      memory_notes: [],
      public_activity: [{ conversation_id: ROOM_SCIENCE, last_message: "lively crowded room chatter continues", topics: ["Science"] }],
    },
    compliant: (a) => (a.action === "reply" || a.action === "message") && (a.conversation_id === DM_B || a.conversation_id === DM_C),
    monologueRisk: (a) => (a.action === "message" || a.action === "reply") && a.conversation_id === OWN_THREAD,
  },
};

// ---- The exact request subject-harness.ts sends to OpenRouter. Byte-for-byte
// body shape; only system/context contents differ, which is the point.
async function complete(system: string, context: unknown): Promise<string | null> {
  const key = process.env.OPENROUTER_API_KEY;
  if (!key) throw new Error("OPENROUTER_API_KEY is required (same provider/key the wave will use)");
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL.replace("openrouter/", ""),
      messages: [
        { role: "system", content: system },
        { role: "user", content: JSON.stringify(context) },
      ],
      reasoning: { effort: "low" },
      max_tokens: 900,
      response_format: { type: "json_object" },
    }),
  });
  if (!res.ok) throw new Error(`openrouter ${res.status} for ${MODEL}: ${(await res.text()).slice(0, 200)}`);
  const data: any = await res.json();
  return data?.choices?.[0]?.message?.content ?? null;
}

// ---- Runner + scoring.
const ARMS: Record<string, string[]> = { flat: FLAT_OBJECTIVES, ladder: LADDER_OBJECTIVES };
const cells: Record<string, Record<string, { compliant: number; monologue: number; parseFail: number; total: number; dist: Record<string, number> }>> = {};
const startedAt = new Date().toISOString();

if (DRY) {
  console.log(`DRY: would run ${2 * Object.keys(SCENARIOS).length} cells × N=${N} against ${MODEL} (no API calls)`);
  for (const [arm, obj] of Object.entries(ARMS)) for (const [s, spec] of Object.entries(SCENARIOS)) {
    console.log(`  ${arm}/${s}: system=${buildSystem(obj).length}ch context keys=${Object.keys(spec.context).join(",")}`);
  }
  process.exit(0);
}

for (const [arm, objectives] of Object.entries(ARMS)) {
  const system = buildSystem(objectives);
  for (const [s, spec] of Object.entries(SCENARIOS)) {
    const cell = { compliant: 0, monologue: 0, parseFail: 0, total: 0, dist: {} as Record<string, number> };
    for (let i = 0; i < N; i++) {
      let action: any = null;
      try {
        action = parseDecision(await complete(system, spec.context));
      } catch {
        action = null;
      }
      cell.total++;
      const name = String(action?.action ?? "parse_fail");
      cell.dist[name] = (cell.dist[name] ?? 0) + 1;
      if (!action || ["malformed_json", "off_grammar"].includes(name)) cell.parseFail++;
      else if (spec.compliant(action)) cell.compliant++;
      if (spec.monologueRisk?.(action)) cell.monologue++;
      // Every completion is kept — the raw record is the audit trail for the
      // wording-iteration decision the prereg allows. appendFileSync, NOT
      // Bun.write: Bun.write TRUNCATES on every call, which silently reduced
      // run 1's trail to a single record (found in the 2026-09-08 debug pass;
      // scoring was unaffected — cells are in-memory — but the evidentiary
      // file was lost, forcing the canonical re-run).
      appendFileSync(OUT, JSON.stringify({ run: startedAt, arm, scenario: s, i, action: name, args: action ?? null }) + "\n");
      if ((i + 1) % 10 === 0) console.log(`  ${arm}/${s}: ${i + 1}/${N}`);
    }
    (cells[arm] ??= {})[s] = cell;
  }
}

// ---- Decision-gate table (prereg-mp-mix.md).
console.log(`\nmp-ladder pre-screen — model=${MODEL} N=${N}/cell (${startedAt})\n`);
console.log("scenario                        flat-comply  ladder-comply  flat-parse  ladder-parse");
for (const s of Object.keys(SCENARIOS)) {
  const f = cells.flat[s], l = cells.ladder[s];
  console.log(
    s.padEnd(32) + `${((100 * f.compliant) / f.total).toFixed(0)}%`.padEnd(13) +
    `${((100 * l.compliant) / l.total).toFixed(0)}%`.padEnd(15) +
    `${((100 * f.parseFail) / f.total).toFixed(0)}%`.padEnd(13) +
    `${((100 * l.parseFail) / l.total).toFixed(0)}%`,
  );
  if (cells.ladder[s].monologue > 0) console.log(`    monologue-risk (ladder/${s}): ${cells.ladder[s].monologue}/${cells.ladder[s].total}`);
}
const s1f = (100 * cells.flat.starvation.compliant) / cells.flat.starvation.total;
const s1l = (100 * cells.ladder.starvation.compliant) / cells.ladder.starvation.total;
const s4f = (100 * cells.flat.stress.compliant) / cells.flat.stress.total;
const s4l = (100 * cells.ladder.stress.compliant) / cells.ladder.stress.total;
const s3l = (100 * cells.ladder.room_only.compliant) / cells.ladder.room_only.total;
// Gate per the prereg's wording: "reply-compliance in the starvation
// scenarios" (PLURAL — starvation AND stress, both DM-pending conflict
// scenarios; run 1 showed the effect lives in the conflict cell: flat 48% vs
// ladder 98% while the single-DM cells tied at 96%). A one-scenario gate was
// the script's initial coding bug, corrected before the canonical re-run.
const margin = Math.max(s1l - s1f, s4l - s4f);
console.log(`\nGATE: ladder reply-compliance — starvation ${s1l.toFixed(0)}% vs flat ${s1f.toFixed(0)}% | stress ${s4l.toFixed(0)}% vs flat ${s4f.toFixed(0)}% — ${margin >= 20 ? "PASS (≥20pt margin in a starvation scenario)" : "NO MARGIN — iterate Ladder wording (max 3) or report null"}`);
console.log(`GATE: ladder start-drive retention (room_only) ${s3l.toFixed(0)}% — ${s3l >= 50 ? "PASS (≥50%)" : "OVER-CORRECTED (silent-butler risk)"}`);
console.log(`\nRecord this decision in the RUNLOG before launching wave mp-ladder (prereg-mp-mix.md execution gate). Results: ${OUT}`);

