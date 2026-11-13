import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { EGGS } from "@aiverse/shared/eggs";
import { cosmeticForEgg } from "@aiverse/shared/events";

const app = createApp();

async function registerAgent(name: string) {
  const reg = await app.request("/owners/register", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ email: `ev-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, password: "password123" }),
  });
  const { token } = (await reg.json()) as { token: string };
  const created = await app.request("/owners/agents", {
    method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }),
  });
  const { agentToken } = (await created.json()) as { agentToken: string };
  const me = await app.request("/agent/me", { headers: { authorization: `Bearer ${agentToken}` } });
  const { id } = (await me.json()) as { id: string };
  return { token: agentToken, id, ownerToken: token };
}
const post = (path: string, body: unknown, token?: string) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });

describe("event log", () => {
  test("agent reports events; public reads them; bad input is rejected", async () => {
    const a = await registerAgent("Ev");
    expect((await post("/events", { type: "said", detail: "  hello\n\tworld  " }, a.token)).status).toBe(201);
    expect((await post("/events", { type: "claimed", detail: "forged" }, a.token)).status).toBe(400);
    expect((await post("/events", { type: "said" })).status).toBe(401);
    const r = await app.request(`/public/agents/${a.id}/events`);
    const j = (await r.json()) as { events: { type: string; detail: string }[] };
    expect(j.events).toHaveLength(1);
    expect(j.events[0]).toMatchObject({ type: "said", detail: "hello world" });
    expect((await app.request("/public/agents/not-a-uuid/events")).status).toBe(404);
  });
  test("cheer: fixed set only, appears in log", async () => {
    const a = await registerAgent("Cheer");
    expect((await post(`/public/agents/${a.id}/cheer`, { cheer: "<script>" })).status).toBe(400);
    expect((await post(`/public/agents/${a.id}/cheer`, { cheer: "fire" })).status).toBe(201);
    const j = (await (await app.request(`/public/agents/${a.id}/events`)).json()) as { events: { type: string; detail: string }[] };
    expect(j.events[0]).toMatchObject({ type: "cheered", detail: "fire" });
  });
  test("egg claim lands in passport, digest and log with a cosmetic", async () => {
    const a = await registerAgent("Pass");
    const [eggId, egg] = Object.entries(EGGS)[1]!;
    const c = await post(`/eggs/${eggId}/claim`, { x: egg.position[0], z: egg.position[2] }, a.token);
    expect(c.status).toBe(201);
    const p = (await (await app.request(`/public/agents/${a.id}/passport`)).json()) as any;
    expect(p.eggsFound).toBe(1);
    expect(p.cosmetics).toEqual([cosmeticForEgg(eggId)]);
    expect(p.best.type).toBe("claimed");
    const d = (await (await app.request(`/public/agents/${a.id}/digest`)).json()) as any;
    expect(d.moments[0].type).toBe("claimed");
  });
  test("agent with events can be deleted", async () => {
    const a = await registerAgent("Del");
    await post("/events", { type: "sat" }, a.token);
    const [eggId, egg] = Object.entries(EGGS)[2]!;
    await post(`/eggs/${eggId}/claim`, { x: egg.position[0], z: egg.position[2] }, a.token);
    const r = await app.request(`/owners/agents/${a.id}`, { method: "DELETE", headers: { authorization: `Bearer ${a.ownerToken}` } });
    expect(r.status).toBeLessThan(300);
  });
});
