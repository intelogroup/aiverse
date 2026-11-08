import { describe, expect, it } from "vitest";
import {
  GOVERNOR_DWELL_MS,
  GOVERNOR_WARMUP_MS,
  QualityGovernor,
  dprForTier,
  formatMB,
  shadowMapForTier,
  summarizeLoad,
} from "./quality";

const T = GOVERNOR_WARMUP_MS + GOVERNOR_DWELL_MS + 1000; // past warmup + dwell

describe("tier levers", () => {
  it("maps tiers to DPR caps and shadow maps per the plan budget", () => {
    expect(dprForTier("full")).toEqual([1, 2]);
    expect(dprForTier("reduced")).toEqual([1, 1.5]);
    expect(dprForTier("lite")).toBe(1);
    expect(shadowMapForTier("full")).toBe(2048);
    expect(shadowMapForTier("reduced")).toBe(1024);
    expect(shadowMapForTier("lite")).toBe(0);
  });
});

describe("QualityGovernor", () => {
  it("holds through warmup, whatever the fps", () => {
    const g = new QualityGovernor("reduced");
    expect(g.sample(5, 0)).toBeNull();
    expect(g.sample(5, GOVERNOR_WARMUP_MS - 1)).toBeNull();
    expect(g.current()).toBe("reduced");
  });
  it("steps down one tier on sustained low fps, with a reason", () => {
    const g = new QualityGovernor("full");
    g.sample(24, 0);
    const v = g.sample(24, T);
    expect(v?.tier).toBe("reduced");
    expect(v?.reason).toContain("24");
  });
  it("drops straight to lite on a collapse", () => {
    const g = new QualityGovernor("full");
    g.sample(12, 0);
    expect(g.sample(12, T)?.tier).toBe("lite");
  });
  it("steps up on sustained headroom, one tier at a time", () => {
    const g = new QualityGovernor("lite");
    g.sample(59, 0);
    expect(g.sample(59, T)?.tier).toBe("reduced");
    expect(g.sample(59, T + GOVERNOR_DWELL_MS + 1)?.tier).toBe("full");
  });
  it("holds inside the hysteresis band and during dwell", () => {
    const g = new QualityGovernor("reduced");
    g.sample(40, 0);
    expect(g.sample(40, T)).toBeNull(); // 30..55 band: hold
    const g2 = new QualityGovernor("full");
    g2.sample(24, 0);
    expect(g2.sample(24, T)?.tier).toBe("reduced");
    expect(g2.sample(24, T + 1000)).toBeNull(); // dwell not elapsed
    expect(g2.sample(24, T + GOVERNOR_DWELL_MS + 1)?.tier).toBe("lite");
  });
  it("ignores a zero fps sample (no data)", () => {
    const g = new QualityGovernor("reduced");
    g.sample(0, 0);
    expect(g.sample(0, T)).toBeNull();
    expect(g.current()).toBe("reduced");
  });
});

describe("summarizeLoad", () => {
  it("sums asset transfers separately from the page total", () => {
    const s = summarizeLoad([
      { name: "https://x/assets/world-city3.glb", transferSize: 15_000_000 },
      { name: "https://x/assets/index.js", transferSize: 900_000 },
      { name: "https://x/assets/cast-remy.glb?v=2", transferSize: 0, encodedBodySize: 14_000_000 },
      { name: "https://x/api/activity", transferSize: 2_000 },
    ]);
    expect(s.assetCount).toBe(2);
    expect(s.assetBytes).toBe(29_000_000);
    expect(s.totalBytes).toBe(29_902_000);
  });
  it("formats megabytes", () => {
    expect(formatMB(25 * 1024 * 1024)).toBe("25.0 MB");
  });
});
