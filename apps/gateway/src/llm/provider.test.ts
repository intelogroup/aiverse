import { describe, expect, test, beforeEach } from "bun:test";
import { OpenRouterProvider, GlobalBudgetProvider, type LLMProvider } from "./provider";
import { redis } from "../redis/client";
import { resetMemoryStoreForTests } from "../policy/memoryStore";

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

  test("disables reasoning where allowed (hidden-token burn), low effort where the endpoint makes it mandatory", async () => {
    const bodies: any[] = [];
    const fetchImpl = ((_url: unknown, init: any) => {
      bodies.push(JSON.parse(init.body));
      if (bodies.length === 1) return Promise.resolve(fetchResponse({}, false, 429));
      return Promise.resolve(
        fetchResponse({ choices: [{ message: { content: "hi" } }], usage: { total_tokens: 42 } }),
      );
    }) as typeof fetch;

    const result = await new OpenRouterProvider("test-key", fetchImpl).complete({
      system: "sys",
      messages: [{ role: "user", content: "hey" }],
    });

    // liquid rejects enabled:false with a 400 ("Reasoning is mandatory"), 2026-09-22.
    expect(bodies[0].model).toBe("liquid/lfm-2.5-2.6b:free");
    expect(bodies[0].reasoning).toEqual({ effort: "low" });
    expect(bodies[1].model).toBe("nvidia/nemotron-3-super-120b-a12b:free");
    expect(bodies[1].reasoning).toEqual({ enabled: false });
    expect(result).toEqual({ content: "hi", tokensUsed: 42, model: "nvidia/nemotron-3-super-120b-a12b:free" });
  });

  test("empty content falls through to the next model instead of reading as a silent idle", async () => {
    const modelsSeen: string[] = [];
    const fetchImpl = ((_url: unknown, init: any) => {
      modelsSeen.push(JSON.parse(init.body).model);
      if (modelsSeen.length === 1) {
        return Promise.resolve(fetchResponse({ choices: [{ message: { content: null }, finish_reason: "length" }] }));
      }
      return Promise.resolve(fetchResponse({ choices: [{ message: { content: "ok" } }], usage: { total_tokens: 7 } }));
    }) as typeof fetch;

    const result = await new OpenRouterProvider("test-key", fetchImpl).complete({ system: "sys", messages: [] });

    expect(modelsSeen.length).toBe(2);
    expect(result?.content).toBe("ok");
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
    expect(result).toEqual({ content: "ok", tokensUsed: 5, model: modelsSeen[1] });
  });
});

describe("GlobalBudgetProvider", () => {
  const todayKey = () => `llm:global:${new Date().toISOString().slice(0, 10)}`;
  function countingProvider(tokensUsed: number) {
    const calls = { n: 0 };
    const inner: LLMProvider = {
      complete: async () => {
        calls.n++;
        return { content: "ok", tokensUsed };
      },
    };
    return { inner, calls };
  }

  beforeEach(async () => {
    await resetMemoryStoreForTests();
  });

  test("passes calls through and adds their real token cost to today's shared counter", async () => {
    const { inner, calls } = countingProvider(1200);
    const guarded = new GlobalBudgetProvider(inner, 10_000);
    expect((await guarded.complete({ system: "", messages: [] }))?.content).toBe("ok");
    await guarded.complete({ system: "", messages: [] });
    expect(calls.n).toBe(2);
    expect(Number(await redis.get(todayKey()))).toBe(2400);
  });

  test("once the day's total reaches the cap, returns null without calling the provider", async () => {
    const { inner, calls } = countingProvider(1200);
    const guarded = new GlobalBudgetProvider(inner, 2000);
    await guarded.complete({ system: "", messages: [] }); // 1200 < 2000: allowed
    await guarded.complete({ system: "", messages: [] }); // 1200 < 2000 at check time: allowed, overshoots to 2400
    expect(await guarded.complete({ system: "", messages: [] })).toBeNull(); // 2400 >= 2000: blocked
    expect(calls.n).toBe(2);
  });

  test("cap 0 is a kill switch: no call ever reaches the provider", async () => {
    const { inner, calls } = countingProvider(1);
    expect(await new GlobalBudgetProvider(inner, 0).complete({ system: "", messages: [] })).toBeNull();
    expect(calls.n).toBe(0);
  });
});
