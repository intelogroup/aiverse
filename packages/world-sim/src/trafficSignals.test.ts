import { describe, expect, test } from "bun:test";
import lamps from "../../../apps/console/src/features/world/signalLamps.json";
import { ALL_RED, CYCLE, JUNCTIONS, YELLOW, flashOn, junctionAt, signalState } from "./trafficSignals";

const times = (j: (typeof JUNCTIONS)[number]) => Array.from({ length: CYCLE * 10 }, (_, i) => i / 10 + 1234.56);

describe("trafficSignals", () => {
  test("junction list matches the generated lamp manifest", () => {
    expect(JUNCTIONS.length).toBe(lamps.junctions.length);
    for (const j of JUNCTIONS) expect(lamps.junctions[j.id]!.rect).toEqual(j.rect);
  });

  test("conflicting approaches are never green or yellow together; all-red gap is honoured", () => {
    for (const j of JUNCTIONS) {
      let sawBothRed = false;
      for (const t of times(j)) {
        const s = signalState(j, t);
        expect(s.ns !== "red" && s.ew !== "red").toBe(false);
        if (s.ns === "red" && s.ew === "red") sawBothRed = true;
      }
      expect(sawBothRed).toBe(true);
    }
  });

  test("each phase runs green -> yellow -> red with the planned durations", () => {
    const j = JUNCTIONS.find((x) => x.green.ns === 28)!;   // avenue junction
    const start = j.offset + 1000 * CYCLE;
    expect(signalState(j, start + 1).ns).toBe("green");
    expect(signalState(j, start + 28 + 1).ns).toBe("yellow");
    expect(signalState(j, start + 28 + YELLOW + 0.1).ns).toBe("red");
    expect(signalState(j, start + 28 + YELLOW + ALL_RED - 0.1).ew).toBe("red");
    expect(signalState(j, start + 28 + YELLOW + ALL_RED + 0.1).ew).toBe("green");
  });

  test("avenue gets the longer green; side streets split evenly", () => {
    const avenue = JUNCTIONS.find((j) => j.rect[0] === -10)!;      // x street c=0 (w 20)
    expect(avenue.green.ns).toBeGreaterThan(avenue.green.ew);
    const side = JUNCTIONS.find((j) => j.rect[0] === 60 && j.rect[1] === 60)!;
    expect(side.green.ns).toBe(side.green.ew);
  });

  test("pedestrian signal: WALK, then flashing DON'T WALK through green and yellow, then steady", () => {
    const j = JUNCTIONS[0]!;
    const start = j.offset + 500 * CYCLE;
    expect(signalState(j, start + 1).pedNs).toBe("walk");
    expect(signalState(j, start + 10).pedNs).toBe("flash");
    expect(signalState(j, start + j.green.ns + 1).pedNs).toBe("flash");
    expect(signalState(j, start + j.green.ns + YELLOW + 1).pedNs).toBe("dont");
    for (const t of times(j)) { const s = signalState(j, t); if (s.pedNs === "walk") expect(s.ns).toBe("green"); if (s.pedEw === "walk") expect(s.ew).toBe("green"); }
  });

  test("green wave: next junction up the avenue turns green one travel time later", () => {
    const up = JUNCTIONS.filter((j) => j.rect[0] === -10 && j.rect[2] === 10).sort((a, b) => a.rect[1] - b.rect[1]);
    expect(up.length).toBeGreaterThan(1);
    const [a, b] = [up[up.length - 2]!, up[up.length - 1]!];
    const dt = ((b.offset - a.offset) % CYCLE + CYCLE) % CYCLE;
    expect(dt).toBeCloseTo((b.rect[1] + 5 - (a.rect[1] + 5)) / 11 % CYCLE, 0);
  });

  test("pure and continuous: same instant -> same state, flash alternates, lookup by point", () => {
    const j = JUNCTIONS[3]!;
    expect(signalState(j, 99999.3)).toEqual(signalState(j, 99999.3));
    expect(signalState(j, 3.2).changesIn).toBeGreaterThan(0);
    expect(flashOn(10.1)).not.toBe(flashOn(10.6));
    expect(junctionAt(65, 65)?.rect).toEqual([60, 60, 70, 70]);
    expect(junctionAt(0, 0)).toBeNull();
  });
});
