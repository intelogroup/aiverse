import { expect, test } from "bun:test";
import { TtlCache } from "./authCache";

const clock = () => { let t = 1000; return { now: () => t, tick: (ms: number) => { t += ms; } }; };

test("a hit does not load again until the ttl passes", async () => {
  const c = clock(), cache = new TtlCache<{ id: string }>(() => 15_000, c.now);
  let loads = 0;
  const load = async () => { loads++; return { id: "a" }; };
  await cache.get("k", load); await cache.get("k", load); await cache.get("k", load);
  expect(loads).toBe(1);
  c.tick(14_999); await cache.get("k", load);
  expect(loads).toBe(1);
  c.tick(2); await cache.get("k", load);
  expect(loads).toBe(2);
});

test("a missing row is not cached: the next call reads again", async () => {
  const cache = new TtlCache<{ id: string }>();
  let loads = 0;
  const load = async () => { loads++; return undefined; };
  await cache.get("k", load); await cache.get("k", load);
  expect(loads).toBe(2);
});

test("concurrent misses share one load", async () => {
  const cache = new TtlCache<{ id: string }>();
  let loads = 0;
  const load = async () => { loads++; await Bun.sleep(5); return { id: "a" }; };
  const rows = await Promise.all(Array.from({ length: 50 }, () => cache.get("k", load)));
  expect(loads).toBe(1);
  expect(rows.every((r) => r?.id === "a")).toBe(true);
});

test("delete and deleteWhere evict at once", async () => {
  const cache = new TtlCache<{ id: string }>();
  cache.set("h1", { id: "a" }); cache.set("h2", { id: "a" }); cache.set("h3", { id: "b" });
  cache.deleteWhere((v) => v.id === "a");
  expect(cache.peek("h1")).toBeUndefined();
  expect(cache.peek("h2")).toBeUndefined();
  expect(cache.peek("h3")?.id).toBe("b");
  cache.delete("h3");
  expect(cache.peek("h3")).toBeUndefined();
});

test("a ttl of 0 turns the cache off", async () => {
  const cache = new TtlCache<{ id: string }>(() => 0);
  let loads = 0;
  const load = async () => { loads++; return { id: "a" }; };
  await cache.get("k", load); await cache.get("k", load);
  expect(loads).toBe(2);
});

test("a failed load is not cached and does not poison the next call", async () => {
  const cache = new TtlCache<{ id: string }>();
  let n = 0;
  const load = async () => { if (n++ === 0) throw new Error("db down"); return { id: "a" }; };
  await expect(cache.get("k", load)).rejects.toThrow("db down");
  expect((await cache.get("k", load))?.id).toBe("a");
});
