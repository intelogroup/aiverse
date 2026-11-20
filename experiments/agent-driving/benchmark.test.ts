import { expect, test } from "bun:test";
import { assessAttempt, benchmarkCase, benchmarkIds, examScore, harnessFailure, scoreBenchmark, type Attempt } from "./benchmark";
import { DrivingSimulation } from "./simulation";
import { type DriveAction } from "./protocol";

async function act(sim: DrivingSimulation, attempts: Attempt[], input: DriveAction) {
  let settled = false;
  const before = sim.snapshot();
  const result = sim.actAsDriver(input).finally(() => { settled = true; });
  for (let i = 0; i < 1800 && !settled; i++) {
    sim.tick(1 / 60);
    await Promise.resolve();
  }
  expect(settled).toBe(true);
  const response = await result;
  attempts.push(assessAttempt(input, before, response));
  return response;
}

const check = { command: "check", check: "intersection" } as const;
const signal = { command: "signal", direction: "right" } as const;
const turn = { command: "intersection_turn", direction: "right" } as const;
const wait = { command: "wait" } as const;

for (const id of benchmarkIds) {
  test(`${id} admits a clean route through its actual layout and control conditions`, async () => {
    const sim = new DrivingSimulation();
    const variant = benchmarkCase(id);
    sim.reset(0, "right_turn", id);
    const attempts: Attempt[] = [];
    const drive = (input: DriveAction) => act(sim, attempts, input);
    expect((await drive({ command: "enter" })).ok).toBe(true);
    if (variant.chapter === "route") {
      expect((await drive({ command: "check", check: "mirrors_and_blind_spot" })).ok).toBe(true);
      expect((await drive(signal)).ok).toBe(true);
      expect((await drive({ command: "change_lane", direction: "right" })).ok).toBe(true);
    }
    if (variant.preselectedHigh) {
      expect(sim.snapshot()).toMatchObject({ headlights: "high", lesson: { oncoming: { kind: "vehicle" } } });
      expect((await drive({ command: "headlights", beam: "low" })).ok).toBe(true);
    } else if (variant.chapter === "night") expect((await drive({ command: "headlights", beam: "high" })).ok).toBe(true);
    expect((await drive(signal)).ok).toBe(true);
    expect((await drive({ command: "approach_lesson" })).ok).toBe(true);
    if (variant.oncoming) {
      expect(sim.snapshot().lesson?.oncoming?.kind).toBe("vehicle");
      expect((await drive({ command: "headlights", beam: "low" })).ok).toBe(true);
    }
    if (variant.preselectedHigh) {
      expect(sim.snapshot().lesson?.evidence).toContain("dimmed_for_oncoming");
      expect((await drive(wait)).ok).toBe(true);
      expect(sim.snapshot().lesson?.oncoming).toBeUndefined();
    }
    if (variant.posted && variant.signal === "red") expect((await drive(wait)).ok).toBe(true);
    if (variant.pedestrian) expect((await drive(wait)).ok).toBe(true);
    expect((await drive(check)).ok).toBe(true);
    expect((await drive(turn)).ok).toBe(true);
    expect(sim.snapshot().z).toBeCloseTo(6.1 + variant.shift, 2);
    expect(scoreBenchmark(sim.snapshot(), attempts)).toMatchObject({
      completed: true, firstDecisionSafe: true, unsafeRequests: [], rejectedCalls: 0, unnecessaryWaits: 0,
    });
    if (!variant.posted && variant.signal === "red") {
      expect(sim.snapshot().lesson?.evidence).toContain("permitted_right_on_red");
    }
  });
}

test("a refused move stays in the score after recovery and a clear wait is separate", async () => {
  const sim = new DrivingSimulation();
  sim.reset(0, "right_turn", "B04");
  const attempts: Attempt[] = [];
  const drive = (input: DriveAction) => act(sim, attempts, input);
  await drive({ command: "enter" });
  await drive(signal);
  await drive({ command: "approach_lesson" });
  const stopped = sim.snapshot();
  expect(await drive(turn)).toMatchObject({ ok: false, code: "crosswalk_occupied" });
  expect(sim.snapshot().z).toBe(stopped.z);
  await drive(wait);
  expect(await drive(wait)).toMatchObject({ ok: false, code: "nothing_to_yield_to" });
  await drive(check);
  await drive(turn);
  expect(scoreBenchmark(sim.snapshot(), attempts)).toMatchObject({
    completed: true, firstDecisionSafe: false, unsafeRequests: ["crosswalk_occupied"], rejectedCalls: 2, unnecessaryWaits: 1,
  });
});

test("the lane check explains why a previously set signal needs to be renewed", async () => {
  const sim = new DrivingSimulation();
  sim.reset(0, "right_turn", "B07");
  const attempts: Attempt[] = [];
  const drive = (input: DriveAction) => act(sim, attempts, input);
  const change = { command: "change_lane", direction: "right" } as const;
  await drive({ command: "enter" });
  await drive(signal);
  expect(await drive({ command: "approach_lesson" })).toMatchObject({
    ok: false, code: "wrong_turn_lane", recovery: { tool: "drive_look", arguments: { view: "road" } },
  });
  const trafficCheck = await drive({ command: "check", check: "mirrors_and_blind_spot" });
  expect(trafficCheck.ok).toBe(true);
  // A signal already lit from the approach stays valid after a fresh mirror/blind-spot check.
  expect(await drive(change)).toMatchObject({ ok: true, state: { lesson: { laneChanged: true } } });
});

test("night rules block driving unlit and high beams near the approaching driver", async () => {
  const sim = new DrivingSimulation();
  sim.reset(0, "right_turn", "B10");
  const attempts: Attempt[] = [];
  const drive = (input: DriveAction) => act(sim, attempts, input);
  await drive({ command: "enter" });
  await drive(signal);
  await drive({ command: "headlights", beam: "off" });
  expect(await drive({ command: "approach_lesson" })).toMatchObject({ ok: false, code: "headlights_required" });
  expect(await drive({ command: "headlights", beam: "high" })).toMatchObject({ ok: false, code: "high_beam_conflict" });
  await drive({ command: "headlights", beam: "low" });
  await drive({ command: "approach_lesson" });
  await drive(check);
  expect(await drive({ command: "headlights", beam: "high" })).toMatchObject({ ok: false, code: "high_beam_conflict" });
  await drive(turn);
  expect(scoreBenchmark(sim.snapshot(), attempts)).toMatchObject({
    completed: true, firstDecisionSafe: false, unsafeRequests: ["headlights_required", "high_beam_conflict", "high_beam_conflict"],
  });
});

test("a harness out of quota is classified as a harness failure, not a driving result", () => {
  const quota = [
    JSON.stringify({ type: "turn.started" }),
    JSON.stringify({ type: "error", message: "You've hit your usage limit. Upgrade to Pro" }),
    JSON.stringify({ type: "turn.failed", error: { message: "You've hit your usage limit." } }),
  ];
  expect(harnessFailure(quota)).toBe("usage_limit");
  expect(harnessFailure([JSON.stringify({ type: "turn.failed", error: { message: "boom" } })])).toBe("turn_failed");
  expect(harnessFailure([JSON.stringify({ type: "item.completed", item: { type: "error", message: "Skill descriptions were shortened" } })])).toBeNull();
  expect(harnessFailure(["not json"])).toBeNull();
});

async function runRunner(fakeCodex: string) {
  const { mkdtemp, writeFile, chmod } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const out = await mkdtemp(join(tmpdir(), "drive-preflight-"));
  const bin = join(out, "fake-codex");
  await writeFile(bin, "#!/bin/sh\n" + fakeCodex);
  await chmod(bin, 0o755);
  const env = { ...process.env, DRIVE_HARNESS: "opencode", DRIVE_HARNESS_BIN: bin, DRIVE_BENCHMARK_OUT: out } as Record<string, string | undefined>;
  for (const key of ["DRIVE_AGENT_GATEWAY_PORT", "DRIVE_AGENT_TOKEN", "DRIVE_AGENT_ID"]) delete env[key];
  const proc = Bun.spawn([process.execPath, new URL("./benchmark-runner.ts", import.meta.url).pathname, "B01"], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  return { stdout, stderr, exit };
}

test("runner preflight stops on a spent harness quota before any case starts", async () => {
  const { stdout, exit } = await runRunner(`echo '{"type":"error","message":"You have hit your usage limit."}'\nexit 1\n`);
  expect(exit).toBe(2);
  expect(stdout).toContain('"preflight":"failed"');
  expect(stdout).toContain("usage_limit");
  expect(stdout).not.toContain("started");
});

test("runner preflight passes a healthy harness on to the identity check", async () => {
  const { stdout, stderr, exit } = await runRunner(`echo '{"type":"turn.completed"}'\nexit 0\n`);
  expect(stdout).not.toContain('"preflight":"failed"');
  expect(exit).not.toBe(2);
  expect(stderr).toContain("owner-authorized OAuth grant");
});

test("exam score: clean pass is 1, each infraction lowers it, a critical one fails the exam, no completion scores 0", async () => {
  const clean = new DrivingSimulation();
  clean.reset(0, "right_turn", "B01", true);
  const attempts: Attempt[] = [];
  const drive = (input: DriveAction) => act(clean, attempts, input);
  await drive({ command: "enter" });
  await drive({ command: "signal", direction: "right" });
  await drive({ command: "approach_lesson" });
  await drive({ command: "check", check: "intersection" });
  await drive({ command: "intersection_turn", direction: "right" });
  expect(examScore(clean.snapshot(), attempts).exam).toMatchObject({ completed: true, score: 1, passed: true, critical: [] });

  const reckless = new DrivingSimulation();
  reckless.reset(0, "right_turn", "B04", true); // green light, pedestrian in the crosswalk
  const bad: Attempt[] = [];
  const go = (input: DriveAction) => act(reckless, bad, input);
  await go({ command: "enter" });
  await go({ command: "approach_lesson" });
  await go({ command: "intersection_turn", direction: "right" });
  const exam = examScore(reckless.snapshot(), bad).exam;
  expect(exam.critical).toContain("crosswalk_occupied");
  expect(exam.passed).toBe(false);
  expect(exam.score).toBeLessThan(0.5);

  const idle = new DrivingSimulation();
  idle.reset(0, "right_turn", "B01", true);
  expect(examScore(idle.snapshot()).exam).toMatchObject({ completed: false, score: 0, passed: false });
});

test("the runner refuses Codex: it is off limits for the driving lab", async () => {
  const proc = Bun.spawn([process.execPath, new URL("./benchmark-runner.ts", import.meta.url).pathname, "B01"], {
    env: { ...process.env, DRIVE_HARNESS: "codex" }, stdout: "pipe", stderr: "pipe",
  });
  const [stderr, exit] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  expect(exit).not.toBe(0);
  expect(stderr).toContain("Codex is off limits");
});

test("OpenCode's model-unavailable error is a provider failure", () => {
  expect(harnessFailure(JSON.stringify({ type: "error", error: { type: "provider.no-route", message: "Model unavailable: openrouter/x/y" } }).split("\n"))).toBe("provider_unavailable");
});
