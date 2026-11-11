// @vitest-environment node
// The viewer stream's wire format (pure) and the sim-side frames/roster, on the real City 3 world.
import { beforeAll, describe, expect, it } from "vitest";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import type { VerseSim } from "@aiverse/world-sim/verseSim";
import { FrameDiffer, decodePose, encodePose, type PoseTuple } from "@aiverse/world-sim/streamProtocol";

const pose = (o: Partial<Parameters<typeof encodePose>[1]> = {}) => ({ x: 1.234, z: -5.678, y: 0.2, heading: 1, speed: 0, posture: "standing" as const, clip: null, ...o });

describe("encodePose / decodePose", () => {
  it("round-trips to centimetre / milliradian precision", () => {
    const d = decodePose(encodePose(7, pose({ x: 12.345, y: 0.5, z: -3.21, heading: 2.5, speed: 1.4, posture: "seated", clip: "Sit Idle" })));
    expect(d).toEqual({ n: 7, x: 12.35, y: 0.5, z: -3.21, heading: 2.5, speed: 1.4, posture: "seated", clip: "Sit Idle" });
  });
  it("a body standing still produces an identical tuple every time, even for equivalent headings", () => {
    expect(encodePose(1, pose({ heading: 1 }))).toEqual(encodePose(1, pose({ heading: 1 + 2 * Math.PI })));
    expect(encodePose(1, pose({ heading: -1 }))).toEqual(encodePose(1, pose({ heading: 2 * Math.PI - 1 })));
  });
  it("omits the clip when there is none (a locomotion tuple is 7 numbers)", () => {
    expect(encodePose(1, pose())).toHaveLength(7);
    expect(encodePose(1, pose({ clip: "Wave" }))).toHaveLength(8);
  });
});

describe("FrameDiffer", () => {
  const a = (x: number): PoseTuple => [1, x, 0, 0, 0, 0, 0];
  const b: PoseTuple = [2, 500, 0, 0, 0, 0, 0];

  it("first frame is a key frame; later frames carry only what changed; keys repeat on the interval", () => {
    const d = new FrameDiffer(1000);
    const k = d.next("e", 0, [a(0), b], 0);
    expect(k.key).toBe(true);
    expect(k.b).toHaveLength(2);
    const m = d.next("e", 0.1, [a(10), b], 100);
    expect(m.key).toBe(false);
    expect(m.b).toEqual([a(10)]); // body 2 did not move: not resent
    expect(d.next("e", 0.2, [a(10), b], 200).b).toEqual([]);
    const k2 = d.next("e", 1.1, [a(10), b], 1100);
    expect(k2.key).toBe(true);
    expect(k2.b).toHaveLength(2);
  });
  it("reports a vanished body once in `gone`", () => {
    const d = new FrameDiffer(10_000);
    d.next("e", 0, [a(0), b], 0);
    expect(d.next("e", 0.1, [a(0)], 100).gone).toEqual([2]);
    expect(d.next("e", 0.2, [a(0)], 200).gone).toEqual([]);
  });
  it("a new epoch (sim restart) forces a key frame and forgets the old bodies", () => {
    const d = new FrameDiffer(10_000);
    d.next("e1", 0, [a(0), b], 0);
    const m = d.next("e2", 0, [a(0)], 50);
    expect(m.key).toBe(true);
    expect(m.gone).toEqual([]);
  });
  it("full() hands a late subscriber the current picture as a key frame", () => {
    const d = new FrameDiffer(10_000);
    expect(d.full(0)).toBeNull();
    d.next("e", 0, [a(0), b], 0);
    d.next("e", 0.1, [a(10), b], 100);
    const f = d.full(0.1)!;
    expect(f.key).toBe(true);
    expect(f.b).toHaveLength(2);
    expect(f.b.find((t) => t[0] === 1)).toEqual(a(10));
  });
});

describe("WorldService.frames / roster", () => {
  let sim: VerseSim;
  beforeAll(async () => { ({ sim } = await loadVerseSim(new URL("../public/assets/", import.meta.url).pathname)); }, 120_000);

  it("numbers bodies privately: frames carry no agent id, the roster maps number -> agent, numbers are not reused", () => {
    const s = new WorldService({ sim });
    s.attach("agent-aaaa-1111");
    s.attach("agent-bbbb-2222");
    const f = s.frames();
    expect(f.b).toHaveLength(2);
    expect(JSON.stringify(f)).not.toContain("agent-");
    const r = s.roster();
    expect(r.epoch).toBe(f.epoch);
    expect(r.bodies.map((x) => x.agentId).sort()).toEqual(["agent-aaaa-1111", "agent-bbbb-2222"]);
    const nA = r.bodies.find((x) => x.agentId === "agent-aaaa-1111")!.n;
    s.detach("agent-aaaa-1111");
    s.attach("agent-cccc-3333");
    const nC = s.roster().bodies.find((x) => x.agentId === "agent-cccc-3333")!.n;
    expect(nC).not.toBe(nA);
    expect(s.roster().rev).toBeGreaterThan(r.rev); // viewers re-fetch names when this changes
    s.detach("agent-bbbb-2222");
    s.detach("agent-cccc-3333");
  });

  it("a walking body's streamed position changes tick to tick; a standing one's tuple does not", async () => {
    const s = new WorldService({ sim });
    s.attach("agent-walk-0001");
    s.attach("agent-idle-0002");
    s.act("agent-walk-0001", "go", { type: "go_to", place: "stall-0" });
    const at = (id: string) => s.frames().b.find((t) => t[0] === s.roster().bodies.find((x) => x.agentId === id)!.n)!;
    const w0 = at("agent-walk-0001"), i0 = at("agent-idle-0002");
    for (let i = 0; i < 20; i++) { s.tick(0.1); await Promise.resolve(); }
    expect(at("agent-walk-0001")).not.toEqual(w0);
    expect(at("agent-walk-0001")[5]).toBeGreaterThan(0); // speed cm/s
    expect(at("agent-idle-0002")).toEqual(i0);
    s.detach("agent-walk-0001");
    s.detach("agent-idle-0002");
  });
});
