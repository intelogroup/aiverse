import { describe, expect, it } from "vitest";
import { EventRing, FrameGapDetector, formatEvent, gapStats, loadsInWindow, reportText } from "./perfLog";

describe("FrameGapDetector", () => {
  it("ignores normal frames and the first sample, reports a stall", () => {
    const d = new FrameGapDetector(100);
    expect(d.feed(1000)).toBeNull();
    expect(d.feed(1017)).toBeNull();
    expect(d.feed(1034)).toBeNull();
    expect(d.feed(1334)).toBe(300);
  });
  it("skip swallows a gap (hidden tab) and re-bases", () => {
    const d = new FrameGapDetector(100);
    d.feed(0);
    expect(d.feed(5000, true)).toBeNull();
    expect(d.feed(5016)).toBeNull();
  });
});

describe("EventRing", () => {
  it("keeps only the newest max entries", () => {
    const r = new EventRing(3);
    for (let i = 0; i < 5; i++) r.push({ t: i, kind: "note", text: String(i) });
    expect(r.all().map((e) => e.text)).toEqual(["2", "3", "4"]);
    expect(r.tail(2).map((e) => e.text)).toEqual(["3", "4"]);
  });
});

describe("gapStats / report", () => {
  const ev = [
    { t: 1000, kind: "gap" as const, text: "120ms pos 1,2" },
    { t: 2000, kind: "gap" as const, text: "600ms pos 3,4" },
    { t: 3000, kind: "tier" as const, text: "lite" },
  ];
  it("counts only gap events and buckets by size", () => {
    expect(gapStats(ev)).toEqual({ count: 2, worst: 600, over250: 1, over500: 1 });
  });
  it("formats and builds a report with a header and summary", () => {
    expect(formatEvent(ev[1])).toContain("gap");
    const r = reportText("iPhone", ev);
    expect(r.split("\n")[0]).toBe("iPhone");
    expect(r).toContain("worst 600ms");
  });
});

describe("loadsInWindow", () => {
  const loads = [{ end: 100, name: "a.glb", bytes: 2_000_000 }, { end: 900, name: "b.ktx2", bytes: 0 }, { end: 1500, name: "c.glb", bytes: 1 }];
  it("lists loads that finished inside the window", () => {
    expect(loadsInWindow(loads, 800, 1000)).toBe(" loads:b.ktx2");
    expect(loadsInWindow(loads, 0, 200)).toBe(" loads:a.glb 2.0MB");
    expect(loadsInWindow(loads, 2000, 3000)).toBe("");
  });
});

import { RUM_DAY_MS, gapBucket, shouldSendPerf, summarize, type GapRec } from "./perfLog";

const rec = (ms: number, x = 123, z = -87): GapRec => ({ t: 20000, ms, x, z, draws: 900, tris: 500000, tier: "reduced", loads: " loads:a.glb 9.4MB" });

describe("summarize", () => {
  it("counts, buckets and rounds positions to 10 m", () => {
    const s = summarize([rec(120), rec(300), rec(700), rec(1500, 123, -87)], { visibleS: 61.4, tierChanges: 1, ctxLost: 0, drawsSamples: [800, 900, 1000] });
    expect(s).toMatchObject({ visibleS: 61, gaps: 4, worst: 1500, over250: 3, over500: 2, bucket: ">=1000", tierChanges: 1, ctxLost: 0, medianDraws: 900 });
    expect(s.top[0]).toMatchObject({ ms: 1500, x: 120, z: -90 });
    expect(s.top).toHaveLength(4);
  });
  it("keeps only the five worst", () => {
    const s = summarize(Array.from({ length: 12 }, (_, i) => rec(100 + i * 10)), { visibleS: 30, tierChanges: 0, ctxLost: 0, drawsSamples: [] });
    expect(s.top.map((g) => g.ms)).toEqual([210, 200, 190, 180, 170]);
    expect(s.medianDraws).toBe(0);
  });
  it("an empty visit is a clean visit", () => {
    expect(summarize([], { visibleS: 40, tierChanges: 0, ctxLost: 0, drawsSamples: [500] })).toMatchObject({ gaps: 0, worst: 0, p95: 0, bucket: "none" });
  });
});

describe("gapBucket", () => {
  it("edges", () => {
    expect([0, 99, 100, 249, 250, 499, 500, 999, 1000].map(gapBucket)).toEqual(["none", "none", "100-249", "100-249", "250-499", "250-499", "500-999", "500-999", ">=1000"]);
  });
});

describe("shouldSendPerf", () => {
  const base = { visibleS: 60, gaps: 0, sampled: false, lastSentMs: 0, nowMs: RUM_DAY_MS * 10 };
  it("needs sampling or a stall cluster", () => {
    expect(shouldSendPerf(base)).toBe(false);
    expect(shouldSendPerf({ ...base, sampled: true })).toBe(true);
    expect(shouldSendPerf({ ...base, gaps: 3 })).toBe(true);
    expect(shouldSendPerf({ ...base, gaps: 2 })).toBe(false);
  });
  it("skips short visits and sends at most once a day", () => {
    expect(shouldSendPerf({ ...base, sampled: true, visibleS: 10 })).toBe(false);
    expect(shouldSendPerf({ ...base, sampled: true, lastSentMs: base.nowMs - 1000 })).toBe(false);
    expect(shouldSendPerf({ ...base, sampled: true, lastSentMs: base.nowMs - RUM_DAY_MS })).toBe(true);
  });
});
