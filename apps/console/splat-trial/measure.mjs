// measure.mjs — splat-in-verse load test rig.
// Protocol transplanted from the batching trial's measure.mjs (same
// static server pattern, same headless SwiftShader Chromium 640x360,
// same poses, same settled-plateau rule: two consecutive identical
// renderer.info reads), adapted:
//   - puppeteer-core + /opt/meta-chromium/chrome (the ms-playwright
//     headless shell cache was wiped with .build-tmp).
//   - URL: /?tiles=0&streamDebug=1&districtDebug=1 + &splat=<mode>.
//     districtDebug adds window.__districts.cam() for the fixed IN/OUT
//     poses; it changes no rendering.
//   - Poses: ORBIT = settled spawn view (batching-comparable);
//     P1 = teleport (14, 2.2, 46) (LOD/batching pose — the splat at
//     (14, 0, 33) sits dead centre in it);
//     IN  = camera (14, 2.0, 41.5) looking at the stall (14, 1.1, 33);
//     OUT = same camera position looking away (+z) — same scene
//     position, splat out of frame.
//   - Frame time from an in-page rAF-delta sampler (a live CDP
//     screencast starves page.evaluate at this scene weight).
//   - Splats staged into dist/splat-trial/ before serving (the PLY
//     files live in the trial dir, per the brief).
// Usage: node measure.mjs <name> <splat-mode|none> <distDir> [port]
//   splat-mode: none | 262k | 1m   (262k == ?splat=1, 1m == ?splat=1m)
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { chromium } = createRequire(path.join(HERE, "package.json"))("playwright-core");
const [name, splatMode, distArg, portArg] = process.argv.slice(2);
const DIST = path.resolve(distArg || path.join(HERE, "../dist"));
const PORT = Number(portArg || 8911);
const outDir = path.join(HERE, "runs", name);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });

const TRIAL = path.resolve(HERE);
const stagedDir = path.join(DIST, "splat-trial");
fs.mkdirSync(stagedDir, { recursive: true });
for (const f of ["bazaar-stall-262k.ply", "bazaar-stall-1m.ply", "bazaar-stall-262k.spz"]) {
  fs.copyFileSync(path.join(TRIAL, f), path.join(stagedDir, f));
}
const stagedBytes = fs.statSync(path.join(stagedDir, "bazaar-stall-262k.ply")).size;
console.log(`staged splat PLYs -> dist/splat-trial/ (262k: ${stagedBytes} B)`);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ktx2": "application/octet-stream", ".bin": "application/octet-stream", ".woff2": "font/woff2", ".ico": "image/x-icon", ".ply": "application/octet-stream" };
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
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const browser = await chromium.launch({
  executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows",
    "--disable-renderer-backgrounding", "--enable-precise-memory-info"],
});
const VW = Number(process.env.VIEW_W || 640), VH = Number(process.env.VIEW_H || 360);
const ctx = await browser.newContext({ viewport: { width: VW, height: VH }, serviceWorkers: "block" });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 200)));
page.on("console", (m) => { if (m.type() === "error") pageErrors.push("console: " + m.text().slice(0, 200)); });
const timed = async (p, ms = 90000) => Promise.race([
  p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, err: String(e).slice(0, 120) })),
  new Promise((res) => setTimeout(() => res({ ok: false, err: "race-timeout" }), ms)),
]);
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);

const splatQuery = splatMode === "none" ? "" : `&splat=${splatMode === "262k" ? "1" : splatMode}`;
const url = `http://127.0.0.1:${PORT}/?tiles=0&streamDebug=1&districtDebug=1${splatQuery}`;
console.log("goto", url);
await page.goto(url, { waitUntil: "load", timeout: 120000 });

// WebGPU environment probe (independent of Spark — the compatible
// Spark line is WebGL2-only; this records what the machine offers).
const webgpu = await timed(page.evaluate(async () => {
  if (!("gpu" in navigator)) return { present: false };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { present: true, adapter: null };
    const info = adapter.info || {};
    return { present: true, adapter: { vendor: info.vendor, device: info.device, architecture: info.architecture, description: info.description } };
  } catch (e) { return { present: true, error: String(e).slice(0, 120) }; }
}), 60000);
console.log("webgpu:", JSON.stringify(webgpu));

let presenting = null;
for (let i = 0; i < 40 && !presenting; i++) {
  const r = await timed(page.evaluate(() => window.__city3Stream ? window.__city3Stream.snapshot().render : null), 30000);
  if (r.ok && r.v && r.v.triangles > 50000) presenting = r.v;
  else await new Promise((s) => setTimeout(s, 2000));
}
console.log("presenting:", JSON.stringify(presenting));
if (!presenting) { console.error("never presented"); process.exit(1); }

// Splat readiness (262k/1m only): __splatTrial from SplatTrial.tsx.
let splat = null;
if (splatMode !== "none") {
  for (let i = 0; i < 40 && !splat; i++) {
    const r = await timed(page.evaluate(() => window.__splatTrial ?? null), 90000);
    if (r.ok && r.v && (r.v.state === "ready" || r.v.state === "error")) splat = r.v;
    else await new Promise((s) => setTimeout(s, 5000));
  }
  console.log("splat:", JSON.stringify(splat));
}

// In-page rAF-delta sampler.
await timed(page.evaluate(() => {
  window.__frameDeltas = [];
  let last = performance.now();
  const loop = (t) => {
    window.__frameDeltas.push(Math.round(t - last));
    last = t;
    if (window.__frameDeltas.length > 400) window.__frameDeltas.splice(0, window.__frameDeltas.length - 400);
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
  return "sampler-ok";
}), 30000);
const harvestDeltas = async () => {
  const r = await timed(page.evaluate(() => { const d = window.__frameDeltas; window.__frameDeltas = []; return d; }), 240000);
  return r.ok ? r.v : [];
};
const heap = async () => {
  const r = await timed(page.evaluate(() => (performance.memory ? { usedJSHeapSize: performance.memory.usedJSHeapSize, totalJSHeapSize: performance.memory.totalJSHeapSize } : null)), 240000);
  return r.ok ? r.v : null;
};

const snapExpr = () => {
  const w = window;
  const snap = w.__city3Stream.snapshot();
  return {
    calls: snap.render.calls, tris: snap.render.triangles,
    geometries: snap.memory.geometries, textures: snap.memory.textures,
    interiors: snap.drawCallsInteriors, built: snap.built,
  };
};
async function settle(label, maxReads = 16) {
  const reads = [];
  let timeouts = 0;
  for (let i = 0; i < maxReads && timeouts < 8; i++) {
    await new Promise((s) => setTimeout(s, 5000));
    const warm = await timed(page.evaluate(() => 1 + 1), 90000);
    if (!warm.ok) { timeouts++; console.log(label, "warm timeout", timeouts); continue; }
    const r = await timed(page.evaluate(snapExpr), 240000);
    if (r.ok && r.v) {
      reads.push(r.v);
      timeouts = 0;
      console.log(label, "read", reads.length, JSON.stringify({ calls: r.v.calls, tris: r.v.tris }));
      const n = reads.length;
      if (n >= 2 && reads[n - 1].calls === reads[n - 2].calls && reads[n - 1].tris === reads[n - 2].tris) break;
    } else { timeouts++; console.log(label, "read timeout", timeouts); }
  }
  const plateaued = reads.length >= 2 && reads[reads.length - 1].calls === reads[reads.length - 2].calls && reads[reads.length - 1].tris === reads[reads.length - 2].tris;
  return { reads, plateau: reads[reads.length - 1] ?? null, plateaued };
}
const pose = async (label, px, py, pz, tx, ty, tz) => {
  const r = await timed(page.evaluate((p) => window.__districts.cam(p.pos, p.tgt), { pos: [px, py, pz], tgt: [tx, ty, tz] }), 60000);
  console.log(label, "cam:", JSON.stringify(r));
  // Same long-soak discipline as P1 (see above): wait out the
  // frame-production stall before settling.
  const soakT0 = Date.now();
  let free = false;
  while (Date.now() - soakT0 < 600000 && !free) {
    const q = await timed(page.evaluate(() => 1 + 1), 240000);
    free = q.ok;
    console.log(label, "soak poll:", free ? "thread free" : "still blocked", Math.round((Date.now() - soakT0) / 1000), "s");
    if (!free) await new Promise((s) => setTimeout(s, 10000));
  }
};

const POSES = (process.env.POSES || "orbit,p1,in,out").split(",");
const orbit = await settle("orbit");
const orbitDeltas = await harvestDeltas();
const orbitHeap = await heap();
console.log("ORBIT plateau:", JSON.stringify(orbit.plateau), "plateaued:", orbit.plateaued, "frameDeltas:", orbitDeltas.length, "heap:", JSON.stringify(orbitHeap));

let p1 = { plateau: null, plateaued: false, reads: [] }, p1Deltas = [], p1Heap = null;
let inPose = { plateau: null, plateaued: false, reads: [] }, inDeltas = [], inHeap = null, shotBytes = null;
let outPose = { plateau: null, plateaued: false, reads: [] }, outDeltas = [], outHeap = null;
if (POSES.includes("p1")) {
const tp = await timed(page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp-ok"; }), 60000);
console.log("teleport P1:", JSON.stringify(tp));
// Long soak after the teleport: on stock main the P1 area stalls
// frame production for many minutes (interior streaming + bakes —
// the batching trial's "no frames at static P1" wall). Poll a
// trivial evaluate until the main thread frees before settling.
{
  const soakT0 = Date.now();
  let free = false;
  while (Date.now() - soakT0 < 900000 && !free) {
    const r = await timed(page.evaluate(() => 1 + 1), 240000);
    free = r.ok;
    console.log("p1 soak poll:", free ? "thread free" : "still blocked", Math.round((Date.now() - soakT0) / 1000), "s");
    if (!free) await new Promise((s) => setTimeout(s, 10000));
  }
}
p1 = await settle("p1");
p1Deltas = await harvestDeltas();
p1Heap = await heap();
console.log("P1 plateau:", JSON.stringify(p1.plateau), "plateaued:", p1.plateaued, "frameDeltas:", p1Deltas.length, "heap:", JSON.stringify(p1Heap));
}

// IN / OUT poses around the stall (14, 0, 33).
if (POSES.includes("in")) {
await pose("IN", 14, 2.0, 41.5, 14, 1.1, 33);
inPose = await settle("in");
inDeltas = await harvestDeltas();
inHeap = await heap();
console.log("IN plateau:", JSON.stringify(inPose.plateau), "plateaued:", inPose.plateaued, "frameDeltas:", inDeltas.length, "heap:", JSON.stringify(inHeap));
try {
  const cdp = await ctx.newCDPSession(page);
  const shot = await timed(cdp.send("Page.captureScreenshot", { format: "jpeg", quality: 70 }), 60000);
  if (shot.ok) {
    const buf = Buffer.from(shot.v.data, "base64");
    fs.writeFileSync(path.join(outDir, "in.jpg"), buf);
    shotBytes = buf.length;
    console.log("in.jpg:", shotBytes, "bytes");
  } else console.log("in.jpg: capture failed:", shot.err);
} catch (e) { console.log("in.jpg: capture threw", String(e).slice(0, 100)); }
}

if (POSES.includes("out")) {
await pose("OUT", 14, 2.0, 41.5, 14, 1.1, 60);
outPose = await settle("out");
outDeltas = await harvestDeltas();
outHeap = await heap();
console.log("OUT plateau:", JSON.stringify(outPose.plateau), "plateaued:", outPose.plateaued, "frameDeltas:", outDeltas.length, "heap:", JSON.stringify(outHeap));
}

const plyServed = served.filter((s) => s.path.includes("splat-trial"));
const meta = {
  run: name, splatMode,
  viewport: { width: VW, height: VH },
  webgpu: webgpu.ok ? webgpu.v : { error: webgpu.err },
  presenting, splat,
  orbit: { plateau: orbit.plateau, plateaued: orbit.plateaued, reads: orbit.reads.length, frameMedianMs: median(orbitDeltas), frameSamples: orbitDeltas.length, heap: orbitHeap },
  p1: { plateau: p1.plateau, plateaued: p1.plateaued, reads: p1.reads.length, frameMedianMs: median(p1Deltas), frameSamples: p1Deltas.length, heap: p1Heap },
  in: { plateau: inPose.plateau, plateaued: inPose.plateaued, reads: inPose.reads.length, frameMedianMs: median(inDeltas), frameSamples: inDeltas.length, heap: inHeap, shotBytes },
  out: { plateau: outPose.plateau, plateaued: outPose.plateaued, reads: outPose.reads.length, frameMedianMs: median(outDeltas), frameSamples: outDeltas.length, heap: outHeap },
  plyServed, plyServedTotal: plyServed.reduce((a, g) => a + g.bytes, 0),
  pageErrors: pageErrors.slice(0, 8),
};
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
console.log("META", JSON.stringify({ orbit: meta.orbit.plateau?.calls, p1: meta.p1.plateau?.calls, in: meta.in.plateau?.calls, out: meta.out.plateau?.calls, splat }));
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
