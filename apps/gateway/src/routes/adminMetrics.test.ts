import { describe, expect, test } from "bun:test";
import { createApp } from "../app";
import { recordStatus, statusWindow } from "../util/metrics";
import type { SimClient } from "../world/simClient";

const json = (b: unknown, status = 200) => Response.json(b, { status });
const SIM_STATS = { windowS: 60, bodies: 3, maxBodies: 200, tick: { budgetMs: 50, n: 10, p50: 4, p99: 9, max: 12 } };
const simWith = (answer: () => Promise<Response>): SimClient => ({ call: answer });

// admin-test@example.com is the .env.test ADMIN_EMAILS fixture (same as admin.test.ts).
async function token(email: string) {
  const app = createApp();
  const body = JSON.stringify({ email, password: "password123" });
  const headers = { "content-type": "application/json" };
  const res = await app.request("/owners/register", { method: "POST", headers, body });
  const r = res.status === 409 ? await app.request("/owners/login", { method: "POST", headers, body }) : res;
  return ((await r.json()) as { token: string }).token;
}

const get = (app: ReturnType<typeof createApp>, t?: string) =>
  app.request("/admin/metrics", { headers: t ? { authorization: `Bearer ${t}` } : {} });

describe("GET /admin/metrics", () => {
  test("401 without a token, 403 for a non-admin owner", async () => {
    const app = createApp({ sim: simWith(async () => json(SIM_STATS)) });
    expect((await get(app)).status).toBe(401);
    expect((await get(app, await token(`metrics-${Date.now()}@example.com`))).status).toBe(403);
  });

  test("admin gets gateway numbers and the proxied sim stats", async () => {
    let path = "";
    const app = createApp({ sim: simWith(async () => ((path = "hit"), json(SIM_STATS))) });
    const res = await get(app, await token("admin-test@example.com"));
    expect(res.status).toBe(200);
    const b = (await res.json()) as any;
    expect(path).toBe("hit");
    expect(b.sim).toEqual(SIM_STATS);
    expect(b.gateway.rssMb).toBeGreaterThan(0);
    expect(b.gateway.requests.total).toBeGreaterThan(0); // the register/login calls above
  });

  test("sim down or erroring -> sim: \"unreachable\", gateway part still served", async () => {
    const t = await token("admin-test@example.com");
    for (const answer of [async () => { throw new Error("timeout"); }, async () => json({ error: "x" }, 500)]) {
      const b = (await (await get(createApp({ sim: simWith(answer) }), t)).json()) as any;
      expect(b.sim).toBe("unreachable");
      expect(typeof b.gateway.uptimeS).toBe("number");
    }
  });
});

describe("status window", () => {
  test("counts by class and ages out after 60 s", () => {
    const t0 = 10_000_000;
    [200, 204, 404, 429, 503].forEach((s) => recordStatus(s, t0));
    expect(statusWindow(t0)).toMatchObject({ "2xx": 2, "4xx": 2, "5xx": 1, total: 5 });
    expect(statusWindow(t0 + 60_000).total).toBe(0);
  });
});
