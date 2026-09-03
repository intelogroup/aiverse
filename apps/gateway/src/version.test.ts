import { describe, expect, test } from "bun:test";
import { createApp } from "./app";

const app = createApp();

describe("GET /version", () => {
  test("reports version, gitSha, branch, environment", async () => {
    const res = await app.request("/version");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty("version");
    expect(body).toHaveProperty("gitSha");
    expect(body).toHaveProperty("branch");
    expect(body).toHaveProperty("environment");
  });
});
