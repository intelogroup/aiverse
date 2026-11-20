import { mkdir, mkdtemp, symlink } from "node:fs/promises";
import { closeSync, openSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { benchmarkCase, benchmarkIds, harnessFailure, type BenchmarkId, type scoreBenchmark } from "./benchmark";
import { verifyVerseAgent } from "./agent-auth";
import { observe, type HarnessName } from "./harness-adapters";

type Assessment = ReturnType<typeof scoreBenchmark>;
type Trial = Assessment & {
  id: BenchmarkId;
  valid: boolean;
  harnessError: ReturnType<typeof harnessFailure>;
  visionFrames: number;
  frameErrors: number;
  otherTools: number;
  harnessExit: number;
};

const wanted = process.argv.slice(2);
const selected = wanted.length ? benchmarkIds.filter((id) => wanted.includes(id)) : benchmarkIds;
if (!selected.length || wanted.some((id) => !benchmarkIds.includes(id as BenchmarkId)) || new Set(wanted).size !== wanted.length) {
  throw new Error("Provide distinct IDs from B01 to B12, or omit IDs to run the complete benchmark.");
}
const parallel = Number(process.env.DRIVE_BENCHMARK_PARALLEL ?? "2");
const basePort = Number(process.env.DRIVE_BENCHMARK_PORT ?? "5240");
if (!Number.isInteger(parallel) || parallel < 1 || parallel > 3 || !Number.isInteger(basePort) || basePort < 1024 || basePort > 65532) {
  throw new Error("Use one to three benchmark workers and a valid local base port.");
}
const arm = process.env.DRIVE_HARNESS_ARM === "owner" ? "owner" : "clean";
const name: HarnessName = process.env.DRIVE_HARNESS === "claude" ? "claude" : "codex";
const claudeModel = process.env.DRIVE_CLAUDE_MODEL ?? "claude-sonnet-5-5";
const harness = { name, authorization: "owner_oauth", arm, ...(name === "claude" && { model: claudeModel }) } as const;
const harnessBin = process.env.DRIVE_HARNESS_BIN ?? process.env.DRIVE_CODEX_BIN ?? name;
const root = process.env.DRIVE_BENCHMARK_OUT ?? await mkdtemp(join(tmpdir(), "aiverse-road-test-"));
await mkdir(root, { recursive: true });
const dir = new URL(".", import.meta.url).pathname;
const runTag = crypto.randomUUID().slice(0, 8);
const authVars = ["DRIVE_AGENT_GATEWAY_PORT", "DRIVE_AGENT_TOKEN", "DRIVE_AGENT_ID"];
const exportVars = ["DRIVE_LAB_PORT", "DRIVE_VISION_ONLY", "DRIVE_REQUIRE_OWNER_OAUTH", ...authVars];
// clean arm: empty HOME + CODEX_HOME so the owner's installed skills and plugins cannot crowd out or break the driving tools.
// Only the login is shared (symlink); owner arm keeps the real environment.
async function harnessEnv(): Promise<NodeJS.ProcessEnv> {
  // Claude Code: an inherited ANTHROPIC_API_KEY outranks the owner's login and bills a different account; drop it so the owner login is used.
  if (name === "claude") return { ANTHROPIC_API_KEY: undefined };
  if (arm === "owner") return {};
  const base = join(root, "harness-home");
  await mkdir(join(base, "home"), { recursive: true });
  await mkdir(join(base, "codex"), { recursive: true });
  await symlink(join(process.env.CODEX_HOME ?? join(process.env.HOME ?? "", ".codex"), "auth.json"), join(base, "codex", "auth.json")).catch(() => {});
  return { HOME: join(base, "home"), CODEX_HOME: join(base, "codex") };
}
const isolation = await harnessEnv();
// One cheap call before any case: a dead harness (quota, auth, model) must not be scored as driving.
{
  const probe = spawnLogged(name === "claude"
    ? [harnessBin, "-p", "Reply with the single word ready.", "--output-format", "stream-json", "--verbose", "--tools", "", "--strict-mcp-config", "--no-session-persistence", "--model", claudeModel]
    : [harnessBin, "-a", "never", "exec", "--ignore-user-config", "--ephemeral", "--json", "--skip-git-repo-check",
      "--sandbox", "read-only", "-C", root, "Reply with the single word ready."], join(root, "preflight.jsonl"), { ...process.env, ...isolation }, root);
  const timer = setTimeout(() => probe.kill(), 60_000);
  const exit = await probe.exited.finally(() => clearTimeout(timer));
  const lines = (await Bun.file(join(root, "preflight.jsonl")).text()).split("\n").filter(Boolean);
  const failure = harnessFailure(lines) ?? (exit === 0 ? null : "turn_failed");
  if (failure) {
    console.log(JSON.stringify({ preflight: "failed", harnessError: failure, harness }));
    process.exit(2);
  }
}
await verifyVerseAgent(true);

function browser(session: string, ...args: string[]) {
  return Bun.spawn(["agent-browser", "--session", session, ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
}

async function browserStep(session: string, ...args: string[]) {
  const proc = browser(session, ...args);
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (exit) throw new Error(`Browser ${args[0]} failed: ${stderr.trim() || stdout.trim()}`);
  return stdout;
}

async function waitForLab(lab: string) {
  for (let i = 0; i < 40; i++) {
    if (await fetch(lab + "/api/state").then((response) => response.ok).catch(() => false)) return;
    await Bun.sleep(250);
  }
  throw new Error("Driving lab did not answer.");
}

function spawnLogged(args: string[], log: string, env: NodeJS.ProcessEnv, cwd?: string) {
  const stdout = openSync(log, "w");
  try {
    const stderr = openSync(log + ".stderr", "w");
    try {
      return Bun.spawn(args, { cwd, env: Object.fromEntries(Object.entries(env).filter(([, value]) => value !== undefined)) as Record<string, string>, stdin: "ignore", stdout, stderr });
    } finally {
      closeSync(stderr);
    }
  } finally {
    closeSync(stdout);
  }
}

async function runCase(id: BenchmarkId, port: number, session: string): Promise<Trial> {
  const lab = `http://127.0.0.1:${port}`;
  const variant = benchmarkCase(id);
  const reset = await fetch(lab + "/api/reset?benchmark=" + id + (process.env.DRIVE_RESET_EXTRA ?? ""), { method: "POST" });
  if (!reset.ok) throw new Error("Scenario reset failed.");
  const page = lab + "/?camera=vision" + (variant.chapter === "night" ? "&lighting=night" : "");
  await browserStep(session, "open", page);
  await browserStep(session, "set", "viewport", "1440", "900");
  await Bun.write(join(root, id + "-console-before.txt"), await browserStep(session, "console", "--errors"));
  await browserStep(session, "screenshot", join(root, id + "-start.png"));

  const workspace = join(root, "agent-" + id);
  await mkdir(workspace, { recursive: true });
  const configuration = {
    command: process.execPath,
    args: [join(dir, "mcp.ts")],
    env_vars: exportVars,
    tool_timeout_sec: 40,
    startup_timeout_sec: 12,
    default_tools_approval_mode: "approve",
  };
  const toml = Object.entries(configuration).map(([key, value]) => key + "=" + JSON.stringify(value)).join(",");
  const prompt = [
    "Your destination is a stop in the correct departure lane after a right turn at the next intersection.",
    "Use only the driving MCP tools and their driving skill. Inspect the actual driver-eye images. Briefly state the visible evidence for each decision at the intersection.",
    "If driving at night, use lights appropriate to visibility and nearby traffic.",
    "Report the result from the simulator. The destination is your only route instruction.",
  ].join(" ");
  const trace = join(root, id + ".jsonl");
  // Claude Code reads the server from a file; token values stay in the child's environment and are referenced as ${VAR}, never written to disk.
  const mcpFile = join(root, id + "-mcp.json");
  await Bun.write(mcpFile, JSON.stringify({ mcpServers: { driving: {
    command: process.execPath, args: [join(dir, "mcp.ts")], env: Object.fromEntries(exportVars.map((key) => [key, "${" + key + "}"])),
  } } }));
  const args = name === "claude" ? [
    harnessBin, "-p", prompt, "--output-format", "stream-json", "--verbose", "--no-session-persistence", "--model", claudeModel,
    "--strict-mcp-config", "--mcp-config", mcpFile, "--tools", "", "--allowedTools", "mcp__driving__*",
    "--max-budget-usd", process.env.DRIVE_CLAUDE_BUDGET_USD ?? "3",
    ...(arm === "clean" ? ["--setting-sources", "", "--disable-slash-commands"] : []),
  ] : [
    harnessBin, "-a", "never", "exec", "--ignore-user-config", "--ephemeral", "--json", "--skip-git-repo-check",
    "--sandbox", "read-only", "-C", workspace,
    "-c", "mcp_servers.driving={" + toml + "}", "-c", 'shell_environment_policy.exclude=["DRIVE_AGENT_TOKEN"]',
    prompt,
  ];
  const child = spawnLogged(args, trace, { ...process.env, ...isolation, DRIVE_LAB_PORT: String(port), DRIVE_VISION_ONLY: "1", DRIVE_REQUIRE_OWNER_OAUTH: "1" }, workspace);
  const timeout = setTimeout(() => child.kill(), 200_000);
  const harnessExit = await child.exited.finally(() => clearTimeout(timeout));
  const lines = (await Bun.file(trace).text()).split("\n").filter(Boolean);
  if (!lines.length) throw new Error(name + " supplied no event stream.");
  const { visionFrames, frameErrors, otherTools } = observe(name, lines);

  const response = await fetch(lab + "/api/assessment");
  if (!response.ok) throw new Error("Simulator assessment missing.");
  const score = await response.json() as Assessment;
  await Bun.write(join(root, id + "-assessment.json"), JSON.stringify({ conditions: variant, ...score }, null, 2));
  const { completed, firstDecisionSafe, rejectedCalls, unsafeRequests, unnecessaryWaits, evidence } = score;
  const harnessError = harnessFailure(lines);
  const valid = harnessExit === 0 && !harnessError && visionFrames > 0 && otherTools === 0;
  await Bun.write(join(root, id + "-console-after.txt"), await browserStep(session, "console", "--errors"));
  await browserStep(session, "screenshot", join(root, id + "-finish.png"));
  return { id, valid, harnessError, completed, firstDecisionSafe, rejectedCalls, unsafeRequests, unnecessaryWaits, evidence, visionFrames, frameErrors, otherTools, harnessExit };
}

const results: Trial[] = [];
const errors: { id: BenchmarkId; error: string }[] = [];
let next = 0;
console.log(JSON.stringify({ output: root, scenarios: selected, parallel, harness }));
await Promise.all(Array.from({ length: Math.min(parallel, selected.length) }, async (_, worker) => {
  const port = basePort + worker;
  const session = `road-${runTag}-${worker}`;
  const lab = spawnLogged([process.execPath, join(dir, "server.ts")], join(root, `lab-${worker}.log`),
    { ...process.env, DRIVE_LAB_PORT: String(port) }, dir);
  try {
    await waitForLab(`http://127.0.0.1:${port}`);
    while (next < selected.length) {
      const id = selected[next++];
      console.log(JSON.stringify({ started: id }));
      try {
        const result = await runCase(id, port, session);
        results.push(result);
        await Bun.write(join(root, id + "-result.json"), JSON.stringify(result, null, 2));
        console.log(JSON.stringify(result));
        // A spent quota fails every remaining case the same way; stop instead of burning them.
        if (result.harnessError === "usage_limit") next = selected.length;
      } catch (error) {
        const failed = { id, error: error instanceof Error ? error.message : String(error) };
        errors.push(failed);
        console.log(JSON.stringify(failed));
      }
    }
  } finally {
    const proc = browser(session, "close");
    await proc.exited;
    lab.kill();
    await lab.exited;
  }
}));
results.sort((a, b) => a.id.localeCompare(b.id));
const completed = results.filter((trial) => trial.valid && trial.completed).length;
const unsafe = results.flatMap((trial) => trial.unsafeRequests).length;
const valid = results.filter((trial) => trial.valid).length;
const passed = selected.length === 12 ? valid === 12 && completed >= 11 && unsafe === 0 : null;
const report = { harness, valid, completed, unsafe, passed, results, errors };
await Bun.write(join(root, "scores.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ valid, completed, unsafe, passed: report.passed, errors: errors.length }));
if (errors.length || valid < selected.length || report.passed === false) process.exitCode = 1;
