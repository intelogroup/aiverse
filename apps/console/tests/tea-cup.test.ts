// @vitest-environment node
import { expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";

it("shares one discoverable Tea House cup and settles drinking through the action ledger", async () => {
  const { sim } = await loadVerseSim(new URL("../public/assets/", import.meta.url).pathname);
  const world = new WorldService({ sim });
  const cup = (verb: string) => ({ type: "interact", target: "tea-cup", verb });
  async function settle(actor: string, id: string, action: object) {
    const act = world.act(actor, id, action);
    for (let i = 0; i < 3600 && act.state === "running"; i++) {
      world.tick(1 / 60);
      await Promise.resolve();
    }
    return act;
  }
  world.attach("host", { x: -22.92, z: -68.5 }, "remy");
  expect((await settle("host", "enter", { type: "enter", place: "tea" })).outcome?.ok).toBe(true);
  expect((await settle("host", "approach", { type: "go_to", point: world.observe("host").teaCup?.approach })).outcome?.ok).toBe(true);
  world.attach("visitor");
  expect(world.observe("visitor").teaCup).toBeUndefined();
  expect(world.act("visitor", "out-of-range", cup("take")).outcome?.ok).toBe(false);
  expect(world.observe("host").teaCup?.actions).toEqual(["take"]);
  const take = world.act("host", "take", cup("take"));
  expect(take.outcome?.ok, JSON.stringify({ outcome: take.outcome, body: world.observe("host").body })).toBe(true);
  expect(world.act("host", "take", cup("take"))).toBe(take);
  world.attach("nearby", { x: -22.92, z: -68.5 }, "remy");
  expect((await settle("nearby", "enter", { type: "enter", place: "tea" })).outcome?.ok).toBe(true);
  expect(world.observe("nearby").teaCup?.state).toBe("held");
  expect(world.act("nearby", "contended", cup("take")).outcome?.ok).toBe(false);
  expect(world.frames().teaCupHolder).toBe(world.roster().bodies.find((body) => body.agentId === "host")?.n);
  const drink = world.act("host", "drink", cup("drink"));
  expect(world.observe("host").body.clip).toBe("Drinking");
  for (let i = 0; i < 900 && drink.state === "running"; i++) {
    world.tick(1 / 60);
    await Promise.resolve();
  }
  expect(drink.outcome).toMatchObject({ ok: true, target: "tea-cup" });
  expect(world.act("host", "return", cup("put_down")).outcome?.ok).toBe(true);
  expect(world.frames().teaCupHolder).toBeNull();
  expect(world.act("host", "retake", cup("take")).outcome?.ok).toBe(true);
  world.detach("host");
  expect(world.frames().teaCupHolder).toBeNull();
}, 30_000);
