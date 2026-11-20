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

test("opencode trace: driving calls via execute, images as data urls, any other namespace is forbidden", async () => {
  const { observeOpencode } = await import("./harness-adapters");
  const exec = (calls: string[], images: number) => ({ type: "tool_use", part: { type: "tool", tool: "execute", state: { metadata: {
    metadata: { toolCalls: calls.map((tool) => ({ tool, status: "completed" })) },
    content: [{ type: "text", text: "x" }, ...Array.from({ length: images }, () => ({ type: "file", uri: "data:image/jpeg;base64,AAAA" }))],
  } } } });
  const lines = j(
    exec(["driving.drive_enter", "driving.drive_look"], 1),
    exec(["driving.drive_look"], 0),
    exec(["opencode.bash", "driving.drive_gas"], 0),
    { type: "tool_use", part: { type: "tool", tool: "bash", state: {} } },
    { type: "text", part: { text: "hi" } },
  );
  expect(observeOpencode(lines)).toEqual({ visionFrames: 1, frameErrors: 1, otherTools: 2, driveCalls: 4 });
});

test("an OpenRouter data-policy refusal is a provider failure, not a driving result", () => {
  const message = "0 endpoints out of 1 requested are available matching your guardrail restrictions and data policy. ZDR violation";
  expect(harnessFailure(j({ type: "error", error: { message } }))).toBe("provider_unavailable");
  expect(harnessFailure(j({ type: "error", error: { message: "No allowed providers are available for the selected model." } }))).toBe("provider_unavailable");
});
