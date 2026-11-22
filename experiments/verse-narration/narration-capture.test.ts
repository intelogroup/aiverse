import { expect, test } from "bun:test";
import { fillerRate, narrationClaude, narrationOpencode, MAX_LINE_CHARS } from "./narration-capture";

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
