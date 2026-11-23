import { beforeEach, describe, expect, test } from "bun:test";
import { _forTests, noteObservation, noteSaid, summaryText, takeTally } from "./visitTally";

const at = (x: number, z: number, more: Record<string, unknown> = {}) => ({ body: { x, z }, nearestPlace: null, insideRoom: null, heard: [], vehicle: null, ...more });
const start = new Date("2026-11-21T10:00:00Z"), end = new Date("2026-11-21T10:12:00Z");

beforeEach(() => _forTests.clear());

describe("visit tally", () => {
  test("distance is the sum of hops between observed positions; a jump past 500 m is a respawn, not walking", () => {
    noteObservation("v", at(0, 0));
    noteObservation("v", at(3, 4));
    noteObservation("v", at(3, 14));
    noteObservation("v", at(3, 1000));
    const t = takeTally("v")!;
    expect(t.distanceM).toBeCloseTo(15, 5);
  });

  test("a place counts only within 10 m, once, and a room counts as a place", () => {
    noteObservation("v", at(0, 0, { nearestPlace: { id: "stall-0", name: "Tea House", kind: "stall", dist: 30 } }));
    noteObservation("v", at(0, 0, { nearestPlace: { id: "stall-0", name: "Tea House", kind: "stall", dist: 4 } }));
    noteObservation("v", at(0, 0, { nearestPlace: { id: "stall-0", name: "Tea House", kind: "stall", dist: 2 }, insideRoom: "room-7" }));
    expect([...takeTally("v")!.places.values()]).toEqual(["Tea House", "room-7"]);
  });

  test("two places sharing a name appear once in the summary", () => {
    noteObservation("v", at(0, 0, { nearestPlace: { id: "stall-0", name: "Tea House", kind: "stall", dist: 2 } }));
    noteObservation("v", at(0, 0, { nearestPlace: { id: "door-0", name: "Tea House", kind: "door", dist: 2 } }));
    expect(summaryText(takeTally("v"), start, end, 1, 50)).toContain("Places it was near: Tea House.");
  });

  test("a heard line counts once even when the agent polls without a cursor, speakers are distinct handles", () => {
    const line = (seq: number, from: string) => ({ seq, from });
    noteObservation("v", at(0, 0, { heard: [line(1, "b-aaaa"), line(2, "b-bbbb")] }));
    noteObservation("v", at(0, 0, { heard: [line(1, "b-aaaa"), line(2, "b-bbbb"), line(3, "b-aaaa")] }));
    const t = takeTally("v")!;
    expect(t.heardLines).toBe(3);
    expect(t.speakers.size).toBe(2);
  });

  test("driving keeps the highest junction count and infraction tally seen", () => {
    noteObservation("v", at(0, 0, { vehicle: { junctionsPassed: 2, infractions: { red_light: 1, speeding: 0 } } }));
    noteObservation("v", at(0, 0, { vehicle: { junctionsPassed: 1, infractions: { red_light: 0, speeding: 0 } } }));
    const t = takeTally("v")!;
    expect(t.junctions).toBe(2);
    expect(t.infractions.red_light).toBe(1);
  });

  test("garbage observations never throw and leave the tally untouched", () => {
    for (const bad of [null, undefined, 5, "x", [], { body: { x: "1", z: null } }, { heard: [null, { seq: "a" }] }]) noteObservation("v", bad);
    const t = takeTally("v")!;
    expect(t.distanceM).toBe(0);
    expect(t.heardLines).toBe(0);
  });

  test("takeTally removes the tally; the map stays bounded", () => {
    noteSaid("a");
    expect(takeTally("a")!.said).toBe(1);
    expect(takeTally("a")).toBeNull();
    for (let i = 0; i < 5100; i++) noteSaid(`v${i}`);
    expect(_forTests.size()).toBeLessThanOrEqual(5000);
  });

  test("the summary gives duration, actions, distance, places, speech and driving, and names no one", () => {
    noteObservation("v", at(0, 0, { nearestPlace: { id: "p", name: "Tea House", kind: "stall", dist: 3 } }));
    noteObservation("v", at(30, 40, { heard: [{ seq: 1, from: "b-secret1" }], vehicle: { junctionsPassed: 3, infractions: { red_light: 1 } } }));
    noteSaid("v"); noteSaid("v");
    const text = summaryText(takeTally("v"), start, end, 87, 200);
    expect(text).toBe("Visit summary: 12 minutes, 87 of 200 actions. Moved at least 50 m. Places it was near: Tea House. Said 2 lines; heard 1 line from 1 body. Drove through 3 junctions, broke: 1 red light.");
    expect(text).not.toContain("b-secret1");
  });

  test("with no tally (gateway restarted mid-visit) the summary still gives time and actions", () => {
    expect(summaryText(null, start, end, 5, 50)).toBe("Visit summary: 12 minutes, 5 of 50 actions.");
  });

  test("an agent that never moved says so, and an empty visit stays under the note cap", () => {
    noteObservation("v", at(1, 1));
    const text = summaryText(takeTally("v"), start, end, 0, 50);
    expect(text).toContain("Did not move.");
    expect(text).toContain("No known place within reach.");
    expect(text.length).toBeLessThan(500);
  });

  test("a long place list is cut and still fits the 500-character ledger row", () => {
    for (let i = 0; i < 30; i++) noteObservation("v", at(0, 0, { nearestPlace: { id: `p${i}`, name: `Place number ${i}`, kind: "k", dist: 1 } }));
    const text = summaryText(takeTally("v"), start, end, 1, 50);
    expect(text).toContain("and 22 more");
    expect(text.length).toBeLessThan(500);
  });
});
