// measure.mjs — batching trial measurement rig, ported from the LOD
// trial's protocol (same server, same headless SwiftShader Chromium,
// same poses, same settled-plateau rule) with three adaptations the
// current main forced, all verified by diag.mjs:
//   1. The settled spawn view on current main is ~18k draw calls (the
//      resident's ~9k primitives in both passes), not the LOD era's
//      single early read of 1,694. Every pose here is read to a true
//      plateau (two consecutive identical reads) — the LOD orbit
//      figure was one presenting snapshot, ours is settled.
//   2. A live CDP screencast starves page.evaluate at this scene
//      weight (frames take tens of seconds; the encoder keeps the
//      main thread saturated). So: all counter reads happen WITHOUT
//      screencast; frame time comes from an in-page rAF-delta sampler;
//      the screencast runs only in a final fixed window at P1 for the
//      film (third-person pose held, H.264, frame count reported).
//   3. Evaluate races are 90 s (diag: evaluates land the moment the
//      main thread frees; 45 s was too tight at 18k calls).
// Poses: ORBIT = spawn view before any teleport; P1 = teleport
// (14, 2.2, 46), the LOD trial's settled pose. Census mode adds a
// hide-diff at P1 (in-scope hidden, then doors hidden).
// Usage: node measure.mjs <name> <none|census|merge|cells|both> <assetGlbPath>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../dist");
const WC = "/home/hatch/workspace/.build-tmp/world-compress/node_modules";
const { chromium } = createRequire(WC + "/package.json")("playwright-core");
const [name, mode, assetPath] = process.argv.slice(2);
const outDir = path.join(HERE, "runs", name);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });

const distAsset = path.join(DIST, "assets/world-city3.glb");
fs.copyFileSync(assetPath, distAsset);
const assetBytes = fs.statSync(distAsset).size;
const assetSha = crypto.createHash("sha256").update(fs.readFileSync(distAsset)).digest("hex");
console.log(`asset -> dist: ${assetBytes} bytes sha256 ${assetSha}`);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ktx2": "application/octet-stream", ".bin": "application/octet-stream", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const served = [];
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(DIST, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/" || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, "index.html");
  const size = fs.statSync(p).size;
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store", "Content-Length": size });
  fs.createReadStream(p).pipe(res);
  served.push({ path: url.pathname, bytes: size });
});
await new Promise((r) => server.listen(8903, "127.0.0.1", r));

const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
const timed = async (p, ms = 90000) => Promise.race([
  p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, err: String(e).slice(0, 120) })),
  new Promise((res) => setTimeout(() => res({ ok: false, err: "race-timeout" }), ms)),
]);

const batchQuery = mode === "none" ? "" : `&batch=${mode}`;
const url = `http://127.0.0.1:8903/?tiles=0&streamDebug=1${batchQuery}`;
console.log("goto", url);
await page.goto(url, { waitUntil: "load", timeout: 120000 });

let presenting = null;
for (let i = 0; i < 40 && !presenting; i++) {
  const r = await timed(page.evaluate(() => window.__city3Stream ? window.__city3Stream.snapshot().render : null), 30000);
  if (r.ok && r.v && r.v.triangles > 50000) presenting = r.v;
  else await new Promise((s) => setTimeout(s, 2000));
}
console.log("presenting:", JSON.stringify(presenting));
if (!presenting) { console.error("never presented"); process.exit(1); }

// In-page frame-time sampler: rAF deltas (ms), harvested per phase.
await timed(page.evaluate(() => {
  const w = window;
  w.__frameDeltas = [];
  let last = performance.now();
  const loop = (t) => {
    w.__frameDeltas.push(Math.round(t - last));
    last = t;
    if (w.__frameDeltas.length > 400) w.__frameDeltas.splice(0, w.__frameDeltas.length - 400);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return "sampler-ok";
}), 30000);
const harvestDeltas = async () => {
  const r = await timed(page.evaluate(() => { const d = window.__frameDeltas; window.__frameDeltas = []; return d; }), 30000);
  return r.ok ? r.v : [];
};
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

const snapExpr = () => {
  const w = window;
  const snap = w.__city3Stream.snapshot();
  const out = {
    calls: snap.render.calls, tris: snap.render.triangles,
    geometries: snap.memory.geometries, textures: snap.memory.textures,
    interiors: snap.drawCallsInteriors, built: snap.built,
    batch: null,
  };
  if (w.__bazaarBatch) out.batch = { census: w.__bazaarBatch.census(), stats: w.__bazaarBatch.stats };
  return out;
};

async function settle(label, maxReads = 16) {
  const reads = [];
  let timeouts = 0;
  for (let i = 0; i < maxReads && timeouts < 8; i++) {
    await new Promise((s) => setTimeout(s, 5000));
    const warm = await timed(page.evaluate(() => 1 + 1), 90000);
    if (!warm.ok) { timeouts++; console.log(label, "warm timeout", timeouts); continue; }
    const r = await timed(page.evaluate(snapExpr), 90000);
    if (r.ok && r.v) {
      reads.push(r.v);
      timeouts = 0;
      console.log(label, "read", reads.length, JSON.stringify({ calls: r.v.calls, tris: r.v.tris, interiors: r.v.interiors }));
      const n = reads.length;
      if (n >= 2 && reads[n - 1].calls === reads[n - 2].calls && reads[n - 1].tris === reads[n - 2].tris) break;
    } else { timeouts++; console.log(label, "read timeout", timeouts); }
  }
  const plateaued = reads.length >= 2 && reads[reads.length - 1].calls === reads[reads.length - 2].calls && reads[reads.length - 1].tris === reads[reads.length - 2].tris;
  return { reads, plateau: reads[reads.length - 1] ?? null, plateaued };
}

const orbit = await settle("orbit");
const orbitDeltas = await harvestDeltas();
console.log("ORBIT plateau:", JSON.stringify(orbit.plateau && { calls: orbit.plateau.calls, tris: orbit.plateau.tris }), "plateaued:", orbit.plateaued, "frameDeltas:", orbitDeltas.length);

const tp = await timed(page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp-ok"; }), 60000);
console.log("teleport:", JSON.stringify(tp));
// Guard against a stale plateau: renderer.info describes the last
// rendered frame, and the first post-teleport frame can lag the
// settle's first reads (observed live in the cells re-run: the P1
// settle "plateaued" on the orbit frame). Give the first P1 frame
// time to land before reading.
await new Promise((s) => setTimeout(s, 30000));
const p1 = await settle("p1");
const p1Deltas = await harvestDeltas();
console.log("P1 plateau:", JSON.stringify(p1.plateau && { calls: p1.plateau.calls, tris: p1.plateau.tris }), "plateaued:", p1.plateaued, "frameDeltas:", p1Deltas.length);

// Liveness proof for batch modes: renderer.info counters describe
// the LAST RENDERED frame, and on this build frames can stop at a
// static pose — two identical reads might be one stale frame, not a
// plateau. Toggling door visibility MUST move the counters if
// frames are flowing; restoring must bring them back. The restored
// settle is the reported P1 plateau for batch modes.
let livenessProof = null;
let p1Reported = p1.plateau;
if (mode !== "none" && p1.plateau) {
  const hd = await timed(page.evaluate(() => window.__bazaarBatch.hideDoors()), 60000);
  console.log("liveness hideDoors:", JSON.stringify(hd));
  const nodoors = await settle("p1-liveness-nodoors", 8);
  await timed(page.evaluate(() => window.__bazaarBatch.showAll()), 60000);
  const restored = await settle("p1-liveness-restored", 8);
  livenessProof = { nodoors: nodoors.plateau, restored: restored.plateau, nodoorsPlateaued: nodoors.plateaued, restoredPlateaued: restored.plateaued };
  if (restored.plateau) p1Reported = restored.plateau;
  console.log("liveness:", JSON.stringify(livenessProof));
  await harvestDeltas();
}
// P1 screenshot (works only when frames flow; failure is evidence too).
try {
  const cdpShot = await ctx.newCDPSession(page);
  const shot = await timed(cdpShot.send("Page.captureScreenshot", { format: "jpeg", quality: 60 }), 60000);
  if (shot.ok) { fs.writeFileSync(path.join(outDir, "p1.jpg"), Buffer.from(shot.v.data, "base64")); console.log("p1.jpg:", Buffer.from(shot.v.data, "base64").length, "bytes"); }
  else console.log("p1.jpg: capture failed:", shot.err);
} catch (e) { console.log("p1.jpg: capture threw", String(e).slice(0, 100)); }

let hideDiff = null;
if (mode === "census" && p1.plateau) {
  hideDiff = {};
  const n1 = await timed(page.evaluate(() => window.__bazaarBatch.hideInScope()), 60000);
  console.log("hideInScope:", JSON.stringify(n1));
  hideDiff.afterHideInScope = (await settle("p1-noinscope", 8)).plateau;
  await timed(page.evaluate(() => window.__bazaarBatch.showAll()), 60000);
  const n2 = await timed(page.evaluate(() => window.__bazaarBatch.hideDoors()), 60000);
  console.log("hideDoors:", JSON.stringify(n2));
  hideDiff.afterHideDoors = (await settle("p1-nodoors", 8)).plateau;
  await timed(page.evaluate(() => window.__bazaarBatch.showAll()), 60000);
  await harvestDeltas();
}

// Film is a separate pass (film.mjs): on current main the renderer
// emits no frames at a static pose (verified: screencast 0 frames in
// 210 s, captureScreenshot x3 all 120 s timeouts at P1), so filming
// needs the sway-cam window film.mjs runs. Counters here are
// film-free and identical across variants.
const frames = [];
const duration = 0;
const probe = null;

const glbServed = served.filter((s) => s.path.endsWith(".glb"));
const meta = {
  run: name, mode,
  asset: { path: assetPath, bytes: assetBytes, sha256: assetSha },
  viewport: { width: 640, height: 360 },
  presenting,
  orbit: { plateau: orbit.plateau, plateaued: orbit.plateaued, reads: orbit.reads.length },
  p1: { plateau: p1.plateau, plateaued: p1.plateaued, reads: p1.reads.length },
  p1Reported,
  livenessProof,
  hideDiff,
  glbServedBytes: glbServed, glbServedTotal: glbServed.reduce((a, g) => a + g.bytes, 0),
  frameTime: {
    orbitMedianMs: median(orbitDeltas), orbitSamples: orbitDeltas.length,
    p1MedianMs: median(p1Deltas), p1Samples: p1Deltas.length,
    filmCapturedFrames: frames.length, filmDurationS: +duration.toFixed(2),
    filmFps: duration > 0 ? +(frames.length / duration).toFixed(3) : 0,
  },
  film: probe,
  pageErrors: pageErrors.slice(0, 5),
};
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
console.log("META", JSON.stringify({ orbit: meta.orbit.plateau && meta.orbit.plateau.calls, p1: meta.p1Reported && meta.p1Reported.calls, frames: frames.length, glbTotal: meta.glbServedTotal }));
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
