import { describe, expect, it } from "vitest";
import type { FramesMessage, PoseTuple } from "@aiverse/world-sim/streamProtocol";
import { RENDER_DELAY_S, RemoteBodies, SAY_LOG_MAX, writeRemoteFrame } from "./remoteFrames";
import { newWalkerFrame } from "./walkerBody";

const tup = (n: number, xm: number, zm = 0, h = 0, s = 0, p = 0): PoseTuple => [n, Math.round(xm * 100), 0, Math.round(zm * 100), Math.round(h * 1000), Math.round(s * 100), p];
const msg = (t: number, b: PoseTuple[], o: Partial<FramesMessage> = {}): FramesMessage => ({ epoch: "e", t, key: false, b, gone: [], ...o });
const roster = { epoch: "e", bodies: [{ n: 1, name: "Wanderer", body: "remy" }] };

describe("RemoteBodies", () => {
  it("interpolates position between the two samples that bracket the render time", () => {
    const r = new RemoteBodies();
    r.applyRoster(roster);
    r.applyFrames(msg(10, [tup(1, 0)], { key: true }), 100);
    r.applyFrames(msg(10.2, [tup(1, 2)]), 100.2);
    expect(r.sample(1, 10.1)!.x).toBeCloseTo(1, 5);
    expect(r.sample(1, 9)!.x).toBe(0); // before the first sample: held, not extrapolated
    expect(r.sample(1, 99)!.x).toBe(2); // after the last: held
  });

  it("renders in the past: render time is server time minus the delay, on the local clock", () => {
    const r = new RemoteBodies();
    expect(r.renderTime(5)).toBeNull();
    r.applyFrames(msg(50, [tup(1, 0)], { key: true }), 5);
    expect(r.renderTime(5)).toBeCloseTo(50 - RENDER_DELAY_S, 5);
    expect(r.renderTime(6)).toBeCloseTo(51 - RENDER_DELAY_S, 5);
  });

  it("turns off the gait when positions stop changing, including while holding the last frame", () => {
    const r = new RemoteBodies();
    r.applyFrames(msg(10, [tup(1, 0, 0, 0, 3)]), 10);
    r.applyFrames(msg(10.2, [tup(1, 0.6, 0, 0, 3)]), 10.2);
    r.applyFrames(msg(10.4, [tup(1, 0.6, 0, 1, 3)]), 10.4);
    const frame = newWalkerFrame();
    expect(writeRemoteFrame(frame, r.sample(1, 10.1)!).state).toBe("walk");
    for (const t of [9.9, 10.2, 10.3, 10.5]) {
      expect(writeRemoteFrame(frame, r.sample(1, t)!).state).toBe("idle");
      expect(frame.speed).toBe(0);
      expect(frame.velocity).toEqual([0, 0]);
    }
  });

  it("turns the short way round when the heading wraps", () => {
    const r = new RemoteBodies();
    r.applyFrames(msg(0, [tup(1, 0, 0, 6.0)], { key: true }), 0);
    r.applyFrames(msg(1, [tup(1, 0, 0, 0.3)]), 1);
    const h = r.sample(1, 0.5)!.heading;
    expect(Math.cos(h)).toBeGreaterThan(0.99); // near 0 / 2pi, not swinging through pi
  });

  it("only lists bodies that have BOTH a position and a roster entry", () => {
    const r = new RemoteBodies();
    r.applyFrames(msg(0, [tup(1, 0), tup(2, 3)], { key: true }), 0);
    expect(r.list()).toEqual([]); // no names yet: nothing to draw
    r.applyRoster(roster);
    expect(r.list()).toEqual([{ n: 1, name: "Wanderer", body: "remy" }]);
  });

  it("drops a body reported gone, and every body missing from a key frame", () => {
    const r = new RemoteBodies();
    r.applyRoster({ epoch: "e", bodies: [{ n: 1, name: "A", body: "remy" }, { n: 2, name: "B", body: "remy" }] });
    r.applyFrames(msg(0, [tup(1, 0), tup(2, 3)], { key: true }), 0);
    r.applyFrames(msg(0.1, [], { gone: [2] }), 0.1);
    expect(r.list().map((b) => b.n)).toEqual([1]);
    r.applyFrames(msg(2, [], { key: true }), 2); // an empty key frame (the sim vanished) clears the world
    expect(r.list()).toEqual([]);
  });

  it("a new epoch (the sim restarted, its clock starts over) discards old samples and re-syncs the clock", () => {
    const r = new RemoteBodies();
    r.applyRoster(roster);
    r.applyFrames(msg(500, [tup(1, 9)], { key: true }), 10);
    r.applyFrames({ ...msg(3, [tup(1, 1)], { key: true }), epoch: "e2" }, 11);
    expect(r.sample(1, 3)!.x).toBe(1);
    expect(r.renderTime(11)).toBeCloseTo(3 - RENDER_DELAY_S, 5);
  });

  it("bumps `rev` only when the set of bodies changes, not on every pose", () => {
    const r = new RemoteBodies();
    r.applyFrames(msg(0, [tup(1, 0)], { key: true }), 0);
    const rev = r.rev;
    r.applyFrames(msg(0.1, [tup(1, 1)]), 0.1);
    r.applyFrames(msg(0.2, [tup(1, 2)]), 0.2);
    expect(r.rev).toBe(rev);
    r.applyFrames(msg(0.3, [tup(2, 2)]), 0.3);
    expect(r.rev).toBe(rev + 1);
  });
});

describe("writeRemoteFrame", () => {
  it("writes the frame CastFigure reads: position, heading, speed, a walk/idle state, a gait", () => {
    const f = newWalkerFrame();
    writeRemoteFrame(f, { n: 1, x: 3, y: 0, z: -4, heading: Math.PI / 2, speed: 1.2, posture: "standing", clip: null });
    expect(f.position).toEqual([3, -4]);
    expect(f.state).toBe("walk");
    expect(f.velocity[0]).toBeCloseTo(1.2, 5);
    expect(f.gait).toEqual({ reverse: false });
    writeRemoteFrame(f, { n: 1, x: 3, y: 0, z: -4, heading: 0, speed: 0, posture: "seated", clip: null });
    expect(f.state).toBe("idle");
  });

  it("finds the nearest body from a number up, so a hidden driver's camera picks its car and not a resident car or a walker", () => {
    const r = new RemoteBodies();
    r.applyRoster({ epoch: "e", bodies: [] });
    r.applyFrames(msg(10, [tup(1, 0), tup(1_000_000, 4), tup(2_000_000, 20), tup(2_000_001, 60)], { key: true }), 100);
    expect(r.nearestFrom(2_000_000, 1, 0, 10)).toBe(2_000_000);
    expect(r.nearestFrom(2_000_000, 55, 0, 10)).toBe(2_000_001);
    expect(r.nearestFrom(3_000_000, 0, 0, 10)).toBeNull();
  });

  it("drops a body the server stops sending (a driver's figure leaves with `gone`), so nothing draws it", () => {
    const r = new RemoteBodies();
    r.applyRoster(roster);
    r.applyFrames(msg(10, [tup(1, 0)], { key: true }), 100);
    expect(r.list().map((b) => b.n)).toEqual([1]);
    r.applyFrames(msg(10.2, [], { gone: [1] }), 100.2);
    expect(r.list()).toEqual([]);
    expect(r.sample(1, 10.2)).toBeNull();
  });
});

describe("say log", () => {
  it("keeps lines after the bubble expires, names the speaker, and caps the length", () => {
    const r = new RemoteBodies();
    r.applyRoster(roster);
    r.applySay({ say: [{ n: 1, text: "hello" }, { n: 9, text: "who" }] } as never, 0);
    expect(r.bubble(1, 60_000)).toBeNull();
    expect(r.says.map((l) => [l.name, l.text])).toEqual([["Wanderer", "hello"], ["Someone", "who"]]);
    const before = r.says;
    for (let i = 0; i < SAY_LOG_MAX; i++) r.applySay({ say: [{ n: 1, text: `line ${i}` }] } as never, 0);
    expect(r.says).not.toBe(before);
    expect(r.says).toHaveLength(SAY_LOG_MAX);
    expect(r.says[0].text).toBe("line 0");
    r.clear();
    expect(r.says).toHaveLength(SAY_LOG_MAX);
  });
});
