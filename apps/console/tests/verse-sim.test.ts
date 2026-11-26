import { MARKET_HALL_SAMPLE } from "@aiverse/shared/marketHall";
import { makeWalker, moveToIntent, step } from "@aiverse/world-sim/walker";
// @vitest-environment node
// The server-side agent sim (packages/world-sim: VerseSim + AgentBody on the baked navmesh) against the real City 3 data, no browser.
//
// What is pinned, and against what:
//  - the scripted Tea House sequence (walk, door, sit, stand, radio on and off, exit): status per step and where each step ends,
//    from the headless run itself (regression golden, tolerance for Bun-vs-Node float differences). The ONE browser anchor is the
//    first step: the browser scout (verse_parity.cjs, 2026-11-10) ended it at (-16.59, 14.88); a full browser golden did not finish
//    (the Tea House step exceeded 9 min of software-rendered wall time), so the later steps are headless goldens, not browser parity.
//  - planning cost: a route is planned in well under a tick (grid A* took 0.1-50 s on the tick thread), and an unreachable goal is
//    refused at once.
//  - the navmesh is baked from the collision GLB in the repo (a stale bake fails here).
// Avoidance does not yet test occlusion (agentBody.ts).
// Every place in city3-places.json is reachable by go_to. The Market Hall has a separate south entry and room.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim, NAVMESH_BIN } from "@aiverse/world-sim/node/loadWorld";
import type { VerseSim } from "@aiverse/world-sim/verseSim";
import { WorldService } from "@aiverse/world-sim/worldService";
import { roomAt, type ScoutAction, type ScoutOutcome } from "@aiverse/world-sim/scout";

const ASSETS = new URL("../public/assets/", import.meta.url).pathname;
const steps = JSON.parse(readFileSync(new URL("./fixtures/verse-sim-scenarios.json", import.meta.url), "utf8")) as { name: string; action: ScoutAction; maxS: number }[];

/** Run the sim in 0.1 s ticks until the action settles or `maxS` sim seconds pass; reports the worst single tick. */
async function run(sim: VerseSim, id: string, action: ScoutAction, maxS: number) {
  const body = sim.body(id)!;
  let out: ScoutOutcome | null = null;
  void body.act(action).then((o) => (out = o));
  const t0 = sim.t;
  let maxTickMs = 0;
  while (!out && sim.t - t0 < maxS) {
    const a = performance.now();
    sim.tick(0.1);
    maxTickMs = Math.max(maxTickMs, performance.now() - a);
    await Promise.resolve();
  }
  return { out: out as ScoutOutcome | null, simS: sim.t - t0, maxTickMs, snap: body.snapshot() };
}

let sim: VerseSim;
beforeAll(async () => {
  ({ sim } = await loadVerseSim(ASSETS));
}, 120_000);

describe("the navmesh artifact", () => {
  it("was baked from the collision GLB that is in the repo", () => {
    const meta = JSON.parse(readFileSync(NAVMESH_BIN.replace(/\.bin$/, ".json"), "utf8")) as { source: { glbSha256: string } };
    const glb = createHash("sha256").update(readFileSync(`${ASSETS}world-city3-collision.glb`)).digest("hex");
    expect(meta.source.glbSha256, "world-city3-collision.glb changed: rebake with `bun run packages/world-sim/node/bakeNavmesh.ts`").toBe(glb);
  });
});

describe("one agent body, the scripted Tea House sequence", () => {
  // [status, x, z, tolerance m, max sim seconds]: headless goldens (see header). Floors: stall y 0.20, Tea House ground floor 0.48.
  const EXPECT: Record<string, [string, number, number, number, number]> = {
    stall: ["arrived", -16.49, 15.13, 0.75, 30],
    "tea-door": ["arrived", -22.91, -74.45, 0.75, 120],
    sit: ["seated", -32.88, -75.65, 0.75, 30],
    stand: ["stood", -33.5, -75.65, 0.75, 6],
    "to-radio": ["arrived", -17.95, -78.65, 0.75, 30],
    "radio-on": ["done", -20.55, -75.91, 0.75, 20],
    "radio-off": ["done", -20.55, -75.91, 0.75, 20],
    exit: ["arrived", -22.91, -70.54, 0.75, 45],
  };
  const results: Record<string, Awaited<ReturnType<typeof run>>> = {};

  it("spawns where the browser scout spawns", () => {
    const b = sim.addBody({ id: "agent-1" });
    const s = b.snapshot();
    expect([+s.x.toFixed(2), +s.y.toFixed(2), +s.z.toFixed(2)]).toEqual([5.68, 0.2, 10.57]);
  });

  for (const st of steps) {
    it(`step ${st.name}`, async () => {
      const r = (results[st.name] = await run(sim, "agent-1", st.action, st.maxS));
      const [status, x, z, tol, maxS] = EXPECT[st.name];
      expect(r.out?.status, `${st.name}: ${JSON.stringify(r.out)} at (${r.snap.x.toFixed(2)}, ${r.snap.y.toFixed(2)}, ${r.snap.z.toFixed(2)})`).toBe(status);
      expect(Math.hypot(r.snap.x - x, r.snap.z - z), `${st.name} ended at (${r.snap.x.toFixed(2)}, ${r.snap.z.toFixed(2)})`).toBeLessThan(tol);
      expect(r.simS).toBeLessThan(maxS);
    }, 60_000);
  }

  it("the first step ends where the browser scout ended it", () => {
    const s = results.stall.snap;
    expect(Math.hypot(s.x - -16.59, s.z - 14.88)).toBeLessThan(0.6);
  });

  it("toggles the radio and ends standing on the Tea House floor", () => {
    expect(sim.interact.isOn("tea-radio")).toBe(false);
    expect(results.exit.snap.posture).toBe("standing");
  });

  it("no single tick of the whole sequence took long enough to stall other agents", () => {
    const worst = Math.max(...Object.values(results).map((r) => r.maxTickMs));
    expect(worst, `worst tick ${worst.toFixed(0)} ms`).toBeLessThan(250); // grid A* froze the tick for up to 55 s
  });
});

describe("planning does not block the tick", () => {
  it("a goal that cannot be reached is refused at once, and a point off the world too", async () => {
    sim.removeBody("probe");
    sim.addBody({ id: "probe" });
    for (const action of [{ type: "go_to", point: [900, 900] }] as ScoutAction[]) {
      const t = performance.now();
      const r = await run(sim, "probe", action, 5);
      expect(r.out?.status).toBe("blocked");
      expect(performance.now() - t, "refusal must not wait for a search").toBeLessThan(1500);
    }
  });

  it("enter walks inside a shop (by lot id or room id); a stall has no room", async () => {
    for (const [i, place, room] of [[0, "house-cabin-1", "house-cabin-1"], [1, "shop-102", "tea"]] as const) {
      const id = `enter-${i}`;
      sim.removeBody(id);
      const lot = sim.places.find((p) => p.id === place)!;
      sim.addBody({ id, spawn: { x: lot.stand[0] + 3, z: lot.stand[1] + 3 } });
      const r = await run(sim, id, { type: "enter", place } as ScoutAction, 150);
      expect(r.out?.status).toBe("arrived");
      expect(roomAt(sim.rooms, r.snap.x, r.snap.z)?.id).toBe(room);
    }
    const r = await run(sim, "enter-0", { type: "enter", place: "stall-0" } as ScoutAction, 5);
    expect(r.out?.status).toBe("unavailable");
  });

  it("shop seats are sittable once, and free again after the sitter stands", async () => {
    const seats = sim.sittables.filter((t) => t.building.startsWith("shop-") && t.kind !== "stool" && sim.rooms.some((r) => r.id === t.building));   // shop-98 has chairs but no interior room: nowhere to walk in
    const picks = seats.filter((_, i) => i % Math.ceil(seats.length / 12) === 0);
    const fails: string[] = [];
    for (const other of sim.bodyIds()) sim.removeBody(other); // a body parked in a shop would block the walk
    for (const [i, seat] of picks.entries()) {
      const a = `sit-a-${i}`, b = `sit-b-${i}`;
      sim.removeBody(a); sim.removeBody(b);
      const lot = sim.places.find((p) => p.id === seat.building)!;
      const room = sim.rooms.find((r) => r.id === seat.building)!, [rx0, rz0, rx1, rz1] = room.rect;   // customer side: from the room centre out through its door
      const ex = room.door[0] - (rx0 + rx1) / 2, ez = room.door[1] - (rz0 + rz1) / 2;
      const [ox, oz] = Math.abs(ex) > Math.abs(ez) ? [Math.sign(ex), 0] : [0, Math.sign(ez)];
      sim.addBody({ id: a, spawn: { x: lot.stand[0] + ox * 3, z: lot.stand[1] + oz * 3 } });
      sim.addBody({ id: b, spawn: { x: lot.stand[0] + ox * 8, z: lot.stand[1] + oz * 8 } });
      let sat: ScoutOutcome | null = null;
      void sim.body(a)!.act({ type: "sit", sittable: seat.id } as ScoutAction).then((o) => (sat = o));
      sim.tick(0.1); await Promise.resolve();
      // b asks while a is still walking there: a's claim already holds the seat
      const rb = await run(sim, b, { type: "sit", sittable: seat.id } as ScoutAction, 1);
      if (rb.out?.status !== "unavailable" || !/occupied/.test(rb.out.detail ?? "")) fails.push(`${seat.id}: claim not seen: ${JSON.stringify(rb.out)}`);
      for (let t = 0; t < 3000 && !sat; t++) { sim.tick(0.1); await Promise.resolve(); }
      if ((sat as ScoutOutcome | null)?.status !== "seated") { fails.push(`${seat.id}: ${JSON.stringify(sat)}`); continue; }
      expect(sim.seatHolder(seat.id)).toBe(a);
      const st = await run(sim, a, { type: "stand" } as ScoutAction, 8);
      if (st.out?.status !== "stood") fails.push(`${seat.id}: stand ${JSON.stringify(st.out)}`);
      if (sim.seatHolder(seat.id) !== null) fails.push(`${seat.id}: not freed`);
    }
    expect(fails).toEqual([]);
  }, 120_000);

  it("every place in city3-places.json is reachable by go_to, and every shop with a room can be entered", async () => {
    const places = JSON.parse(readFileSync(`${ASSETS}city3-places.json`, "utf8")) as { id: string }[];
    const fails: string[] = [];
    for (const p of places) {   // a fresh body per goal: a body left inside the previous shop would make the next route fail for the wrong reason
      sim.removeBody("sweep"); sim.addBody({ id: "sweep" });
      const g = await run(sim, "sweep", { type: "go_to", place: p.id } as ScoutAction, 400);
      if (g.out?.status !== "arrived") fails.push(`${p.id} go_to ${JSON.stringify(g.out)}`);
      const room = sim.rooms.find((r) => r.id === p.id);
      if ((p.id.startsWith("shop-") || p.id.startsWith("house-")) && room) {
        sim.removeBody("sweep"); sim.addBody({ id: "sweep" });
        const e = await run(sim, "sweep", { type: "enter", place: p.id } as ScoutAction, 300);
        // past the door line, not only inside the rect: an L-shaped house's rect also covers its porch
        const [ix, iz] = [room.center[0] - room.door[0], room.center[1] - room.door[1]];
        const past = ((e.snap.x - room.door[0]) * ix + (e.snap.z - room.door[1]) * iz) / (Math.hypot(ix, iz) || 1);
        if (e.out?.status !== "arrived" || roomAt(sim.rooms, e.snap.x, e.snap.z)?.id !== p.id || past < 0.1) fails.push(`${p.id} enter ${JSON.stringify(e.out)} past ${past.toFixed(2)}`);
      }
    }
    sim.removeBody("sweep");
    expect(fails).toEqual([]);
  }, 300_000);

  it("opens Scandi Hawk's blocked door for an agent entering and exiting", async () => {
    const id = "hawk-walker";
    const roomId = "house-ring-35-0";
    sim.addBody({ id, spawn: { x: 22.925, z: -138.7 } });
    try {
      expect(sim.walk.has("door:house-ring-35-0")).toBe(true);
      const entry = await run(sim, id, { type: "enter", place: roomId }, 550);
      expect(entry.out?.status).toBe("arrived");
      expect(roomAt(sim.rooms, entry.snap.x, entry.snap.z)?.id).toBe(roomId);
      const sit = await run(sim, id, { type: "sit", sittable: "scandi-hawk-sofa" }, 550);
      expect(sit.out?.status).toBe("seated");
      const stand = await run(sim, id, { type: "stand" }, 30);
      expect(stand.out?.status).toBe("stood");
      const exit = await run(sim, id, { type: "go_to", point: [22.925, -138.7] }, 550);
      expect(exit.out?.status).toBe("arrived");
      expect(roomAt(sim.rooms, exit.snap.x, exit.snap.z)).toBeNull();
      sim.tick(3);
      expect(sim.walk.has("door:house-ring-35-0")).toBe(true);
    } finally {
      sim.removeBody(id);
    }
  });

  it("lets an agent walk to Scandi Hawk's loft bed, recover energy, and walk back outside", async () => {
    const service = new WorldService({ sim, movementEnergy: true });
    const id = "hawk-loft-walker";
    const roomId = "house-ring-35-0";
    const bedId = "scandi-hawk-loft-bed";
    const outside = [22.925, -138.7] as [number, number];
    service.attach(id, { x: outside[0], z: outside[1] });
    const body = sim.body(id)!;
    async function act(actionId: string, action: ScoutAction, status: ScoutOutcome["status"]) {
      const record = service.act(id, actionId, action);
      const started = sim.t;
      const heights: number[] = [];
      let previous = body.pose();
      let largestStride = 0, largestRise = 0, largestFloorChange = 0;
      while (record.state === "running" && sim.t - started < 45) {
        const priorFloor = body.state.y;
        service.tick(1 / 60);
        const pose = body.pose();
        largestStride = Math.max(largestStride, Math.hypot(pose.x - previous.x, pose.z - previous.z));
        largestRise = Math.max(largestRise, Math.abs(pose.y - previous.y));
        largestFloorChange = Math.max(largestFloorChange, Math.abs(body.state.y - priorFloor));
        heights.push(body.state.y);
        previous = pose;
        await Promise.resolve();
      }
      expect(record.outcome, JSON.stringify(body.snapshot())).toMatchObject({ ok: true, status });
      expect(largestStride).toBeLessThan(0.12);
      expect(largestRise).toBeLessThan(0.42);
      expect(largestFloorChange).toBeLessThan(0.42);
      return heights;
    }

    try {
      await act("enter", { type: "enter", place: roomId }, "arrived");
      const entry = service.observe(id);
      expect(entry.body.y).toBeCloseTo(0.53, 2);
      await act("face-bed", { type: "face", point: [21.89, -143.7] }, "done");
      expect(service.observe(id).scene).toContainEqual(expect.objectContaining({
        id: bedId, kind: "seat", seatKind: "bed", state: "free",
      }));

      const ascent = await act("sit", { type: "sit", sittable: bedId }, "seated");
      expect(ascent.some((y) => y > 1.2 && y < 2.0)).toBe(true);
      expect(ascent.some((y) => y > 2.3 && y < 3.2)).toBe(true);
      const seated = service.observe(id);
      expect(seated.body.seatedOn).toBe(bedId);
      expect(seated.body.y).toBeCloseTo(3.36, 2);
      expect(seated.energy!.current).toBeLessThan(entry.energy!.current);

      await act("rest", { type: "wait", seconds: 3 }, "done");
      const rested = service.observe(id);
      expect(rested.energy!.current).toBeGreaterThan(seated.energy!.current);
      expect(rested.body.seatedOn).toBe(bedId);

      await act("stand", { type: "stand" }, "stood");
      expect(body.state.x).toBeCloseTo(23.37, 2);
      expect(body.state.z).toBeCloseTo(-143.60, 2);
      expect(body.state.y).toBeCloseTo(3.36, 2);
      const descent = await act("exit", { type: "go_to", point: outside }, "arrived");
      expect(descent.some((y) => y > 1.2 && y < 2.0)).toBe(true);
      expect(descent.some((y) => y > 2.3 && y < 3.2)).toBe(true);
      expect(body.state.y).toBeCloseTo(0.2, 2);
      expect(roomAt(sim.rooms, body.state.x, body.state.z)).toBeNull();
      expect(Math.hypot(body.state.x - outside[0], body.state.z - outside[1])).toBeLessThan(0.6);
    } finally {
      service.detach(id);
    }
  });

  it("walks up Scandi Hawk's treads to the loft and back downstairs", () => {
    const body = makeWalker(26.2, 0.53, -145.47, Math.PI);
    const walkTo = (goal: [number, number]) => {
      for (let i = 0; i < 240; i++) {
        const intent = moveToIntent(body, goal, 0.045);
        if (intent.arrived) return;
        step(body, intent.input, 1 / 60, sim.world);
      }
      throw new Error(`Walker did not reach ${goal} from ${body.x}, ${body.y}, ${body.z}`);
    };
    walkTo([26.2, -146.48]);
    walkTo([23.1, -146.45]);
    expect(body.y).toBeCloseTo(3.36, 2);
    walkTo([23.37, -143.60]);
    expect(body.y).toBeCloseTo(3.36, 2);
    walkTo([23.1, -146.45]);
    walkTo([26.2, -146.48]);
    walkTo([26.2, -145.47]);
    expect(body.y).toBeCloseTo(0.53, 2);
  });

  it("walks across the Villa bridge at deck height", async () => {
    const id = "villa-walker";
    const start = sim.places.find(place => place.id === "stall-40")!.stand;
    sim.addBody({ id, x: start[0], z: start[1] });
    try {
      const body = sim.body(id)!;
      let outcome: ScoutOutcome | undefined;
      void body.act({ type: "go_to", place: "villa" }).then(result => { outcome = result; });
      const deckHeights: number[] = [];
      for (let tick = 0; tick < 3600 && !outcome; tick++) {
        sim.tick(0.1);
        await Promise.resolve();
        const { y, z } = body.snapshot();
        if (z >= 180 && z < 215) deckHeights.push(y);
      }
      expect(outcome?.status).toBe("arrived");
      expect(deckHeights.length).toBeGreaterThan(20);
      expect(deckHeights.every(y => Math.abs(y - 0.2) < 0.03)).toBe(true);
    } finally {
      sim.removeBody(id);
    }
  });

  it("walks from Hawk Lane to both entrances and uses the commons bench", async () => {
    const id = "hawk-commons-visitor";
    sim.addBody({ id, spawn: { x: 24, z: -136.4 } });
    try {
      const hawk = await run(sim, id, { type: "enter", place: "house-ring-35-0" }, 75);
      expect(hawk.out?.status).toBe("arrived");
      expect(roomAt(sim.rooms, hawk.snap.x, hawk.snap.z)?.id).toBe("house-ring-35-0");
      const porch = await run(sim, id, { type: "go_to", place: "hawk-lane-neighbor-porch" }, 75);
      expect(porch.out?.status).toBe("arrived");
      // the American house next door is walk-in (Cedar House): sunk to the hero-shop floor (slab + lift + 0.28) and its doorway open
      expect(porch.snap.y).toBeCloseTo(0.53, 2);
      expect(sim.world.blocked([41.74, 0.53, -143], [41.74, 0.53, -144.6], 0.4)).toBeNull();
      const commons = await run(sim, id, { type: "go_to", place: "hawk-lane-commons" }, 75);
      expect(commons.out?.status).toBe("arrived");
      const sit = await run(sim, id, { type: "sit", sittable: "hawk-lane-bench" }, 20);
      expect(sit.out?.status).toBe("seated");
      expect((await run(sim, id, { type: "stand" }, 10)).out?.status).toBe("stood");
      const street = await run(sim, id, { type: "go_to", point: [24, -136.4] }, 75);
      expect(street.out?.status).toBe("arrived");
    } finally {
      sim.removeBody(id);
    }
  });

  it("keeps Hawk Lane's stepping trail and waterfront sidewalk passable", () => {
    expect(sim.world.blocked([13, 0.2, -157.5], [39, 0.2, -157.5], 0.4)).toBeNull();
    expect(sim.world.blocked([26, 0.2, -177.8], [31, 0.2, -177.8], 0.4)).toBeNull();
    expect(sim.world.blocked([28.8, 0.2, -177.8], [28.8, 0.2, -178.8], 0.4)).not.toBeNull();
  });

  it("visits the Hawk Lane overlook and keeps the waterfront through route open", async () => {
    const id = "hawk-overlook-visitor";
    sim.addBody({ id, spawn: { x: 33.4, z: -177.3 } });
    try {
      const visit = await run(sim, id, { type: "go_to", place: "hawk-lane-overlook" }, 35);
      expect(visit.out?.status).toBe("arrived");
      const sit = await run(sim, id, { type: "sit", sittable: "hawk-lane-overlook-bench" }, 35);
      expect(sit.out?.status).toBe("seated");
      expect((await run(sim, id, { type: "stand" }, 10)).out?.status).toBe("stood");
      const exit = await run(sim, id, { type: "go_to", point: [43.5, -177.3] }, 35);
      expect(exit.out?.status).toBe("arrived");
      for (const z of [-177.15, -177.7]) {
        expect(sim.world.blocked([31, 0.2, z], [44, 0.2, z], 0.4)).toBeNull();
      }
      expect(sim.world.blocked([34, 0.2, -179.1], [34, 0.2, -179.74], 0.4)).not.toBeNull();
    } finally {
      sim.removeBody(id);
    }
  });

  it("crosses the reclaimed northwest lawn while the Lido pool stays blocked", () => {
    expect(sim.world.blocked([-93.5, 0.2, -109], [-78.5, 0.2, -109], 0.4)).toBeNull();
    expect(sim.world.groundY(-86, -109, 2)).toBeCloseTo(0.2, 2);
    expect(sim.world.blocked([35, 0.2, 89], [35, 0.2, 92], 0.4)).not.toBeNull();
  });

  it("reaches both Lido terrace benches and keeps the poolside route clear", async () => {
    const id = "lido-visitor";
    sim.addBody({ id, spawn: { x: 32, z: 110.5 } });
    try {
      const terrace = await run(sim, id, { type: "go_to", place: "lido-terrace" }, 30);
      expect(terrace.out?.status).toBe("arrived");
      for (const sittable of ["lido-bench-west", "lido-bench-east"]) {
        const sit = await run(sim, id, { type: "sit", sittable }, 30);
        expect(sit.out).toMatchObject({ status: "seated", target: sittable });
        expect((await run(sim, id, { type: "stand" }, 10)).out?.status).toBe("stood");
      }
      for (const z of [109.5, 110.5, 111.5]) {
        expect(sim.world.blocked([29, 0.2, z], [41, 0.2, z], 0.4)).toBeNull();
      }
      expect(sim.world.blocked([31.35, 0.2, 112], [31.35, 0.2, 114], 0.4)).not.toBeNull();
    } finally {
      sim.removeBody(id);
    }
  });

  it("enters Market Hall from the south, visits checkout and snacks, sits, and exits", async () => {
    const id = "hall-market-visitor";
    sim.addBody({ id, spawn: { x: 34.5, z: -74 } });
    try {
      const entry = await run(sim, id, { type: "enter", place: "hall-0" }, 100);
      expect(entry.out?.status).toBe("arrived");
      expect(roomAt(sim.rooms, entry.snap.x, entry.snap.z)?.id).toBe("hall-0");
      expect(entry.snap.y).toBeCloseTo(0.2, 2);

      for (const place of [
        "market-hall-bakery", "market-hall-produce", "market-hall-cheese",
        "market-hall-flowers", "market-hall-pantry-shelves", "market-hall-water",
        "market-hall-checkout", "market-hall-snacks",
      ]) {
        const visit = await run(sim, id, { type: "go_to", place }, 100);
        expect(visit.out).toMatchObject({ ok: true, status: "arrived", target: place });
      }
      const sample = await run(sim, id, { type: "interact", target: MARKET_HALL_SAMPLE.id }, 100);
      expect(sample.out).toMatchObject({ ok: true, status: "done", target: MARKET_HALL_SAMPLE.id });
      const seat = await run(sim, id, { type: "sit", sittable: "market-hall-bench-north" }, 100);
      expect(seat.out?.status).toBe("seated");
      expect((await run(sim, id, { type: "stand" }, 30)).out?.status).toBe("stood");
      const exit = await run(sim, id, { type: "go_to", place: "hall-0" }, 100);
      expect(exit.out?.status).toBe("arrived");
      expect(roomAt(sim.rooms, exit.snap.x, exit.snap.z)).toBeNull();

      for (const x of [33.5, 35, 36.5]) {
        expect(sim.world.blocked([x, 0.2, -79], [x, 0.2, -113], 0.28)).toBeNull();
      }
      expect(sim.world.blocked([18, 0.2, -95], [15.5, 0.2, -95], 0.28)).not.toBeNull();
      expect(sim.world.blocked([52, 0.2, -95], [54.5, 0.2, -95], 0.28)).not.toBeNull();
      expect(sim.world.blocked([35, 0.2, -117], [35, 0.2, -120], 0.28)).not.toBeNull();
      expect(sim.world.blocked([28, 0.2, -78], [28, 0.2, -76], 0.28)).not.toBeNull();
    } finally {
      sim.removeBody(id);
    }
  });

  it("20 agents sent to far places in the same tick keep every tick short", async () => {
    const places = (JSON.parse(readFileSync(`${ASSETS}city3-places.json`, "utf8")) as { id: string }[]).filter((_, i) => i % 7 === 0).slice(0, 20);
    const ids = places.map((_, i) => `crowd-${i}`);
    ids.forEach((id) => sim.addBody({ id }));
    const pending = ids.map((id, i) => sim.body(id)!.act({ type: "go_to", place: places[i].id }));
    let worst = 0;
    let settled = 0;
    pending.forEach((p) => void p.then(() => settled++));
    for (let t = 0; t < 3000 && settled < ids.length; t++) { // 300 sim s: the far places are 100+ m of walking
      const a = performance.now();
      sim.tick(0.1);
      worst = Math.max(worst, performance.now() - a);
      await Promise.resolve();
    }
    ids.forEach((id) => sim.removeBody(id));
    expect(worst, `worst tick with 20 planners ${worst.toFixed(0)} ms`).toBeLessThan(250);
    expect(settled).toBe(ids.length);
  }, 60_000);
});
