import { beforeAll, expect, test } from "bun:test";
import { validAction } from "@aiverse/world-sim/actionProtocol";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { STALL_CONSUMABLES, STALL_MOUTH_S, STALL_PICKUP_S, type StallConsumableId } from "@aiverse/world-sim/stallConsumables";
import { WorldService } from "@aiverse/world-sim/worldService";

const assets = new URL("../../console/public/assets/", import.meta.url).pathname;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => { ({ sim } = await loadVerseSim(assets)); });
const advance = async (world: WorldService, seconds: number) => {
  for (let i = 0; i < Math.ceil(seconds / 0.025); i++) {
    world.tick(0.025);
    await Promise.resolve();
  }
};
async function approach(world: WorldService, agent: string, x: number, z: number) {
  world.attach(agent, { x, z: z - 0.7 });
  const walk = world.act(agent, "walk", { type: "go_to", point: [x, z] });
  await advance(world, 7);
  expect(walk.outcome?.ok).toBe(true);
}
async function startMotion(world: WorldService, id: StallConsumableId) {
  for (let i = 0; i < 120 && !world.frames().stallProps?.[id].motion; i++) await advance(world, 0.025);
  expect(world.frames().stallProps?.[id].motion).toBeDefined();
}
const intent = (id: StallConsumableId) => ({ type: "interact", target: id, verb: STALL_CONSUMABLES[id].verb });

test("the fruit transfers to the hand, disappears at the mouth, and a replay cannot eat it twice", async () => {
  const world = new WorldService({ sim, stallConsumables: true });
  const id = "stall-apple";
  const [x, z] = STALL_CONSUMABLES[id].approach;
  try {
    await approach(world, "a", x, z);
    world.attach("b", { x: x + 0.85, z });
    expect(validAction(intent(id))).toBe(true);
    expect(validAction({ ...intent(id), verb: "drink" })).toBe(false);
    expect(validAction({ ...intent(id), amount: 500 })).toBe(false);
    expect(world.observe("a").stallConsumables?.find(prop => prop.id === id)?.available).toBe(true);
    const rec = world.act("a", "eat", intent(id));
    expect(world.act("b", "eat", intent(id)).outcome?.detail).toContain("object_busy");
    await startMotion(world, id);
    await advance(world, STALL_PICKUP_S + 0.25);
    expect(world.observe("a").heldObjects).toEqual([id]);
    expect(world.frames().stallProps?.[id].visible).toBe(true);
    expect(rec.consumed).toBeUndefined();
    await advance(world, STALL_MOUTH_S);
    expect(world.frames().stallProps?.[id].visible).toBe(false);
    expect(world.observe("a").heldObjects).toEqual([]);
    expect(rec.consumed).toBe(id);
    await advance(world, 3);
    expect(rec.outcome?.ok).toBe(true);
    expect(world.act("a", "eat", intent(id))).toBe(rec);
    expect(world.act("a", "empty", intent(id)).outcome?.detail).toContain("out_of_stock");
  } finally { for (const id of world.agentIds()) world.detach(id); }
});

test("the bottle returns to its table every time, runs out after four sips, and keeps volume private", async () => {
  const world = new WorldService({ sim, stallConsumables: true });
  const id = "stall-water";
  const [x, z] = STALL_CONSUMABLES[id].approach;
  try {
    await approach(world, "a", x, z);
    for (let i = 0; i < 4; i++) {
      const rec = world.act("a", `sip-${i}`, intent(id));
      await startMotion(world, id);
      await advance(world, 0.85);
      expect(world.observe("a").heldObjects).toEqual([id]);
      expect(world.frames().stallProps?.[id].motion).toBeDefined();
      await advance(world, 3);
      expect(rec.consumed).toBe(id);
      expect(rec.outcome?.ok).toBe(true);
      expect(world.frames().stallProps?.[id]).toEqual({ visible: true });
    }
    expect(world.act("a", "empty", intent(id)).outcome?.detail).toContain("out_of_stock");
    expect(JSON.stringify(world.observe("a").stallConsumables)).not.toMatch(/portions|volume|refill/);
  } finally { world.detach("a"); }
});

test("stopping before contact returns the untouched item and releases the reservation", async () => {
  const world = new WorldService({ sim, stallConsumables: true });
  const id = "stall-water";
  const [x, z] = STALL_CONSUMABLES[id].approach;
  try {
    await approach(world, "a", x, z);
    const rec = world.act("a", "first", intent(id));
    await startMotion(world, id);
    await advance(world, 0.85);
    world.act("a", "stop", { type: "stop" });
    await advance(world, 2);
    expect(rec.consumed).toBeUndefined();
    expect(world.observe("a").heldObjects ?? []).not.toContain(id);
    expect(world.frames().stallProps?.[id]).toEqual({ visible: true });
    expect(world.observe("a").stallConsumables?.find(prop => prop.id === id)?.available).toBe(true);
  } finally { world.detach("a"); }
});

test("leaving and re-attaching keeps stamina, plus standing recovery for the time away", async () => {
  const world = new WorldService({ sim, movementEnergy: true });
  const [x, z] = STALL_CONSUMABLES["stall-apple"].approach;
  try {
    world.attach("tired", { x, z: z - 6 });
    world.act("tired", "walk", { type: "go_to", point: [x, z - 0.7] });
    await advance(world, 2);
    world.act("tired", "halt", { type: "stop" });
    await advance(world, 0.05);
    const before = world.observe("tired").energy!.current;
    expect(before).toBeLessThan(100);
    world.detach("tired");
    expect(world.attach("tired", { x, z }).energy!.current).toBeCloseTo(before, 1);
    world.detach("tired");
    await advance(world, 0.5);
    const back = world.attach("tired", { x, z }).energy!.current;
    expect(back).toBeCloseTo(Math.min(100, before + 0.5), 1);
  } finally { world.detach("tired"); }
});
