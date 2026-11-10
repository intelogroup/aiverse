import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { createSimServer } from "@aiverse/sim/server";
import { createApp } from "../app";
import { websocket } from "../ws/gateway";
import { createWorldStream, getWorldStream, type StreamSocket } from "./frames";
import { httpSimClient, type SimClient } from "./simClient";
import { redis } from "../redis/client";

const parse = (s: string) => JSON.parse(s) as { type: string; payload: any };
const wait = async (cond: () => boolean, ms = 3000) => { const end = Date.now() + ms; while (!cond() && Date.now() < end) await Bun.sleep(5); if (!cond()) throw new Error("timed out"); };

function fakeSocket(buffered = 0) {
  const got: string[] = [];
  const sock: StreamSocket & { got: string[]; buffered: number; messages(type: string): any[] } = {
    got, buffered,
    send: (d) => { got.push(d); },
    getBufferedAmount: () => sock.buffered,
    messages: (type) => got.map(parse).filter((m) => m.type === type).map((m) => m.payload),
  };
  return sock;
}

/** A scripted sim: `/frames` and `/roster` answer from mutable state, or fail on demand. */
function fakeSim() {
  const st = { epoch: "e1", t: 0, rev: 1, b: [[1, 100, 0, 200, 0, 0, 0]] as any[], bodies: [{ n: 1, agentId: "11111111-aaaa-bbbb-cccc-000000000001", body: "remy" }], fail: false, calls: 0 };
  const client: SimClient = {
    call: async (_m, path) => {
      st.calls++;
      if (st.fail) return new Response("{}", { status: 503 });
      if (path === "/frames") return Response.json({ epoch: st.epoch, t: st.t, rosterRev: st.rev, b: st.b });
      if (path === "/roster") return Response.json({ epoch: st.epoch, rev: st.rev, bodies: st.bodies });
      return new Response("{}", { status: 404 });
    },
  };
  return { st, client };
}

const names = async (ids: string[]) => new Map(ids.map((id) => [id, id.endsWith("1") ? "Wanderer" : "Other"]));
let stream: ReturnType<typeof createWorldStream> | undefined;
afterEach(() => { stream?.stop(); stream = undefined; });

describe("world stream (gateway half)", () => {
  test("is lazy: no subscriber, no sim calls; the loop stops when the last one leaves", async () => {
    const sim = fakeSim();
    stream = createWorldStream({ sim: sim.client, names, intervalMs: 5 });
    await Bun.sleep(40);
    expect(sim.st.calls).toBe(0);
    const s = fakeSocket();
    stream.subscribe("a", s);
    await wait(() => sim.st.calls > 2);
    stream.unsubscribe("a");
    await Bun.sleep(30);
    const after = sim.st.calls;
    await Bun.sleep(60);
    expect(sim.st.calls).toBe(after);
    expect(stream.running).toBe(false);
  });

  test("two spectators both get the roster (display name + body, never the agent id) and the first key frame", async () => {
    const sim = fakeSim();
    stream = createWorldStream({ sim: sim.client, names, intervalMs: 5 });
    const a = fakeSocket(), b = fakeSocket();
    stream.subscribe("a", a);
    stream.subscribe("b", b);
    await wait(() => a.messages("world_frames").length > 0 && b.messages("world_frames").length > 0);
    for (const s of [a, b]) {
      expect(s.messages("world_roster")[0].bodies).toEqual([{ n: 1, name: "Wanderer", body: "remy" }]);
      expect(s.messages("world_frames")[0]).toMatchObject({ epoch: "e1", key: true, b: [[1, 100, 0, 200, 0, 0, 0]] });
      expect(s.got.join("")).not.toContain("11111111-aaaa");
    }
  });

  test("a body that does not move is not resent between key frames; one that moves is", async () => {
    const sim = fakeSim();
    stream = createWorldStream({ sim: sim.client, names, intervalMs: 5, keyEveryMs: 60_000 });
    const s = fakeSocket();
    stream.subscribe("a", s);
    await wait(() => s.messages("world_frames").length > 0);
    const n0 = s.messages("world_frames").length;
    await Bun.sleep(60);
    expect(s.messages("world_frames").length).toBe(n0); // nothing changed: nothing sent
    sim.st.t = 1; sim.st.b = [[1, 150, 0, 200, 0, 140, 0]];
    await wait(() => s.messages("world_frames").length > n0);
    const delta = s.messages("world_frames").at(-1);
    expect(delta.key).toBe(false);
    expect(delta.b).toEqual([[1, 150, 0, 200, 0, 140, 0]]);
  });

  test("a late subscriber is given the roster and the whole picture at once; a vanished body is reported in `gone`", async () => {
    const sim = fakeSim();
    stream = createWorldStream({ sim: sim.client, names, intervalMs: 5, keyEveryMs: 60_000 });
    const first = fakeSocket();
    stream.subscribe("first", first);
    await wait(() => first.messages("world_frames").length > 0);
    const late = fakeSocket();
    stream.subscribe("late", late);
    expect(late.messages("world_roster")).toHaveLength(1); // synchronously, before any further tick
    expect(late.messages("world_frames")[0].key).toBe(true);
    sim.st.b = []; sim.st.rev = 2; sim.st.bodies = [];
    await wait(() => first.messages("world_frames").some((m) => m.gone?.includes(1)));
  });

  test("a slow socket misses frames instead of queueing them; the others are unaffected", async () => {
    const sim = fakeSim();
    stream = createWorldStream({ sim: sim.client, names, intervalMs: 5, keyEveryMs: 60_000, maxBufferedBytes: 1000 });
    const slow = fakeSocket(10_000), fast = fakeSocket();
    stream.subscribe("slow", slow);
    stream.subscribe("fast", fast);
    await wait(() => fast.messages("world_frames").length > 0);
    expect(slow.got).toHaveLength(0);
    expect(stream.stats().dropped).toBeGreaterThan(0);
  });

  test("a socket that throws is dropped without stopping the others", async () => {
    const sim = fakeSim();
    stream = createWorldStream({ sim: sim.client, names, intervalMs: 5 });
    const bad: StreamSocket = { send: () => { throw new Error("closed"); } };
    const good = fakeSocket();
    stream.subscribe("bad", bad);
    stream.subscribe("good", good);
    await wait(() => good.messages("world_frames").length > 0);
    expect(stream.subscribers).toBe(1);
  });

  test("when the sim goes away, viewers are told the world is empty (no frozen figures); when it returns, a fresh key frame arrives", async () => {
    const sim = fakeSim();
    stream = createWorldStream({ sim: sim.client, names, intervalMs: 2, keyEveryMs: 60_000 });
    const s = fakeSocket();
    stream.subscribe("a", s);
    await wait(() => s.messages("world_frames").length > 0);
    sim.st.fail = true;
    await wait(() => s.messages("world_frames").some((m) => m.key && m.b.length === 0), 5000);
    sim.st.fail = false;
    const before = s.messages("world_frames").length;
    await wait(() => s.messages("world_frames").length > before, 8000);
    const back = s.messages("world_frames").at(-1);
    expect(back.key).toBe(true);
    expect(back.b).toHaveLength(1);
  });

  test("subscriber cap", () => {
    const sim = fakeSim();
    stream = createWorldStream({ sim: sim.client, names, intervalMs: 1000, maxSubscribers: 2 });
    expect(stream.subscribe("a", fakeSocket())).toBe(true);
    expect(stream.subscribe("b", fakeSocket())).toBe(true);
    expect(stream.subscribe("c", fakeSocket())).toBe(false);
    expect(stream.subscribe("a", fakeSocket())).toBe(true); // re-subscribing an existing one is fine
  });
});

// The gate: a body walking in the real sim, seen by two real WebSocket clients through the real gateway app.
describe("world stream over /public/ws (real gateway + real sim)", () => {
  const SECRET = "y".repeat(48);
  const ASSETS = new URL("../../../console/public/assets/", import.meta.url).pathname;
  let service: WorldService, simHttp: ReturnType<typeof Bun.serve>, server: ReturnType<typeof Bun.serve>;

  beforeAll(async () => {
    const keys = await redis.keys("register:*");
    if (keys.length) await redis.del(...keys);
    const { sim } = await loadVerseSim(ASSETS);
    service = new WorldService({ sim, maxBodies: 5 });
    simHttp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: createSimServer({ service, secret: SECRET }).fetch });
    const app = createApp({ sim: httpSimClient(`http://127.0.0.1:${simHttp.port}`, SECRET) });
    server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
  }, 120_000);
  afterAll(() => { getWorldStream()?.stop(); server?.stop(true); simHttp?.stop(true); });

  function viewer(subscribe = true) {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/public/ws`);
    const msgs: { type: string; payload: any }[] = [];
    ws.onmessage = (e) => msgs.push(JSON.parse(String(e.data)));
    ws.onopen = () => { if (subscribe) ws.send(JSON.stringify({ type: "subscribe_world" })); };
    return { ws, msgs, frames: () => msgs.filter((m) => m.type === "world_frames").map((m) => m.payload) };
  }

  test("two viewers see the same walking body; an unsubscribed socket and a junk message get nothing", async () => {
    const agentId = crypto.randomUUID(); // no agents row: the name falls back, the id must still never reach a viewer
    service.attach(agentId);
    const a = viewer(), b = viewer(), quiet = viewer(false), junk = viewer(false);
    junk.ws.onopen = () => junk.ws.send("{not json");
    await wait(() => a.frames().length > 0 && b.frames().length > 0);

    service.act(agentId, "go", { type: "go_to", place: "stall-0" });
    for (let i = 0; i < 60; i++) { service.tick(0.1); await Promise.resolve(); }
    await wait(() => {
      const lastA = a.frames().at(-1), lastB = b.frames().at(-1);
      return !!lastA && !!lastB && lastA.t > 5 && lastA.t === lastB.t;
    }, 5000).catch(() => {});
    await Bun.sleep(400);

    const posOf = (v: ReturnType<typeof viewer>) => {
      let p: number[] | undefined;
      for (const f of v.frames()) { if (f.epoch === "") continue; for (const t of f.b) p = t; }
      return p!;
    };
    const roster = a.msgs.find((m) => m.type === "world_roster")!.payload;
    expect(roster.bodies).toHaveLength(1);
    expect(roster.bodies[0]).toMatchObject({ name: "agent", body: "remy" });
    const start = a.frames()[0].b[0];
    const pa = posOf(a), pb = posOf(b);
    expect(Math.hypot(pa[1] - start[1], pa[3] - start[3])).toBeGreaterThan(100); // moved more than a metre (cm units)
    expect(pa).toEqual(pb); // both viewers hold the same position
    expect(JSON.stringify(a.msgs)).not.toContain(agentId);
    expect(quiet.msgs).toHaveLength(0);
    expect(junk.msgs).toHaveLength(0);

    for (const v of [a, b, quiet, junk]) v.ws.close();
    service.detach(agentId);
    await wait(() => getWorldStream()!.subscribers === 0);
  }, 30_000);
});
