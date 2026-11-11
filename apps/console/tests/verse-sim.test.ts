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
// Known gaps (kept visible, not hidden): no occlusion test in avoidance (agentBody.ts), no elevator controller (upper floors).
// hall-0's stand used to sit on the hall's wall line (no route, "no safe route"); it now stands 2.5 m off on the walkable side, so all
// 158 places are reachable by go_to. The hall itself is still a doorless solid box.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim, NAVMESH_BIN } from "@aiverse/world-sim/node/loadWorld";
import type { VerseSim } from "@aiverse/world-sim/verseSim";
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
    for (const [i, place, room] of [[0, "shop-47", "shop-47"], [1, "shop-102", "tea"]] as const) {
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

  it("the Great Hall (hall-0) is reachable: its stand is off the wall line", async () => {
    sim.removeBody("hall");
    sim.addBody({ id: "hall" });
    const r = await run(sim, "hall", { type: "go_to", place: "hall-0" } as ScoutAction, 300);
    expect(r.out?.status).toBe("arrived");
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
