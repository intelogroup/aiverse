import { mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";

type Part = { type: string; text?: string; data?: string; mimeType?: string };
type ToolItem = {
  type: string;
  tool?: string;
  server?: string;
  arguments?: { view?: string };
  text?: string;
  result?: { content?: Part[] };
};

type Finding = {
  scenario: string;
  source: "agent" | "tool" | "world" | "harness";
  tool: string;
  code: string;
  observation?: string;
  frames?: string[];
};

const decisions = new Set(["drive_change_lane", "drive_approach", "drive_intersection_turn", "drive_wait", "drive_headlights"]);
const toolProblems = new Set(["wrong_check_area", "nothing_to_yield_to", "driver_not_seated", "maneuver_unavailable", "signal_before_approach"]);
const hiddenLessonFields = ["benchmark", "signalHead", "sign", "hazard", "actor", "oncoming", "crosswalk", "laneDivider", "evidence"];

function parseResponse(text: string) {
  try {
    return JSON.parse(text) as { ok?: boolean; code?: string; error?: string; lesson?: Record<string, unknown> };
  } catch {
    return undefined;
  }
}

const traceDir = process.argv[2];
if (!traceDir) throw new Error("Provide the directory containing a benchmark run.");
const auditDir = join(traceDir, "audit");
await mkdir(auditDir, { recursive: true });
const paths = (await readdir(traceDir)).filter((name) => /^B\d\d\.jsonl$/.test(name)).sort();
const findings: Finding[] = [];
const observations: { scenario: string; decision: string; views: string[]; outcome: string }[] = [];

for (const name of paths) {
  const scenario = name.slice(0, 3);
  const frames = new Map<string, Part>();
  let narrator: string | undefined;
  let number = 0;
  let complete = false;
  const lines = (await Bun.file(join(traceDir, name)).text()).split("\n").filter(Boolean);
  for (const line of lines) {
    let event: { type: string; item?: ToolItem };
    try {
      event = JSON.parse(line);
    } catch {
      findings.push({ scenario, source: "harness", tool: "trace", code: "invalid_event" });
      continue;
    }
    if (event.type === "turn.completed") complete = true;
    if (event.type !== "item.completed" || !event.item) continue;
    const item = event.item;
    if (item.type === "agent_message") narrator = item.text;
    if (item.type !== "mcp_tool_call" || item.server !== "driving" || !item.tool) continue;
    const { tool } = item;
    const parts = item.result?.content ?? [];
    const response = parseResponse(parts.find((part) => part.type === "text")?.text ?? "");
    if (response?.lesson && hiddenLessonFields.some((field) => field in response.lesson!)) {
      findings.push({ scenario, source: "harness", tool, code: "hidden_world_state_exposed" });
    }
    if (tool === "drive_look") {
      const image = parts.find((part) => part.type === "image");
      if (image?.data) frames.set(item.arguments?.view ?? "ahead", image);
      else findings.push({ scenario, source: "world", tool, code: "camera_frame_unavailable", observation: response?.error });
    }
    if (decisions.has(tool)) observations.push({
      scenario, decision: tool, views: [...frames.keys()], outcome: response?.code ?? (response?.ok ? "accepted" : "unknown"),
    });
    if (response?.ok === false) {
      const code = response.code ?? "missing_recovery_code";
      const saved = await Promise.all([...frames.entries()].map(async ([view, frame]) => {
        const filename = `${scenario}-${number}-${view}.${frame.mimeType === "image/png" ? "png" : "jpg"}`;
        await Bun.write(join(auditDir, filename), Buffer.from(frame.data!, "base64"));
        return filename;
      }));
      findings.push({
        scenario, source: toolProblems.has(code) ? "tool" : "agent", tool, code,
        observation: narrator?.slice(0, 720), frames: saved,
      });
      number++;
    } else if (response?.ok && decisions.has(tool)) {
      frames.clear();
    }
  }
  if (!complete) findings.push({ scenario, source: "harness", tool: "trace", code: "turn_incomplete" });
}
await Bun.write(join(auditDir, "findings.json"), JSON.stringify({ findings, observations }, null, 2));
console.log(JSON.stringify({ traces: paths.length, findings: findings.map(({ scenario, source, tool, code }) => ({ scenario, source, tool, code })) }));
