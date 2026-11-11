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
  });
});
