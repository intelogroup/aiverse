import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { and, eq, isNull } from "drizzle-orm";
import { agentVisits } from "@aiverse/shared/schema";
import { loadVerseSim } from "@aiverse/world-sim/node/loadWorld";
import { WorldService } from "@aiverse/world-sim/worldService";
import { createSimServer } from "@aiverse/sim/server";
import { createApp } from "../app";
import { db } from "../db/client";
import { websocket } from "../ws/gateway";
import { httpSimClient } from "../world/simClient";
import { redis } from "../redis/client";

// The UTC clock feed (owner decision, 2026-11-17): the world state surfaces
// (attach, GET /body, GET /observe) are stamped at the gateway with the
// gateway's UTC now + the calling agent's visit deadline, in ISO and
// epoch-ms forms, alongside the sim's own `t` (elapsed sim-seconds, never
// edited). Same harness shape as world.test.ts: real gateway app, real sim
// server, real world.
const SECRET = "x".repeat(48);
const ASSETS = new URL("../../../console/public/assets/", import.meta.url).pathname;
let service: WorldService;
let simHttp: ReturnType<typeof Bun.serve>;
let app: ReturnType<typeof createApp>;
let server: ReturnType<typeof Bun.serve>;

beforeAll(async () => {
  // Owner registration is rate limited per IP in Redis (60/h); do not inherit earlier runs' count.
  const keys = await redis.keys("register:*");
  if (keys.length) await redis.del(...keys);
  const { sim } = await loadVerseSim(ASSETS);
  service = new WorldService({ sim, maxBodies: 5 });
  const simApp = createSimServer({ service, secret: SECRET });
  simHttp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: simApp.fetch });
  app = createApp({ sim: httpSimClient(`http://127.0.0.1:${simHttp.port}`, SECRET) });
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
}, 120_000);

afterAll(() => { server?.stop(true); simHttp?.stop(true); });

const json = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function ownerWithAgent(name: string) {
  const email = `worldclock-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  const { token: ownerToken } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: `${name}${Math.random().toString(36).slice(2, 7)}`, capabilities: [] }) });
  const { agent, agentToken } = (await created.json()) as any;
  await app.request(`/owners/agents/${agent.id}/wallet`, { method: "PATCH", headers: json(ownerToken), body: JSON.stringify({ autonomyMode: "autonomous" }) });
  return { ownerToken: ownerToken as string, agentId: agent.id as string, agentToken: agentToken as string };
}
const startVisit = async (ownerToken: string, agentId: string) =>
  ((await (await app.request(`/owners/agents/${agentId}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes: 30, maxActions: 50 }) })).json()) as any).visit;

const w = (token: string, method: string, path: string, body?: unknown) =>
  app.request(`/world${path}`, { method, headers: json(token), body: body === undefined ? undefined : JSON.stringify(body) });

/** The four clock fields on a stamped state response, pinned against the test process's own clock and the visit row. */
function expectClockFields(data: any, visitEndsAtMs: number) {
  expect(typeof data.utc_now).toBe("string");
  expect(typeof data.utc_now_ms).toBe("number");
  // The ISO and epoch-ms forms name the same instant.
  expect(new Date(data.utc_now).getTime()).toBe(data.utc_now_ms);
  // ...and that instant is the gateway's now, not a cached or sim-derived time.
  expect(Math.abs(data.utc_now_ms - Date.now())).toBeLessThan(10_000);
  // The deadline rides in both forms and equals the visit row's endsAt.
  expect(data.visit_ends_at_ms).toBe(visitEndsAtMs);
  expect(data.visit_ends_at).toBe(new Date(visitEndsAtMs).toISOString());
}

describe("/world UTC clock feed", () => {
  test("attach, body and observe carry utc_now + the visit deadline; the sim's t rides unchanged", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("ClockAgent");
    const visit = await startVisit(ownerToken, agentId);
    const visitEndsAtMs = new Date(visit.endsAt).getTime();
    // The stamp must equal the visit ROW's endsAt, not just the create response's echo of it.
    const row = await db.query.agentVisits.findFirst({
      where: and(eq(agentVisits.agentId, agentId), isNull(agentVisits.endedAt)),
    });
    expect(row).toBeTruthy();
    expect(row!.endsAt.getTime()).toBe(visitEndsAtMs);

    const attach = await w(agentToken, "POST", "/body", {});
    expect(attach.status).toBe(201);
    const attachData = (await attach.json()) as any;
    expectClockFields(attachData, visitEndsAtMs);
    // The sim payload is untouched: the observation and its own clock are still there.
    expect(typeof attachData.observation.t).toBe("number");

    const bodyRes = await w(agentToken, "GET", "/body");
    expect(bodyRes.status).toBe(200);
    const bodyData = (await bodyRes.json()) as any;
    expect(bodyData.body).toBeTruthy();
    expectClockFields(bodyData, visitEndsAtMs);

    const observeRes = await w(agentToken, "GET", "/observe");
    expect(observeRes.status).toBe(200);
    const observeData = (await observeRes.json()) as any;
    expect(typeof observeData.observation.t).toBe("number");
    expectClockFields(observeData, visitEndsAtMs);
  });

  test("non-state surfaces are not stamped: places and clips carry no clock fields", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("ClockScope");
    await startVisit(ownerToken, agentId);

    const places = (await (await w(agentToken, "GET", "/places")).json()) as any;
    expect(Array.isArray(places.places)).toBe(true);
    expect(places.utc_now).toBeUndefined();
    expect(places.utc_now_ms).toBeUndefined();
    expect(places.visit_ends_at_ms).toBeUndefined();

    const clips = (await (await w(agentToken, "GET", "/clips")).json()) as any;
    expect(Array.isArray(clips.clips)).toBe(true);
    expect(clips.utc_now).toBeUndefined();
    expect(clips.visit_ends_at_ms).toBeUndefined();
  });
});
