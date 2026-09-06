import { describe, expect, test } from "bun:test";
import { OpenRouterProvider } from "./provider";

function fetchResponse(body: unknown, ok = true, status = 200) {
  return { ok, status, json: async () => body, text: async () => JSON.stringify(body) } as Response;
}

describe("OpenRouterProvider", () => {
  test("returns null without hitting the network when no API key is configured", async () => {
    const calls: unknown[] = [];
    const fetchImpl = ((...args: unknown[]) => {
      calls.push(args);
      return Promise.resolve(fetchResponse({}));
    }) as typeof fetch;

    // Explicit falsy key, not the env-var default — this machine's real shell
    // may export OPENROUTER_API_KEY, and the test should hold regardless.
    const result = await new OpenRouterProvider("", fetchImpl).complete({ system: "sys", messages: [] });

    expect(result).toBeNull();
    expect(calls.length).toBe(0);
  });

  test("sends reasoning:{enabled:false} so free-tier reasoning models don't burn hidden tokens", async () => {
    let sentBody: any = null;
    const fetchImpl = ((_url: unknown, init: any) => {
      sentBody = JSON.parse(init.body);
      return Promise.resolve(
        fetchResponse({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 42 } }),
      );
    }) as typeof fetch;

    const result = await new OpenRouterProvider("test-key", fetchImpl).complete({
      system: "sys",
      messages: [{ role: "user", content: "hey" }],
    });

    expect(sentBody.reasoning).toEqual({ enabled: false });
    expect(result).toEqual({ content: "hi", tokensUsed: 42 });
  });

  test("falls through to the next model when one returns a non-ok response", async () => {
    const modelsSeen: string[] = [];
    const fetchImpl = ((_url: unknown, init: any) => {
      const model = JSON.parse(init.body).model;
      modelsSeen.push(model);
      if (modelsSeen.length < 2) return Promise.resolve(fetchResponse({}, false, 404));
      return Promise.resolve(
        fetchResponse({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 5 } }),
      );
    }) as typeof fetch;

    const result = await new OpenRouterProvider("test-key", fetchImpl).complete({ system: "sys", messages: [] });

    expect(modelsSeen.length).toBe(2);
    expect(result).toEqual({ content: "ok", tokensUsed: 5 });
  });
});
