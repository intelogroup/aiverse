// diag2.mjs — does Page.captureScreenshot produce real frames at P1
// on current main (where screencast produced none)?
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
await new Promise((r) => server.listen(8905, "127.0.0.1", r));
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const timed = async (p, ms = 90000) => Promise.race([p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, err: String(e).slice(0, 120) })), new Promise((res) => setTimeout(() => res({ ok: false, err: "race-timeout" }), ms))]);
await page.goto("http://127.0.0.1:8905/?tiles=0&streamDebug=1", { waitUntil: "load", timeout: 120000 });
let presenting = null;
for (let i = 0; i < 40 && !presenting; i++) {
  const r = await timed(page.evaluate(() => window.__city3Stream ? window.__city3Stream.snapshot().render : null), 30000);
  if (r.ok && r.v && r.v.triangles > 50000) presenting = r.v;
  else await new Promise((s) => setTimeout(s, 2000));
}
console.log("presenting:", JSON.stringify(presenting));
await timed(page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp"; }), 60000);
await new Promise((s) => setTimeout(s, 60000));
const snap = await timed(page.evaluate(() => window.__city3Stream.snapshot().render), 90000);
console.log("at P1:", JSON.stringify(snap.v ?? snap.err));
const cdp = await ctx.newCDPSession(page);
for (let i = 0; i < 3; i++) {
  const t = Date.now();
  const shot = await timed(cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }), 120000);
  const ms = Date.now() - t;
  if (shot.ok) {
    const bytes = Buffer.from(shot.v.data, "base64");
    fs.writeFileSync(path.join(HERE, `diag2-shot${i}.jpg`), bytes);
    console.log(`shot ${i}: ${ms} ms, ${bytes.length} bytes`);
  } else console.log(`shot ${i}: FAIL ${shot.err} after ${ms} ms`);
}
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
