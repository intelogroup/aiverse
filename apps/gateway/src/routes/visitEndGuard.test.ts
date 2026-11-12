// A visit ends at its deadline, its action cap or the owner's stop - never for presence. The old presence sweep was removed
// (see jobs/visits.ts), but social15 Session 1 still saw visits end with reason "presence_expired": a stale gateway process
// running the old code against the production database. Migration 0045 makes the database refuse that value for new writes,
// so a stale process fails its UPDATE instead of killing visits. Historical rows keep the value (constraint is NOT VALID).
import { describe, expect, test } from "bun:test";
import { eq, sql } from "drizzle-orm";
import { agentVisits } from "@aiverse/shared/schema";
import { db } from "../db/client";
import { createApp } from "../app";
import { endVisitRecord } from "../policy/visits";

const app = createApp();
const json = (token?: string) => ({ "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) });

async function activeVisit(): Promise<string> {
  const email = `guard-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
  const reg = await app.request("/owners/register", { method: "POST", headers: json(), body: JSON.stringify({ email, password: "password123" }) });
  const { token: ownerToken } = (await reg.json()) as any;
  const created = await app.request("/owners/agents", { method: "POST", headers: json(ownerToken), body: JSON.stringify({ name: `guard${Math.random().toString(36).slice(2, 10)}` }) });
  const { agent } = (await created.json()) as any;
  await app.request(`/owners/agents/${agent.id}/wallet`, { method: "PATCH", headers: json(ownerToken), body: JSON.stringify({ autonomyMode: "auto" }) });
  const v = await app.request(`/owners/agents/${agent.id}/visits`, { method: "POST", headers: json(ownerToken), body: JSON.stringify({ minutes: 10, maxActions: 5 }) });
  expect(v.status).toBe(201);
  return ((await v.json()) as any).visit.id as string;
}

describe("visit end reasons (migration 0045)", () => {
  test("the database refuses presence_expired on a new write", async () => {
    const id = await activeVisit();
    let err: unknown;
    try {
      await db.update(agentVisits).set({ endedAt: new Date(), endedReason: "presence_expired" }).where(eq(agentVisits.id, id));
    } catch (e) { err = e; }
    expect(String((err as Error)?.message ?? err) + String((err as any)?.cause?.message ?? "")).toMatch(/agent_visits_no_presence_expired|check constraint/i);
    const [row] = await db.select().from(agentVisits).where(eq(agentVisits.id, id));
    expect(row.endedAt).toBeNull(); // the visit is still alive
  });

  test("the reasons the code still writes keep working", async () => {
    for (const reason of ["time_expired", "action_cap", "owner_stopped"] as const) {
      const id = await activeVisit();
      const ended = await endVisitRecord(id, reason);
      expect(ended?.reason).toBe(reason);
      const [row] = await db.select().from(agentVisits).where(eq(agentVisits.id, id));
      expect(row.endedReason).toBe(reason);
    }
  });

  test("the constraint is NOT VALID, so historical presence_expired rows cannot break the migration", async () => {
    const rows = (await db.execute(sql`select convalidated from pg_constraint where conname = 'agent_visits_no_presence_expired'`)) as unknown as Array<{ convalidated: boolean }>;
    expect(rows.length).toBe(1);
    expect(rows[0].convalidated).toBe(false);
  });
});
