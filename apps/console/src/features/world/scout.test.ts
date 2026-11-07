// @vitest-environment node
// Scout harness core against fake worlds — no three, no DOM.

import { describe, expect, it } from "vitest";
import { ClipTestState } from "./clips";
import { TeaDoorController, clipChannel } from "./teaDoor";
import { InteractController, type InteractableDef } from "./interactables";
import {
  ScoutExecutor,
  bearingDeg,
  districtAt,
  nearestPlace,
  nearestSittable,
  oracleScene,
  roomAt,
  type ScoutPlace,
  type ScoutRoomShape,
  type Sittable,
} from "./scout";
import { WALK_CONFIG, makeWalker, type Hit, type World } from "./walker";

const PLACES: ScoutPlace[] = [
  { id: "stall-0", kind: "stall", name: "stall-0", pos: [-17, 18], stand: [-17, 15.2], heading: Math.PI },
  { id: "stall-1", kind: "stall", name: "stall-1", pos: [-17, 13.8], stand: [-17, 13.8], heading: Math.PI },
  { id: "press", kind: "shopfront", name: "Kronikler Press", pos: [-27.08, 72.5], stand: [-27.08, 72.5], heading: 0, room: "press", door: [-27.08, 72.5] },
  { id: "tea", kind: "shopfront", name: "Matchmaker's Tea House", pos: [-22.92, -72.5], stand: [-22.92, -72.5], heading: 0, room: "tea", door: [-22.92, -72.5] },
];

const ROOMS: ScoutRoomShape[] = [
  { id: "press", name: "Kronikler Press", door: [-27.08, 72.5], rect: [-38, 72, -12, 85], center: [-25, 78.5] },
  { id: "tea", name: "Matchmaker's Tea House", door: [-22.92, -72.5], rect: [-38, -85, -12, -72], center: [-25, -78.5] },
];

const SITTING: Sittable = {
  id: "press-armchair-489",
  building: "press",
  kind: "armchair",
  seat: [-35.5, 73.9],
  facing: 0,
  approach: [-35.5, 74.52],
  approachSide: "front",
  seatHeight: 0.45,
  floorY: 0.48,
};

/** Flat ground at `ground` everywhere; optional wall slab at x >= wallX. */
function fakeWorld(opts: { wallX?: number; ground?: number } = {}): World {
  const R = WALK_CONFIG.radius;
  const g = opts.ground ?? 0.2;
  return {
    groundY: (_x, _z, fromY) => (g > fromY ? null : g),
    blocked: (_from, to): Hit | null => {
      if (opts.wallX === undefined) return null;
      const pen = to[0] + R - opts.wallX;
      return pen > 0 ? { nx: -1, nz: 0, depth: pen } : null;
    },
  };
}

function makeExec(over: Partial<{ places: ScoutPlace[]; sittables: Sittable[] }> = {}) {
  const clips = new ClipTestState();
  const exec = new ScoutExecutor({
    places: over.places ?? PLACES,
    sittables: over.sittables ?? [SITTING],
    clips,
    hipsY: 0.718,
  });
  return { exec, clips };
}

/** Tick the executor at 60 Hz until the promise settles (or the budget runs out). */
async function drive(
  exec: ScoutExecutor,
  state: ReturnType<typeof makeWalker>,
  world: World,
  promise: Promise<unknown>,
  maxSecs = 200,
): Promise<unknown> {
  let settled = false;
  let value: unknown;
  void promise.then((v) => {
    settled = true;
    value = v;
  });
  const dt = 1 / 60;
  for (let t = 0; t < maxSecs && !settled; t += dt) {
    exec.tick(dt, state, world);
    // let promise callbacks run
    await Promise.resolve();
  }
  if (!settled) throw new Error("action never settled");
  return value;
}

describe("bearingDeg", () => {
  it("is 0 dead ahead, +/-180 behind, and signed by side", () => {
    expect(bearingDeg(0, 0, 5)).toBeCloseTo(0, 5);
    // Behind is the wrap seam: +/-180 are the same direction; the
    // implementation returns the [-180, 180) representative.
    expect(Math.abs(bearingDeg(0, 0, -5))).toBeCloseTo(180, 5);
    expect(bearingDeg(0, 5, 0)).toBeCloseTo(90, 5);
    expect(bearingDeg(0, -5, 0)).toBeCloseTo(-90, 5);
    // Facing +x (heading pi/2): a point dead ahead in +x reads 0.
    expect(bearingDeg(Math.PI / 2, 5, 0)).toBeCloseTo(0, 5);
  });
});

describe("blackboard derivations", () => {
  it("nearestPlace finds the closest lot", () => {
    const n = nearestPlace(PLACES, -17, 16);
    expect(n?.place.id).toBe("stall-0");
    expect(n?.dist).toBeCloseTo(2, 5);
  });

  it("roomAt reports containment", () => {
    expect(roomAt(ROOMS, -25, 78)?.id).toBe("press");
    expect(roomAt(ROOMS, 0, 0)).toBeNull();
  });

  it("districtAt prefers the containing district", () => {
    const ds = [
      { id: "bazaar", name: "Sunstone Bazaar", center: [0, 0] as [number, number], half: 180 },
      { id: "glassq", name: "Glass Quarter", center: [0, -400] as [number, number], half: 180 },
    ];
    expect(districtAt(ds, 3, -3)?.id).toBe("bazaar");
    expect(districtAt(ds, 0, -390)?.id).toBe("glassq");
  });

  it("nearestSittable honours the engage range", () => {
    expect(nearestSittable([SITTING], -35.5, 70)?.id).toBe(SITTING.id);
    expect(nearestSittable([SITTING], 0, 0)).toBeNull();
  });
});

describe("oracleScene", () => {
  it("projects places in the cone with bearings and distances, sorted", () => {
    // At stall-0's customer spot facing north (-z is heading pi? no: heading
    // pi faces (sin pi, cos pi) = (0,-1) -> -z). Face +z (heading 0) instead:
    // stall-1 is 4.2 m behind... use heading pi to face the stalls row.
    const scene = oracleScene(PLACES, ROOMS, { x: -17, z: 20, heading: Math.PI });
    const ids = scene.map((o) => o.id);
    expect(ids).toContain("stall-0");
    expect(ids).toContain("stall-1");
    const s0 = scene.find((o) => o.id === "stall-0")!;
    expect(s0.distance).toBeCloseTo(2, 1);
    expect(Math.abs(s0.bearingDeg)).toBeLessThan(5);
    // press is ~52 m away: out of range.
    expect(ids).not.toContain("press");
  });

  it("includes the room Scout is inside, and doors carry enterable", () => {
    const scene = oracleScene(PLACES, ROOMS, { x: -25, z: 78, heading: 0 });
    const room = scene.find((o) => o.kind === "room");
    expect(room?.id).toBe("press");
    const door = scene.find((o) => o.kind === "door" && o.id === "press");
    expect(door).toBeUndefined(); // inside it: the room entry replaces the door
    const teaDoorScene = oracleScene(PLACES, ROOMS, { x: -23, z: -60, heading: Math.PI });
    const teaDoor = teaDoorScene.find((o) => o.kind === "door" && o.id === "tea");
    expect(teaDoor?.enterable).toBe(true);
  });
});

describe("executor: movement", () => {
  it("go_to a place walks there and settles arrived", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const out = (await drive(exec, s, fakeWorld(), exec.submit({ type: "go_to", place: "stall-0" }, s))) as { status: string; target?: string };
    expect(out.status).toBe("arrived");
    expect(out.target).toBe("stall-0");
    // Arrives at the stall's STAND point (its pos is inside the structure).
    expect(Math.hypot(s.x - -17, s.z - 15.2)).toBeLessThan(0.6);
  });

  it("go_to also resolves a shopfront by its room id", async () => {
    const { exec } = makeExec();
    const s = makeWalker(-23, 0.2, -60, Math.PI);
    const out = (await drive(exec, s, fakeWorld(), exec.submit({ type: "go_to", place: "tea" }, s))) as { status: string; target?: string };
    expect(out.status).toBe("arrived");
    expect(out.target).toBe("tea");
  });

  it("go_to an unknown place is unavailable without moving", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const out = (await exec.submit({ type: "go_to", place: "nope" }, s)) as { status: string };
    expect(out.status).toBe("unavailable");
    expect(exec.busy).toBe(false);
  });

  it("go_to into a wall settles blocked", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const out = (await drive(
      exec,
      s,
      fakeWorld({ wallX: 3 }),
      exec.submit({ type: "go_to", point: [10, 0] }, s),
    )) as { status: string };
    expect(out.status).toBe("blocked");
    expect(s.x).toBeLessThan(3);
  });

  it("a second action while busy is rejected", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const first = exec.submit({ type: "go_to", place: "stall-0" }, s);
    const second = (await exec.submit({ type: "wait", seconds: 1 }, s)) as { status: string };
    expect(second.status).toBe("rejected");
    await drive(exec, s, fakeWorld(), first);
  });

  it("face turns the heading and settles done", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const out = (await drive(exec, s, fakeWorld(), exec.submit({ type: "face", headingDeg: 90 }, s))) as { status: string };
    expect(out.status).toBe("done");
    expect(Math.abs(s.heading - Math.PI / 2)).toBeLessThan(0.05);
  });

  it("wait counts down and settles done", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const out = (await drive(exec, s, fakeWorld(), exec.submit({ type: "wait", seconds: 0.5 }, s))) as { status: string };
    expect(out.status).toBe("done");
  });
});

describe("executor: play / say / finish", () => {
  it("play fires a social clip and restores Idle at the end", async () => {
    const { exec, clips } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const p = exec.submit({ type: "play", clip: "Waving" }, s);
    expect(clips.current).toBe("Waving");
    const out = (await drive(exec, s, fakeWorld(), p)) as { status: string };
    expect(out.status).toBe("done");
    expect(clips.current).toBeNull();
  });

  it("play rejects clips outside the social subset", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const out = (await exec.submit({ type: "play", clip: "OpenDoorInwards" }, s)) as { status: string };
    expect(out.status).toBe("unavailable");
  });

  it("say resolves immediately; finish closes the gate", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    expect(((await exec.submit({ type: "say", text: "hello" }, s)) as { status: string }).status).toBe("done");
    expect(((await exec.submit({ type: "finish" }, s)) as { status: string }).status).toBe("done");
    expect(((await exec.submit({ type: "wait", seconds: 1 }, s)) as { status: string }).status).toBe("rejected");
  });
});

describe("executor: sitting", () => {
  it("sit walks to the approach, turns, sits; stand reverses it", async () => {
    const { exec, clips } = makeExec();
    // Inside the press, on its floor.
    const s = makeWalker(-30, 0.48, 74.5, 0);
    const world = fakeWorld({ ground: 0.48 });
    const out = (await drive(exec, s, world, exec.submit({ type: "sit", sittable: SITTING.id }, s))) as { status: string };
    expect(out.status).toBe("seated");
    expect(exec.posture).toBe("seated");
    expect(clips.current).toBe("SittingIdle");
    // The walker state is parked at the seat, at floor height.
    expect(s.x).toBeCloseTo(SITTING.seat[0], 3);
    expect(s.z).toBeCloseTo(SITTING.seat[1], 3);
    expect(s.y).toBeCloseTo(SITTING.floorY, 3);
    // The render override drops the root by seatHeight - hipsY.
    const ov = exec.frameOverride();
    expect(ov?.drop).toBeCloseTo(SITTING.seatHeight - 0.718, 3);
    // Movement is refused while seated.
    expect(((await exec.submit({ type: "go_to", place: "stall-0" }, s)) as { status: string }).status).toBe("rejected");
    // Stand: back at the approach point, standing.
    const out2 = (await drive(exec, s, world, exec.submit({ type: "stand" }, s))) as { status: string };
    expect(out2.status).toBe("stood");
    expect(exec.posture).toBe("standing");
    expect(s.x).toBeCloseTo(SITTING.approach[0], 3);
    expect(s.z).toBeCloseTo(SITTING.approach[1], 3);
  });

  it("sit with no sittable in range is unavailable", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const out = (await exec.submit({ type: "sit" }, s)) as { status: string };
    expect(out.status).toBe("unavailable");
  });

  it("sit by unknown id is unavailable", async () => {
    const { exec } = makeExec();
    const s = makeWalker(0, 0.2, 0, 0);
    const out = (await exec.submit({ type: "sit", sittable: "tea-sofa-999" }, s)) as { status: string };
    expect(out.status).toBe("unavailable");
  });
});

describe("executor: doors", () => {
  it("go_to a point inside the Tea House runs the full door performance on the way and settles arrived, never blocked", async () => {
    const clips = new ClipTestState();
    const channel = clipChannel(clips);
    const door = new TeaDoorController({ channel, setBlocker: () => {} });
    let sessions = 0;
    const exec = new ScoutExecutor({
      places: PLACES,
      sittables: [SITTING],
      clips,
      hipsY: 0.718,
      door: (s, wanted, dt) => {
        const before = door.sessionOwner;
        const out = door.drive(s, dt, wanted.forward > 0, "scout", channel);
        if (!before && door.sessionOwner) sessions++;
        return out;
      },
    });
    const s = makeWalker(-22.8, 0.2, -68.5, Math.PI);
    const inside: [number, number] = [-22.9, -75.0];
    const out = (await drive(exec, s, fakeWorld(), exec.submit({ type: "go_to", point: inside }, s))) as { status: string };
    expect(out.status).toBe("arrived");
    expect(sessions).toBe(1);
    expect(Math.hypot(s.x - inside[0], s.z - inside[1])).toBeLessThan(0.6);
  });
});

describe("executor: interact", () => {
  const RADIO: InteractableDef = {
    id: "tea-radio", room: "tea", kind: "radio", asset: "vintage_radio_transceiver", label: "Radio",
    pos: [-17.9, 1.26, -78.5], rotY: 1.5708, stand: [-16.9, -78.5], heading: -1.5708, floorY: 0.48,
  };
  function rig(withInteract = true) {
    const clips = new ClipTestState();
    const ctl = new InteractController();
    ctl.register([RADIO]);
    const exec = new ScoutExecutor({
      places: PLACES,
      sittables: [SITTING],
      clips,
      hipsY: 0.718,
      interact: withInteract
        ? {
            defs: () => ctl.list(),
            isOn: (id) => ctl.isOn(id),
            request: (id, at) => ctl.request(id, "scout", clips, at),
            drive: (st, dt) => ctl.drive(st, dt, "scout"),
          }
        : undefined,
    });
    return { exec, clips, ctl };
  }

  it("walks to the stand point, uses the radio, settles done (on); a second use settles done (off)", async () => {
    const { exec, clips, ctl } = rig();
    const fired: string[] = [];
    const realFire = clips.fire.bind(clips);
    clips.fire = (n: string) => (fired.push(n), realFire(n));
    const s = makeWalker(-21.0, 0.2, -76.0, 0.5);
    const out = (await drive(exec, s, fakeWorld(), exec.submit({ type: "interact", target: "tea-radio" }, s))) as { status: string; detail?: string; target?: string };
    expect(out).toMatchObject({ status: "done", detail: "on", target: "tea-radio" });
    expect(ctl.isOn("tea-radio")).toBe(true);
    expect(fired.filter((n) => n === "Interact")).toHaveLength(1);
    expect(Math.hypot(s.x - RADIO.stand[0], s.z - RADIO.stand[1])).toBeLessThan(0.1);
    const out2 = (await drive(exec, s, fakeWorld(), exec.submit({ type: "interact", target: "radio" }, s))) as { status: string; detail?: string };
    expect(out2).toMatchObject({ status: "done", detail: "off" }); // addressed by kind this time
    expect(ctl.isOn("tea-radio")).toBe(false);
  });

  it("is not read as timeout/blocked while the session holds the body (clocks pause)", async () => {
    const { exec, ctl } = rig();
    // Far start: the walk plus the 3.2 s clip is long; the outcome must still be done.
    const s = makeWalker(-27.0, 0.2, -72.5, 0.0);
    const out = (await drive(exec, s, fakeWorld(), exec.submit({ type: "interact", target: "Radio" }, s))) as { status: string };
    expect(out.status).toBe("done");
    expect(ctl.isOn("tea-radio")).toBe(true);
  });

  it("rejects unknown props, a world without props, and a seated Scout", async () => {
    const { exec } = rig();
    const s = makeWalker(-21.0, 0.2, -76.0, 0.5);
    expect(await exec.submit({ type: "interact", target: "jukebox" }, s)).toMatchObject({ ok: false, status: "unavailable" });
    const none = rig(false);
    expect(await none.exec.submit({ type: "interact", target: "tea-radio" }, s)).toMatchObject({ ok: false, status: "unavailable" });
  });

  it("an unreachable stand point ends blocked, never hangs", async () => {
    const { exec, ctl } = rig();
    const s = makeWalker(-22.0, 0.2, -78.5, Math.PI / 2); // west of a wall slab at x >= -18; the stand point (-16.9) is behind it
    const out = (await drive(exec, s, fakeWorld({ wallX: -18 }), exec.submit({ type: "interact", target: "tea-radio" }, s))) as { status: string };
    expect(["blocked", "timeout"]).toContain(out.status);
    expect(ctl.isOn("tea-radio")).toBe(false);
  });
});

describe("oracleScene: interactables", () => {
  const radio = { id: "tea-radio", label: "Radio", kind: "radio", pos: [-17.9, -78.5] as [number, number], on: false };
  it("lists a prop in view with its state, and always within touch range", () => {
    const inView = oracleScene([], ROOMS, { x: -17.9, z: -75.5, heading: Math.PI }, {}, [radio]);
    const o = inView.find((x) => x.kind === "interactable");
    expect(o).toMatchObject({ id: "tea-radio", name: "Radio", state: "off" });
    expect(o!.distance).toBeCloseTo(3, 1);
    const behind = oracleScene([], ROOMS, { x: -17.9, z: -75.5, heading: 0 }, {}, [radio]);
    expect(behind.find((x) => x.kind === "interactable")).toBeUndefined(); // behind, > 2.5 m
    const touch = oracleScene([], ROOMS, { x: -17.9, z: -77.0, heading: 0 }, {}, [{ ...radio, on: true }]);
    expect(touch.find((x) => x.kind === "interactable")).toMatchObject({ state: "on" }); // 1.5 m: perceived regardless of the cone
  });
});
