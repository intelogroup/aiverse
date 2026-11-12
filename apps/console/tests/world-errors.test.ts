// @vitest-environment node
// Failures that tell the agent what to do next: wrong action shape, a crowd in the way, a place with no interior.
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { explainAction } from "@aiverse/world-sim/actionProtocol";

const ASSETS = new URL("../public/assets/", import.meta.url).pathname;
let service: WorldService;
beforeAll(async () => {
  const { sim } = await loadVerseSim(ASSETS);
  service = new WorldService({ sim, maxBodies: 4 });
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

describe("refusals explain themselves", () => {
  it("a nested action is told to be flat, a missing type lists the types", () => {
    expect(explainAction({ play: { clip: "Waving" } })).toMatch(/flat: \{"type":"play".*not \{"play":/);
    expect(explainAction({ clip: "Waving" })).toMatch(/needs a "type".*Example: \{"type":"play"/);
    expect(explainAction({ type: "dance" })).toMatch(/unknown action type "dance"/);
  });

  it("enter on a hall or stall says it has no interior", async () => {
    service.attach("e1");
    const r = await settle("e1", service.act("e1", "x1", { type: "enter", place: "hall-0" }).id, 5);
    expect(r.outcome?.status).toBe("unavailable");
    expect(r.outcome?.detail).toMatch(/hall-0 has no interior: use go_to/);
  });

  it("a blocked walk with a body at arm's length says a body is in the way; alone it does not", () => {
    service.attach("c1");
    const me = service.body("c1");
    const blocked = { ok: false, status: "blocked" as const, detail: "no progress for 2.5 s, 3.0 m out" };
    const explain = (id: string) => (service.sim.body(id) as unknown as { explainBlocked(o: typeof blocked): { detail: string } }).explainBlocked(blocked);
    expect(explain("c1").detail).toBe(blocked.detail);
    service.attach("c2", { x: me.x + 1.0, z: me.z });
    const c2 = service.body("c2");
    expect(Math.hypot(c2.x - me.x, c2.z - me.z), "spawned beside c1").toBeLessThan(2.0);
    expect(explain("c1").detail).toMatch(/another body is right beside you.*wait a few seconds/);
    // a planning refusal is not a crowd problem, even with a body at arm's length (waiting would not fix it)
    const noRoute = { ok: false, status: "blocked" as const, detail: "no safe route" };
    const explainNoRoute = (service.sim.body("c1") as unknown as { explainBlocked(o: typeof noRoute): { detail: string } }).explainBlocked(noRoute);
    expect(explainNoRoute.detail).toBe("no safe route");
  });
});
