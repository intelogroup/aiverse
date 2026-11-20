import { expect, test } from "bun:test";
import { assessAttempt, benchmarkCase, benchmarkIds, harnessFailure, scoreBenchmark, type Attempt } from "./benchmark";
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
  expect(trafficCheck.ok && trafficCheck.event.detail).toContain("set before this lane check");
  expect(await drive(change)).toMatchObject({ ok: false, code: "signal_required" });
  await drive(signal);
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
