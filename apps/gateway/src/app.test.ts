import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

describe("health", () => {
  test("GET /health pings DB and Redis, returns ok when both are up", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.status).toBe("ok");
    expect(body.db).toBe("ok");
    expect(body.redis).toBe("ok");
    // native liveness never gates the HTTP status/overall status — see app.ts.
    expect(["active", "stale", "unknown"]).toContain(body.natives);
  });
});
