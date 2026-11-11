// @vitest-environment node
// Seeing other bodies through the public API: range, view cone, line of sight, opaque per-visit handles, face/go_to by handle.
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";

const ASSETS = new URL("../public/assets/", import.meta.url).pathname;
let service: WorldService;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => {
  ({ sim } = await loadVerseSim(ASSETS));
  service = new WorldService({ sim, maxBodies: 8 });
}, 120_000);

async function settle(agent: string, id: string, maxS = 60) {
  for (let t = 0; t < maxS * 10; t++) {
    const rec = service.actRecord(agent, id)!;
    if (rec.state !== "running") return rec;
    service.tick(0.1);
    await Promise.resolve();
  }
  return service.actRecord(agent, id)!;
}
const bodies = (agent: string) => service.observe(agent).scene.filter((o) => o.kind === "body");

describe("sight", () => {
  it("two bodies in the open see each other with different opaque handles, and nothing else of the other", async () => {
    service.attach("amy"); // the plaza: open ground
    const { x, z } = service.body("amy");
    service.attach("ben", { x: x + 5, z, heading: -Math.PI / 2 });
    await settle("amy", service.act("amy", "face0", { type: "face", point: [x + 5, z] }).id, 20);
    const a = service.observe("amy"), b = service.observe("ben");
    const sa = bodies("amy"), sb = bodies("ben");
    expect(sa).toHaveLength(1);
    expect(sb).toHaveLength(1);
    expect(sa[0].id).not.toBe(sb[0].id);
    expect(sa[0].id).toMatch(/^b-[0-9a-f]{8}$/);
    expect(sa[0].distance).toBeGreaterThan(2);
    expect(sa[0].distance).toBeLessThan(8);
    expect(sa[0].facingYou).toBe(true);
    const json = JSON.stringify(a.scene.filter((o) => o.kind === "body"));
    expect(json).not.toContain("ben");
    const other = service.body("ben");
    expect(json).not.toContain(String(Math.round(other.x * 10) / 10));
    // stable within the visit
    expect(bodies("amy")[0].id).toBe(sa[0].id);
    expect(b.scene.some((o) => o.kind === "body")).toBe(true);
  });

  it("behind you, beyond 15 m, or behind a wall: not seen", async () => {
    const { x, z } = service.body("amy");
    service.attach("cat", { x: x + 1, z, heading: -Math.PI / 2 }); // faces -x; ben is at +x
    await settle("cat", service.act("cat", "c0", { type: "face", headingDeg: -90 }).id, 20);
    expect(bodies("cat").every((o) => o.distance <= 2.5), "ben is behind the view cone, only amy at touch range shows").toBe(true);
    service.attach("dan", { x: x - 30, z, heading: 0 });
    expect(bodies("dan").length, "beyond 15 m").toBe(0);
    service.detach("cat"); service.detach("dan");
  });

  it("a wall hides a body that is close; the door gap does not", async () => {
    const lot = sim.places.find((p) => p.id === "shop-65")!;
    service.attach("eve", { x: lot.stand[0], z: lot.stand[1] });
    expect(JSON.stringify(await settle("eve", service.act("eve", "e1", { type: "enter", place: "shop-65" }).id, 120))).toContain("arrived");
    const me = service.body("eve");
    // outside the south wall, off the door: wall between
    service.attach("fay", { x: me.x + 5, z: -60.5 });
    await settle("eve", service.act("eve", "e2", { type: "face", point: [me.x + 5, -60.5] }).id, 20);
    expect(bodies("eve").length, "wall between").toBe(0);
    service.detach("fay");
    // straight through the door: eve on the door's axis inside, gus 3 m outside on the same axis
    const door = sim.rooms.find((r) => r.id === "shop-65")!.door;
    expect((await settle("eve", service.act("eve", "e3", { type: "go_to", point: [door[0], door[1] + 4] }).id, 60)).outcome?.status).toBe("arrived");
    service.attach("gus", { x: door[0], z: door[1] - 3 });
    await settle("eve", service.act("eve", "e4", { type: "face", point: [door[0], door[1] - 3] }).id, 20);
    expect(bodies("eve").length, "through the door").toBe(1);
    service.detach("gus"); service.detach("eve");
  }, 60_000);
});

describe("acting on a handle", () => {
  it("face {body} turns toward them and go_to {body} stops about 1.2 m short; stale handles are refused", async () => {
    const { x, z } = service.body("amy");
    const h = bodies("amy")[0].id;
    expect((await settle("amy", service.act("amy", "f1", { type: "face", body: h }).id, 20)).outcome?.ok).toBe(true);
    const r = await settle("amy", service.act("amy", "f2", { type: "go_to", body: h }).id, 30);
    expect(r.outcome?.status).toBe("arrived");
    const gap = Math.hypot(service.body("amy").x - service.body("ben").x, service.body("amy").z - service.body("ben").z);
    expect(gap).toBeGreaterThan(0.8);
    expect(gap).toBeLessThan(1.8);
    const bad = await settle("amy", service.act("amy", "f3", { type: "face", body: "b-deadbeef" }).id, 5);
    expect(bad.outcome?.detail).toMatch(/not_visible/);
    service.detach("ben");
    expect((await settle("amy", service.act("amy", "f4", { type: "face", body: h }).id, 5)).outcome?.detail).toMatch(/not_visible/);
    service.attach("ben", { x: x + 3, z, heading: Math.PI });
    expect(bodies("amy").every((o) => o.id !== h), "a new visit means a new handle").toBe(true);
  }, 60_000);
});
