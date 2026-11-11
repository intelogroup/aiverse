// @vitest-environment node
// Seats in the public body API: observe offers them inside the shop, a claimed seat reads "taken" to others and "yours" to the
// sitter, a second `sit` is refused as occupied, and the seat frees when the sitter stands.
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";

const ASSETS = new URL("../public/assets/", import.meta.url).pathname;
let service: WorldService;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];

beforeAll(async () => {
  ({ sim } = await loadVerseSim(ASSETS));
  service = new WorldService({ sim, maxBodies: 4 });
}, 120_000);

async function settle(agent: string, id: string, maxS = 200) {
  for (let t = 0; t < maxS * 10; t++) {
    const rec = service.actRecord(agent, id)!;
    if (rec.state !== "running") return rec;
    service.tick(0.1);
    await Promise.resolve(); // let the outcome promise settle the record
  }
  return service.actRecord(agent, id)!;
}

describe("seats in observe", () => {
  it("lists the room's seats, shows claims, refuses a second sitter, frees on stand", async () => {
    const seat = sim.sittables.find((s) => s.building === "shop-65" && s.group)!;
    const lot = sim.places.find((p) => p.id === "shop-65")!;
    service.attach("alice", { x: lot.stand[0], z: lot.stand[1] });
    service.attach("bob", { x: lot.stand[0] + 15, z: lot.stand[1] + 15 });

    const e = await settle("alice", service.act("alice", "a1", { type: "enter", place: "shop-65" }).id);
    expect(JSON.stringify(e)).toContain("arrived");
    const seen = service.observe("alice").scene.filter((o) => o.kind === "seat");
    expect(seen.length, "seats of the room, within 25 m and the view cone or 2.5 m").toBeGreaterThan(0);
    expect(seen.every((o) => o.state === "free" && typeof o.seatKind === "string")).toBe(true);

    service.act("alice", "a2", { type: "sit", sittable: seat.id });
    service.tick(0.1);
    service.act("bob", "b1", { type: "sit", sittable: seat.id });
    expect((await settle("bob", "b1", 2)).outcome?.detail).toMatch(/occupied/);
    expect((await settle("alice", "a2")).outcome?.status).toBe("seated");
    const mine = service.observe("alice").scene.find((o) => o.id === seat.id);
    expect(mine?.state).toBe("yours");

    expect((await settle("alice", service.act("alice", "a3", { type: "stand" }).id, 10)).outcome?.status).toBe("stood");
    expect(sim.seatHolder(seat.id)).toBeNull();
    expect(service.observe("alice").scene.find((o) => o.id === seat.id)?.state).toBe("free");
  }, 60_000);

  it("seats are only offered inside their room", () => {
    service.attach("carol");
    expect(service.observe("carol").scene.some((o) => o.kind === "seat")).toBe(false);
  });
});
