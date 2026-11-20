import { afterAll, beforeAll, expect, test } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

// Real lab server + real MCP server over stdio, as an agent harness would see them.
const port = 5391;
const lab = `http://127.0.0.1:${port}`;
const dir = new URL(".", import.meta.url).pathname;
const hidden = ["benchmark", "signalHead", "sign", "hazard", "actor", "oncoming", "crosswalk", "laneDivider", "evidence", "infractions", "exam"];
let server: ReturnType<typeof Bun.spawn>;
let client: Client;

beforeAll(async () => {
  server = Bun.spawn([process.execPath, "server.ts"], { cwd: dir, env: { ...process.env, DRIVE_LAB_PORT: String(port) }, stdout: "ignore", stderr: "ignore" });
  for (let i = 0; i < 40 && !(await fetch(lab + "/api/state").then((r) => r.ok).catch(() => false)); i++) await Bun.sleep(250);
  client = new Client({ name: "exam-test", version: "1" });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: [dir + "mcp.ts"],
    env: { ...process.env, DRIVE_LAB_PORT: String(port), DRIVE_VISION_ONLY: "1" } as Record<string, string>,
  }));
});
afterAll(async () => { await client.close(); server.kill(); });

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as { type: string; text?: string }[]).find((part) => part.type === "text")?.text ?? "{}";
  return JSON.parse(text) as Record<string, any>;
};
const reset = (mode: "exam" | "lesson") => fetch(`${lab}/api/reset?lesson=lane_change${mode === "exam" ? "&mode=exam" : ""}`, { method: "POST" });

test("exam mode: an unsafe lane change is not coached, hidden fields stay hidden, the infraction is scored", async () => {
  await reset("exam");
  await call("drive_enter");
  await call("drive_check", { area: "mirrors_and_blind_spot" });
  const moved = await call("drive_change_lane", { direction: "left" });
  expect(moved).not.toHaveProperty("recovery");
  const lesson = moved.lesson as Record<string, unknown>;
  for (const field of hidden) expect(lesson).not.toHaveProperty(field);
  expect(lesson).not.toHaveProperty("detectedConflict");
  const state = await (await fetch(`${lab}/api/state`)).json() as { lesson: { infractions: { code: string }[] } };
  expect(state.lesson.infractions.map((item) => item.code)).toContain("blind_spot_occupied");
}, 90_000);

test("lesson mode still coaches: refusal carries a recovery tool and the check names the conflict", async () => {
  await reset("lesson");
  await call("drive_enter");
  const checked = await call("drive_check", { area: "mirrors_and_blind_spot" });
  expect(checked.lesson).toHaveProperty("detectedConflict", "blind_spot_vehicle");
  const refused = await call("drive_change_lane", { direction: "left" });
  expect(refused.ok).toBe(false);
  expect(refused).toHaveProperty("recovery");
}, 90_000);
