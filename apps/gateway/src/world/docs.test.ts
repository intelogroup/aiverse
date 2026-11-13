import { describe, expect, test } from "bun:test";
import { agentBodies } from "@aiverse/world-sim/bodies";
import { worldDocText } from "./docs";

// The llms.txt guide is the only agent-facing enumeration of wearable
// bodies: what it offers is what a cold agent believes it can wear.
describe("worldDocText — bodies offered to agents", () => {
  const doc = worldDocText("https://api.example.test");

  test("offers exactly the agent-pickable bodies", () => {
    const line = doc.split("\n").find((l) => l.includes("Bodies an agent may wear:"));
    expect(line).toBeDefined();
    expect(line).toContain(`Bodies an agent may wear: ${agentBodies().map((b) => b.id).join(", ")}.`);
  });

  test("never offers the cast-only bodies (Jim's ruling, 2026-11-11)", () => {
    expect(doc).not.toContain("mage");
    expect(doc).not.toContain("skeleton-warrior");
    // "cast" appears in the doc's prose ("cast-only figures"), so pin the
    // offered list itself: Body Block must not be among the wearable ids.
    const line = doc.split("\n").find((l) => l.includes("Bodies an agent may wear:"));
    const offered = line
      ?.split("Bodies an agent may wear:")[1]
      .replace(".", "")
      .split(",")
      .map((s) => s.trim());
    expect(offered).not.toContain("cast");
    expect(offered).toEqual(agentBodies().map((b) => b.id));
  });
});

// The senses guide states physical facts an agent plans with; they come from the code (look.ts LOOK_HFOV_DEG / LOOK_FAR_M, the
// photo camera's 55 degree vertical field at 512x288 = about 86 degrees wide), so a change there has to change the text.
describe("worldDocText — senses guide", () => {
  const doc = worldDocText("https://api.example.test");
  test("names the three senses and the first-person photo", () => {
    for (const k of ["SENSES:", "observe (free", "look (one action", "see (one action", "your own body is not in it"]) expect(doc).toContain(k);
  });
  test("pixel-size rule matches the photo camera: 280 x W / D for a 512 px, 86 degree frame", () => {
    const hfov = 2 * Math.atan(Math.tan((55 * Math.PI) / 360) * (512 / 288));
    expect((hfov * 180) / Math.PI).toBeCloseTo(86, 0);
    const fx = 256 / Math.tan(hfov / 2);
    expect(Math.round(fx / 10) * 10).toBe(280);
    expect(doc).toContain("about 280 x W / D pixels wide");
    expect(Math.round((fx * 0.4) / 5)).toBe(22);
    expect(doc).toContain("22 px at 5 m");
  });
  test("states the look geometry limits from the sim constants", async () => {
    const { LOOK_FAR_M, LOOK_HFOV_DEG } = await import("@aiverse/world-sim/look");
    expect(doc).toContain(`(${LOOK_HFOV_DEG} degrees wide, ${LOOK_FAR_M} m)`);
  });
});

