import { describe, expect, test } from "bun:test";
import { buildActionGrammar } from "./harness-action-grammar";

// harness-action-grammar.ts is shared by every ecology wave (mp-ladder's
// pre-screen included), and every wave besides the bazaar experiment itself
// expects the grammar byte-identical to what its frozen_config_sha256 was
// sealed against (see ecology-config.ts's ECOLOGY_FROZEN_FILES). This pins
// buildActionGrammar(false) — the non-bazaar branch — to exactly what
// ACTIONS/ACTION_GRAMMAR were on main before the bazaar experiment (PR #11)
// touched this file, so a future change to the bazaar branch can't leak
// into the shared default without this test catching it.
const PRE_BAZAAR_ACTIONS = [
  "nothing", "observe", "join_room", "leave_conversation", "message", "reply",
  "start_conversation", "invite", "discover_peers", "ask_peer", "create_goal", "delegate",
];
const PRE_BAZAAR_GRAMMAR = `{"action": one of
  "nothing"        — do nothing this tick
  "observe"        — read the world, take no outward action
  "join_room"      — {"room": "<slug>"}
  "leave_conversation" — {"conversation_id": "<id>"}
  "message"        — {"conversation_id": "<id>", "content": "<text>"}
  "reply"          — {"conversation_id": "<id>", "reply_to_id": "<msg id>", "content": "<text>"}
  "start_conversation" — {"participant_ids": ["<agent id>", ...], "content": "<text>", "name": "<group name — required if participant_ids has more than 1 id, omit for a 1:1 DM>"}
  "invite"         — {"conversation_id": "<id>", "agent_id": "<agent id>"}
  "discover_peers" — {"skill": "<term>"} (search by skill) or {} (no args = roster of every agent in the Verse: id, name, status, capabilities)
  "ask_peer"       — {"agent_id": "<agent id>", "content": "<text>"}
  "create_goal"    — {"objective": "<text>"}
  "delegate"       — {"agent_id": "<agent id>", "content": "<text>", "context_id": "<goal context id or null>"}
}
Public rooms are shared threads: join_room puts you in the room thread (it returns its conversation id and the thread then appears in your conversations), and a message to that thread is PUBLIC — every agent can read it and reply. You do not need to know an agent in advance to speak publicly. Context.known_room_slugs lists the only valid room argument values for join_room — never guess a slug or use a conversation id there.
There is no "research" or "explore" action. Once you have joined a room, act on whatever drew you there by posting: "message" to speak in that room's thread, or "reply"/"start_conversation" to engage a specific peer. Reading Context is not itself an action — it always ends in one of the actions listed above.
Each row in Context.public_activity may include topics (subject tags from message content) — use them, together with your own persona, to judge fit; the harness does not rank or filter by them.
Context.arrivals lists agents who entered the Verse recently (from live arrival broadcasts). Greeting or starting a conversation with a new arrival is a normal, welcome social action — you already have their agent_id.
Context.already_joined_rooms lists slugs join_room has already succeeded on for you this run — you're already in that room's thread (check Context.conversations for it) and re-issuing join_room there does nothing new. Whether to post there, reply, or do something else is still your call.
Context.open_dm_by_participant maps an agent id to a conversation id you already opened with them this run — start_conversation to a peer already in this map does not continue that thread, it opens a separate new one. If you want to add to a conversation you already have with someone, use reply or message with that conversation id instead.
Context.memory_notes are your own past notes and traces, read-only — reference them if relevant to what you're doing. There is no action to add to, edit, or search them; they are shown to you as-is each tick.
Do not open a message/reply with an acknowledgment phrase ("thanks", "thanks for the heads-up", "appreciate it", "noted", etc) — start directly with your actual content or answer.
When replying or continuing a conversation, add at least one concrete new point, example, or question — restating or validating what the other person said (e.g. "that's an interesting point") without adding something new reads as filler, not engagement.
Write all message/reply content in English, regardless of what language a peer's message is in.
Respond with one JSON object only. No prose.`;

describe("buildActionGrammar", () => {
  test("bazaarMode=false is byte-identical to the grammar every non-bazaar ecology wave was sealed against", () => {
    const { ACTIONS, ACTION_GRAMMAR, ACTION_ARG_SCHEMAS } = buildActionGrammar(false);
    expect([...ACTIONS].sort()).toEqual([...PRE_BAZAAR_ACTIONS].sort());
    expect(ACTION_GRAMMAR).toBe(PRE_BAZAAR_GRAMMAR);
    expect(Object.keys(ACTION_ARG_SCHEMAS)).not.toContain("post_bounty");
  });

  test("bazaarMode=true adds the market actions without changing any pre-existing line", () => {
    const base = buildActionGrammar(false);
    const bazaar = buildActionGrammar(true);
    for (const a of PRE_BAZAAR_ACTIONS) expect(bazaar.ACTIONS.has(a)).toBe(true);
    for (const a of ["post_bounty", "list_bounties", "claim_bounty", "complete_bounty", "verify_bounty"]) {
      expect(bazaar.ACTIONS.has(a)).toBe(true);
    }
    // Every line present in the base grammar still appears verbatim in the
    // bazaar grammar — additions only, no rewording of shared lines.
    for (const line of base.ACTION_GRAMMAR.split("\n")) {
      if (line.includes('"delegate"')) continue; // the one line bazaar mode extends in place
      expect(bazaar.ACTION_GRAMMAR).toContain(line);
    }
    expect(bazaar.ACTION_ARG_SCHEMAS.post_bounty).toBeDefined();
  });
});
