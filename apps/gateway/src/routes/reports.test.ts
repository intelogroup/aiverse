import { describe, expect, test } from "bun:test";
import { createApp } from "../app";

const app = createApp();

function uniqueEmail() {
  return `test-${Date.now()}-${Math.random().toString(36).slice(2)}@example.com`;
}

// Falls back to login on 409 so the fixed admin-test@example.com fixture
// (see .env.test ADMIN_EMAILS) works across repeated local test runs
// against the same aiverse_test DB, not just a fresh one.
async function registerOwner(email: string) {
  const res = await app.request("/owners/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: "password123" }),
  });
  if (res.status === 409) {
    const loginRes = await app.request("/owners/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "password123" }),
    });
    const { token } = await loginRes.json();
    return token as string;
  }
  const { token } = await res.json();
  return token as string;
}

async function createAgent(token: string) {
  const res = await app.request("/owners/agents", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({ name: "ReportTargetAgent", capabilities: [] }),
  });
  const body = await res.json();
  return body.agent.id as string;
}

describe("POST /reports", () => {
  test("unauthenticated request is rejected", async () => {
    const res = await app.request("/reports", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetAgentId: "00000000-0000-0000-0000-000000000000", reason: "spam" }),
    });
    expect(res.status).toBe(401);
  });

  test("missing reason is rejected", async () => {
    const token = await registerOwner(uniqueEmail());
    const res = await app.request("/reports", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ targetAgentId: "00000000-0000-0000-0000-000000000000" }),
    });
    expect(res.status).toBe(400);
  });

  test("owner reports another owner's agent", async () => {
    const reporterToken = await registerOwner(uniqueEmail());
    const targetOwnerToken = await registerOwner(uniqueEmail());
    const targetAgentId = await createAgent(targetOwnerToken);

    const res = await app.request("/reports", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ targetAgentId, reason: "spamming public rooms" }),
    });
    expect(res.status).toBe(201);
    const { report } = await res.json();
    expect(report.targetAgentId).toBe(targetAgentId);
    expect(report.status).toBe("open");
  });
});

describe("admin report review", () => {
  test("non-admin owner cannot list reports", async () => {
    const token = await registerOwner(uniqueEmail());
    const res = await app.request("/admin/reports", { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(403);
  });

  test("admin lists and resolves a report", async () => {
    const reporterToken = await registerOwner(uniqueEmail());
    const targetAgentId = await createAgent(reporterToken);
    const adminToken = await registerOwner("admin-test@example.com");

    const createRes = await app.request("/reports", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${reporterToken}` },
      body: JSON.stringify({ targetAgentId, reason: "impersonation" }),
    });
    const { report } = await createRes.json();

    const listRes = await app.request("/admin/reports", { headers: { authorization: `Bearer ${adminToken}` } });
    expect(listRes.status).toBe(200);
    const { reports } = await listRes.json();
    expect(reports.some((r: { id: string }) => r.id === report.id)).toBe(true);

    const resolveRes = await app.request(`/admin/reports/${report.id}/resolve`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${adminToken}` },
      body: JSON.stringify({ status: "dismissed" }),
    });
    expect(resolveRes.status).toBe(200);
    const { report: resolved } = await resolveRes.json();
    expect(resolved.status).toBe("dismissed");

    const listAfterRes = await app.request("/admin/reports", { headers: { authorization: `Bearer ${adminToken}` } });
    const { reports: openAfter } = await listAfterRes.json();
    expect(openAfter.some((r: { id: string }) => r.id === report.id)).toBe(false);
  });
});
