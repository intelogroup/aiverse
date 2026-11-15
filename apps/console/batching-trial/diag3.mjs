// diag3.mjs — isolate what wakes the frame loop on current main.
// Order mirrors the LOD trial's measure.mjs exactly: screencast
// starts immediately after goto (before presenting), pointer wiggle
// after teleport. Plus the sway interval. Everything logged.
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
await new Promise((r) => server.listen(8907, "127.0.0.1", r));
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const timed = async (label, p, ms = 90000) => {
  const t = Date.now();
  const r = await Promise.race([p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, err: String(e).slice(0, 120) })), new Promise((res) => setTimeout(() => res({ ok: false, err: "race-timeout" }), ms))]);
  console.log(label, "->", r.ok ? "ok" : "FAIL " + r.err, `(${Math.round((Date.now() - t) / 1000)}s)`);
  return r;
};
await page.goto("http://127.0.0.1:8907/?tiles=0&streamDebug=1", { waitUntil: "load", timeout: 120000 });
const cdp = await ctx.newCDPSession(page);
let castFrames = 0;
cdp.on("Page.screencastFrame", async (e) => { castFrames++; try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch {} });
await timed("startScreencast (early)", cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 360, everyNthFrame: 1 }), 90000);
let presenting = null;
for (let i = 0; i < 40 && !presenting; i++) {
  const r = await timed(`snap ${i}`, page.evaluate(() => window.__city3Stream ? window.__city3Stream.snapshot().render : null), 30000);
  if (r.ok && r.v && r.v.triangles > 50000) presenting = r.v;
  else await new Promise((s) => setTimeout(s, 2000));
}
console.log("presenting:", JSON.stringify(presenting), "castFrames so far:", castFrames);
await timed("install sampler", page.evaluate(() => {
  const w = window;
  w.__frameDeltas = [];
  let last = performance.now();
  const loop = (t) => { w.__frameDeltas.push(Math.round(t - last)); last = t; requestAnimationFrame(loop); };
  requestAnimationFrame(loop);
  return "sampler-ok";
}), 90000);
await timed("teleport", page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp"; }), 90000);
await timed("mouse wiggle", (async () => { await page.mouse.move(320, 180); await page.mouse.move(330, 190); return "wiggled"; })(), 60000);
for (let k = 0; k < 4; k++) {
  await new Promise((s) => setTimeout(s, 30000));
  const r = await timed(`poll ${k}`, page.evaluate(() => { const s = window.__city3Stream.snapshot(); return { calls: s.render.calls, tris: s.render.triangles, deltas: window.__frameDeltas ? window.__frameDeltas.length : -1 }; }), 60000);
  console.log("  castFrames:", castFrames, "poll:", r.ok ? JSON.stringify(r.v) : r.err);
}
await timed("stopScreencast", cdp.send("Page.stopScreencast"), 15000);
console.log("FINAL castFrames:", castFrames);
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
