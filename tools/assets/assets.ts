/**
 * Public world GLBs, recorded in assets.lock.json and fetched from R2.
 *
 *   bun tools/assets/assets.ts lock                    rewrite the lock from the tracked GLBs
 *   bun tools/assets/assets.ts check [--remote]        files (and R2 objects) match the lock
 *   bun tools/assets/assets.ts pull [--force] [--root DIR]
 *   bun tools/assets/assets.ts missing                 "path<TAB>key" for each file R2 lacks
 *
 * Keys are `glbs/<sha256[0:16]>/<basename>`, the same ones the R2 release workflow uploads. They come
 * from the lock's own hash, never from staged-assets.json, which can name older bytes.
 * Downloads are anonymous. Nothing here uploads; .github/workflows/assets-publish.yml does.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

export type Lock = Record<string, { sha256: string; size: number }>;

const REPO = resolve(import.meta.dir, "../..");
const LOCK = join(REPO, "assets.lock.json");
const TRACKED = "apps/console/public/assets/*.glb";
const BASE = process.env.ASSET_BASE || "https://assets.aiverse.network";
const HEADERS = { "User-Agent": "assets-pull" };

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
export const keyFor = (path: string, hash: string) => `glbs/${hash.slice(0, 16)}/${basename(path)}`;
const localHash = (file: string) => (existsSync(file) ? sha256(readFileSync(file)) : null);

async function pool<T>(items: T[], size: number, work: (item: T) => Promise<void>) {
  const queue = [...items];
  await Promise.all(Array.from({ length: size }, async () => {
    for (let item = queue.shift(); item !== undefined; item = queue.shift()) await work(item);
  }));
}

/** One retry for network errors and 5xx; a 404 is an answer. */
async function request(url: string, method: "GET" | "HEAD"): Promise<{ res: Response; body: Uint8Array }> {
  for (let attempt = 1; ; attempt++) {
    try {
      const res = await fetch(url, { method, headers: HEADERS, signal: AbortSignal.timeout(180_000) });
      if (res.status >= 500) throw new Error(`HTTP ${res.status}`);
      return { res, body: new Uint8Array(await res.arrayBuffer()) };
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

export async function pull(lock: Lock, root: string, base: string, force = false) {
  const done = { fetched: 0, skipped: 0, failed: [] as string[] };
  await pool(Object.entries(lock), 5, async ([path, want]) => {
    const file = join(root, path);
    const have = localHash(file);
    if (have === want.sha256) return void done.skipped++;
    if (have && !force) return void done.failed.push(`${path}: local file differs from the lock (--force overwrites it)`);
    try {
      const { res, body } = await request(`${base}/${keyFor(path, want.sha256)}`, "GET");
      if (!res.ok) return void done.failed.push(`${path}: HTTP ${res.status}`);
      if (sha256(body) !== want.sha256) return void done.failed.push(`${path}: downloaded bytes do not match the lock`);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(`${file}.part`, body);
      renameSync(`${file}.part`, file);
      done.fetched++;
    } catch (error) {
      done.failed.push(`${path}: ${error instanceof Error ? error.message : error}`);
    }
  });
  done.failed.sort();
  return done;
}

export async function check(lock: Lock, root: string, base?: string) {
  const failed: string[] = [];
  await pool(Object.entries(lock), 8, async ([path, want]) => {
    const have = localHash(join(root, path));
    if (have !== want.sha256) failed.push(`${path}: ${have ? "differs from the lock" : "missing"}`);
    if (!base) return;
    try {
      const { res } = await request(`${base}/${keyFor(path, want.sha256)}`, "HEAD");
      if (!res.ok) failed.push(`${path}: not on R2 (HTTP ${res.status})`);
      else if (Number(res.headers.get("content-length")) !== want.size) failed.push(`${path}: R2 size differs`);
    } catch (error) {
      failed.push(`${path}: ${error instanceof Error ? error.message : error}`);
    }
  });
  return failed.sort();
}

/** What an upload has to send. Only a 404 counts as absent; any other answer stops the run. */
export async function missing(lock: Lock, base: string) {
  const out: string[] = [];
  await pool(Object.entries(lock), 8, async ([path, want]) => {
    const { res } = await request(`${base}/${keyFor(path, want.sha256)}`, "HEAD");
    if (res.status === 404) out.push(`${path}\t${keyFor(path, want.sha256)}`);
    else if (!res.ok) throw new Error(`${path}: HTTP ${res.status}`);
  });
  return out.sort();
}

function tracked(): string[] {
  const git = Bun.spawnSync(["git", "ls-files", "-z", "--", TRACKED], { cwd: REPO });
  if (git.exitCode !== 0) throw new Error("git ls-files failed");
  return git.stdout.toString().split("\0").filter(Boolean).sort();
}

function writeLock() {
  const lock: Lock = {};
  for (const path of tracked()) {
    const bytes = readFileSync(join(REPO, path));
    lock[path] = { sha256: sha256(bytes), size: bytes.length };
  }
  writeFileSync(LOCK, JSON.stringify(lock, null, 2) + "\n");
  console.log(`locked ${Object.keys(lock).length} files`);
}

/** staged-assets.json is what the running app asks R2 for; report where it names other bytes. */
function stagedDrift(lock: Lock): string[] {
  const staged: Record<string, string> = JSON.parse(readFileSync(join(REPO, "apps/console/src/lib/staged-assets.json"), "utf8"));
  return Object.entries(lock)
    .filter(([path, { sha256: hash }]) => staged[basename(path)] && staged[basename(path)] !== keyFor(path, hash))
    .map(([path]) => path);
}

async function main(argv: string[]) {
  const [command] = argv;
  const flag = (name: string) => argv.includes(name);
  if (command === "lock") return writeLock();
  if (command === "missing") {
    const lock: Lock = JSON.parse(readFileSync(LOCK, "utf8"));
    for (const line of await missing(lock, BASE)) console.log(line);
    return;
  }
  if (command !== "check" && command !== "pull") throw new Error("usage: assets.ts lock | missing | check [--remote] | pull [--force] [--root DIR]");
  const lock: Lock = JSON.parse(readFileSync(LOCK, "utf8"));
  const at = argv.indexOf("--root");
  if (at >= 0 && !argv[at + 1]) throw new Error("--root needs a directory");
  const root = at >= 0 ? resolve(argv[at + 1]) : REPO;
  let failed: string[];
  if (command === "pull") {
    const done = await pull(lock, root, BASE, flag("--force"));
    console.log(`fetched ${done.fetched}, already correct ${done.skipped}, failed ${done.failed.length}`);
    failed = done.failed;
  } else {
    failed = await check(lock, root, flag("--remote") ? BASE : undefined);
    if (root === REPO) {
      failed.push(...tracked().filter((path) => !lock[path]).map((path) => `${path}: tracked but not in the lock`));
      for (const path of stagedDrift(lock)) console.warn(`warning: staged-assets.json names older bytes for ${path}`);
    }
    console.log(`checked ${Object.keys(lock).length} files, ${failed.length} problems`);
  }
  for (const line of failed) console.error(line);
  if (failed.length) process.exit(1);
}

if (import.meta.main) await main(process.argv.slice(2));
