import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { check, keyFor, missing, pull, type Lock } from "./assets";

const entry = (text: string) => ({ sha256: createHash("sha256").update(text).digest("hex"), size: text.length });
const served = new Map<string, string>();
const server = Bun.serve({
  port: 0,
  fetch: (req) => {
    const body = served.get(new URL(req.url).pathname.slice(1));
    return body === undefined ? new Response("no", { status: 404 }) : new Response(body);
  },
});
const base = `http://localhost:${server.port}`;
const root = mkdtempSync(join(tmpdir(), "assets-"));
afterAll(() => { server.stop(true); rmSync(root, { recursive: true, force: true }); });

const lock: Lock = { "a/good.glb": entry("good"), "a/gone.glb": entry("gone"), "a/bad.glb": entry("bad") };
served.set(keyFor("a/good.glb", lock["a/good.glb"].sha256), "good");
served.set(keyFor("a/bad.glb", lock["a/bad.glb"].sha256), "tampered");

test("keys match the R2 release workflow", () => {
  expect(keyFor("x/y/w.glb", "0123456789abcdef0000")).toBe("glbs/0123456789abcdef/w.glb");
});

test("pull writes verified files and names the rest", async () => {
  const done = await pull(lock, root, base);
  expect(done.fetched).toBe(1);
  expect(done.failed).toEqual(["a/bad.glb: downloaded bytes do not match the lock", "a/gone.glb: HTTP 404"]);
  expect(readFileSync(join(root, "a/good.glb"), "utf8")).toBe("good");
  expect(existsSync(join(root, "a/bad.glb"))).toBe(false);
});

test("a correct file is skipped; a local edit survives without --force", async () => {
  const one: Lock = { "a/good.glb": lock["a/good.glb"] };
  expect((await pull(one, root, base)).skipped).toBe(1);
  writeFileSync(join(root, "a/good.glb"), "edited");
  expect((await pull(one, root, base)).failed[0]).toContain("--force");
  expect(readFileSync(join(root, "a/good.glb"), "utf8")).toBe("edited");
  expect((await pull(one, root, base, true)).fetched).toBe(1);
  expect(readFileSync(join(root, "a/good.glb"), "utf8")).toBe("good");
});

test("check reports local and remote problems", async () => {
  mkdirSync(join(root, "a"), { recursive: true });
  writeFileSync(join(root, "a/gone.glb"), "gone");
  const some: Lock = { "a/good.glb": lock["a/good.glb"], "a/gone.glb": lock["a/gone.glb"] };
  expect(await check(some, root)).toEqual([]);
  expect(await check(some, root, base)).toEqual(["a/gone.glb: not on R2 (HTTP 404)"]);
});

test("missing lists only what the store answers 404 for", async () => {
  const want = [`a/gone.glb\t${keyFor("a/gone.glb", lock["a/gone.glb"].sha256)}`];
  expect(await missing({ "a/good.glb": lock["a/good.glb"], "a/gone.glb": lock["a/gone.glb"] }, base)).toEqual(want);
});
