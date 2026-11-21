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
    const line = doc.split("\n").find((l) => l.includes("Bodies an agent may wear:"));
    const offered = line
      ?.split("Bodies an agent may wear:")[1]
      .replace(".", "")
      .split(",")
      .map((s) => s.trim());
    for (const id of ["mage", "skeleton-warrior", "cast"]) expect(offered).not.toContain(id);
    expect(offered).toEqual(agentBodies().map((b) => b.id));
  });
});

describe("worldDocText — one action at a time", () => {
  const doc = worldDocText("https://api.example.test");
  test("explains busy, stop and that running means still walking", () => {
    expect(doc).toContain('detail:"busy"');
    expect(doc).toContain("send stop");
    expect(doc).toContain('"running" means the body is still on its way');
  });
});
// The senses guide states physical facts an agent plans with; they come from the code (look.ts LOOK_HFOV_DEG / LOOK_FAR_M, the
// photo camera's 55 degree vertical field at 1024x576 = about 86 degrees wide), so a change there has to change the text.
describe("worldDocText — senses guide", () => {
  const doc = worldDocText("https://api.example.test");
  test("names the three senses and the first-person photo", () => {
    for (const k of ["SENSES:", "observe (free", "look (one action", "see (one action", "your own body is not in it"]) expect(doc).toContain(k);
  });
  test("pixel-size rule matches the photo camera: 550 x W / D for a 1024 px, 86 degree frame", () => {
    const hfov = 2 * Math.atan(Math.tan((55 * Math.PI) / 360) * (1024 / 576));
    expect((hfov * 180) / Math.PI).toBeCloseTo(86, 0);
    const fx = 512 / Math.tan(hfov / 2);
    expect(Math.round(fx / 10) * 10).toBe(550);
    expect(doc).toContain("about 550 x W / D pixels wide");
    expect(Math.round((fx * 0.4) / 5)).toBe(44);
    expect(doc).toContain("44 px at 5 m");
  });
  test("states the look geometry limits from the sim constants", async () => {
    const { LOOK_FAR_M, LOOK_HFOV_DEG } = await import("@aiverse/world-sim/look");
    expect(doc).toContain(`(${LOOK_HFOV_DEG} degrees wide, ${LOOK_FAR_M} m)`);
  });
});


describe("worldDocText — driving", () => {
  const doc = worldDocText("https://api.example.test");
  test("says getting in is the agent's own choice and lists the three actions and the infractions", () => {
    expect(doc).toContain("Walking past one does nothing");
    for (const a of ["enter_vehicle", "drive {", "exit_vehicle", "observe.vehicle", "red_light", "wrong_lane", "BLOCKED", "reverse:true", "compassDeg", "heading", "STOP"]) expect(doc).toContain(a);
  });
  test("numbers come from the code", () => {
    expect(doc).toContain("within 3 m");
    expect(doc).toContain("speed limit of 11.5 m/s");
    expect(doc).toContain("seconds up to 5");
  });
});
