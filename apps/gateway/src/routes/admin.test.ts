import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { eq } from "drizzle-orm";
import { agents } from "@aiverse/shared/schema";
import { db } from "../db/client";

const app = createApp();

function uniqueEmail() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

async function register(email: string) {
  const res = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  if (res.status === 409) {
    const login = await app.request("/owners/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    return (await login.json()).token as string;
  }
  return (await res.json()).token as string;
}

// admin-test@example.com is the .env.test ADMIN_EMAILS fixture.
const adminToken = () => register("admin-test@example.com");

async function createAgent(ownerToken: string) {
  const res = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${ownerToken}` },
    body: JSON.stringify({
      name: `PauseProv-${Date.now()}-${Math.random().toString(36).slice(2)}`,
      capabilities: [],
    }),
  });
  const body = await res.json();
  return body.agent.id as string;
}

function post(path: string, token: string) {
  return app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}` },
  });
}

async function agentRow(agentId: string) {
  return db.query.agents.findFirst({ where: eq(agents.id, agentId) });
}

// AIV-ADMIN-SUSPEND-OWNER-RESUME-001: admin suspend and owner pause both
// wrote the same status "paused" with no provenance, and POST
// /admin/agents/:id/resume unconditionally set "offline" — re-enabling
// agents the OWNER had paused, potentially on suspicion of compromise.
// Provenance (agents.pausedBy, first pauser owns the pause) now decides
// who may resume.
describe("pause provenance (AIV-ADMIN-SUSPEND-OWNER-RESUME-001)", () => {
  test("admin resume cannot lift an owner's pause; the owner resume can", async () => {
    const owner = await register(uniqueEmail());
    const admin = await adminToken();
    const agentId = await createAgent(owner);

    expect((await post(`/owners/agents/${agentId}/pause`, owner)).status).toBe(200);
    expect((await agentRow(agentId))?.pausedBy).toBe("owner");

    const adminResume = await post(`/admin/agents/${agentId}/resume`, admin);
    expect(adminResume.status).toBe(409);
    expect((await agentRow(agentId))?.status).toBe("paused");

    expect((await post(`/owners/agents/${agentId}/resume`, owner)).status).toBe(200);
    const row = await agentRow(agentId);
    expect(row?.status).toBe("offline");
    expect(row?.pausedBy).toBeNull();
  });

  test("owner resume cannot lift an admin suspension; the admin resume can", async () => {
    const owner = await register(uniqueEmail());
    const admin = await adminToken();
    const agentId = await createAgent(owner);

    expect((await post(`/admin/agents/${agentId}/suspend`, admin)).status).toBe(200);
    expect((await agentRow(agentId))?.pausedBy).toBe("admin");

    const ownerResume = await post(`/owners/agents/${agentId}/resume`, owner);
    expect(ownerResume.status).toBe(409);
    expect((await agentRow(agentId))?.status).toBe("paused");

    expect((await post(`/admin/agents/${agentId}/resume`, admin)).status).toBe(200);
    const row = await agentRow(agentId);
    expect(row?.status).toBe("offline");
    expect(row?.pausedBy).toBeNull();
  });

  test("first pauser owns the pause: suspend-after-owner-pause and pause-after-suspend keep provenance", async () => {
    const owner = await register(uniqueEmail());
    const admin = await adminToken();

    // Owner pauses first; admin suspend must not convert it.
    const a1 = await createAgent(owner);
    await post(`/owners/agents/${a1}/pause`, owner);
    expect((await post(`/admin/agents/${a1}/suspend`, admin)).status).toBe(200);
    expect((await agentRow(a1))?.pausedBy).toBe("owner");
    expect((await post(`/admin/agents/${a1}/resume`, admin)).status).toBe(409);
    expect((await post(`/owners/agents/${a1}/resume`, owner)).status).toBe(200);

    // Admin suspends first; owner pause must not convert it.
    const a2 = await createAgent(owner);
    await post(`/admin/agents/${a2}/suspend`, admin);
    expect((await post(`/owners/agents/${a2}/pause`, owner)).status).toBe(200);
    expect((await agentRow(a2))?.pausedBy).toBe("admin");
    expect((await post(`/owners/agents/${a2}/resume`, owner)).status).toBe(409);
    expect((await post(`/admin/agents/${a2}/resume`, admin)).status).toBe(200);
  });
});
