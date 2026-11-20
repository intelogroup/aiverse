import { expect, test } from "bun:test";
import { actionSchema, COURSE, stopLineGap, type DriveAction } from "./protocol";
import { DrivingSimulation } from "./simulation";
import { inspectDriver } from "./driver";

function harness() {
  const sim = new DrivingSimulation();
  const advance = (seconds: number) => {
    for (let i = 0; i < seconds * 60; i++) sim.tick(1 / 60);
    return sim.snapshot();
  };
  async function act(action: DriveAction, runFor: number) {
    const result = sim.act(action);
    advance(runFor);
    return result;
  }
  return { sim, advance, act };
}

test("entry opens and closes the door, then enables steering and the brake", async () => {
  const { sim, advance, act } = harness();
  expect((await sim.act({ command: "gas" })).ok).toBe(false);
  const entry = sim.act({ command: "enter" });
  const duringEntry = advance(2);
  expect(duringEntry.phase).toBe("entering");
  expect(duringEntry.door).toBeLessThan(-1);
  expect((await sim.act({ command: "gas" })).ok).toBe(false);
  advance(3);
  expect((await entry).ok).toBe(true);
  expect(sim.snapshot()).toMatchObject({ phase: "driving", door: 0, speed: 0 });
  const start = sim.snapshot();
  const gas = await act({ command: "gas", seconds: 1.6 }, 1.62);
  expect(gas.ok).toBe(true);
  expect(gas.state.speed).toBeGreaterThan(5);
  expect(gas.state.z).toBeGreaterThan(start.z + 4);
  expect(gas.state.wheelRoll).toBeGreaterThan(12);
  expect((await sim.act({ command: "exit" })).ok).toBe(false);
  const left = await act({ command: "turn_left", seconds: 0.5, amount: 0.55 }, 0.52);
  expect(left.state.heading).toBeGreaterThan(0.1);
  expect(left.state.x).toBeGreaterThan(start.x);
  const right = await act({ command: "turn_right", seconds: 0.75, amount: 0.7 }, 0.77);
  expect(right.state.heading).toBeLessThan(left.state.heading);
  expect((await act({ command: "brake" }, 1)).state.speed).toBe(0);
  expect((await act({ command: "exit" }, 4.2)).state.phase).toBe("outside");
});

test("headlight switches leave motion intact and the brake lamps remain on while the pedal is held", async () => {
  const { sim, advance, act } = harness();
  expect(await sim.actAsDriver({ command: "headlights", beam: "low" })).toMatchObject({ ok: false, code: "driver_not_seated" });
  await act({ command: "enter" }, 5);
  expect(await sim.actAsDriver({ command: "headlights", beam: "low" })).toMatchObject({
    ok: true, state: { headlights: "low", braking: false },
  });
  const gas = sim.act({ command: "gas", seconds: 1.6 });
  advance(0.4);
  expect(await sim.actAsDriver({ command: "headlights", beam: "high" })).toMatchObject({
    ok: true, state: { headlights: "high", action: "gas" },
  });
  advance(1.3);
  expect((await gas).ok).toBe(true);
  expect(await act({ command: "brake" }, 2)).toMatchObject({ ok: true, state: { speed: 0, braking: true, headlights: "high" } });
  expect(await sim.actAsDriver({ command: "headlights", beam: "off" })).toMatchObject({
    ok: true, state: { headlights: "off", braking: true },
  });
  expect(advance(0.5)).toMatchObject({ action: null, braking: true });
  await act({ command: "gas", seconds: 0.4 }, 0.5);
  expect(sim.snapshot()).toMatchObject({ braking: false });
  sim.reset();
  expect(sim.snapshot()).toMatchObject({ braking: false, headlights: "off" });
});

test("yield holds the stopped car through a real conflicting movement", async () => {
  const { sim, advance } = harness();
  const entry = sim.act({ command: "enter" });
  advance(4.7);
  await entry;
  for (let i = 0; i < 300 && !sim.snapshot().traffic.occupied; i++) advance(0.05);
  expect(sim.snapshot().traffic.occupied).toBe(true);
  const state = sim.snapshot();
  const yielding = sim.act({ command: "yield" });
  const waiting = advance(0.6);
  expect(waiting.action).toBe("yield");
  expect(waiting.yielding).toBe(true);
  expect(waiting.traffic.occupied).toBe(true);
  expect(waiting.z).toBe(state.z);
  advance(5);
  const done = await yielding;
  expect(done.ok).toBe(true);
  expect(done.state.traffic.occupied).toBe(false);
  expect(done.state.speed).toBe(0);
});

test("the course boundary stops the vehicle and identifies the interrupted action", async () => {
  const { sim, act } = harness();
  await act({ command: "enter" }, 4.7);
  await act({ command: "gas", seconds: 1.8 }, 1.85);
  const stopped = await act({ command: "turn_left", seconds: 3, amount: 1 }, 3.1);
  expect(stopped.state.speed).toBe(0);
  expect(stopped.state.x).toBeLessThanOrEqual(6.1);
  expect(sim.snapshot().events.at(-1)?.detail).toMatch(/edge/);
});

test("the contract rejects unbounded inputs and reset settles pending tool calls", async () => {
  const { sim } = harness();
  expect(actionSchema.safeParse({ command: "gas", seconds: 20 }).success).toBe(false);
  expect(actionSchema.safeParse({ command: "gas", teleport: true }).success).toBe(false);
  const entry = sim.act({ command: "enter" });
  sim.reset();
  expect(await entry).toMatchObject({ ok: false, state: { phase: "outside" } });
});

test("a stopped driver can pull away while turning, and braking cancels the input", async () => {
  const { sim, advance, act } = harness();
  await act({ command: "enter" }, 4.7);
  const turning = sim.act({ command: "turn_right", seconds: 3, throttle: 0.5 });
  const moving = advance(0.8);
  expect(moving.speed).toBeGreaterThan(1);
  expect(moving.heading).toBeLessThan(-0.04);
  const stop = sim.act({ command: "brake" });
  expect(await turning).toMatchObject({ ok: false, error: "Control released to stop the car." });
  advance(0.5);
  expect(await stop).toMatchObject({ ok: true, state: { speed: 0, action: null } });
});


test("bounded steering and gas leave the car stationary during inference and respect the yield line", async () => {
  const { sim, advance, act } = harness();
  await act({ command: "enter" }, 4.7);
  const left = await act({ command: "turn_left", motion: { degrees: 10 } }, 3);
  expect(left.state.heading).toBeCloseTo(Math.PI / 18, 4);
  expect(left.state.speed).toBe(0);
  expect(advance(8).z).toBe(left.state.z);

  const right = await act({ command: "turn_right", motion: { degrees: 10 } }, 3);
  expect(right.state.heading).toBeCloseTo(0, 4);
  expect(right.state.speed).toBe(0);

  const earlyYield = await act({ command: "yield" }, 5);
  expect(earlyYield.state.clearedToCross).toBe(false);
  const noClearance = await sim.act({ command: "gas", motion: { destination: "far_side" } });
  expect(noClearance.ok).toBe(false);
  const stopped = await act({ command: "gas", motion: { meters: 30 } }, 8);
  expect(stopped.ok).toBe(true);
  expect(stopped.state.speed).toBe(0);
  expect(stopLineGap(stopped.state.z)).toBeCloseTo(COURSE.lineMarginMeters, 2);
  expect(advance(8).z).toBe(stopped.state.z);
});

test("a delayed crossing waits for fresh traffic, then parks clear of the intersection", async () => {
  const { sim, advance, act } = harness();
  await act({ command: "enter" }, 4.7);
  const approach = await act({ command: "gas", motion: { destination: "yield_line" } }, 8);
  expect(approach.ok).toBe(true);
  expect(stopLineGap(approach.state.z)).toBeCloseTo(COURSE.lineMarginMeters, 2);

  for (let i = 0; i < 300 && !sim.snapshot().traffic.occupied; i++) advance(0.05);
  expect(sim.snapshot().traffic.occupied).toBe(true);
  const yielded = await act({ command: "yield" }, 5);
  expect(yielded).toMatchObject({ ok: true, event: { waitedForTraffic: true }, state: { clearedToCross: true, speed: 0 } });

  for (let i = 0; i < 300 && !sim.snapshot().traffic.occupied; i++) advance(0.05);
  expect(sim.snapshot().traffic.occupied).toBe(true);
  const crossing = sim.act({ command: "gas", motion: { destination: "far_side" } });
  expect(advance(0.4)).toMatchObject({ z: approach.state.z, speed: 0, action: "gas" });
  advance(14);
  const parked = await crossing;
  expect(parked).toMatchObject({ ok: true, event: { waitedForTraffic: true }, state: { clearedToCross: false, speed: 0 } });
  expect(parked.state.z).toBeCloseTo(COURSE.parkZ, 2);
  expect(parked.state.events.some((event) => event.status === "blocked")).toBe(false);
});


test("driver action availability follows the actual crossing milestones", async () => {
  const { sim, advance } = harness();
  async function drive(action: DriveAction, seconds: number) {
    const result = sim.actAsDriver(action);
    advance(seconds);
    return result;
  }
  expect(inspectDriver(sim.snapshot()).availableTools).toEqual(["drive_observe", "drive_enter"]);
  expect(await sim.actAsDriver({ command: "yield" })).toMatchObject({
    ok: false, code: "driver_not_seated", recovery: { tool: "drive_enter" },
  });
  await drive({ command: "enter" }, 4.7);
  const before = sim.snapshot();
  for (const action of [{ command: "yield" }, { command: "gas", motion: { destination: "far_side" } }] as const) {
    expect(await sim.actAsDriver(action)).toMatchObject({
      ok: false, recovery: { tool: "drive_approach", arguments: {} },
    });
    expect(sim.snapshot()).toEqual(before);
  }
  expect(await sim.actAsDriver({ command: "gas", seconds: 2 })).toMatchObject({
    ok: false, code: "bounded_motion_required",
  });

  const turn = await drive({ command: "turn_left", motion: { degrees: 10 } }, 3);
  expect(inspectDriver(turn.state).availableTools).not.toContain("drive_approach");
  expect(await sim.actAsDriver({ command: "gas", motion: { destination: "yield_line" } })).toMatchObject({
    ok: false, code: "heading_misaligned", recovery: { tool: "drive_turn_right", arguments: { degrees: 10 } },
  });
  await drive({ command: "turn_right", motion: { degrees: 10 } }, 3);
  const approach = await drive({ command: "gas", motion: { destination: "yield_line" } }, 8);
  expect(inspectDriver(approach.state)).toMatchObject({ crossingStatus: "at_line", next: { tool: "drive_yield" } });
  expect(inspectDriver(approach.state).availableTools).not.toContain("drive_cross");

  const yielded = await drive({ command: "yield" }, 5);
  expect(inspectDriver(yielded.state)).toMatchObject({ crossingStatus: "yielded", next: { tool: "drive_cross" } });
  expect(inspectDriver(yielded.state).availableTools).not.toContain("drive_yield");
  const crossed = await drive({ command: "gas", motion: { destination: "far_side" } }, 15);
  expect(inspectDriver(crossed.state)).toMatchObject({ crossingStatus: "past" });
  expect(crossed.state.speed).toBe(0);
});
