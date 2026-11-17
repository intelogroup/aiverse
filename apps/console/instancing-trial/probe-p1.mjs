// probe-p1.mjs — forced-frame P1 probe for the instancing trial.
// Why this exists: measure.mjs's P1 settle "plateaued" on the stale
// pre-teleport orbit frame in BOTH the (b) and (c) passes of
// 2026-11-16 (frameDeltas 0 post-teleport; the app renders on demand
// and a static pose emits no frames, so renderer.info never updates).
// The batching rig's own answer was the liveness restored settle;
// this probe adds the film pass's trick — a CDP screencast started
// before load, which keeps the compositor producing frames — so
// snapshot reads describe live frames, and it segments screencast
// frame flow by phase (static P1 vs mouse-drag orbit) to design the
// orbit film. Same poses, same two-identical-reads plateau rule,
// same snapshot expression as measure.mjs.
// Usage: node probe-p1.mjs <name> <none|both|both-inst> <consoleDir> <assetGlbPath>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { createRequire } from "node:module";

const [name, mode, consoleDir, assetPath] = process.argv.slice(2);
const DIST = path.resolve(consoleDir, "dist");
const HERE = path.dirname(new URL(import.meta.url).pathname);
const outDir = path.join(HERE, "runs", `probe-${name}`);
fs.mkdirSync(outDir, { recursive: true });
const WC = "/home/hatch/workspace/businto/node_modules";
const { chromium } = createRequire(WC + "/package.json")("playwright-core");

fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
const distAsset = path.join(DIST, "assets/world-city3.glb");
fs.copyFileSync(assetPath, distAsset);
const assetSha = crypto.createHash("sha256").update(fs.readFileSync(distAsset)).digest("hex");
console.log(`asset -> dist: ${fs.statSync(distAsset).size} bytes sha256 ${assetSha}`);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ktx2": "application/octet-stream", ".bin": "application/octet-stream", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(DIST, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/" || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, "index.html");
  const size = fs.statSync(p).size;
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store", "Content-Length": size });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8924, "127.0.0.1", r));

const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
const timed = async (p, ms = 90000) => Promise.race([
  p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, err: String(e).slice(0, 120) })),
  new Promise((res) => setTimeout(() => res({ ok: false, err: "race-timeout" }), ms)),
]);

const QUERIES = { none: "", both: "&batch=both", "both-inst": "&batch=both&instance=1" };
const batchQuery = QUERIES[mode];
if (batchQuery === undefined) { console.error("bad mode", mode); process.exit(2); }
const url = `http://127.0.0.1:8924/?tiles=0&streamDebug=1${batchQuery}`;
console.log("goto", url);
await page.goto(url, { waitUntil: "load", timeout: 120000 });

// Screencast from before load-in completes: forces compositing.
const cdp = await ctx.newCDPSession(page);
const frameTs = [];
cdp.on("Page.screencastFrame", async (e) => {
  frameTs.push(e.metadata.timestamp);
  try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch {}
});
const castStart = await timed(cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 360, everyNthFrame: 1 }), 90000);
console.log("screencast start:", castStart.ok ? "ok" : castStart.err);

let presenting = null;
for (let i = 0; i < 40 && !presenting; i++) {
  const r = await timed(page.evaluate(() => window.__city3Stream ? window.__city3Stream.snapshot().render : null), 30000);
  if (r.ok && r.v && r.v.triangles > 50000) presenting = r.v;
  else await new Promise((s) => setTimeout(s, 2000));
}
console.log("presenting:", JSON.stringify(presenting), "castFrames:", frameTs.length);
if (!presenting) { console.error("never presented"); process.exit(1); }

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
  if (w.__bazaarInstance) out.instance = { census: w.__bazaarInstance.census(), stats: w.__bazaarInstance.stats };
  return out;
};

async function settle(label, maxReads = 12) {
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
  return { reads: reads.length, plateau: reads[reads.length - 1] ?? null, plateaued };
}

const result = { run: name, mode, assetSha, phases: {} };

// ORBIT settle + 30 s frame harvest.
const orbit = await settle("orbit");
await harvestDeltas();
const castOrbitStart = frameTs.length;
await new Promise((s) => setTimeout(s, 30000));
const orbitDeltas = await harvestDeltas();
result.phases.orbit = { plateau: orbit.plateau, plateaued: orbit.plateaued, reads: orbit.reads, deltaMedianMs: median(orbitDeltas), deltaSamples: orbitDeltas.length, castFrames30s: frameTs.length - castOrbitStart };
console.log("ORBIT:", JSON.stringify({ calls: orbit.plateau && orbit.plateau.calls, tris: orbit.plateau && orbit.plateau.tris, plateaued: orbit.plateaued, deltaMedianMs: result.phases.orbit.deltaMedianMs, deltaSamples: orbitDeltas.length, cast30: result.phases.orbit.castFrames30s }));

// Teleport, 30 s guard (rig's rule), count static-P1 cast frames.
const castTpStart = frameTs.length;
const tp = await timed(page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp-ok"; }), 60000);
console.log("teleport:", JSON.stringify(tp));
await new Promise((s) => setTimeout(s, 30000));
result.phases.staticP1CastFrames30s = frameTs.length - castTpStart;
console.log("static P1 cast frames in 30 s:", result.phases.staticP1CastFrames30s);

// P1 settle under screencast.
const p1 = await settle("p1");
result.phases.p1 = { plateau: p1.plateau, plateaued: p1.plateaued, reads: p1.reads };
console.log("P1:", JSON.stringify({ calls: p1.plateau && p1.plateau.calls, tris: p1.plateau && p1.plateau.tris, plateaued: p1.plateaued }));

// Liveness for batch modes (rig's reported-P1 rule).
let p1Reported = p1.plateau;
if ((mode === "both" || mode === "both-inst") && p1.plateau) {
  const hd = await timed(page.evaluate(() => window.__bazaarBatch.hideDoors()), 60000);
  console.log("liveness hideDoors:", JSON.stringify(hd));
  const nodoors = await settle("p1-liveness-nodoors", 8);
  await timed(page.evaluate(() => window.__bazaarBatch.showAll()), 60000);
  const restored = await settle("p1-liveness-restored", 8);
  result.phases.liveness = { nodoors: nodoors.plateau, nodoorsPlateaued: nodoors.plateaued, restored: restored.plateau, restoredPlateaued: restored.plateaued };
  if (restored.plateau) p1Reported = restored.plateau;
  console.log("liveness:", JSON.stringify({ nodoors: nodoors.plateau && nodoors.plateau.calls, restored: restored.plateau && restored.plateau.calls }));
}
result.p1Reported = p1Reported;

// P1 30 s delta harvest (static pose, screencast on).
await harvestDeltas();
const castP1Start = frameTs.length;
await new Promise((s) => setTimeout(s, 30000));
const p1Deltas = await harvestDeltas();
result.phases.p1Harvest = { deltaMedianMs: median(p1Deltas), deltaSamples: p1Deltas.length, castFrames30s: frameTs.length - castP1Start };
console.log("P1 harvest:", JSON.stringify(result.phases.p1Harvest));

// Drag-orbit test: does mouse drag move the camera / force frames?
// (Skipped with SKIP_DRAG=1: in the (c) run the drag phase hung for
// ~9 min against the post-showAll doubled scene and was killed; the
// log up to the harvest is the probe's record for that run.)
const castDragStart = frameTs.length;
if (process.env.SKIP_DRAG) {
  result.phases.drag = { skipped: true };
  result.totalCastFrames = frameTs.length;
  result.pageErrors = pageErrors.slice(0, 5);
  fs.writeFileSync(path.join(outDir, "probe.json"), JSON.stringify(result, null, 1));
  console.log("PROBE DONE (drag skipped)", name);
  await timed(cdp.send("Page.stopScreencast"), 15000);
  await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
  server.close();
  process.exit(0);
}
await harvestDeltas();
try {
  await page.mouse.move(320, 180);
  await page.mouse.down();
  for (let i = 0; i < 60; i++) {
    const a = (i / 60) * Math.PI * 2;
    await page.mouse.move(320 + Math.round(Math.cos(a) * 60), 180 + Math.round(Math.sin(a) * 40));
    await new Promise((s) => setTimeout(s, 500));
  }
  await page.mouse.up();
} catch (e) { console.log("drag threw", String(e).slice(0, 100)); }
const dragDeltas = await harvestDeltas();
result.phases.drag = { castFrames30s: frameTs.length - castDragStart, deltaMedianMs: median(dragDeltas), deltaSamples: dragDeltas.length };
console.log("DRAG:", JSON.stringify(result.phases.drag));
const afterDrag = await timed(page.evaluate(snapExpr), 90000);
result.phases.afterDragRead = afterDrag.ok ? { calls: afterDrag.v.calls, tris: afterDrag.v.tris, interiors: afterDrag.v.interiors } : null;
console.log("after-drag read:", JSON.stringify(result.phases.afterDragRead));

result.totalCastFrames = frameTs.length;
result.pageErrors = pageErrors.slice(0, 5);
fs.writeFileSync(path.join(outDir, "probe.json"), JSON.stringify(result, null, 1));
console.log("PROBE DONE", name, JSON.stringify({ orbit: orbit.plateau && orbit.plateau.calls, p1: p1Reported && p1Reported.calls, cast: frameTs.length }));
await timed(cdp.send("Page.stopScreencast"), 15000);
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
