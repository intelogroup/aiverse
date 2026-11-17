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

// Edge cases for the UTC clock feed (PR #206 follow-up, 2026-11-17). Same
// harness shape as worldClock.test.ts: real gateway app, real sim server,
// real world. Each test pins the behavior the feed exhibits at a boundary —
// an expired visit, a non-UTC process timezone, a rapid burst across a
// second boundary, two agents side by side, and error responses.
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
  service = new WorldService({ sim, maxBodies: 10 });
  const simApp = createSimServer({ service, secret: SECRET });
  simHttp = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: simApp.fetch });
  app = createApp({ sim: httpSimClient(`http://127.0.0.1:${simHttp.port}`, SECRET) });
  server = Bun.serve({ port: 0, fetch: app.fetch, websocket });
}, 120_000);

afterAll(() => { server?.stop(true); simHttp?.stop(true); });

const json = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function ownerWithAgent(name: string) {
  const email = `worldclockedge-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  const { token: ownerToken } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: `${name}${Math.random().toString(36).slice(2, 7)}`, capabilities: [] }) });
  const { agent, agentToken } = (await created.json()) as any;
  await app.request(`/owners/agents/${agent.id}/wallet`, { method: "PATCH", headers: json(ownerToken), body: JSON.stringify({ autonomyMode: "autonomous" }) });
  return { ownerToken: ownerToken as string, agentId: agent.id as string, agentToken: agentToken as string };
}
const startVisit = async (ownerToken: string, agentId: string, minutes = 30, maxActions = 1000) =>
  ((await (await app.request(`/owners/agents/${agentId}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes, maxActions }) })).json()) as any).visit;

const w = (token: string, method: string, path: string, body?: unknown) =>
  app.request(`/world${path}`, { method, headers: json(token), body: body === undefined ? undefined : JSON.stringify(body) });

let rpcId = 0;
async function whoami(agentToken: string) {
  const res = await app.request("/mcp/agent", {
    method: "POST",
    headers: { ...json(agentToken), accept: "application/json, text/event-stream" },
    body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method: "tools/call", params: { name: "agent_whoami", arguments: {} } }),
  });
  expect(res.status).toBe(200);
  const body = (await res.json()) as any;
  return JSON.parse(body.result.content[0].text as string) as any;
}

const CLOCK_KEYS = ["utc_now", "utc_now_ms", "visit_ends_at", "visit_ends_at_ms"] as const;
function expectNoClockFields(data: any) {
  for (const k of CLOCK_KEYS) expect(data[k]).toBeUndefined();
}

describe("/world UTC clock feed — edge cases", () => {
  test("expired visit: whoami reports the past deadline next to a later utc_now; /world ends the visit and answers without a stamp", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("EdgeExpired");
    const visit = await startVisit(ownerToken, agentId);
    const attach = await w(agentToken, "POST", "/body", {});
    expect(attach.status).toBe(201);

    // Move the deadline into the past, behind the gateway's back (test
    // scaffolding): the row now says the visit ended a minute ago, but
    // nothing has ended it yet (endedAt still null, no sweeper in tests).
    const pastEndsAt = new Date(Date.now() - 60_000);
    await db.update(agentVisits).set({ endsAt: pastEndsAt }).where(eq(agentVisits.id, visit.id));

    // whoami reads the row directly. Owner ruling (2026-11-17): `active`
    // requires the deadline to be in the future, so this expired-but-open
    // visit reports active:false — while the deadline fields keep showing
    // the actual past endsAt (null is reserved for "no visit"), and
    // utc_now_ms sits AFTER it: when it expired stays legible from this
    // one payload, which is the point of the feed.
    const before = await whoami(agentToken);
    expect(before.visit.active).toBe(false);
    expect(before.visit.endsAt).toBe(pastEndsAt.toISOString());
    expect(before.visit_ends_at_ms).toBe(pastEndsAt.getTime());
    expect(before.visit_ends_at).toBe(pastEndsAt.toISOString());
    expect(before.utc_now_ms).toBeGreaterThan(before.visit_ends_at_ms);
    expect(new Date(before.utc_now).getTime()).toBe(before.utc_now_ms);

    // The /world surfaces enforce the deadline instead: agentAuth ends the
    // visit on the spot (time_expired) and refuses — an error response, so
    // no clock stamp rides on it.
    const observe = await w(agentToken, "GET", "/observe");
    expect(observe.status).toBe(403);
    const observeData = (await observe.json()) as any;
    expect(observeData.error).toBe("visit_ended");
    expect(observeData.reason).toBe("time_expired");
    expectNoClockFields(observeData);

    const bodyRes = await w(agentToken, "GET", "/body");
    expect(bodyRes.status).toBe(403);
    expectNoClockFields((await bodyRes.json()) as any);

    // Now that the visit row is ended, whoami reports no visit and nulls.
    const after = await whoami(agentToken);
    expect(after.visit.active).toBe(false);
    expect(after.visit_ends_at).toBeNull();
    expect(after.visit_ends_at_ms).toBeNull();
    expect(typeof after.utc_now_ms).toBe("number");
  }, 30_000);

  test("process timezone does not leak into the stamp: TZ=America/New_York still yields Z-suffixed UTC agreeing with Date.now()", async () => {
    const prevTz = process.env.TZ;
    process.env.TZ = "America/New_York";
    try {
      // Prove the zone actually took effect in this process (EST/EDT are
      // behind UTC) — otherwise the assertions below would be vacuous.
      expect(new Date().getTimezoneOffset()).toBeGreaterThan(0);
      const { ownerToken, agentId, agentToken } = await ownerWithAgent("EdgeTz");
      const visit = await startVisit(ownerToken, agentId);
      const visitEndsAtMs = new Date(visit.endsAt).getTime();
      const attach = await w(agentToken, "POST", "/body", {});
      expect(attach.status).toBe(201);
      const data = (await attach.json()) as any;
      expect(data.utc_now.endsWith("Z")).toBe(true);
      expect(new Date(data.utc_now).getTime()).toBe(data.utc_now_ms);
      expect(Math.abs(data.utc_now_ms - Date.now())).toBeLessThan(10_000);
      expect(data.visit_ends_at).toBe(new Date(visitEndsAtMs).toISOString());
      expect(data.visit_ends_at.endsWith("Z")).toBe(true);
    } finally {
      if (prevTz === undefined) delete process.env.TZ; else process.env.TZ = prevTz;
    }
  }, 30_000);

  test("rapid successive observes: utc_now_ms never decreases, ISO and ms forms agree exactly, including across a second boundary", async () => {
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("EdgeBurst");
    await startVisit(ownerToken, agentId);
    const attach = await w(agentToken, "POST", "/body", {});
    expect(attach.status).toBe(201);

    const stamps: { iso: string; ms: number; ends: number }[] = [];
    // Paced at the sim's own read limit (apps/sim server: 5 reads/s per body,
    // token bucket) — the fastest sustained cadence the product serves; a
    // faster burst is refused 429 by the sim before the gateway can stamp.
    for (let i = 0; i < 25; i++) {
      const res = await w(agentToken, "GET", "/observe");
      expect(res.status).toBe(200);
      const data = (await res.json()) as any;
      stamps.push({ iso: data.utc_now, ms: data.utc_now_ms, ends: data.visit_ends_at_ms });
      if (i < 24) await new Promise((r) => setTimeout(r, 210));
    }
    // One more sample taken just past the next wall-clock second boundary.
    const waitMs = 1000 - (Date.now() % 1000) + 40;
    await new Promise((r) => setTimeout(r, waitMs));
    const boundaryRes = await w(agentToken, "GET", "/observe");
    expect(boundaryRes.status).toBe(200);
    const boundary = (await boundaryRes.json()) as any;
    stamps.push({ iso: boundary.utc_now, ms: boundary.utc_now_ms, ends: boundary.visit_ends_at_ms });

    for (let i = 0; i < stamps.length; i++) {
      // The two forms denote the same instant — exactly, not approximately.
      expect(new Date(stamps[i].iso).getTime()).toBe(stamps[i].ms);
      // The deadline is the visit's, constant across the burst.
      expect(stamps[i].ends).toBe(stamps[0].ends);
      if (i > 0) expect(stamps[i].ms).toBeGreaterThanOrEqual(stamps[i - 1].ms);
    }
    // The boundary sample really is in a later second than the burst start.
    expect(Math.floor(stamps[stamps.length - 1].ms / 1000)).toBeGreaterThan(Math.floor(stamps[0].ms / 1000));
  }, 30_000);

  test("per-agent isolation: two agents observing concurrently each carry their own visit deadline", async () => {
    const a = await ownerWithAgent("EdgeIsoA");
    const b = await ownerWithAgent("EdgeIsoB");
    const visitA = await startVisit(a.ownerToken, a.agentId, 15);
    const visitB = await startVisit(b.ownerToken, b.agentId, 45);
    const endsA = new Date(visitA.endsAt).getTime();
    const endsB = new Date(visitB.endsAt).getTime();
    expect(endsB - endsA).toBeGreaterThan(20 * 60_000);

    expect((await w(a.agentToken, "POST", "/body", {})).status).toBe(201);
    expect((await w(b.agentToken, "POST", "/body", {})).status).toBe(201);

    const [obsA, obsB] = await Promise.all([w(a.agentToken, "GET", "/observe"), w(b.agentToken, "GET", "/observe")]);
    const dataA = (await obsA.json()) as any;
    const dataB = (await obsB.json()) as any;
    expect(dataA.visit_ends_at_ms).toBe(endsA);
    expect(dataA.visit_ends_at).toBe(new Date(endsA).toISOString());
    expect(dataB.visit_ends_at_ms).toBe(endsB);
    expect(dataB.visit_ends_at).toBe(new Date(endsB).toISOString());
  }, 30_000);

  test("error responses on stamped routes carry no clock fields", async () => {
    // (a) No visit at all: the /world visit gate refuses with 403 no_visit.
    const noVisit = await ownerWithAgent("EdgeNoVisit");
    const resA = await w(noVisit.agentToken, "GET", "/observe");
    expect(resA.status).toBe(403);
    const dataA = (await resA.json()) as any;
    expect(dataA.error).toBe("no_visit");
    expectNoClockFields(dataA);

    // (b) Bad auth on a stamped route: 401, no stamp.
    const resB = await app.request("/world/observe", { method: "GET", headers: json("not-a-real-token") });
    expect(resB.status).toBe(401);
    expectNoClockFields((await resB.json()) as any);

    // (c) A stamped route's own validation refusal: POST /world/body with an
    // unpickable body answers 400 from inside the handler — unstamped.
    const { ownerToken, agentId, agentToken } = await ownerWithAgent("EdgeBadPick");
    await startVisit(ownerToken, agentId);
    const resC = await w(agentToken, "POST", "/body", { body: "not-a-real-body" });
    expect(resC.status).toBe(400);
    const dataC = (await resC.json()) as any;
    expect(dataC.error).toBe("body_not_pickable");
    expectNoClockFields(dataC);
  }, 30_000);
});
