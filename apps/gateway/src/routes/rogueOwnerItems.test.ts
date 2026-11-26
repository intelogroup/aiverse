import { test, expect } from "bun:test";
import { createApp } from "../app";
import { db } from "../db/client";
import { sql } from "drizzle-orm";
const app = createApp();
const auth = (t: string) => ({ "content-type": "application/json", authorization: `Bearer ${t}` });
async function owner(p: string) {
  const reg = await app.request("/owners/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: `${p}-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`, password: "password123" }) });
  return (await reg.json()).token as string;
}
async function agent(ownerToken: string, name: string) {
  const res = await app.request("/owners/agents", { method: "POST", headers: auth(ownerToken), body: JSON.stringify({ name, capabilities: [] }) });
  const j = await res.json(); return { token: j.agentToken as string, id: j.agent.id as string };
}
test("P2b rogue gifts victim's item to an accomplice", async () => {
  const R = Math.random().toString(36).slice(2, 8);
  const v = await agent(await owner("p2b-victim"), `P2bHolder-${R}`);
  const x = await agent(await owner("p2b-rogue"), `P2bGrabber-${R}`);
  const y = await agent(await owner("p2b-accomplice"), `P2bFence-${R}`);
  const rows = (await db.execute(sql`INSERT INTO verse_inventory (agent_id, name) VALUES (${v.id}::uuid, 'Brass Lantern') RETURNING id, revision`)) as unknown as Array<{ id: string; revision: number }>;
  const res = await app.request(`/verse/inventory/${rows[0].id}/transfer`, { method: "POST", headers: auth(x.token), body: JSON.stringify({ toAgentId: y.id, revision: rows[0].revision }) });
  const bodyText = await res.text();
  console.log(`[rogue] P2b accomplice transfer: ${res.status} ${bodyText.slice(0, 80)}`);
  expect(res.status).toBe(409);
  const after = (await db.execute(sql`SELECT agent_id FROM verse_inventory WHERE id = ${rows[0].id}::uuid`)) as unknown as Array<{ agent_id: string }>;
  expect(after[0].agent_id).toBe(v.id);
});
