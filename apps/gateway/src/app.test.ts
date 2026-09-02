import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

describe("health", () => {
  test("GET /health pings DB and Redis, returns ok when both are up", async () => {
    const app = createApp();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ status: "ok", db: "ok", redis: "ok" });
  });
});
