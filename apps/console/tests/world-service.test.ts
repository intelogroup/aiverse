// @vitest-environment node
// WorldService: the agent-facing surface of the server sim (attach, act with polling, observe, lease, caps), on the real City 3 world.
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldError, WorldService } from "@aiverse/world-sim/worldService";
import type { VerseSim } from "@aiverse/world-sim/verseSim";

const ASSETS = new URL("../public/assets/", import.meta.url).pathname;
let sim: VerseSim;

beforeAll(async () => { ({ sim } = await loadVerseSim(ASSETS)); }, 120_000);

const svc = (o: { maxBodies?: number; leaseS?: number } = {}) => new WorldService({ sim, ...o });
const code = (f: () => unknown) => { try { f(); } catch (e) { return e instanceof WorldError ? e.code : `other:${e}`; } return null; };
/** Tick in 0.1 s steps until the predicate holds or `maxS` sim seconds pass. */
async function until(s: WorldService, pred: () => boolean, maxS: number) {
  for (let t = 0; t < maxS && !pred(); t += 0.1) { s.tick(0.1); await Promise.resolve(); }
}

describe("WorldService", () => {
  it("attaches a body once, observes it, and detaches", () => {
    const s = svc();
    const o = s.attach("a-attach");
    expect(o.body.id).toBe("a-attach");
    expect(o.body.posture).toBe("standing");
    expect(Array.isArray(o.scene)).toBe(true);
    expect(s.attach("a-attach").body.x).toBe(o.body.x); // idempotent: same body, not a second one
    expect(s.bodyCount).toBe(1);
    expect(s.detach("a-attach")).toBe(true);
    expect(s.detach("a-attach")).toBe(false);
    expect(code(() => s.observe("a-attach"))).toBe("no_body");
  });

  it("acts asynchronously: running, then settled arrived; replay is idempotent; a reused id is a conflict", async () => {
    const s = svc();
    s.attach("a-act");
    const rec = s.act("a-act", "go-1", { type: "go_to", place: "stall-0" });
    expect(rec.state).toBe("running");
    expect(s.act("a-act", "go-1", { type: "go_to", place: "stall-0" })).toBe(rec); // same record, no second walk
    expect(code(() => s.act("a-act", "go-1", { type: "stop" }))).toBe("id_conflict");
    await until(s, () => rec.state === "settled", 90);
    expect(rec.state).toBe("settled");
    expect(rec.outcome?.status).toBe("arrived");
    const o = s.observe("a-act");
    expect(o.lastAct?.id).toBe("go-1");
    expect(o.nearestPlace?.id).toBe("stall-0");
    // The scene is the view cone, not a place list: turn toward the stall (it is straight ahead, +z) and it is perceived.
    const turn = s.act("a-act", "face-1", { type: "face", headingDeg: 0 });
    await until(s, () => turn.state === "settled", 10);
    expect(turn.outcome?.ok).toBe(true);
    const seen = s.observe("a-act").scene.find((x) => x.kind === "place" && x.id === "stall-0");
    expect(seen).toBeDefined();
    expect(Math.abs(seen!.bearingDeg)).toBeLessThan(65);
    s.detach("a-act");
  }, 60_000);

  it("rejects what the physical boundary does not allow, and acts without a body", () => {
    const s = svc();
    s.attach("a-bad");
    for (const bad of [{ type: "teleport", point: [0, 0] }, { type: "go_to", point: [NaN, 0] }, { type: "chat", text: "hi" }, { type: "say", text: "" }, { type: "say", text: "x".repeat(141) }, "stop", null]) {
      expect(code(() => s.act("a-bad", "x1", bad))).toBe("invalid_action");
    }
    expect(code(() => s.act("a-bad", "bad id!", { type: "stop" }))).toBe("invalid_action");
    expect(code(() => s.act("nobody", "x2", { type: "stop" }))).toBe("no_body");
    s.detach("a-bad");
  });

  it("a second action while one runs is refused as busy, and stop cancels the first", async () => {
    const s = svc();
    s.attach("a-busy");
    const first = s.act("a-busy", "w1", { type: "go_to", place: "stall-0" });
    const second = s.act("a-busy", "w2", { type: "wait", seconds: 1 });
    s.tick(0.1); await Promise.resolve(); await Promise.resolve();
    expect(second.state).toBe("settled");
    expect(second.outcome).toMatchObject({ ok: false, status: "rejected", detail: "busy" });
    const stop = s.act("a-busy", "w3", { type: "stop" });
    await until(s, () => stop.state === "settled" && first.state === "settled", 2);
    expect(first.outcome?.detail).toBe("cancelled");
    expect(stop.outcome?.ok).toBe(true);
    s.detach("a-busy");
  }, 30_000);

  it("caps bodies and stops an abandoned body after the lease", async () => {
    const s = svc({ maxBodies: 1, leaseS: 2 });
    s.attach("a-cap1");
    expect(code(() => s.attach("a-cap2"))).toBe("world_full");
    const rec = s.act("a-cap1", "l1", { type: "go_to", place: "stall-0" });
    s.tick(0.5); // moving
    expect(s.sim.body("a-cap1")!.busy).toBe(true);
    await until(s, () => rec.state === "settled", 5); // nobody touches the body: the lease (2 sim s) cancels the walk
    expect(rec.state).toBe("settled");
    expect(rec.outcome?.detail).toBe("cancelled");
    s.detach("a-cap1");
  }, 30_000);
});
