// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  BAR_FRONT_ZONE,
  BARTENDER_LINES,
  BARTENDER_POS,
  BARTENDER_REGREET_S,
  BartenderGreeter,
} from "./bartender";
import { angleTo } from "./walker";

const DT = 1 / 30;
const atBar: [number, number] = [BARTENDER_POS[0] + 0.5, BARTENDER_POS[1] + 2.3]; // a stool in front of him
const far: [number, number] = [BARTENDER_POS[0], BARTENDER_POS[1] + 8];

function run(g: BartenderGreeter, secs: number, movers: [number, number][]) {
  const greets: string[] = [];
  for (let t = 0; t < secs; t += DT) {
    const s = g.step(DT, movers);
    if (s.greet) greets.push(s.greet.id);
  }
  return greets;
}

describe("BartenderGreeter", () => {
  it("greets someone who comes up to the bar, once, with the welcome line", () => {
    const g = new BartenderGreeter();
    expect(run(g, 2, [far])).toEqual([]);
    expect(run(g, 5, [atBar])).toEqual(["bartender1"]);
    expect(g.engaged).toBe(true);
  });

  it("turns to face the visitor, and back home once they leave", () => {
    const g = new BartenderGreeter();
    const side: [number, number] = [BARTENDER_POS[0] + 2.5, BARTENDER_POS[1] + 1.0];
    run(g, 3, [side]);
    const want = Math.atan2(side[0] - BARTENDER_POS[0], side[1] - BARTENDER_POS[1]);
    expect(Math.abs(angleTo(g.heading, want))).toBeLessThan(0.05);
    run(g, 3, [far]);
    expect(g.engaged).toBe(false);
    expect(Math.abs(angleTo(g.heading, 0))).toBeLessThan(0.05);
  });

  it("does not chatter: leaving and coming straight back is not greeted again within the cooldown", () => {
    const g = new BartenderGreeter();
    expect(run(g, 2, [atBar])).toEqual(["bartender1"]);
    run(g, 2, [far]);
    expect(run(g, 2, [atBar])).toEqual([]); // back within 45 s
  });

  it("greets a returning visitor after the cooldown with the second line", () => {
    const g = new BartenderGreeter();
    run(g, 2, [atBar]);
    run(g, BARTENDER_REGREET_S + 1, [far]);
    expect(run(g, 2, [atBar])).toEqual(["bartender2"]);
  });

  it("greets a customer anywhere along the 12 m bar, not only right in front of him", () => {
    const g = new BartenderGreeter();
    const farEnd: [number, number] = [-35.0, -79.6]; // in front of the last stool, ~6 m from him
    expect(run(g, 3, [farEnd])).toEqual(["bartender1"]);
    const want = Math.atan2(farEnd[0] - BARTENDER_POS[0], farEnd[1] - BARTENDER_POS[1]);
    expect(Math.abs(angleTo(g.heading, want))).toBeLessThan(0.05); // and turns to that customer
  });

  it("hysteresis: a step back from the zone edge does not end it; leaving the grown zone does", () => {
    const g = new BartenderGreeter();
    run(g, 1, [atBar]);
    const justOutside: [number, number] = [BARTENDER_POS[0], BAR_FRONT_ZONE[3] + 0.5]; // 0.5 m past the zone, inside the grown one
    run(g, 2, [justOutside]);
    expect(g.engaged).toBe(true);
    run(g, 2, [far]);
    expect(g.engaged).toBe(false);
  });

  it("someone just passing across the far side of the room is not greeted", () => {
    const g = new BartenderGreeter();
    expect(run(g, 3, [[-29.5, -74.0]])).toEqual([]); // near the door, 8.7 m away
  });

  it("has a line for every greeting it can make, each with a clip id", () => {
    expect(BARTENDER_LINES.length).toBeGreaterThanOrEqual(2);
    for (const l of BARTENDER_LINES) expect(l.id).toMatch(/^bartender\d$/);
  });
});
