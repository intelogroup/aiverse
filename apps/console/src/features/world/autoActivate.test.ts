import { describe, expect, it } from "vitest";
import { InteractController, type InteractableDef } from "./interactables";
import { autoActivateTarget, AUTO_ACTIVATE_REARM } from "./scout";
import { eggInteractable, haloLevel, haloState } from "./EasterEggs";

const egg = eggInteractable({ id: "egg-t", district: "bazaar", position: [10, 0.2, 5], rotationY: 0, scale: 1, hint: "" });

describe("egg interactable", () => {
  it("stands in front of the egg and faces it", () => {
    expect(egg.kind).toBe("egg");
    expect(egg.stand[0]).toBeCloseTo(10);
    expect(egg.stand[1]).toBeCloseTo(5.7);
    expect(Math.cos(egg.heading)).toBeLessThan(0); // faces -z, toward the egg
  });
});

describe("controller sources", () => {
  it("registering one source keeps the others", () => {
    const c = new InteractController();
    c.register([{ ...egg, id: "radio", kind: "radio" } as InteractableDef], "rooms");
    c.register([egg], "eggs");
    expect(c.list().map(d => d.id).sort()).toEqual(["egg-t", "radio"]);
    c.register([], "eggs");
    expect(c.list().map(d => d.id)).toEqual(["radio"]);
  });
});

describe("autoActivateTarget", () => {
  const at = (x: number, z: number, heading: number) => ({ x, z, heading });
  it("fires once when close and facing, re-arms after leaving", () => {
    const spent = new Set<string>();
    expect(autoActivateTarget([egg], at(10, 5.7, Math.PI), spent)).toBe("egg-t");
    expect(autoActivateTarget([egg], at(10, 5.7, Math.PI), spent)).toBeNull();
    expect(autoActivateTarget([egg], at(10, 5.7 + AUTO_ACTIVATE_REARM + 0.1, Math.PI), spent)).toBeNull();
    expect(autoActivateTarget([egg], at(10, 5.7, Math.PI), spent)).toBe("egg-t");
  });
  it("ignores far, or close but facing away", () => {
    expect(autoActivateTarget([egg], at(10, 8, Math.PI), new Set())).toBeNull();
    expect(autoActivateTarget([egg], at(10, 5.7, 0), new Set())).toBeNull();
  });
});

describe("egg halo", () => {
  it("picks the state: spent beats active beats ready", () => {
    expect(haloState({ approached: false, on: false, spent: false })).toBe("none");
    expect(haloState({ approached: true, on: false, spent: false })).toBe("ready");
    expect(haloState({ approached: true, on: true, spent: false })).toBe("active");
    expect(haloState({ approached: true, on: true, spent: true })).toBe("spent");
  });
  it("ready pulses, active flashes then holds, spent is dim and still", () => {
    const ready = [0, 0.1, 0.2, 0.3, 0.4, 0.5].map(t => haloLevel("ready", t, 0));
    expect(Math.max(...ready)).toBeGreaterThan(Math.min(...ready) + 0.15);
    expect(haloLevel("active", 0, 0)).toBeGreaterThan(haloLevel("active", 0, 5));
    expect(haloLevel("active", 0, 5)).toBeGreaterThan(haloLevel("spent", 0, 5));
    expect(haloLevel("spent", 1, 0)).toBe(haloLevel("spent", 9, 3));
    expect(haloLevel("none", 1, 0)).toBe(0);
  });
  it("controller tracks approach and spent", () => {
    const c = new InteractController();
    c.register([egg], "eggs");
    expect(c.isApproached(egg.id)).toBe(false);
    c.drive({ x: egg.stand[0], z: egg.stand[1] } as never, 0.01, "scout");
    expect(c.isApproached(egg.id)).toBe(true);
    expect(c.isSpent(egg.id)).toBe(false);
    c.markSpent(egg.id);
    expect(c.isSpent(egg.id)).toBe(true);
  });
});
