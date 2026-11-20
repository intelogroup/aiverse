import { expect, test } from "bun:test";
import { DrivingSimulation } from "./simulation";
import { type DriveAction } from "./protocol";
import { type LessonOptions } from "./lessons";

async function act(sim: DrivingSimulation, input: DriveAction) {
  let complete = false;
  const result = sim.actAsDriver(input).finally(() => { complete = true; });
  await Promise.resolve();
  for (let i = 0; i < 1800 && !complete; i++) { sim.tick(1 / 60); await Promise.resolve(); }
  expect(complete).toBe(true);
  return result;
}

async function ready(options: LessonOptions, signal = true) {
  const sim = new DrivingSimulation();
  sim.reset(0, "right_turn", "B01", true, { realtime: true, ...options });
  await act(sim, { command: "enter" });
  if (signal) await act(sim, { command: "signal", direction: "right" });
  return sim;
}
const approach = (sim: DrivingSimulation, speed: number) => act(sim, { command: "gas", motion: { destination: "yield_line" }, speed });
// Runs the clock until the car is no longer moving under its own command; returns the seconds it took and the lights it saw.
function run(sim: DrivingSimulation, maxSeconds = 40, each?: (t: number) => void) {
  const lights: string[] = [];
  let t = 0;
  for (; t < maxSeconds * 60; t++) {
    sim.tick(1 / 60);
    const light = sim.snapshot().lesson!.signalHead!;
    if (lights.at(-1) !== light) lights.push(light);
    each?.(t / 60);
    if (!sim.snapshot().action) break;
  }
  return { seconds: t / 60, lights, state: sim.snapshot() };
}

test("a realtime approach returns at once and the car then drives itself to the line at the chosen speed", async () => {
  const slow = await ready({});
  expect(await approach(slow, 4)).toMatchObject({ ok: true });
  expect(slow.snapshot().action).toBe("approach_lesson");
  const slowRun = run(slow);
  const fast = await ready({});
  await approach(fast, 12);
  const fastRun = run(fast);
  expect(slowRun.state.lesson!.stoppedAtLine).toBe(true);
  expect(fastRun.state.lesson!.stoppedAtLine).toBe(true);
  expect(fastRun.state.speed).toBe(0);
  expect(fastRun.seconds).toBeLessThan(slowRun.seconds * 0.6);
});

test("brake during a realtime approach stops short of the line and the approach can be repeated", async () => {
  const sim = await ready({});
  await approach(sim, 10);
  run(sim, 2.5, () => {});
  const before = sim.snapshot();
  expect(before.speed).toBeGreaterThan(3);
  const braked = await act(sim, { command: "brake" });
  expect(braked).toMatchObject({ ok: true });
  const stopped = run(sim);
  expect(stopped.state.speed).toBe(0);
  expect(stopped.state.lesson!.stoppedAtLine).toBe(false);
  expect(stopped.state.z).toBeLessThan(-3);
  expect(await approach(sim, 5)).toMatchObject({ ok: true });
});

test("while the car cruises only brake, check and signal are accepted", async () => {
  const sim = await ready({});
  await approach(sim, 6);
  run(sim, 0.5, () => {});
  expect(await act(sim, { command: "intersection_turn", direction: "right" })).toMatchObject({ ok: false, code: "maneuver_in_progress" });
  expect(await act(sim, { command: "check", check: "intersection" })).toMatchObject({ ok: true });
});

test("the light turns yellow then red on the clock while the car approaches", async () => {
  const sim = await ready({ turnsRed: true });
  expect(sim.snapshot().lesson!.signalHead).toBe("green");
  await approach(sim, 3);
  const { lights } = run(sim);
  expect(lights).toEqual(["green", "yellow", "red"]);
});

test("without the reflex a slow car that never brakes runs the red; a fast one clears the yellow legally", async () => {
  const slow = await ready({ turnsRed: true, reflex: false });
  await approach(slow, 3);
  const slowRun = run(slow);
  expect(slowRun.state.lesson!.infractions.map((item) => item.code)).toEqual(["ran_red_light"]);
  expect(slowRun.state.lesson!.stoppedAtLine).toBe(true);
  const fast = await ready({ turnsRed: true, reflex: false });
  await approach(fast, 16);
  const fastRun = run(fast);
  expect(fastRun.state.lesson!.infractions).toEqual([]);
  expect(fastRun.state.lesson!.evidence).toContain("passed_line_on_yellow");
});

test("with the reflex on the car stops at the line whatever the light does", async () => {
  const sim = await ready({ turnsRed: true, reflex: true });
  await approach(sim, 3);
  const { state } = run(sim);
  expect(state.lesson!.stoppedAtLine).toBe(true);
  expect(state.lesson!.infractions).toEqual([]);
});

test("the sense feed shows the yellow light near the line and the time left", async () => {
  const sim = await ready({ turnsRed: true });
  await approach(sim, 4);
  let seen: { light: string; etaS: number | null } | undefined;
  run(sim, 40, () => {
    const event = sim.snapshot().lesson!.senses!.horizon.find((e) => e.type === "stop_line");
    if (event && event.type === "stop_line" && event.light === "yellow" && !seen) seen = { light: event.light, etaS: event.etaS };
  });
  expect(seen?.light).toBe("yellow");
  expect(seen?.etaS).toBeGreaterThan(0);
});

test("braking on the yellow, waiting for green, then proceeding completes the turn with no infraction", async () => {
  const sim = await ready({ turnsRed: true, reflex: false });
  await approach(sim, 5);
  let braked = false;
  run(sim, 30, () => {
    if (!braked && sim.snapshot().lesson!.signalHead === "yellow") { braked = true; void sim.actAsDriver({ command: "brake" }); }
  });
  expect(braked).toBe(true);
  expect(sim.snapshot().speed).toBe(0);
  expect(sim.snapshot().lesson!.stoppedAtLine).toBe(false);
  expect(await act(sim, { command: "wait" })).toMatchObject({ ok: true });
  expect(sim.snapshot().lesson!.signalHead).toBe("green");
  await approach(sim, 5);
  expect(run(sim).state.lesson!.infractions).toEqual([]);
  await act(sim, { command: "check", check: "intersection" });
  expect(await act(sim, { command: "intersection_turn", direction: "right" })).toMatchObject({ ok: true });
  const done = sim.snapshot().lesson!;
  expect(done.passed).toBe(true);
  expect(done.infractions).toEqual([]);
});
