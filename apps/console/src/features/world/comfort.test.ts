import { describe, expect, it } from "vitest";
import { DEFAULT_COMFORT, coachSeen, loadComfort, markCoachSeen } from "./comfort";

function fakeStorage(init: Record<string, string> = {}) {
  const map = new Map(Object.entries(init));
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
  };
}

describe("loadComfort", () => {
  it("defaults when nothing is stored", () => {
    expect(loadComfort(fakeStorage())).toEqual(DEFAULT_COMFORT);
    expect(loadComfort(null)).toEqual(DEFAULT_COMFORT);
  });
  it("round-trips stored values and clamps out-of-range numbers", () => {
    const s = fakeStorage({
      "aiverse.comfort": JSON.stringify({
        lookSensitivity: 9,
        invertY: true,
        masterVolume: 0.4,
        musicVolume: -2,
        windVolume: 0.25,
        paVolume: "loud",
      }),
    });
    const c = loadComfort(s);
    expect(c.lookSensitivity).toBe(2); // clamped to the 0.5–2 range
    expect(c.invertY).toBe(true);
    expect(c.masterVolume).toBe(0.4);
    expect(c.musicVolume).toBe(0); // clamped to 0–1
    expect(c.windVolume).toBe(0.25);
    expect(c.paVolume).toBe(1); // non-number falls back to default
  });
  it("survives corrupt JSON", () => {
    expect(loadComfort(fakeStorage({ "aiverse.comfort": "{nope" }))).toEqual(DEFAULT_COMFORT);
  });
});

describe("coach marks", () => {
  it("are unseen until marked, then stay seen (exactly once)", () => {
    const s = fakeStorage();
    expect(coachSeen("stick", s)).toBe(false);
    markCoachSeen("stick", s);
    expect(coachSeen("stick", s)).toBe(true);
    expect(coachSeen("look", s)).toBe(false);
  });
});
