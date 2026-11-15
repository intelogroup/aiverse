// diag.mjs — what happens to evaluates + the view after a teleport?
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../dist");
const WC = "/home/hatch/workspace/.build-tmp/world-compress/node_modules";
const { chromium } = createRequire(WC + "/package.json")("playwright-core");
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ktx2": "application/octet-stream", ".bin": "application/octet-stream", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(DIST, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/" || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store", "Content-Length": fs.statSync(p).size });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8902, "127.0.0.1", r));
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(String(e).slice(0, 160)));
const timed = async (label, p, ms) => {
  const t = Date.now();
  const r = await Promise.race([p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, err: String(e).slice(0, 120) })), new Promise((res) => setTimeout(() => res({ ok: false, err: "race-timeout" }), ms))]);
  console.log(label, "->", r.ok ? JSON.stringify(r.v)?.slice(0, 160) : "FAIL " + r.err, `(${Date.now() - t} ms)`);
  return r;
};
await page.goto("http://127.0.0.1:8902/?tiles=0&streamDebug=1&lod=1", { waitUntil: "load", timeout: 120000 });
// readiness
for (let i = 0; i < 40; i++) {
  const r = await timed(`present-poll ${i}`, page.evaluate(() => window.__city3Stream ? ({...window.__city3Stream.snapshot().render, lodCount: window.__bazaarLod?.count ?? null, hist: window.__bazaarLod?.histogram() ?? null, census: window.__bazaarLod?.census() ?? null}) : null), 20000);
  if (r.ok && r.v && r.v.triangles > 50000) break;
  await new Promise((s) => setTimeout(s, 2000));
}
await timed("trivial 1+1 (pre-teleport)", page.evaluate(() => 1 + 1), 30000);
await timed("teleport P1", page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp-ok"; }), 30000);
for (let i = 0; i < 6; i++) {
  await new Promise((s) => setTimeout(s, 10000));
  await timed(`trivial ${i} (post-teleport)`, page.evaluate(() => 1 + 1), 45000);
  await timed(`snapshot ${i}`, page.evaluate(() => ({...window.__city3Stream.snapshot().render, lodCount: window.__bazaarLod?.count ?? null, hist: window.__bazaarLod?.histogram() ?? null, census: window.__bazaarLod?.census() ?? null})), 45000);
}
console.log("pageErrors:", errors.slice(0, 5));
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
