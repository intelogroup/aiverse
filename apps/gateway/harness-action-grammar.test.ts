import { describe, test, expect } from "bun:test";
import { parseDecision, normalizeAction, repairActionArgs } from "./scripts/harness-action-grammar";

describe("harness action grammar (parseDecision)", () => {
  test("clean JSON passes through", () => {
    expect(parseDecision('{"action":"nothing"}')).toEqual({ action: "nothing" });
  });

  test("bare-key promotion: join_room as top-level key (wave-3 shape)", () => {
    expect(parseDecision('{"join_room":"general"}')).toEqual({ value: "general", action: "join_room" });
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
    const out = parseDecision('I will join the room now {"action":"join_room","room_slug":"general"} thanks');
    expect(out).toEqual({ action: "join_room", room_slug: "general" });
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

  test("near-miss arg name repaired at parse time: join_room room → room_slug", () => {
    // The 2026-08-31 shakedown shape: {"action":"join_room","room":"paradox_of_surrender"}
    const out = parseDecision('{"action":"join_room","room":"paradox_of_surrender"}');
    expect(out.action).toBe("join_room");
    expect(out.room_slug).toBe("paradox_of_surrender");
    expect(out.room).toBeUndefined();
  });

  test("near-miss arg aliases: content/message, targetAgentId/target", () => {
    expect(parseDecision('{"action":"ask_peer","target":"84a4eb7b-0000","message":"hi"}').content).toBe("hi");
    expect(parseDecision('{"action":"reply","conv":"c1","text":"yo"}').conversationId).toBe("c1");
  });

  test("unrepaired near-misses stay untouched (executor reports the real API error)", () => {
    const out = parseDecision('{"action":"join_room","destination":"nowhere"}');
    expect(out.action).toBe("join_room");
    expect(out.destination).toBe("nowhere");
    expect(out.room_slug).toBeUndefined();
  });

  test("off-grammar action is preserved as-is for the off_grammar bucket", () => {
    const out = parseDecision('{"action":"start_a_business"}');
    expect(out.action).toBe("start_a_business");
  });

  test("repairActionArgs leaves already-valid actions untouched", () => {
    const a = { action: "reply", conversationId: "c1", content: "hello" };
    expect(repairActionArgs(a)).toEqual(a);
    expect(normalizeAction({ action: "NOTHING" }).action).toBe("nothing");
  });
});
