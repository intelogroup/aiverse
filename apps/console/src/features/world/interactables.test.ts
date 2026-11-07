// @vitest-environment node
import { describe, expect, it } from "vitest";
import { boxesMesh, createCapsuleWorld, meshFromArrays } from "./capsuleWorld";
import { angleTo, makeWalker, step, type World } from "./walker";
import { clipDef } from "./clips";
import {
  INTERACT_ALIGN_TIMEOUT_S,
  INTERACT_CLIP,
  INTERACT_CONTACT_S,
  INTERACT_PROMPT_RANGE,
  InteractController,
  interactPose,
  type InteractChannel,
  type InteractableDef,
} from "./interactables";

const DT = 1 / 60;
/** The Tea House radio exactly as tools/city3 lists it in out/interiors/index.json. */
const RADIO: InteractableDef = {
  id: "tea-radio",
  room: "tea",
  kind: "radio",
  asset: "vintage_radio_transceiver",
  label: "Radio",
  pos: [-17.9, 1.26, -78.5],
  rotY: 1.5708,
  stand: [-16.9, -78.5],
  heading: -1.5708,
  floorY: 0.48,
};
const ZERO = { forward: 0, strafe: 0, turn: 0, run: false };
const FLOOR = RADIO.floorY;

function groundWorld(extra: ReturnType<typeof boxesMesh>[] = []): World {
  const x0 = -30, x1 = -8, z0 = -90, z1 = -66, y = FLOOR;
  const ground = meshFromArrays(new Float32Array([x0, y, z0, x0, y, z1, x1, y, z1, x1, y, z0]), new Uint32Array([0, 1, 2, 0, 2, 3]), "test-ground");
  const meshes = [ground, ...extra.filter((m): m is NonNullable<typeof m> => m !== null)];
  return createCapsuleWorld(() => meshes);
}

/** A clip channel that honours the catalog duration and can be hijacked (another clip fired over it). */
function fakeChannel(now: () => number) {
  let cur: { name: string; at: number } | null = null;
  const ch = {
    fired: [] as string[],
    fire(name: string): boolean {
      ch.fired.push(name);
      cur = { name, at: now() };
      return true;
    },
    get current(): string | null {
      if (!cur) return null;
      const d = clipDef(cur.name)?.duration ?? 0;
      return now() - cur.at < d ? cur.name : null;
    },
    hijack() {
      cur = { name: "Waving", at: now() };
    },
  };
  return ch satisfies InteractChannel & { fired: string[]; hijack(): void };
}

function rig(start: { x: number; z: number; heading?: number }, world: World = groundWorld(), actor = "player") {
  const ctl = new InteractController();
  ctl.register([RADIO]);
  let t = 0;
  const channel = fakeChannel(() => t);
  const s = makeWalker(start.x, FLOOR, start.z, start.heading ?? 0);
  const flips: boolean[] = [];
  ctl.subscribe((_id, on) => flips.push(on));
  return {
    ctl,
    channel,
    s,
    flips,
    actor,
    frame() {
      t += DT;
      const input = ctl.drive(s, DT, actor);
      ctl.tick(DT);
      step(s, input ?? ZERO, DT, world);
      return input;
    },
    /** Frames until the actor's session is gone (or the cap). */
    run(maxFrames = 60 * 20) {
      let n = 0;
      while (ctl.sessionOf(actor) && n < maxFrames) {
        this.frame();
        n++;
      }
      return n;
    },
    now: () => t,
  };
}

describe("interactPose", () => {
  it("is the stand point + heading from the index", () => {
    expect(interactPose(RADIO)).toEqual({ x: -16.9, z: -78.5, heading: -1.5708 });
  });
});

describe("InteractController requests", () => {
  it("refuses an unknown prop, a far actor, and a second request while busy / already using", () => {
    const r = rig({ x: -16.9, z: -77.0 });
    r.frame(); // seen
    expect(r.ctl.request("nope", "player", r.channel)).toBe("unknown");
    const far = rig({ x: -26, z: -70 });
    far.frame();
    expect(far.ctl.request("tea-radio", "player", far.channel)).toBe("too-far");
    expect(r.ctl.request("tea-radio", "player", r.channel)).toBe("started");
    expect(r.ctl.request("tea-radio", "player", r.channel)).toBe("already-using");
    expect(r.ctl.request("tea-radio", "scout", fakeChannel(() => 0), { x: -16.9, z: -77.5 })).toBe("busy");
    expect(r.ctl.sessionOwner("tea-radio")).toBe("player");
  });

  it("nearest() only finds a prop within the prompt range of its stand point", () => {
    const ctl = new InteractController();
    ctl.register([RADIO]);
    expect(ctl.nearest(-16.9, -78.5 + INTERACT_PROMPT_RANGE - 0.1)?.id).toBe("tea-radio");
    expect(ctl.nearest(-16.9, -78.5 + INTERACT_PROMPT_RANGE + 0.2)).toBeNull();
    expect(ctl.requestNearest("player", fakeChannel(() => 0), { x: -10, z: -70 })).toBe("too-far");
  });
});

describe("InteractController session", () => {
  it("walks to the stand pose, fires Interact once, flips ON exactly at contact, ends facing the radio", () => {
    const r = rig({ x: -16.2, z: -77.4, heading: 2.0 });
    r.frame();
    expect(r.ctl.request("tea-radio", "player", r.channel)).toBe("started");
    let flippedAtClipT: number | null = null;
    let performStart = -1;
    while (r.ctl.sessionOf("player")) {
      r.frame();
      const sess = r.ctl.sessionOf("player");
      if (sess?.phase === "perform" && performStart < 0) performStart = r.now();
      if (r.flips.length && flippedAtClipT === null && performStart >= 0) flippedAtClipT = r.now() - performStart;
      if (r.now() > 25) throw new Error("session did not finish");
    }
    expect(r.channel.fired).toEqual([INTERACT_CLIP]);
    expect(r.flips).toEqual([true]);
    expect(r.ctl.isOn("tea-radio")).toBe(true);
    expect(flippedAtClipT).not.toBeNull();
    expect(flippedAtClipT!).toBeGreaterThanOrEqual(INTERACT_CONTACT_S - 0.05);
    expect(flippedAtClipT!).toBeLessThan(INTERACT_CONTACT_S + 0.1);
    const pose = interactPose(RADIO);
    expect(Math.hypot(r.s.x - pose.x, r.s.z - pose.z)).toBeLessThan(0.05);
    expect(Math.abs(angleTo(r.s.body, pose.heading))).toBeLessThan(0.1);
  });

  it("a second session turns it back OFF", () => {
    const r = rig({ x: -16.9, z: -78.0, heading: -1.5708 });
    r.frame();
    expect(r.ctl.request("tea-radio", "player", r.channel)).toBe("started");
    r.run();
    expect(r.ctl.isOn("tea-radio")).toBe(true);
    expect(r.ctl.request("tea-radio", "player", r.channel)).toBe("started");
    r.run();
    expect(r.ctl.isOn("tea-radio")).toBe(false);
    expect(r.flips).toEqual([true, false]);
  });

  it("the prompt says what E will do", () => {
    const r = rig({ x: -16.9, z: -78.0, heading: -1.5708 });
    r.frame();
    expect(r.ctl.status("player")).toBe("E · turn radio on");
    r.ctl.request("tea-radio", "player", r.channel);
    r.run();
    expect(r.ctl.status("player")).toBe("E · turn radio off");
  });

  it("an actor that vanishes mid-session is dropped and nothing flips", () => {
    const r = rig({ x: -16.9, z: -78.0, heading: -1.5708 });
    r.frame();
    r.ctl.request("tea-radio", "player", r.channel);
    for (let i = 0; i < 30; i++) r.frame();
    expect(r.ctl.sessionOf("player")).not.toBeNull();
    for (let i = 0; i < 90; i++) r.ctl.tick(DT); // 1.5 s without drive()
    expect(r.ctl.sessionOf("player")).toBeNull();
    expect(r.ctl.sessionOwner("tea-radio")).toBeNull();
    expect(r.ctl.isOn("tea-radio")).toBe(false);
  });

  it("a clip cut short before contact leaves the state alone", () => {
    const r = rig({ x: -16.9, z: -78.0, heading: -1.5708 });
    r.frame();
    r.ctl.request("tea-radio", "player", r.channel);
    while (r.ctl.sessionOf("player")?.phase !== "perform") r.frame();
    for (let i = 0; i < 20; i++) r.frame(); // ~0.33 s in
    r.channel.hijack();
    r.run();
    expect(r.ctl.isOn("tea-radio")).toBe(false);
    expect(r.flips).toEqual([]);
  });

  it("gives up aligning when the pose is unreachable (never hunts for ever)", () => {
    // A wall between the bot and the stand point.
    const wall = boxesMesh([[-16.2, -78.5, 0.1, 2.5, FLOOR, FLOOR + 2.5, 0]], [0, 0], "wall");
    const r = rig({ x: -15.4, z: -78.5, heading: 3.14 }, groundWorld([wall]));
    r.frame();
    expect(r.ctl.request("tea-radio", "player", r.channel, { x: -16.0, z: -78.5 })).toBe("started");
    const n = r.run(60 * (INTERACT_ALIGN_TIMEOUT_S + 3));
    expect(n / 60).toBeGreaterThanOrEqual(INTERACT_ALIGN_TIMEOUT_S - 0.1);
    expect(n / 60).toBeLessThan(INTERACT_ALIGN_TIMEOUT_S + 1);
    expect(r.ctl.isOn("tea-radio")).toBe(false);
    expect(r.channel.fired).toEqual([]);
  });

  it("state survives re-registering the same definitions (the room index reloads)", () => {
    const r = rig({ x: -16.9, z: -78.0, heading: -1.5708 });
    r.frame();
    r.ctl.request("tea-radio", "player", r.channel);
    r.run();
    r.ctl.register([RADIO]);
    expect(r.ctl.isOn("tea-radio")).toBe(true);
  });
});
