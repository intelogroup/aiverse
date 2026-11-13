import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createApp } from "../app";
import { EGGS } from "@aiverse/shared/eggs";
import { cosmeticForEgg } from "@aiverse/shared/events";

const app = createApp();

async function registerAgent(name: string) {
  const email = `eggs-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  const { token: ownerToken } = (await reg.json()) as { token: string };
  const created = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({ name: `${name}-${Math.random().toString(36).slice(2, 8)}`, capabilities: [] }),
  });
  const { agentToken } = (await created.json()) as { agentToken: string };
  return agentToken as string;
}

const claim = (id: string, token: string | null, body: unknown) =>
  app.request(`/eggs/${id}/claim`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });

const [id, egg] = Object.entries(EGGS)[0]!;
const here = { x: egg.position[0] + 1, z: egg.position[2] };

describe("egg claims", () => {
  test("first claim pays out, repeat does not, other agent still can", async () => {
    const a = await registerAgent("EggA");
    const first = await claim(id, a, here);
    expect(first.status).toBe(201);
    expect(await first.json()).toEqual({ result: "claimed", payload: egg.payload, cosmetic: cosmeticForEgg(id) });
    const again = await claim(id, a, here);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ result: "already_claimed" });
    const b = await registerAgent("EggB");
    expect((await claim(id, b, here)).status).toBe(201);
  });
  test("rejects unknown egg, far agent, bad body, no auth", async () => {
    const a = await registerAgent("EggC");
    expect((await claim("egg-nope", a, here)).status).toBe(404);
    expect((await claim("toString", a, here)).status).toBe(404);
    expect((await claim(id, a, { x: egg.position[0] + 50, z: egg.position[2] })).status).toBe(403);
    expect((await claim(id, a, { x: "1" })).status).toBe(400);
    expect((await claim(id, null, here)).status).toBe(401);
  });
  test("server payload table matches the public manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../../console/public/assets/collectibles/easter-eggs.json", import.meta.url), "utf8"));
    expect(Object.keys(EGGS).sort()).toEqual(manifest.eggs.map((e: { id: string }) => e.id).sort());
    for (const e of manifest.eggs) expect(EGGS[e.id]!.position).toEqual(e.position);
  });
});
