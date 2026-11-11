// @vitest-environment node
// Gestures in the public body API: every listed clip plays, names forgive case/aliases, a standing gesture is refused while seated.
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { explainAction } from "@aiverse/world-sim/actionProtocol";
import { clipDef, resolveSocialClip, SOCIAL_CLIPS } from "@aiverse/world-sim/clips";

const ASSETS = new URL("../public/assets/", import.meta.url).pathname;
let service: WorldService;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => {
  ({ sim } = await loadVerseSim(ASSETS));
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

describe("gesture names", () => {
  it("the social set is the catalog's social clips and every one exists", () => {
    expect(SOCIAL_CLIPS.length).toBeGreaterThanOrEqual(19);
    for (const n of SOCIAL_CLIPS) expect(clipDef(n), n).toBeDefined();
  });
  it("aliases and case resolve; non-social clips and junk do not", () => {
    for (const [name, want] of [["wave", "Waving"], ["WAVING", "Waving"], ["Laugh", "Laughing"], ["nod", "NodYes"], ["shake head", "ShakeHeadNo"], ["silly-dancing", "SillyDancing"], ["cheer", "Victory"]]) {
      expect(resolveSocialClip(name)?.name, name).toBe(want);
    }
    for (const bad of ["Death", "AttackPunch", "EnterCar", "cartwheel", "", 5, null]) expect(resolveSocialClip(bad), String(bad)).toBeUndefined();
  });
  it("the protocol accepts aliases and names the playable ones when refusing", () => {
    expect(explainAction({ type: "play", clip: "wave" })).toBeNull();
    expect(explainAction({ type: "play", clip: "Death" })).toMatch(/playable: .*Waving/);
  });
});

describe("playing gestures", () => {
  it("every listed clip plays to completion standing", async () => {
    service.attach("g1");
    const fails: string[] = [];
    for (const [i, c] of service.clips().entries()) {
      const rec = await settle("g1", service.act("g1", `p${i}`, { type: "play", clip: c.name, seconds: 1 }).id, 40);
      if (rec.outcome?.status !== "done") fails.push(`${c.name}: ${JSON.stringify(rec.outcome)}`);
    }
    expect(fails).toEqual([]);
  }, 120_000);

  it("a standing gesture is refused while seated; a seated one plays", async () => {
    const seat = sim.sittables.find((s) => s.building === "shop-65")!;
    const lot = sim.places.find((p) => p.id === "shop-65")!;
    service.attach("g2", { x: lot.stand[0], z: lot.stand[1] });
    expect((await settle("g2", service.act("g2", "s1", { type: "sit", sittable: seat.id }).id, 200)).outcome?.status).toBe("seated");
    const bad = await settle("g2", service.act("g2", "s2", { type: "play", clip: "wave" }).id, 5);
    expect(bad.outcome?.status).toBe("rejected");
    expect(bad.outcome?.detail).toMatch(/stand first.*SittingTalking/);
    expect((await settle("g2", service.act("g2", "s3", { type: "play", clip: "SittingTalking", seconds: 1 }).id, 10)).outcome?.status).toBe("done");
  }, 120_000);
});
