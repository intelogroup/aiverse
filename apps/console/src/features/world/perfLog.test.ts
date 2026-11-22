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
