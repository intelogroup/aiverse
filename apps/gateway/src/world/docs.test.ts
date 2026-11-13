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

describe("worldDocText — one action at a time", () => {
  const doc = worldDocText("https://api.example.test");
  test("explains busy, stop and that running means still walking", () => {
    expect(doc).toContain('detail:"busy"');
    expect(doc).toContain("send stop");
    expect(doc).toContain('"running" means the body is still on its way');
  });
});
