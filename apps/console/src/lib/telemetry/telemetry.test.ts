import { describe, expect, it } from "vitest";
import { Blackbox } from "./blackbox";
import { deriveDistrict, FALLBACK_DISTRICTS } from "./context";
import { classifyAsset } from "./index";

describe("Blackbox ring buffer", () => {
  it("keeps the newest events and evicts the oldest past capacity", () => {
    const bb = new Blackbox(5);
    for (let i = 0; i < 8; i++) bb.record("tick", { i });
    expect(bb.size).toBe(5);
    expect(bb.all().map((e) => e.data?.i)).toEqual([3, 4, 5, 6, 7]);
  });

  it("tail returns the most recent slice, oldest first", () => {
    const bb = new Blackbox(10);
    bb.record("a");
    bb.record("b");
    bb.record("c");
    expect(bb.tail(2).map((e) => e.type)).toEqual(["b", "c"]);
  });

  it("exports NDJSON in the rig trace shape ({ts, t, type, data})", () => {
    const bb = new Blackbox(10);
    bb.record("session.start", { buildSha: "abc" });
    const lines = bb.toJSONL().trim().split("\n");
    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]);
    expect(parsed.type).toBe("session.start");
    expect(typeof parsed.ts).toBe("string");
    expect(typeof parsed.t).toBe("number");
    expect(parsed.data.buildSha).toBe("abc");
  });
});

describe("deriveDistrict", () => {
  it("places the plaza in the bazaar and the spires in the halo", () => {
    expect(deriveDistrict(0, 0, FALLBACK_DISTRICTS)).toBe("bazaar");
    expect(deriveDistrict(10, 390, FALLBACK_DISTRICTS)).toBe("halo");
    expect(deriveDistrict(-390, 5, FALLBACK_DISTRICTS)).toBe("terraces");
    expect(deriveDistrict(395, -5, FALLBACK_DISTRICTS)).toBe("foundry");
    expect(deriveDistrict(0, -395, FALLBACK_DISTRICTS)).toBe("glassq");
  });

  it("reports the gaps honestly as between", () => {
    expect(deriveDistrict(200, 0, FALLBACK_DISTRICTS)).toBe("between");
    expect(deriveDistrict(0, 200, FALLBACK_DISTRICTS)).toBe("between");
  });
});

describe("classifyAsset", () => {
  it("names the GLB family the eval layer tracks", () => {
    expect(classifyAsset("/assets/world-city3.glb")).toBe("city");
    expect(classifyAsset("/assets/world-city3-collision.glb")).toBe("collision");
    expect(classifyAsset("/assets/world-city3-library.glb")).toBe("library");
    expect(classifyAsset("/assets/world-halo.glb")).toBe("halo");
    expect(classifyAsset("/assets/world-glassq.glb")).toBe("district:glassq");
    expect(classifyAsset("/assets/world-foundry-collision.glb")).toBe("collision:foundry");
    expect(classifyAsset("/assets/residents/mira-maid.glb")).toBe("resident");
    expect(classifyAsset("/assets/districts.json")).toBe("manifest");
  });

  it("ignores non-world traffic", () => {
    expect(classifyAsset("/assets/logo.png")).toBeNull();
    expect(classifyAsset("https://cdn.example.com/font.woff2")).toBeNull();
  });
});
