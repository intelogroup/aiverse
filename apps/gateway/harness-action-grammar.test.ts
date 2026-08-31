import { describe, test, expect } from "bun:test";
import { parseDecision, normalizeAction, repairActionArgs } from "./scripts/harness-action-grammar";

describe("harness action grammar (parseDecision)", () => {
  test("clean JSON passes through", () => {
    expect(parseDecision('{"action":"nothing"}')).toEqual({ action: "nothing" });
  });

  test("bare-key promotion: join_room as top-level key (wave-3 shape)", () => {
    // Scalar arg maps to the action's primary argument (voided-e2a fix)
    expect(parseDecision('{"join_room":"general"}')).toEqual({ room: "general", action: "join_room" });
  });

  test("bare-key promotion with object args: delegate", () => {
    const out = parseDecision('{"delegate":{"goal_id":"abc"}}');
    expect(out.action).toBe("delegate");
    expect(out.goal_id).toBe("abc");
  });

  test("edit-distance-1 action typo repaired (delegeate)", () => {
    expect(parseDecision('{"delegeate":{"goal_id":"x"}}').action).toBe("delegate");
  });

  test("malformed salvage: JSON wrapped in prose", () => {
    const out = parseDecision('I will join the room now {"action":"join_room","room":"general"} thanks');
    expect(out).toEqual({ action: "join_room", room: "general" });
  });

  test("malformed salvage: fenced json + trailing text", () => {
    const out = parseDecision('```json\n{"action":"observe"}\n``` and that is my decision');
    expect(out).toEqual({ action: "observe" });
  });

  test("truly unparseable output stays malformed_json with raw kept", () => {
    const out = parseDecision("I choose to do absolutely nothing at all, no json here");
    expect(out.action).toBe("malformed_json");
    expect(out.raw).toContain("absolutely nothing");
  });

  test("executor-contract args pass untouched: join_room {room} (was 'repaired' wrongly before)", () => {
    // The executor reads action.room; {"room":…} is CORRECT output and must
    // never be rewritten (the original camelCase schema destroyed it).
    const out = parseDecision('{"action":"join_room","room":"paradox_of_surrender"}');
    expect(out.action).toBe("join_room");
    expect(out.room).toBe("paradox_of_surrender");
    expect(out.room_slug).toBeUndefined();
  });

  test("near-miss aliases to executor contract: room_slug → room, conv → conversation_id", () => {
    expect(parseDecision('{"action":"join_room","room_slug":"general"}').room).toBe("general");
    expect(parseDecision('{"action":"reply","conv":"c1","text":"yo"}').conversation_id).toBe("c1");
    expect(parseDecision('{"action":"ask_peer","target":"84a4eb7b-0000","message":"hi"}').agent_id).toBe("84a4eb7b-0000");
    expect(parseDecision('{"action":"ask_peer","target":"84a4eb7b-0000","message":"hi"}').content).toBe("hi");
  });

  test("unrepaired near-misses stay untouched (executor reports the real API error)", () => {
    const out = parseDecision('{"action":"join_room","destination":"nowhere"}');
    expect(out.action).toBe("join_room");
    expect(out.destination).toBe("nowhere");
    expect(out.room).toBeUndefined();
  });

  test("off-grammar action is preserved as-is for the off_grammar bucket", () => {
    const out = parseDecision('{"action":"start_a_business"}');
    expect(out.action).toBe("start_a_business");
  });

  test("repairActionArgs leaves already-valid actions untouched", () => {
    const a = { action: "reply", conversation_id: "c1", content: "hello" };
    expect(repairActionArgs(a)).toEqual(a);
    expect(normalizeAction({ action: "NOTHING" }).action).toBe("nothing");
  });
});
