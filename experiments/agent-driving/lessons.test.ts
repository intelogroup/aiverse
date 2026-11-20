import { expect, test } from "bun:test";
import { DrivingSimulation } from "./simulation";
import { COURSE, DRIVER, type DriveAction, type LessonId } from "./protocol";
import { LESSON_ROAD } from "./lessons";

async function act(sim: DrivingSimulation, input: DriveAction) {
  let complete = false;
  const result = sim.actAsDriver(input).finally(() => { complete = true; });
  await Promise.resolve();
  for (let i = 0; i < 1800 && !complete; i++) {
    sim.tick(1 / 60);
    await Promise.resolve();
  }
  expect(complete).toBe(true);
  return result;
}

async function start(lesson: LessonId) {
  const sim = new DrivingSimulation();
  sim.reset(0, lesson);
  expect(await act(sim, { command: "enter" })).toMatchObject({ ok: true, state: { phase: "driving" } });
  return sim;
}

test("lane change requires a clear adjacent lane, a fresh check, and a signal", async () => {
  const sim = await start("lane_change");
  const change = { command: "change_lane", direction: "left" } as const;
  const check = { command: "check", check: "mirrors_and_blind_spot" } as const;
  expect(await act(sim, { ...change, direction: "right" })).toMatchObject({ ok: false, code: "no_adjacent_lane" });
  expect(await act(sim, change)).toMatchObject({ ok: false, code: "blind_spot_occupied" });
  expect(await act(sim, { command: "wait" })).toMatchObject({ ok: true });
  expect(await act(sim, change)).toMatchObject({ ok: false, code: "check_target_lane" });
  await act(sim, check);
  expect(await act(sim, change)).toMatchObject({
    ok: false, code: "signal_required", recovery: { tool: "drive_signal", arguments: { direction: "left" } },
  });
  await act(sim, { command: "signal", direction: "left" });
  expect(await act(sim, change)).toMatchObject({
    ok: true, state: { speed: 0, lesson: { passed: true, indicator: null, laneDivider: "broken_white" } },
  });
  expect(sim.snapshot().x).toBeCloseTo(LESSON_ROAD.laneCenter, 2);
  expect(sim.snapshot().heading).toBeCloseTo(0, 3);
});

test("the mirror course allows a right lane change and stays aligned", async () => {
  const sim = await start("lane_change_right");
  expect(sim.snapshot().lesson?.actor?.x).toBe(-LESSON_ROAD.laneCenter);
  await act(sim, { command: "wait" });
  await act(sim, { command: "check", check: "mirrors_and_blind_spot" });
  await act(sim, { command: "signal", direction: "right" });
  expect(await act(sim, { command: "change_lane", direction: "right" })).toMatchObject({
    ok: true, state: { speed: 0, lesson: { passed: true } },
  });
  expect(sim.snapshot().x).toBeCloseTo(-LESSON_ROAD.laneCenter, 2);
  expect(sim.snapshot().heading).toBeCloseTo(0, 3);
});

test("three-point turn stops between forward, reverse, and forward with a fresh safety check", async () => {
  const sim = await start("three_point");
  const leg = { command: "three_point" } as const;
  const check = { command: "check", check: "both_directions" } as const;
  const signal = { command: "signal", direction: "left" } as const;
  await act(sim, signal);
  expect(await act(sim, leg)).toMatchObject({ ok: false, code: "check_each_leg" });
  await act(sim, check);
  expect(await act(sim, leg)).toMatchObject({ ok: true, state: { speed: 0, lesson: { gear: "drive", legs: 1 } } });
  expect(COURSE.halfRoad - sim.snapshot().x - DRIVER.halfLength).toBeCloseTo(0.6, 2);
  await act(sim, check);
  expect(await act(sim, leg)).toMatchObject({ ok: false, code: "check_each_leg" });
  await act(sim, { command: "check", check: "rear_and_both_directions" });
  const rollBeforeReverse = sim.snapshot().wheelRoll;
  expect(await act(sim, leg)).toMatchObject({ ok: true, state: { speed: 0, lesson: { gear: "reverse", legs: 2 } } });
  expect(sim.snapshot().wheelRoll).toBeLessThan(rollBeforeReverse);
  await act(sim, check);
  expect(await act(sim, leg)).toMatchObject({ ok: false, code: "signal_required" });
  await act(sim, signal);
  expect(await act(sim, leg)).toMatchObject({ ok: true, state: { speed: 0, lesson: { gear: "drive", legs: 3, passed: true } } });
  expect(sim.snapshot().x).toBeCloseTo(LESSON_ROAD.laneCenter, 2);
  expect(sim.snapshot().heading).toBeCloseTo(Math.PI, 3);
});

for (const lesson of ["right_turn", "left_turn", "no_turn_on_red", "crosswalk"] as const) {
  test(`${lesson} verifies a full stop, control and right of way before the proper exit lane`, async () => {
    const sim = await start(lesson);
    const direction = lesson === "left_turn" ? "left" : "right";
    const turn = { command: "intersection_turn", direction } as const;
    const check = { command: "check", check: "intersection" } as const;
    const wait = { command: "wait" } as const;
    expect(await act(sim, turn)).toMatchObject({ ok: false, code: "stop_before_line" });
    await act(sim, { command: "signal", direction });
    expect(await act(sim, { command: "gas", motion: { destination: "yield_line" } })).toMatchObject({
      ok: true, state: { speed: 0, lesson: { stoppedAtLine: true } },
    });
    const stop = sim.snapshot();
    expect(COURSE.yieldLineZ - stop.z - DRIVER.halfLength).toBeCloseTo(COURSE.lineMarginMeters, 2);
    if (lesson === "no_turn_on_red" || lesson === "crosswalk") {
      expect(await act(sim, turn)).toMatchObject({ ok: false, code: "posted_no_turn_on_red" });
      expect(await act(sim, { command: "gas", seconds: 1 })).toMatchObject({ ok: false, code: "use_lesson_controls" });
      await act(sim, wait);
      expect(sim.snapshot().z).toBe(stop.z);
    }
    if (lesson === "crosswalk") {
      expect(sim.snapshot().lesson).toMatchObject({ signalHead: "green", actor: { kind: "pedestrian" } });
      expect(await act(sim, turn)).toMatchObject({ ok: false, code: "crosswalk_occupied" });
      await act(sim, wait);
      expect(sim.snapshot().z).toBe(stop.z);
    }
    if (lesson === "left_turn") {
      expect(await act(sim, turn)).toMatchObject({ ok: false, code: "yield_to_oncoming" });
      await act(sim, wait);
    }
    expect(await act(sim, turn)).toMatchObject({ ok: false, code: "check_intersection" });
    expect(await act(sim, { command: "check", check: "both_directions" })).toMatchObject({
      ok: false, code: "wrong_check_area", recovery: { tool: "drive_check", arguments: { area: "intersection" } },
    });
    await act(sim, check);
    expect(await act(sim, turn)).toMatchObject({ ok: true, state: { speed: 0, lesson: { passed: true, indicator: null } } });
    const final = sim.snapshot();
    expect(final.z).toBeCloseTo(COURSE.crossingZ + (direction === "left" ? 1 : -1) * LESSON_ROAD.laneCenter, 2);
    expect(final.heading).toBeCloseTo((direction === "left" ? 1 : -1) * Math.PI / 2, 3);
    expect(Math.abs(final.x)).toBeGreaterThan(LESSON_ROAD.curb + DRIVER.halfLength);
  });
}

test("lane change accepts signal-then-check and check-then-signal; a lane change with no check is refused", async () => {
  const check = { command: "check", check: "mirrors_and_blind_spot" } as const;
  const change = { command: "change_lane", direction: "left" } as const;
  const ready = async (order: "signal-first" | "check-first") => {
    const sim = new DrivingSimulation();
    sim.reset(0, "lane_change");
    await act(sim, { command: "enter" });
    await act(sim, { command: "wait" });
    if (order === "signal-first") { await act(sim, { command: "signal", direction: "left" }); await act(sim, check); }
    else { await act(sim, check); await act(sim, { command: "signal", direction: "left" }); }
    return sim;
  };
  expect(await act(await ready("signal-first"), change)).toMatchObject({ ok: true });
  expect(await act(await ready("check-first"), change)).toMatchObject({ ok: true });
  // No check yet (and the target lane is still occupied): refused. The stale-check path is covered by check_target_lane above.
  const stale = new DrivingSimulation();
  stale.reset(0, "lane_change");
  await act(stale, { command: "enter" });
  await act(stale, { command: "signal", direction: "left" });
  expect(await act(stale, change)).toMatchObject({ ok: false });
});
