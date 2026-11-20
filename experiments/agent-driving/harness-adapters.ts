// Reads a harness event stream and counts what the benchmark validity rules need.
// Same contract for every harness: MCP `driving` server only, owner OAuth, no shell/web/file tools.
export type HarnessName = "codex" | "claude";
export type Observation = { visionFrames: number; frameErrors: number; otherTools: number; driveCalls: number };

type Part = { type?: string };
const hasImage = (content: unknown) => Array.isArray(content) && content.some((part: Part) => part?.type === "image");

export function observeCodex(lines: readonly string[]): Observation {
  const forbidden = new Set(["command_execution", "web_search", "file_change", "collab_tool_call"]);
  const out: Observation = { visionFrames: 0, frameErrors: 0, otherTools: 0, driveCalls: 0 };
  for (const line of lines) {
    const event = JSON.parse(line);
    if (event.type !== "item.completed") continue;
    const item = event.item;
    const driving = item.type === "mcp_tool_call" && item.server === "driving";
    if (forbidden.has(item.type) || item.type === "mcp_tool_call" && !driving) out.otherTools++;
    if (driving) out.driveCalls++;
    if (driving && item.tool === "drive_look") hasImage(item.result?.content) ? out.visionFrames++ : out.frameErrors++;
  }
  return out;
}

export function observeClaude(lines: readonly string[]): Observation {
  const out: Observation = { visionFrames: 0, frameErrors: 0, otherTools: 0, driveCalls: 0 };
  const looks = new Set<string>();
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const content = event.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content) {
      if (event.type === "assistant" && block.type === "tool_use") {
        if (typeof block.name !== "string" || !block.name.startsWith("mcp__driving__")) out.otherTools++;
        else {
          out.driveCalls++;
          if (block.name === "mcp__driving__drive_look") looks.add(block.id);
        }
      } else if (event.type === "user" && block.type === "tool_result" && looks.has(block.tool_use_id)) {
        hasImage(block.content) ? out.visionFrames++ : out.frameErrors++;
      }
    }
  }
  return out;
}

export const observe = (name: HarnessName, lines: readonly string[]) => (name === "claude" ? observeClaude : observeCodex)(lines);
