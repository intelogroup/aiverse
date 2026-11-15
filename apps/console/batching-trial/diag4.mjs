// diag4.mjs — is the merge-mode P1 plateau a genuine P1 frame?
// Sequence: merge mode -> presenting -> teleport P1 -> reads ->
// __bazaarBatch.dispose() (restores originals, removes merged) ->
// reads. If post-dispose counters move toward baseline P1 (~8,948),
// frames render at P1 and the merge plateau was a real P1 frame.
// If they stay at the merge plateau, no frame rendered after the
// teleport and the plateau was the carried-over orbit frame.
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
await new Promise((r) => server.listen(8908, "127.0.0.1", r));
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const timed = async (label, p, ms = 90000) => {
  const r = await Promise.race([p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, err: String(e).slice(0, 120) })), new Promise((res) => setTimeout(() => res({ ok: false, err: "race-timeout" }), ms))]);
  console.log(label, "->", r.ok ? JSON.stringify(r.v)?.slice(0, 160) : "FAIL " + r.err);
  return r;
};
await page.goto("http://127.0.0.1:8908/?tiles=0&streamDebug=1&batch=merge", { waitUntil: "load", timeout: 120000 });
let presenting = null;
for (let i = 0; i < 40 && !presenting; i++) {
  const r = await timed(`snap ${i}`, page.evaluate(() => window.__city3Stream ? window.__city3Stream.snapshot().render : null), 30000);
  if (r.ok && r.v && r.v.triangles > 50000) presenting = r.v;
  else await new Promise((s) => setTimeout(s, 2000));
}
console.log("presenting:", JSON.stringify(presenting));
await timed("teleport", page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp"; }), 90000);
const snap = () => page.evaluate(() => { const s = window.__city3Stream.snapshot(); return { calls: s.render.calls, tris: s.render.triangles, geos: s.memory.geometries }; });
for (let i = 0; i < 3; i++) { await new Promise((s) => setTimeout(s, 8000)); await timed(`p1 read ${i}`, snap()); }
await timed("dispose", page.evaluate(() => { window.__bazaarBatch.dispose(); return "disposed"; }), 90000);
for (let i = 0; i < 4; i++) { await new Promise((s) => setTimeout(s, 8000)); await timed(`post-dispose read ${i}`, snap()); }
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
