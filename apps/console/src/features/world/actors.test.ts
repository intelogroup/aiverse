// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ActorRegistry, actorHit, crossingThreat, avoidActorInput, type ActorBody } from "./actors";
import { makeWalker, moveToIntent, step, type World } from "./walker";
const body = (id = "other", x = 0, z = 0): ActorBody => ({ id, position: [x, 0, z], velocity: [0, 0], radius: .4, height: 1.7, updatedAtMs: 100 });
const ground: World = { groundY: () => 0, blocked: () => null };

describe("world actor registry", () => {
  it("expires absent owners, removes unmounted owners, and excludes self", () => {
    let now = 100; const actors = new ActorRegistry(2000, () => now);
    actors.publish(body("self")); actors.publish(body("other", 1));
    expect(actors.nearby("self", [0, 0, 0], 2).map(a => a.id)).toEqual(["other"]);
    actors.remove("other"); expect(actors.nearby("self", [0, 0, 0], 2)).toEqual([]);
    now = 2101; expect(actors.list()).toEqual([]);
  });
  it("copies inputs and rejects invalid state or older updates", () => {
    const actors = new ActorRegistry(2000, () => 100); const b = body(); actors.publish(b); b.position[0] = 99;
    const read = actors.list(); read[0].position[0] = 50;
    actors.publish({ ...body(), position: [20, 0, 0], updatedAtMs: 99 });
    expect(actors.list()[0].position[0]).toBe(0);
    expect(() => actors.publish({ ...body(), velocity: [NaN, 0] })).toThrow();
    actors.clear(); expect(actors.list()).toEqual([]);
  });
  it("does not collide with self or an actor on another storey", () => {
    const actors = new ActorRegistry(2000, () => 100); actors.publish(body("self"));
    const world = actors.wrapWorld(ground, "self"); expect(world.blocked([-2, 0, 0], [2, 0, 0], .4)).toBeNull();
    actors.publish({ ...body(), position: [0, 3, 0] }); expect(world.blocked([-2, 0, 0], [2, 0, 0], .4)).toBeNull();
  });
  it("sweeps fast movement and permits moving out of an overlap", () => {
    expect(actorHit([-3, 0, 0], [3, 0, 0], .4, 1.7, body())?.nx).toBe(-1);
    expect(actorHit([.5, 0, 0], [1, 0, 0], .4, 1.7, body())).toBeNull();
    expect(actorHit([.5, 0, 0], [.4, 0, 0], .4, 1.7, body())).not.toBeNull();
  });
  it("real walker steps do not penetrate a stationary actor", () => {
    const actors = new ActorRegistry(2000, () => 100); actors.publish(body()); const world = actors.wrapWorld(ground, "self");
    const s = makeWalker(-3, 0, 0, Math.PI / 2);
    for (let k = 0; k < 300; k++) { step(s, moveToIntent(s, [3, 0]).input, 1/30, world); expect(Math.hypot(s.x, s.z)).toBeGreaterThanOrEqual(.8 - 1e-5); }
    expect(s.x).toBeLessThan(0);
  });
  it("predicts crossing traffic and assigns only one moving actor yield priority", () => {
    const a = { ...body("a", -1), velocity: [1, 0] as [number, number] };
    const b = { ...body("b", 1), velocity: [-1, 0] as [number, number] };
    expect(crossingThreat(a, b)?.timeToClosest).toBe(1);
    expect(crossingThreat(a, b)?.shouldYield).toBe(false); expect(crossingThreat(b, a)?.shouldYield).toBe(true);
    expect(crossingThreat(a, { ...body("far", 20) })).toBeNull();
  });
  it("yields right with stable mobile priority and lets anchored residents keep priority", () => {
    const a = { ...body("a", -1), velocity: [1, 0] as [number, number], mobile: true };
    const b = { ...body("b", 1), velocity: [-1, 0] as [number, number], mobile: true };
    const wanted = { forward: 1, strafe: 0, turn: 0, run: false, faceHeading: -Math.PI / 2 };
    expect(avoidActorInput(b, [a], wanted).strafe).toBe(.7);
    expect(avoidActorInput(a, [b], { ...wanted, faceHeading: Math.PI/2 }).forward).toBe(1);
    expect(crossingThreat(a, { ...b, mobile: false })?.shouldYield).toBe(true);
    expect(avoidActorInput(b, [], wanted)).toEqual(wanted);
  });

});
