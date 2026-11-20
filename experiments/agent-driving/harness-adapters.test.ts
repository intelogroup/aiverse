import { expect, test } from "bun:test";
import { observeClaude, observeCodex } from "./harness-adapters";
import { harnessFailure } from "./benchmark";

const j = (...events: object[]) => events.map((event) => JSON.stringify(event));

test("claude trace: driving calls and images counted, any other tool is forbidden", () => {
  const lines = j(
    { type: "assistant", message: { content: [{ type: "tool_use", id: "a", name: "mcp__driving__drive_look" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "a", content: [{ type: "text", text: "ok" }, { type: "image", source: {} }] }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "b", name: "mcp__driving__drive_look" }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "b", content: [{ type: "text", text: "camera off" }] }] } },
    { type: "assistant", message: { content: [{ type: "tool_use", id: "c", name: "mcp__driving__drive_gas" }, { type: "tool_use", id: "d", name: "Bash" }] } },
  );
  expect(observeClaude(lines)).toEqual({ visionFrames: 1, frameErrors: 1, otherTools: 1, driveCalls: 3 });
});

test("codex trace keeps its old counting", () => {
  const lines = j(
    { type: "item.completed", item: { type: "mcp_tool_call", server: "driving", tool: "drive_look", result: { content: [{ type: "image" }] } } },
    { type: "item.completed", item: { type: "command_execution" } },
    { type: "item.completed", item: { type: "mcp_tool_call", server: "other", tool: "x" } },
  );
  expect(observeCodex(lines)).toEqual({ visionFrames: 1, frameErrors: 0, otherTools: 2, driveCalls: 1 });
});

test("claude result errors classify as harness failures", () => {
  expect(harnessFailure(j({ type: "result", is_error: true, result: "Credit balance is too low" }))).toBe("usage_limit");
  expect(harnessFailure(j({ type: "result", is_error: true, result: "Invalid API key" }))).toBe("auth");
  expect(harnessFailure(j({ type: "result", is_error: false, result: "ready" }))).toBeNull();
});
