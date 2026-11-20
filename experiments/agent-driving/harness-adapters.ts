// Reads a harness event stream and counts what the benchmark validity rules need.
// Same contract for every harness: MCP `driving` server only, owner OAuth, no shell/web/file tools.
export type HarnessName = "codex" | "claude" | "opencode";
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

// OpenCode 2.x gives the model one `execute` tool; the model writes code calling tools.driving.<tool>(). Each event lists the
// calls it made and carries any returned images as data: URLs. A call outside the driving namespace is forbidden.
// Read-only MCP discovery that OpenCode offers in its own namespace; everything else outside driving.* is forbidden
// (session_*, worktree_* and any other namespace).
const opencodeIntrospection = new Set(["opencode.list_mcp_resources", "opencode.read_mcp_resource", "opencode.models", "search"]);

export function observeOpencode(lines: readonly string[]): Observation {
  const out: Observation = { visionFrames: 0, frameErrors: 0, otherTools: 0, driveCalls: 0 };
  for (const line of lines) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    const part = event.part;
    if (event.type !== "tool_use" || part?.type !== "tool") continue;
    const meta = part.state?.metadata;
    if (part.tool !== "execute") { out.otherTools++; continue; }
    const calls: { tool?: string }[] = meta?.metadata?.toolCalls ?? [];
    const images = (meta?.content ?? []).filter((item: { type?: string; uri?: string }) => item.type === "file" && String(item.uri).startsWith("data:image")).length;
    let looks = 0;
    for (const call of calls) {
      if (call.tool && opencodeIntrospection.has(call.tool)) continue;
      if (!call.tool?.startsWith("driving.")) out.otherTools++;
      else { out.driveCalls++; if (call.tool === "driving.drive_look") looks++; }
    }
    out.visionFrames += Math.min(images, looks);
    out.frameErrors += Math.max(0, looks - images);
  }
  return out;
}

export const observe = (name: HarnessName, lines: readonly string[]) => ({ claude: observeClaude, opencode: observeOpencode, codex: observeCodex })[name](lines);
