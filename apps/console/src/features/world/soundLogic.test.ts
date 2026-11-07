// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  bannerVisible,
  clockEventsBetween,
  creakFor,
  distanceGain,
  districtAt,
  duckedGain,
  paAudible,
  stepFade,
  DUCK_FACTOR,
  MUSIC_GAIN,
  VERSE_DAY_S,
  WIND_GAIN,
  type Announcement,
  type DistrictLite,
} from "./soundLogic";

// City 3's real layout (districts.json): five squares, half 180,
// centres 400 apart — 40 m of water between neighbours.
const DEFS: DistrictLite[] = [
  { id: "bazaar", center: [0, 0], half: 180 },
  { id: "glassq", center: [0, -400], half: 180 },
  { id: "foundry", center: [400, 0], half: 180 },
  { id: "terraces", center: [-400, 0], half: 180 },
  { id: "halo", center: [0, 400], half: 180 },
];

describe("districtAt", () => {
  it("finds the containing district", () => {
    expect(districtAt(0, 0, DEFS)).toBe("bazaar");
    expect(districtAt(-22.9, -72.5, DEFS)).toBe("bazaar"); // the tea door
    expect(districtAt(0, -400, DEFS)).toBe("glassq");
    expect(districtAt(399, 5, DEFS)).toBe("foundry");
  });
  it("is null on open water between islands", () => {
    expect(districtAt(0, -200, DEFS)).toBeNull();
    expect(districtAt(200, 0, DEFS)).toBeNull();
  });
  it("counts the square's edge as inside, just past it as outside", () => {
    expect(districtAt(180, 0, DEFS)).toBe("bazaar");
    expect(districtAt(180.01, 0, DEFS)).toBeNull();
  });
  it("is null with no defs loaded", () => {
    expect(districtAt(0, 0, [])).toBeNull();
  });
});

describe("paAudible (scope matching)", () => {
  it("verse scope reaches every listener, even on open water", () => {
    expect(paAudible("bazaar", "verse")).toBe(true);
    expect(paAudible("glassq", "verse")).toBe(true);
    expect(paAudible(null, "verse")).toBe(true);
  });
  it("district scope reaches only that district", () => {
    expect(paAudible("bazaar", "bazaar")).toBe(true);
    expect(paAudible("glassq", "bazaar")).toBe(false);
    expect(paAudible(null, "bazaar")).toBe(false);
  });
});

describe("distanceGain", () => {
  it("is full at the listener and silent at/past the radius", () => {
    expect(distanceGain(0, 12)).toBe(1);
    expect(distanceGain(12, 12)).toBe(0);
    expect(distanceGain(30, 12)).toBe(0);
  });
  it("falls off quadratically in between", () => {
    expect(distanceGain(6, 12)).toBeCloseTo(0.25);
    expect(distanceGain(3, 12)).toBeCloseTo(0.5625);
  });
  it("decreases monotonically with distance", () => {
    let prev = Infinity;
    for (let d = 0; d <= 12; d += 0.5) {
      const g = distanceGain(d, 12);
      expect(g).toBeLessThanOrEqual(prev);
      prev = g;
    }
  });
});

describe("duckedGain (PA priority)", () => {
  it("passes the base gain through when no PA is playing", () => {
    expect(duckedGain(MUSIC_GAIN, false)).toBe(MUSIC_GAIN);
    expect(duckedGain(WIND_GAIN, false)).toBe(WIND_GAIN);
  });
  it("dips music + wind to the duck factor while the PA plays", () => {
    expect(duckedGain(MUSIC_GAIN, true)).toBeCloseTo(MUSIC_GAIN * DUCK_FACTOR);
    expect(duckedGain(WIND_GAIN, true)).toBeCloseTo(WIND_GAIN * DUCK_FACTOR);
    expect(DUCK_FACTOR).toBeGreaterThan(0);
    expect(DUCK_FACTOR).toBeLessThan(1);
  });
});

describe("stepFade (zone crossfade)", () => {
  it("moves toward the target by dt/fadeS of the swing", () => {
    expect(stepFade(0, 1, 0.1, 1)).toBeCloseTo(0.1);
    expect(stepFade(1, 0, 0.25, 1)).toBeCloseTo(0.75);
  });
  it("never overshoots", () => {
    expect(stepFade(0.95, 1, 0.5, 1)).toBe(1);
    expect(stepFade(0.05, 0, 0.5, 1)).toBe(0);
  });
  it("snaps when fadeS is 0 and rests at the target", () => {
    expect(stepFade(0.2, 0.8, 0.1, 0)).toBe(0.8);
    expect(stepFade(0.5, 0.5, 0.1, 1)).toBe(0.5);
  });
  it("crosses the tea threshold in ~the fade time", () => {
    // 10 ticks of 0.1 s at fadeS 1.0: in → full, out → silent.
    let g = 0;
    for (let i = 0; i < 10; i++) g = stepFade(g, MUSIC_GAIN, 0.1, 1.0);
    expect(g).toBeCloseTo(MUSIC_GAIN);
    for (let i = 0; i < 10; i++) g = stepFade(g, 0, 0.1, 1.0);
    expect(g).toBeCloseTo(0);
  });
});

describe("clockEventsBetween (verse clock)", () => {
  const H = VERSE_DAY_S / 2;
  it("fires nothing inside a quiet stretch", () => {
    expect(clockEventsBetween(160, 290)).toEqual([]);
    expect(clockEventsBetween(100, 100)).toEqual([]);
    expect(clockEventsBetween(300, 200)).toEqual([]);
  });
  it("fires dusk crossing the half-day boundary", () => {
    expect(clockEventsBetween(H - 1, H + 1)).toEqual(["dusk"]);
    // the boundary itself belongs to the later interval
    expect(clockEventsBetween(H, H + 10)).toEqual([]);
    expect(clockEventsBetween(H - 10, H)).toEqual(["dusk"]);
  });
  it("fires dawn crossing a day boundary", () => {
    expect(clockEventsBetween(VERSE_DAY_S - 5, VERSE_DAY_S + 5)).toEqual(["dawn"]);
  });
  it("orders multiple crossings and survives multi-day jumps", () => {
    expect(clockEventsBetween(100, VERSE_DAY_S + 100)).toEqual(["dusk", "dawn"]);
    const many = clockEventsBetween(0, VERSE_DAY_S * 2 + 1);
    expect(many).toEqual(["dusk", "dawn", "dusk", "dawn"]);
  });
});

describe("creakFor (door swing envelope)", () => {
  it("is silent for a stationary or parked leaf", () => {
    expect(creakFor(45, 45, 0.1).gain).toBe(0);
    expect(creakFor(0, 0, 0.1).gain).toBe(0);
    expect(creakFor(95, 90, 0.1).gain).toBe(0); // parked open
    expect(creakFor(45, 35, 0).gain).toBe(0); // no dt, no claim
  });
  it("gain rises with angular speed through the swing", () => {
    const slow = creakFor(20, 18, 0.1); // 20 deg/s
    const fast = creakFor(45, 35, 0.1); // 100 deg/s
    expect(slow.gain).toBeGreaterThan(0);
    expect(fast.gain).toBeGreaterThan(slow.gain);
    expect(fast.gain).toBeCloseTo(0.55 * (100 / 130));
  });
  it("playback rate rises with the angle", () => {
    expect(creakFor(30, 20, 0.1).rate).toBeLessThan(creakFor(80, 70, 0.1).rate);
  });
  it("the Inwards free swing (0 -> 95 in ~1 s) peaks audibly", () => {
    // easeInOut mid-swing: ~50 deg in one 0.1 s tick pair is faster
    // than the real curve; a representative fast tick must saturate.
    const mid = creakFor(50, 38, 0.1); // 120 deg/s
    expect(mid.gain).toBeCloseTo(0.55 * (120 / 130), 1);
  });
});

describe("bannerVisible", () => {
  const a: Announcement = {
    id: 1,
    text: "Dusk falls.",
    scope: "bazaar",
    clip: "pa-dusk",
    startAt: 100,
    audioDur: 3.9,
  };
  it("shows in scope while the audio runs and through the linger", () => {
    expect(bannerVisible(a, 100, "bazaar")).toBe(true);
    expect(bannerVisible(a, 103.8, "bazaar")).toBe(true);
    expect(bannerVisible(a, 105.4, "bazaar")).toBe(true);
  });
  it("hides after audio + linger", () => {
    expect(bannerVisible(a, 105.6, "bazaar")).toBe(false);
    expect(bannerVisible(a, 200, "bazaar")).toBe(false);
  });
  it("never shows out of scope", () => {
    expect(bannerVisible(a, 101, "glassq")).toBe(false);
    expect(bannerVisible(a, 101, null)).toBe(false);
  });
  it("verse scope shows anywhere, and null shows nothing", () => {
    const v: Announcement = { ...a, scope: "verse" };
    expect(bannerVisible(v, 101, null)).toBe(true);
    expect(bannerVisible(null, 101, "bazaar")).toBe(false);
  });
});
