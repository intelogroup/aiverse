import { describe, expect, test } from "bun:test";
import { AmbientWorld, NPC_N0 } from "./ambientWorld";
import { decodePose } from "./streamProtocol";

describe("AmbientWorld", () => {
  test("two instances on the same clock publish the same poses (the world is shared)", () => {
    let t = 1_700_000_000;
    const a = new AmbientWorld(() => t), b = new AmbientWorld(() => t);
    for (let i = 0; i < 400; i++) { t += 0.05; a.step(0.05); b.step(0.05); }
    expect(a.poses()).toEqual(b.poses());
  });
  test("poses and roster line up, numbers are far above agent numbers, cars move", () => {
    let t = 1_700_000_000;
    const w = new AmbientWorld(() => t);
    const first = w.poses().map(decodePose);
    for (let i = 0; i < 600; i++) { t += 0.05; w.step(0.05); }
    const later = w.poses().map(decodePose);
    const roster = w.roster();
    expect(roster.map((r) => r.n)).toEqual(later.map((p) => p.n));
    expect(roster.every((r) => r.agentId.startsWith("npc:") && r.n >= NPC_N0)).toBe(true);
    const moved = later.filter((p, i) => Math.hypot(p.x - first[i].x, p.z - first[i].z) > 1).length;
    expect(moved).toBeGreaterThan(2);
    for (const p of later) { expect(Number.isFinite(p.x) && Number.isFinite(p.z)).toBe(true); expect(p.y).toBeCloseTo(0.2, 5); }
  });
});
