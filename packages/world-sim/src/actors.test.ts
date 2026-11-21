import { expect, test } from "bun:test";
import { ActorRegistry, actorHit, type ActorBody } from "./actors";
import type { Vec3 } from "./walk";

const open = { blocked: () => null } as any;
const rng = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

test("wrapWorld.blocked agrees with a brute-force sweep over every live actor, for random moves", () => {
  let now = 1000;
  const reg = new ActorRegistry(2000, () => now), r = rng(7);
  const bodies: ActorBody[] = [];
  for (let i = 0; i < 120; i++) {
    const b: ActorBody = { id: "a" + i, position: [r() * 60 - 30, 0, r() * 60 - 30], velocity: [0, 0], radius: 0.3 + r(), height: 1.7, mobile: true, updatedAtMs: now };
    bodies.push(b); reg.publish(b);
  }
  const world = reg.wrapWorld(open, "a0");
  for (let k = 0; k < 400; k++) {
    const from: Vec3 = [r() * 60 - 30, 0, r() * 60 - 30], to: Vec3 = [from[0] + (r() - 0.5) * 12, 0, from[2] + (r() - 0.5) * 12];
    const want = bodies.filter((b) => b.id !== "a0").map((b) => actorHit(from, to, 0.4, 1.7, b)).find((h) => h);
    expect(world.blocked(from, to, 0.4)).toEqual(want ?? null);
  }
});

test("an actor past its ttl no longer blocks, and a skipped id never blocks", () => {
  let now = 0;
  const reg = new ActorRegistry(2000, () => now);
  reg.publish({ id: "x", position: [0, 0, 0], velocity: [0, 0], radius: 1, height: 1.7, mobile: true, updatedAtMs: 0 });
  const world = reg.wrapWorld(open, "me");
  expect(world.blocked([-3, 0, 0], [3, 0, 0], 0.4)).not.toBeNull();
  expect(reg.wrapWorld(open, ["me", "x"]).blocked([-3, 0, 0], [3, 0, 0], 0.4)).toBeNull();
  now = 2001;
  expect(world.blocked([-3, 0, 0], [3, 0, 0], 0.4)).toBeNull();
});

test("nearby returns copies of the live actors in range, sorted by id, without self or expired ones", () => {
  let now = 0;
  const reg = new ActorRegistry(2000, () => now);
  const put = (id: string, x: number, t = 0) => reg.publish({ id, position: [x, 0, 0], velocity: [0, 0], radius: 0.4, height: 1.7, mobile: true, updatedAtMs: t });
  put("b", 1); put("a", 2); put("me", 0); put("far", 50); put("old", 1, -5000);
  const got = reg.nearby("me", [0, 0, 0], 5);
  expect(got.map((b) => b.id)).toEqual(["a", "b"]);
  got[0]!.position[0] = 99;                                           // a copy: the registry is not touched
  expect(reg.nearby("me", [0, 0, 0], 5)[0]!.position[0]).toBe(2);
});
