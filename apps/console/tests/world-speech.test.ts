// @vitest-environment node
// Proximity speech through the public API: range, line of sight, addressing, per-visit handles, cursor, untrusted text, validation.
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { explainAction } from "@aiverse/world-sim/actionProtocol";
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
const handleOf = (agent: string) => service.observe(agent).scene.find((o) => o.kind === "body")!.id;

describe("say", () => {
  it("validates text length, the to handle, and unknown fields", () => {
    expect(explainAction({ type: "say", text: "hi" })).toBeNull();
    expect(explainAction({ type: "say", text: "hi", to: "b-12345678" })).toBeNull();
    expect(explainAction({ type: "say" })).toMatch(/say needs text/);
    expect(explainAction({ type: "say", text: "   " })).toMatch(/say needs text/);
    expect(explainAction({ type: "say", text: "x".repeat(141) })).toMatch(/1-140/);
    expect(explainAction({ type: "say", text: "hi", volume: 11 })).toMatch(/unexpected field/);
  });

  it("a line reaches a listener in range with the speaker's handle and name, and nothing else of the speaker", async () => {
    service.attach("amy");
    const { x, z } = service.body("amy");
    service.attach("ben", { x: x + 4, z, heading: -Math.PI / 2 });
    const rec = await settle("amy", service.act("amy", "s1", { type: "say", text: "Hello there" }, { name: "Amy" }).id, 5);
    expect(rec.outcome).toMatchObject({ ok: true, status: "done" });
    const heard = service.observe("ben").heard;
    expect(heard).toHaveLength(1);
    expect(heard[0]).toMatchObject({ text: "Hello there", name: "Amy", toYou: false, untrusted: true });
    expect(heard[0].from).toMatch(/^b-[0-9a-f]{8}$/);
    expect(JSON.stringify(heard)).not.toContain("amy");
    // the speaker hears nothing of their own line
    expect(service.observe("amy").heard).toHaveLength(0);
  });

  it("the speaker's handle for the listener matches the scene handle, so a reply can use it", async () => {
    const h = handleOf("ben");
    expect(h).toMatch(/^b-/);
    // ben is not facing amy yet; a face by handle needs amy in sight, so turn first
    const heard = service.observe("ben").heard[0];
    await settle("ben", service.act("ben", "t0", { type: "face", point: [service.body("amy").x, service.body("amy").z] }).id, 10);
    expect(service.observe("ben").scene.find((o) => o.kind === "body")!.id).toBe(heard.from);
    const reply = await settle("ben", service.act("ben", "t1", { type: "say", text: "Hi Amy", to: heard.from }, { name: "Ben" }).id, 5);
    expect(reply.outcome?.ok).toBe(true);
    const back = service.observe("amy").heard;
    expect(back).toHaveLength(1);
    expect(back[0]).toMatchObject({ text: "Hi Amy", name: "Ben", toYou: true });
  });

  it("heardSince is a cursor: only newer lines come back", () => {
    const all = service.observe("ben").heard;
    const last = all[all.length - 1].seq;
    expect(service.observe("ben", last).heard).toHaveLength(0);
    expect(service.observe("ben", all[0].seq - 1).heard).toHaveLength(all.length);
  });

  it("out of earshot, behind a wall, or to a body you cannot see: not heard / refused", async () => {
    const { x, z } = service.body("amy");
    service.attach("dan", { x: x - 20, z });
    await settle("amy", service.act("amy", "s2", { type: "say", text: "Anyone?" }, { name: "Amy" }).id, 5);
    expect(service.observe("dan").heard, "20 m away").toHaveLength(0);
    const nobody = await settle("amy", service.act("amy", "s3", { type: "say", text: "hey", to: "b-deadbeef" }).id, 5);
    expect(nobody.outcome).toMatchObject({ ok: false, status: "unavailable" });
    expect(nobody.outcome?.detail).toContain("not_visible");
    service.detach("dan");
    const lot = sim.places.find((p) => p.id === "shop-65")!;
    service.attach("eve", { x: lot.stand[0], z: lot.stand[1] });
    expect(JSON.stringify(await settle("eve", service.act("eve", "e1", { type: "enter", place: "shop-65" }).id, 120))).toContain("arrived");
    const me = service.body("eve");
    service.attach("fay", { x: me.x + 4, z: -60.5 }); // outside the south wall, 4 m off the door axis
    await settle("fay", service.act("fay", "f1", { type: "say", text: "through the wall?" }, { name: "Fay" }).id, 5);
    expect(service.observe("eve").heard.filter((m) => m.text === "through the wall?"), "a wall blocks sound").toHaveLength(0);
    service.detach("fay"); service.detach("eve");
  }, 60_000);

  it("a line expires after 60 simulation seconds, and the same id replays the first result without saying twice", async () => {
    service.attach("gil");
    const { x, z } = service.body("gil");
    service.attach("hal", { x: x + 3, z });
    const first = service.act("gil", "r1", { type: "say", text: "once" }, { name: "Gil" });
    const again = service.act("gil", "r1", { type: "say", text: "once" }, { name: "Gil" });
    expect(again).toBe(first);
    expect(service.observe("hal").heard).toHaveLength(1);
    for (let i = 0; i < 61 * 10; i++) service.tick(0.1);
    expect(service.observe("hal").heard).toHaveLength(0);
    service.detach("gil"); service.detach("hal");
  });

  it("the speaker talks with the body, and the viewer stream carries the line (cut to 140)", async () => {
    service.attach("ivy");
    const { x, z } = service.body("ivy");
    service.attach("jon", { x: x + 3, z });
    await settle("ivy", service.act("ivy", "v1", { type: "say", text: "stream me" }, { name: "Ivy" }).id, 5);
    expect(service.observe("ivy").body.clip).toBe("Talking");
    const line = service.frames().say.find((e) => e.text === "stream me");
    expect(line).toBeDefined();
    expect(line!.n).toBeGreaterThan(0);
    service.detach("ivy"); service.detach("jon");
  });
});
