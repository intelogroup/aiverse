import { beforeAll, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { AmbientWorld } from "@aiverse/world-sim/ambientWorld";
import { WorldService } from "@aiverse/world-sim/worldService";

const ASSETS = new URL("../../console/public/assets/", import.meta.url).pathname;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => { sim = (await loadVerseSim(ASSETS)).sim; }, 120_000);

/** Walk an agent along a fixed route; with `blocker`, a pedestrian-sized resident disc stands on the route (published as WorldService.tick publishes AmbientWorld NPCs). */
async function walk(id: string, blocker?: [number, number]): Promise<{ path: [number, number][]; status: string }> {
  const service = new WorldService({ sim });
  service.attach(id, { x: 68.75, z: 10.9 });
  service.act(id, "go-1", { type: "go_to", point: [76.5, 11.3] });
  const path: [number, number][] = [];
  for (let t = 0; t < 40; t += 0.1) {
    if (blocker) sim.publishDisc("npc:ped-test", blocker[0], 0.2, blocker[1], 0.35, 1.8);
    service.tick(0.1);
    await Promise.resolve();
    const o = service.observe(id).body;
    path.push([o.x, o.z]);
    if (service.actRecord(id, "go-1")?.state === "settled") break;
  }
  const status = service.actRecord(id, "go-1")?.outcome?.status ?? "running";
  service.detach(id);
  return { path, status };
}

test("an agent body does not walk through a resident disc", async () => {
  const free = await walk("npc-free");
  expect(free.status).toBe("arrived");
  const mid = free.path[Math.floor(free.path.length / 2)];
  const dist = (p: [number, number][]) => Math.min(...p.map(([x, z]) => Math.hypot(x - mid[0], z - mid[1])));
  expect(dist(free.path)).toBeLessThan(0.2);
  const hit = await walk("npc-block", mid);
  expect(dist(hit.path)).toBeGreaterThan(0.6);   // body 0.4 + pedestrian 0.35, less slack
}, 90_000);

test("the service publishes every resident car and pedestrian as solid discs", () => {
  const ambient = new AmbientWorld(() => 1_000_000, 2);
  const d = ambient.discs();
  expect(d.length).toBe(ambient.cars.length * 2 + ambient.walkers.length);
  expect(new Set(d.map((x) => x.id)).size).toBe(d.length);
  expect(d.every((x) => x.id.startsWith("npc:") && Number.isFinite(x.x) && Number.isFinite(x.z))).toBe(true);
});
