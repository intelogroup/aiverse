import { beforeAll, describe, expect, test } from "bun:test";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { createSimServer, SIM_API_VERSION } from "./server";

const SECRET = "s".repeat(40);
const ASSETS = new URL("../../console/public/assets/", import.meta.url).pathname;
let service: WorldService;
let clock = 1_000_000;
let app: ReturnType<typeof createSimServer>;

beforeAll(async () => {
  const { sim } = await loadVerseSim(ASSETS);
  service = new WorldService({ sim, maxBodies: 3 });
  app = createSimServer({ service, secret: SECRET, now: () => clock, actPerS: 2, readPerS: 5 });
}, 120_000);

const AID = "11111111-1111-4111-8111-111111111111";
const call = (method: string, path: string, body?: unknown, h: Record<string, string> = {}) =>
  app.fetch(new Request(`http://sim${path}`, {
    method,
    headers: { authorization: `Bearer ${SECRET}`, "x-sim-api": String(SIM_API_VERSION), "content-type": "application/json", ...h },
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
const tickUntil = async (pred: () => boolean, maxS: number) => { for (let t = 0; t < maxS && !pred(); t += 0.1) { service.tick(0.1); await Promise.resolve(); } };

describe("sim internal API", () => {
  test("refuses a wrong secret, a missing secret and a version mismatch", async () => {
    expect((await call("GET", "/healthz", undefined, { authorization: "Bearer nope" })).status).toBe(401);
    expect((await call("GET", "/healthz", undefined, { authorization: "" })).status).toBe(401);
    expect((await call("GET", "/healthz", undefined, { "x-sim-api": "999" })).status).toBe(426);
    const ok = await call("GET", "/healthz");
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).ready).toBe(true);
  });

  test("attach -> act (202) -> poll to settled -> observe -> detach", async () => {
    const r = await call("POST", "/bodies", { agentId: AID, expiresAtMs: clock + 60_000 });
    expect(r.status).toBe(201);
    expect((await call("POST", "/bodies", { agentId: AID, expiresAtMs: clock + 60_000 })).status).toBe(200); // idempotent
    const a = await call("POST", `/bodies/${AID}/act`, { id: "go-1", action: { type: "go_to", place: "stall-0" } });
    expect(a.status).toBe(202);
    expect(((await a.json()) as any).act.state).toBe("running");
    await tickUntil(() => service.actRecord(AID, "go-1")?.state === "settled", 90);
    clock += 1000;
    const p = (await (await call("GET", `/bodies/${AID}/act/go-1`)).json()) as any;
    expect(p.act.outcome.status).toBe("arrived");
    clock += 1000;
    const o = (await (await call("GET", `/bodies/${AID}/observe`)).json()) as any;
    expect(o.observation.nearestPlace.id).toBe("stall-0");
    clock += 1000;
    const b = (await (await call("GET", `/bodies/${AID}`)).json()) as any;
    expect(b.body.posture).toBe("standing");
    expect(b.body.x).toBeCloseTo(o.observation.body.x, 1);
    expect(((await (await call("DELETE", `/bodies/${AID}`)).json()) as any).removed).toBe(true);
    expect((await call("GET", `/bodies/${AID}/observe`)).status).toBe(404);
    expect(((await (await call("GET", `/bodies/${AID}`)).json()) as any).error).toBe("no_body");
  });

  test("a figure pick is honored and exposed; cast-only/unknown picks are loud 400s; the figure is fixed for the body's life", async () => {
    const B = "22222222-2222-4222-8222-222222222222";
    // Pick honored + exposed on attach response, GET body, observe and roster.
    const r = await call("POST", "/bodies", { agentId: B, expiresAtMs: clock + 60_000, body: "summer" });
    expect(r.status).toBe(201);
    expect(((await r.json()) as any).observation.body.figure).toBe("summer");
    clock += 1000;
    expect(((await (await call("GET", `/bodies/${B}`)).json()) as any).body.figure).toBe("summer");
    clock += 1000;
    expect(((await (await call("GET", `/bodies/${B}/observe`)).json()) as any).observation.body.figure).toBe("summer");
    const roster = ((await (await call("GET", "/roster")).json()) as any).bodies as { agentId: string; body: string }[];
    expect(roster.find((x) => x.agentId === B)?.body).toBe("summer");
    // Same figure again: idempotent 200. Non-string pick: 400.
    expect((await call("POST", "/bodies", { agentId: B, expiresAtMs: clock + 60_000, body: "summer" })).status).toBe(200);
    // A different figure on the live body: 409, and the body still wears summer.
    const conflict = await call("POST", "/bodies", { agentId: B, expiresAtMs: clock + 60_000, body: "eve" });
    expect(conflict.status).toBe(409);
    clock += 1000;
    expect(((await (await call("GET", `/bodies/${B}`)).json()) as any).body.figure).toBe("summer");
    expect(((await (await call("DELETE", `/bodies/${B}`)).json()) as any).removed).toBe(true);

    // Cast-only and unknown picks: 400 naming the problem and the pickable set; nothing attaches.
    const C = "33333333-3333-4333-8333-333333333333";
    const cast = await call("POST", "/bodies", { agentId: C, expiresAtMs: clock + 60_000, body: "mage" });
    expect(cast.status).toBe(400);
    const castBody = (await cast.json()) as any;
    expect(castBody.error).toBe("invalid_action");
    expect(castBody.message).toContain("cast-only");
    expect(castBody.message).toContain("summer");
    const unknown = await call("POST", "/bodies", { agentId: C, expiresAtMs: clock + 60_000, body: "nope" });
    expect(unknown.status).toBe(400);
    expect(((await unknown.json()) as any).message).toContain("unknown body");
    expect((await call("POST", "/bodies", { agentId: C, expiresAtMs: clock + 60_000, body: 42 })).status).toBe(400);
    expect(service.has(C)).toBe(false);
    // No pick: the platform default.
    const dflt = await call("POST", "/bodies", { agentId: C, expiresAtMs: clock + 60_000 });
    expect(dflt.status).toBe(201);
    expect(((await dflt.json()) as any).observation.body.figure).toBe("remy");
    await call("DELETE", `/bodies/${C}`);
  });

  test("clips lists what play accepts; a refused action says why and names the valid options", async () => {
    const clips = ((await (await call("GET", "/clips")).json()) as any).clips;
    expect(clips.map((c: any) => c.name)).toContain("Waving");
    clock += 10_000;
    await call("POST", "/bodies", { agentId: AID, expiresAtMs: clock + 60_000 });
    const wave = (await (await call("POST", `/bodies/${AID}/act`, { id: "w1", action: { type: "play", clip: "cartwheel" } })).json()) as any;
    expect(wave.error).toBe("invalid_action");
    expect(wave.message).toContain("Waving");
    clock += 1000;
    expect((await call("POST", `/bodies/${AID}/act`, { id: "w1b", action: { type: "play", clip: "Wave" } })).status).toBe(202); // alias, any case
    clock += 1000;
    const type = (await (await call("POST", `/bodies/${AID}/act`, { id: "w2", action: { type: "dance" } })).json()) as any;
    expect(type.message).toContain("go_to");
    clock += 1000;
    expect((await call("POST", `/bodies/${AID}/act`, { id: "w3", action: { type: "face", point: [0, 0] } })).status).toBe(202);
    clock += 1000;
    expect((await call("POST", `/bodies/${AID}/act`, { id: "w4", action: { type: "face", point: [0, 0], headingDeg: 3 } })).status).toBe(400);
    clock += 1000;
    await call("DELETE", `/bodies/${AID}`);
  });

  test("rejects bad input: teleport, reused id, oversize body, bad agent id, past expiry", async () => {
    clock += 10_000;
    await call("POST", "/bodies", { agentId: AID, expiresAtMs: clock + 60_000 });
    expect((await call("POST", `/bodies/${AID}/act`, { id: "t1", action: { type: "teleport", point: [0, 0] } })).status).toBe(400);
    clock += 1000;
    expect((await call("POST", `/bodies/${AID}/act`, { id: "dup", action: { type: "wait", seconds: 1 } })).status).toBe(202);
    clock += 1000;
    expect((await call("POST", `/bodies/${AID}/act`, { id: "dup", action: { type: "wait", seconds: 1 } })).status).toBe(200); // replay
    clock += 1000;
    expect((await call("POST", `/bodies/${AID}/act`, { id: "dup", action: { type: "stop" } })).status).toBe(409);
    clock += 1000;
    expect((await call("POST", `/bodies/${AID}/act`, { id: "big", action: { type: "stop" }, pad: "x".repeat(5000) })).status).toBe(413);
    expect((await call("POST", "/bodies", { agentId: "../etc", expiresAtMs: clock + 1000 })).status).toBe(400);
    expect((await call("POST", "/bodies", { agentId: AID, expiresAtMs: clock - 1 })).status).toBe(400);
    await call("DELETE", `/bodies/${AID}`);
  });

  test("rate limits actions per agent, then recovers", async () => {
    clock += 10_000;
    await call("POST", "/bodies", { agentId: AID, expiresAtMs: clock + 60_000 });
    const codes: number[] = [];
    for (let i = 0; i < 6; i++) codes.push((await call("POST", `/bodies/${AID}/act`, { id: `r${i}`, action: { type: "wait", seconds: 1 } })).status);
    expect(codes.slice(0, 4)).toEqual([202, 202, 202, 202]); // burst of 4 (2 x rate)
    expect(codes.slice(4)).toContain(429);
    clock += 1000;
    expect((await call("POST", `/bodies/${AID}/act`, { id: "r-later", action: { type: "stop" } })).status).toBe(202);
    await call("DELETE", `/bodies/${AID}`);
  });

  test("a body past its visit deadline is removed even if the gateway never says so", async () => {
    clock += 10_000;
    await call("POST", "/bodies", { agentId: AID, expiresAtMs: clock + 5_000 });
    expect(service.has(AID)).toBe(true);
    clock += 6_000;
    expect(app.expire()).toEqual([AID]);
    expect(service.has(AID)).toBe(false);
  });

  test("look returns the images and scene, and is limited to one per second per body", async () => {
    const LID = "22222222-2222-4222-8222-222222222222";
    expect((await call("POST", "/bodies", { agentId: LID, expiresAtMs: clock + 60_000 })).status).toBe(201);
    const ok = await call("POST", `/bodies/${LID}/look`, {});
    expect(ok.status).toBe(200);
    const v = ((await ok.json()) as any).look;
    expect(v.width).toBe(128);
    expect(v.height).toBe(72);
    expect(typeof v.depthPng).toBe("string");
    expect(v.observation.body.id).toBeDefined();
    const fast = await call("POST", `/bodies/${LID}/look`, {});
    expect(fast.status).toBe(429);
    expect(fast.headers.get("retry-after")).toBe("1");
    clock += 1100;
    expect((await call("POST", `/bodies/${LID}/look`, {})).status).toBe(200);
    expect((await call("POST", `/bodies/33333333-3333-4333-8333-333333333333/look`, {})).status).toBe(404);
    await call("DELETE", `/bodies/${LID}`);
  });

  test("caps the number of bodies", async () => {
    clock += 10_000;
    const ids = ["aaaaaaa1", "aaaaaaa2", "aaaaaaa3", "aaaaaaa4"];
    const codes: number[] = [];
    for (const id of ids) codes.push((await call("POST", "/bodies", { agentId: id, expiresAtMs: clock + 60_000 })).status);
    expect(codes).toEqual([201, 201, 201, 503]);
    for (const id of ids) await call("DELETE", `/bodies/${id}`);
  });
});
