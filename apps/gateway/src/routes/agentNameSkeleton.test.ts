import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { agentNameSkeleton } from "../util/agentName";

// Name uniqueness vs Unicode confusables (2026-11-26): the ROGUE OWNER battery found
// confusables registering as distinct agents (zero-width space,
// Cyrillic homoglyph). Against the skeleton check those now collide
// with the real name and are refused — while genuinely different
// names, and legitimate non-Latin names, still register.

const app = createApp();
const R = Math.random().toString(36).slice(2, 8);
const auth = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });

async function ownerToken(prefix: string): Promise<string> {
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, password: "password123" }),
  });
  return (await reg.json()).token as string;
}

async function createStatus(owner: string, name: string): Promise<number> {
  const res = await app.request("/owners/agents", {
    method: "POST",
    headers: auth(owner),
    body: JSON.stringify({ name, capabilities: [] }),
  });
  return res.status;
}

describe("agent name skeleton (ROGUE OWNER P1 regression)", () => {
  test("skeleton folds confusables, format chars, case and space", () => {
    expect(agentNameSkeleton("Beacon")).toBe("beacon");
    expect(agentNameSkeleton("Bеacon")).toBe("beacon"); // Cyrillic е
    expect(agentNameSkeleton("Bea​con")).toBe("beacon"); // zero-width space
    expect(agentNameSkeleton("  BEACON ")).toBe("beacon");
    expect(agentNameSkeleton("Βeacon")).toBe("beacon"); // Greek Β → β → b
    // A name legitimately written in Cyrillic throughout keeps its own
    // identity — it only folds where letters are Latin lookalikes, and
    // distinct Cyrillic names stay distinct.
    expect(agentNameSkeleton("Москва")).not.toBe(agentNameSkeleton("Минск"));
  });

  test("confusable variants of an existing name are refused (409)", async () => {
    const victim = await ownerToken("namefix-victim");
    const rogue = await ownerToken("namefix-rogue");
    const base = `Beacon-${R}`;
    expect(await createStatus(victim, base)).toBe(201);
    for (const variant of [`Bеacon-${R}`, `Bea​con-${R}`, base.toLowerCase(), `${base} `]) {
      expect(await createStatus(rogue, variant)).toBe(409);
    }
    // Self-registration path enforces it too.
    const selfReg = await app.request("/agents/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: `Bеacon-${R}`, capabilities: [] }),
    });
    expect(selfReg.status).toBe(409);
    // Genuinely different names still register.
    expect(await createStatus(rogue, `Lantern-${R}`)).toBe(201);
    expect(await createStatus(rogue, `Beacon-${R}-2`)).toBe(201);
  });
});
