import { describe, expect, it } from "vitest";
import { InteractController } from "./interactables";
import { danceLevel, toyDefs, toyKindOf, toyPhrase } from "./toys";

describe("toys", () => {
  it("defines four unique interactables with usable stand points", () => {
    const defs = toyDefs();
    expect(new Set(defs.map(d => d.id)).size).toBe(4);
    for (const d of defs) {
      expect(toyKindOf(d)).not.toBeNull();
      expect(Math.hypot(d.stand[0] - d.pos[0], d.stand[1] - d.pos[2])).toBeGreaterThan(1);
      expect(toyPhrase(toyKindOf(d)!).length).toBeGreaterThan(5);
    }
  });
  it("register under their own source without wiping rooms", () => {
    const c = new InteractController();
    c.register([{ ...toyDefs()[0]!, id: "room-radio", kind: "radio" }], "rooms");
    c.register(toyDefs(), "toys");
    expect(c.list().map(d => d.id)).toContain("room-radio");
    expect(c.list()).toHaveLength(5);
  });
  it("counts live actors near a point", () => {
    const c = new InteractController();
    c.observe("a", 0, 0); c.observe("b", 1, 1); c.observe("c", 30, 30);
    expect(c.actorsNear(0, 0, 3)).toBe(2);
  });
  it("dance level grows with dancers and is capped", () => {
    expect(danceLevel(false, 5, false)).toBe(0);
    expect(danceLevel(true, 0, false)).toBe(1);
    expect(danceLevel(true, 2, false)).toBeGreaterThan(danceLevel(true, 1, false));
    expect(danceLevel(true, 50, false)).toBe(4);
    expect(danceLevel(false, 0, true)).toBe(1);
  });
});
