import { expect, test } from "bun:test";
import { fillerRate, narrationClaude, narrationOpencode, narrationPi, MAX_LINE_CHARS } from "./narration-capture";

const j = (...e: unknown[]) => e.map((x) => JSON.stringify(x));

test("claude: visible text and thinking blocks are kept apart, tool_use ignored", () => {
  const out = narrationClaude(j(
    { type: "assistant", message: { content: [{ type: "thinking", thinking: "The tea house is north." }, { type: "text", text: "Walking to the tea house." }, { type: "tool_use", id: "a", name: "mcp__x__go_to" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: "ok" }] } },
  ));
  expect(out.map((l) => [l.kind, l.text])).toEqual([["thinking", "The tea house is north."], ["visible", "Walking to the tea house."]]);
  expect(out.map((l) => l.seq)).toEqual([0, 1]);
});

test("opencode: text parts are visible, reasoning parts thinking, tool events ignored", () => {
  const out = narrationOpencode(j(
    { type: "text", part: { text: "hi" } },
    { type: "reasoning", part: { text: "plan" } },
    { type: "tool_use", part: { type: "tool", tool: "execute", state: {} } },
  ));
  expect(out.map((l) => [l.kind, l.text])).toEqual([["visible", "hi"], ["thinking", "plan"]]);
});

test("garbage lines, empty text and non-strings are skipped without throwing", () => {
  expect(narrationClaude(["not json", ...j({ type: "assistant", message: { content: [{ type: "text", text: "   " }, { type: "text", text: 5 }] } })])).toEqual([]);
  expect(narrationOpencode(["{", ...j({ type: "text", part: {} })])).toEqual([]);
});

test("long lines are capped but their real length stays visible", () => {
  const [l] = narrationClaude(j({ type: "assistant", message: { content: [{ type: "text", text: "x".repeat(MAX_LINE_CHARS + 100) }] } }));
  expect(l.text.length).toBe(MAX_LINE_CHARS);
  expect(l.chars).toBe(MAX_LINE_CHARS + 100);
});

test("fillerRate flags tool-restating lines only", () => {
  const lines = narrationClaude(j({ type: "assistant", message: { content: [{ type: "text", text: "I will call the drive_look tool." }, { type: "text", text: "Tea house looks busy, so I will wait outside." }] } }));
  expect(fillerRate(lines)).toBe(0.5);
  expect(fillerRate([])).toBe(0);
});

test("opencode: the event timestamp is kept so lines can be synced to tool calls", () => {
  const [l] = narrationOpencode(j({ type: "text", timestamp: 1795388000000, part: { text: "heading to the tea house" } }));
  expect(l.t).toBe(1795388000000);
});

test("pi: completed assistant messages give text and thinking; deltas, user turns and tool calls are ignored", () => {
  const out = narrationPi(j(
    { type: "message_end", message: { role: "user", content: "walk to the tea house", timestamp: 1 } },
    { type: "message_update", assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "Hel" } },
    { type: "message_end", message: { role: "assistant", timestamp: 1795388000000, content: [
      { type: "thinking", thinking: "Tea house is shop-102." }, { type: "thinking", thinking: "", thinkingSignature: "opaque" },
      { type: "text", text: "Heading to shop-102." }, { type: "toolCall", name: "mcp__verse__world_act" } ] } },
  ));
  expect(out.map((l) => [l.kind, l.text, l.t])).toEqual([["thinking", "Tea house is shop-102.", 1795388000000], ["visible", "Heading to shop-102.", 1795388000000]]);
});
