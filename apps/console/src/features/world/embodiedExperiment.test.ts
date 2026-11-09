// @vitest-environment node
// Deterministic controller experiment: no screenshots, LLM decisions or production traffic.
// Gates are intentionally strict: a failed scenario must not be called a successful full experiment.
import { describe, expect, it } from "vitest";
import { ActorRegistry, avoidActorInput } from "./actors";
import { ClipTestState } from "./clips";
import { navigationSegment, planRoute } from "./navigation";
import { ScoutExecutor, type ScoutOutcome } from "./scout";
import { makeWalker, type Vec3, type World } from "./walker";

type Rect = [number, number, number, number];
type Scenario = "open" | "detour" | "crossing" | "doorway" | "unreachable" | "obstacle_inserted";
const SEEDS = Array.from({ length: 20 }, (_, i) => i + 1);
const opts = { cellSize: .5, halfExtent: 12, maxExpansions: 6000 };
function arena(rects: Rect[]): World {
  return { groundY: (x, z) => Math.abs(x) <= 10 && Math.abs(z) <= 10 ? 0 : null,
    blocked: (from, to, radius) => {
      const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[2] - from[2]) / .1));
      for (let k = 0; k <= n; k++) {
        const x = from[0] + (to[0] - from[0]) * k/n, z = from[2] + (to[2] - from[2]) * k/n;
        for (const [x0, z0, x1, z1] of rects) {
          if (x <= x0-radius || x >= x1+radius || z <= z0-radius || z >= z1+radius) continue;
          const candidates = [{ nx: -1, nz: 0, depth: x-x0+radius }, { nx: 1, nz: 0, depth: x1+radius-x }, { nx: 0, nz: -1, depth: z-z0+radius }, { nx: 0, nz: 1, depth: z1+radius-z }];
          return candidates.sort((a,b) => a.depth-b.depth)[0];
        }
      }
      return null;
    } };
}
async function run(scenario: Scenario, seed: number) {
  const jitter = (seed - 10.5) / 100;
  const rects: Rect[] = scenario === "detour" ? [[-.25,-2,.25,2]] : scenario === "doorway" ? [[-.25,-10,.25,-.65],[-.25,.65,.25,10]] : scenario === "unreachable" ? [[-.25,-10,.25,10]] : [];
  const staticWorld = arena(rects);
  let now = 0; const registry = new ActorRegistry(2000, () => now);
  const starts: Vec3[] = [[-4,0,jitter]];
  const goals: Vec3[] = [[4,0,jitter]];
  if (scenario === "crossing") { starts.push([jitter,0,-4]); goals.push([jitter,0,4]); }
  if (scenario === "doorway") { starts.push([4,0,-jitter]); goals[0] = [6,0,jitter]; goals.push([-6,0,-jitter]); }
  const states = starts.map(p => makeWalker(...p));
  states.forEach((s,i) => registry.publishWalker(`bot-${i}`,s));
  const worlds = states.map((_,i) => registry.wrapWorld(staticWorld,`bot-${i}`));
  const executors = states.map((_,i) => new ScoutExecutor({
    places: [], sittables: [], clips: new ClipTestState(), hipsY: .7,
    avoid: (s,input) => avoidActorInput({id:`bot-${i}`,position:[s.x,s.y,s.z],velocity:[s.vx,s.vz],radius:.4,height:1.7,updatedAtMs:now,mobile:true},registry.nearby(`bot-${i}`,[s.x,s.y,s.z],10),input),
    plan: (s,target) => { const r=planRoute(staticWorld,[s.x,s.y,s.z],[target[0],s.y,target[1]],opts); return r.status==="found" ? r.waypoints.map(p=>[p[0],p[2]]) : null; },
    safe: (s,target) => navigationSegment(staticWorld,[s.x,s.y,s.z],[target[0],s.y,target[1]],opts),
  }));
  const outcomes: (ScoutOutcome | null)[] = states.map(()=>null);
  executors.forEach((ex,i) => { void ex.submit({ type:"go_to",point:[goals[i][0],goals[i][2]] },states[i]).then(o=>{outcomes[i]=o;}); });
  let minClearance = Infinity;
  let doorwayThreatAt: number | null = null, doorwayClearAt: number | null = null;
  for (let frame=0;frame<1800 && outcomes.some(o=>o===null);frame++) {
    now=frame*1000/30;
    if(scenario==="obstacle_inserted" && frame===30) rects.push([-.25,-2,.25,2]);
    for (let i=0;i<states.length;i++) {
      executors[i].tick(1/30,states[i],worlds[i]); registry.publishWalker(`bot-${i}`,states[i]);
      const feet: Vec3 = [states[i].x, states[i].y, states[i].z];
      expect(staticWorld.blocked(feet, feet, .4), `${scenario} seed ${seed}: static penetration`).toBeNull();
      if (states.length===2) minClearance=Math.min(minClearance,Math.hypot(states[0].x-states[1].x,states[0].z-states[1].z)-.8);
    }
    if (scenario === "doorway") {
      if (doorwayThreatAt === null && Math.hypot(states[0].x-states[1].x, states[0].z-states[1].z) <= 5.2) doorwayThreatAt = now;
      if (doorwayClearAt === null && states[0].x > .8 && states[1].x < -.8) doorwayClearAt = now;
    }
    await Promise.resolve();
  }
  return { seed, outcomes: outcomes.map(o=>o?.status??"unsettled"), completed: outcomes.every(o=>o?.status==="arrived"), minClearance, elapsedSeconds: now/1000,
    doorwayClearSeconds: doorwayThreatAt !== null && doorwayClearAt !== null ? (doorwayClearAt-doorwayThreatAt)/1000 : null,
    maxTargetError: Math.max(...states.map((s,i)=>Math.hypot(s.x-goals[i][0],s.z-goals[i][2]))) };
}
describe("embodied deterministic experiment (20 seeds per scenario)", () => {
  for (const scenario of ["open","detour","crossing","doorway","obstacle_inserted","unreachable"] as const) {
    it(scenario, async () => {
      const results=[];
      for(const seed of SEEDS) results.push(await run(scenario,seed));
      const completed=results.filter(r=>r.completed).length;
      const minClearance=Math.min(...results.map(r=>r.minClearance));
      console.log(JSON.stringify({scenario,seeds:SEEDS.length,completed,maxDoorwayClearSeconds:scenario==="doorway"?Math.max(...results.map(r=>r.doorwayClearSeconds??Infinity)):null,maxSeconds:Math.max(...results.map(r=>r.elapsedSeconds)),minClearance:Number.isFinite(minClearance)?minClearance:null,failures:results.filter(r=>!r.completed).map(r=>({seed:r.seed,outcomes:r.outcomes}))}));
      expect(minClearance).toBeGreaterThanOrEqual(-.02);
      if(scenario==="doorway") expect(results.every(r=>r.doorwayClearSeconds!==null && r.doorwayClearSeconds<=10)).toBe(true);
      if(scenario==="unreachable") expect(results.every(r=>r.outcomes.every(s=>s==="blocked"))).toBe(true);
      else { expect(completed).toBeGreaterThanOrEqual(19); expect(results.filter(r=>r.completed).every(r=>r.maxTargetError<=1)).toBe(true); }
    },30000);
  }
  it("stale and removed actors disappear in all seeds",()=>{
    for(const seed of SEEDS){let now=seed;const registry=new ActorRegistry(2000,()=>now);registry.publishWalker("gone",makeWalker(0,0,0));now+=2001;expect(registry.list()).toEqual([]);registry.publishWalker("gone",makeWalker(0,0,0));registry.remove("gone");expect(registry.list()).toEqual([]);}
  });
  it("stop cancels pending action and cannot replay movement after resumed ticks", async () => {
    for (const seed of SEEDS) {
      const state = makeWalker(-4, 0, seed / 100);
      const world = arena([]);
      const ex = new ScoutExecutor({ places: [], sittables: [], clips: new ClipTestState(), hipsY: .7 });
      const pending = ex.submit({ type: "go_to", point: [4, 0] }, state);
      for (let frame = 0; frame < 30; frame++) ex.tick(1/30, state, world);
      expect((await ex.submit({ type: "stop" }, state)).ok).toBe(true);
      expect((await pending).detail).toBe("cancelled");
      const position = [state.x, state.y, state.z];
      for (let frame = 0; frame < 90; frame++) ex.tick(1/30, state, world);
      expect([state.x, state.y, state.z]).toEqual(position);
      expect(state.speed).toBe(0);
    }
  });

});
