import { beforeAll, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { validAction } from "@aiverse/world-sim/actionProtocol";
import { APPLE_ID, APPLE_PICKUP, APPLE_RECEIVING, APPLE_STANDS } from "@aiverse/world-sim/movableProps";
import { WorldService } from "@aiverse/world-sim/worldService";

const assets = new URL("../../console/public/assets/", import.meta.url).pathname;
let sim: Awaited<ReturnType<typeof loadVerseSim>>["sim"];
beforeAll(async () => { ({ sim } = await loadVerseSim(assets)); });
const advance = async (world: WorldService, seconds: number) => {
  for (let i = 0; i < Math.ceil(seconds / 0.05); i++) {
    world.tick(0.05);
    await Promise.resolve();
  }
};
const grab = { type: "grab", target: APPLE_ID };
const place = { type: "place", target: APPLE_ID, surface: APPLE_RECEIVING };

test("public action shape cannot set transforms or choose an arbitrary clip", () => {
  expect(validAction(grab)).toBe(true);
  expect(validAction(place)).toBe(true);
  expect(validAction({ ...grab, clip: "PickUp" })).toBe(false);
  expect(validAction({ ...place, point: [0, 10] })).toBe(false);
  expect(validAction({ type: "go_to", point: [8, 12], precise: true })).toBe(false);
});

test("agent discovers, reserves, grabs at contact, carries and places the same object", async () => {
  const world = new WorldService({ sim, movableProps: true });
  try {
    const a = world.attach("a", { x: 8, z: 12 });
    expect(a.movableProps?.object.actions).toEqual(["grab"]);
    expect(world.attach("b", { x: 7.2, z: 12 }).movableProps?.object.id).toBe(APPLE_ID);
    const record = world.act("a", "grab", grab);
    expect(world.act("a", "grab", grab)).toBe(record);
    expect(world.act("b", "race", grab).outcome?.detail).toContain("object_busy");
    await advance(world, 1.25);
    expect(world.frames().apple?.motion?.stand).toBe(APPLE_PICKUP);
    expect(world.observe("a").heldObjects).toEqual([]);
    await advance(world, 3);
    expect(world.observe("a").heldObjects).toEqual([APPLE_ID]);
    const holder = world.roster().bodies.find((entry) => entry.agentId === "a")!.n;
    expect(world.frames().apple?.holder).toBe(holder);
    await advance(world, 8);
    expect(record.outcome?.ok).toBe(true);

    const walk = world.act("a", "walk", { type: "go_to", point: [...APPLE_STANDS[APPLE_RECEIVING].stance] });
    await advance(world, 6);
    expect(walk.outcome?.ok).toBe(true);
    expect(world.frames().apple?.holder).toBe(holder);
    const put = world.act("a", "place", place);
    await advance(world, 4);
    expect(world.frames().apple?.motion?.stand).toBe(APPLE_RECEIVING);
    expect(world.observe("a").heldObjects).toEqual([APPLE_ID]);
    await advance(world, 8);
    expect(put.outcome?.ok).toBe(true);
    expect(world.frames().apple).toEqual({ holder: null, stand: APPLE_RECEIVING, motion: null });
    expect(world.observe("a").heldObjects).toEqual([]);
  } finally { for (const id of world.agentIds()) world.detach(id); }
});

test("stop before contact releases the reservation and a stopped carry remains held", async () => {
  const world = new WorldService({ sim, movableProps: true });
  try {
    world.attach("a", { x: 8, z: 12 });
    world.attach("unsupported", { x: 8, z: 11 }, "eve");
    expect(world.act("unsupported", "try", grab).outcome?.detail).toContain("unsupported_grip");
    const first = world.act("a", "first", grab);
    await advance(world, 1);
    world.act("a", "stop1", { type: "stop" });
    expect(first.outcome?.detail).toBe("cancelled");
    expect(world.frames().apple?.holder).toBeNull();
    const second = world.act("a", "second", grab);
    await advance(world, 4);
    world.act("a", "stop2", { type: "stop" });
    expect(second.outcome?.detail).toBe("cancelled");
    expect(world.observe("a").heldObjects).toEqual([APPLE_ID]);
    world.detach("a");
    expect(world.frames().apple).toEqual({ stand: APPLE_PICKUP, holder: null, motion: null });
  } finally { for (const id of world.agentIds()) world.detach(id); }
});
