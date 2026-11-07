import { describe, expect, it } from "vitest";
import {
  KEEPER_ENTER_RADIUS,
  KEEPER_EXIT_RADIUS,
  KEEPER_TURN_RATE,
  createKeeper,
  stepKeeper,
} from "./keeper";
import { angleTo } from "./walker";

const SELF: [number, number] = [-17, 15.4];
const DT = 1 / 30;

/** A mover `d` metres from the keeper along +x. */
const at = (d: number): [number, number] => [SELF[0] + d, SELF[1]];

describe("keeper trigger", () => {
  it("starts idle, facing home", () => {
    const k = createKeeper(Math.PI);
    expect(k.talking).toBe(false);
    expect(k.heading).toBe(Math.PI);
  });

  it("enter fires once when a mover crosses the enter radius", () => {
    const k = createKeeper(0);
    const far = stepKeeper(k, DT, SELF, [at(5)]);
    expect(far).toEqual({ entered: false, exited: false });
    expect(k.talking).toBe(false);

    const edge = stepKeeper(k, DT, SELF, [at(KEEPER_ENTER_RADIUS)]);
    expect(edge.entered).toBe(true);
    expect(k.talking).toBe(true);

    // Still inside: no second enter edge.
    const again = stepKeeper(k, DT, SELF, [at(1.5)]);
    expect(again).toEqual({ entered: false, exited: false });
    expect(k.talking).toBe(true);
  });

  it("just outside the enter radius stays idle", () => {
    const k = createKeeper(0);
    const ev = stepKeeper(k, DT, SELF, [at(KEEPER_ENTER_RADIUS + 0.01)]);
    expect(ev.entered).toBe(false);
    expect(k.talking).toBe(false);
  });

  it("hysteresis: the band between radii holds whichever state it is in", () => {
    const band = (KEEPER_ENTER_RADIUS + KEEPER_EXIT_RADIUS) / 2;

    const idle = createKeeper(0);
    stepKeeper(idle, DT, SELF, [at(band)]);
    expect(idle.talking).toBe(false);

    const talking = createKeeper(0);
    stepKeeper(talking, DT, SELF, [at(1)]);
    expect(talking.talking).toBe(true);
    const ev = stepKeeper(talking, DT, SELF, [at(band)]);
    expect(ev).toEqual({ entered: false, exited: false });
    expect(talking.talking).toBe(true);
  });

  it("exit fires past the exit radius, and when the last mover vanishes", () => {
    const k = createKeeper(0);
    stepKeeper(k, DT, SELF, [at(1)]);
    const atEdge = stepKeeper(k, DT, SELF, [at(KEEPER_EXIT_RADIUS)]);
    expect(atEdge.exited).toBe(false);
    expect(k.talking).toBe(true);
    const past = stepKeeper(k, DT, SELF, [at(KEEPER_EXIT_RADIUS + 0.01)]);
    expect(past.exited).toBe(true);
    expect(k.talking).toBe(false);

    stepKeeper(k, DT, SELF, [at(1)]);
    expect(k.talking).toBe(true);
    const gone = stepKeeper(k, DT, SELF, []);
    expect(gone.exited).toBe(true);
    expect(k.talking).toBe(false);
  });

  it("faces the nearest mover, not just any mover", () => {
    const k = createKeeper(0);
    // Near mover due -z of the keeper (bearing pi), far mover due +x (bearing pi/2).
    const near: [number, number] = [SELF[0], SELF[1] - 1.5];
    const far: [number, number] = [SELF[0] + 2.0, SELF[1]];
    // Many steps so the capped turn can complete.
    for (let i = 0; i < 120; i++) stepKeeper(k, DT, SELF, [far, near]);
    expect(k.talking).toBe(true);
    expect(Math.abs(angleTo(k.heading, Math.PI))).toBeLessThan(0.01);
  });

  it("turn is capped and takes the short way across the seam", () => {
    const k = createKeeper(Math.PI - 0.05);
    // Mover at bearing -pi + 0.05: the short way is +0.1 rad, not -(2pi - 0.1).
    const mover: [number, number] = [SELF[0] + Math.sin(-Math.PI + 0.05) * 1.5, SELF[1] + Math.cos(-Math.PI + 0.05) * 1.5];
    const before = k.heading;
    stepKeeper(k, DT, SELF, [mover]);
    const turned = angleTo(before, k.heading);
    expect(turned).toBeGreaterThan(0);
    expect(turned).toBeLessThanOrEqual(KEEPER_TURN_RATE * DT + 1e-9);
  });

  it("after the mover leaves, the heading eases back home", () => {
    const home = Math.PI;
    const k = createKeeper(home);
    // Talk to a mover due +x (bearing pi/2) long enough to face them fully.
    for (let i = 0; i < 120; i++) stepKeeper(k, DT, SELF, [at(1.5)]);
    expect(Math.abs(angleTo(k.heading, Math.PI / 2))).toBeLessThan(0.01);
    // Mover leaves; heading returns home at the capped rate and settles there.
    for (let i = 0; i < 120; i++) stepKeeper(k, DT, SELF, []);
    expect(k.talking).toBe(false);
    expect(Math.abs(angleTo(k.heading, home))).toBeLessThan(0.01);
  });

  it("an idle keeper with nobody near keeps his home heading", () => {
    const k = createKeeper(1.25);
    for (let i = 0; i < 60; i++) stepKeeper(k, DT, SELF, [at(9)]);
    expect(k.talking).toBe(false);
    expect(k.heading).toBeCloseTo(1.25, 9);
  });
});
