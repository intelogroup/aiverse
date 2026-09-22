import { afterEach, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { clientIp } from "./clientIp";

const app = new Hono().get("/ip", (c) => c.text(clientIp(c)));
const ip = async (headers: Record<string, string>) => (await app.request("/ip", { headers })).text();

const originalRender = process.env.RENDER;
afterEach(() => {
  if (originalRender === undefined) delete process.env.RENDER;
  else process.env.RENDER = originalRender;
});

describe("clientIp", () => {
  test("ignores a client-spoofed leftmost x-forwarded-for entry", async () => {
    delete process.env.RENDER;
    expect(await ip({ "x-forwarded-for": "6.6.6.6, 203.0.113.9" })).toBe("203.0.113.9");
  });

  test("on Render, uses cf-connecting-ip and ignores x-forwarded-for", async () => {
    process.env.RENDER = "true";
    expect(
      await ip({ "cf-connecting-ip": "198.51.100.7", "x-forwarded-for": "6.6.6.6, 198.51.100.7, 172.70.0.1" }),
    ).toBe("198.51.100.7");
  });

  test("on Render without cf-connecting-ip, does not fall back to spoofable x-forwarded-for", async () => {
    process.env.RENDER = "true";
    expect(await ip({ "x-forwarded-for": "6.6.6.6" })).toBe("unknown");
  });

  test("no headers yields unknown", async () => {
    delete process.env.RENDER;
    expect(await ip({})).toBe("unknown");
  });
});
