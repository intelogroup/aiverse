// rig.mjs — LOD trial measurement rig (watchdog-bounded; see TRIAL-NOTES).
// Serves the console build (apps/console/dist), drives the REAL console
// world view (/?tiles=0&streamDebug=1) in headless Chromium (SwiftShader),
// flies ONE fixed camera path through the bazaar via the console's own
// __city3Stream.teleport, samples renderer.info per rendered frame
// (page-side rAF sampler), and records CDP screencast frames -> H.264 MP4.
//
// Every CDP call is raced against a short timeout and a global watchdog
// finalizes artifacts from whatever state exists: on this shared-CPU box a
// frame takes seconds and long-lived processes get culled, so no step may
// wait indefinitely.
//
// Usage: node rig.mjs <baseline|lod> <assetGlbPath>
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

const [name, assetPath] = process.argv.slice(2);
if (!name || !assetPath) { console.error("usage: node rig.mjs <baseline|lod> <assetGlbPath>"); process.exit(2); }
const lodMode = name === "lod";
const outDir = path.join(HERE, "runs", name);
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
const VIEWPORT = { width: 640, height: 360 };

const state = { samples: [], frames: [], served: [], pageErrors: [], lodCount: null, readyMs: null, finalized: false };

// ---------- finalize (idempotent; called by the normal path AND watchdog) ----------
function finalize(note) {
  if (state.finalized) return;
  state.finalized = true;
  const frames = [...state.frames].sort((a, b) => a.ts - b.ts);
  const duration = frames.length > 1 ? frames[frames.length - 1].ts - frames[0].ts : 0;
  const fps = duration > 0 ? frames.length / duration : 0;
  let probe = null;
  const filmPath = path.join(outDir, "film.mp4");
  try {
    if (frames.length) {
      let concat = "";
      for (let i = 0; i < frames.length; i++) {
        const d = i + 1 < frames.length ? frames[i + 1].ts - frames[i].ts : (duration / Math.max(1, frames.length - 1)) || 0.1;
        concat += `file '${frames[i].file}'\nduration ${Math.max(0.01, d).toFixed(4)}\n`;
      }
      concat += `file '${frames[frames.length - 1].file}'\n`;
      fs.writeFileSync(path.join(outDir, "concat.txt"), concat);
      execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(outDir, "concat.txt"), "-vsync", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", filmPath], { stdio: "inherit", timeout: 120000 });
      probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames,duration", "-of", "json", filmPath], { encoding: "utf8" }));
    }
  } catch (e) { console.error("encode failed:", String(e).slice(0, 200)); }
  const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
  const samples = state.samples;
  const glbServed = state.served.filter((s) => s.path.endsWith(".glb"));
  const meta = {
    run: name, lodMode, note,
    asset: { path: assetPath, bytes: state.assetBytes, sha256: state.assetSha },
    viewport: VIEWPORT, path: PATH, totalSecs: TOTAL_SECS, lodCount: state.lodCount, readyMs: state.readyMs,
    samples: samples.length,
    drawCalls: { mean: +mean(samples.map((s) => s.calls)).toFixed(1), peak: Math.max(0, ...samples.map((s) => s.calls)) },
    triangles: { mean: Math.round(mean(samples.map((s) => s.tris))), peak: Math.max(0, ...samples.map((s) => s.tris)) },
    glbServedBytes: glbServed, glbServedTotal: glbServed.reduce((a, g) => a + g.bytes, 0),
    film: { capturedFrames: frames.length, captureDurationS: +duration.toFixed(2), capturedFps: +fps.toFixed(2), probe },
    pageErrors: state.pageErrors.slice(0, 5),
  };
  fs.writeFileSync(path.join(outDir, "samples.json"), JSON.stringify(samples, null, 1));
  fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
  console.log("FINALIZED", JSON.stringify({ samples: meta.samples, drawCalls: meta.drawCalls, triangles: meta.triangles, film: meta.film.capturedFrames + " frames @ " + meta.film.capturedFps + " fps", glbTotal: meta.glbServedTotal }));
}
setTimeout(() => { console.error("WATCHDOG: finalizing from current state"); finalize("watchdog"); process.exit(0); }, 20 * 60 * 1000);

// ---------- camera path (identical for every run) ----------
// Eye-level (y=2.2) walk through the bazaar at a constant 5.75 m/s.
// teleport() aims the controls target at (x, 0, z-20): view toward -z,
// pitched ~6 deg down. CameraCollider (wide mode) may displace the camera
// slightly; conditions are identical across runs.
const PATH = [
  { from: [14, 2.2, 46], to: [14, 2.2, -46], secs: 16 },
  { from: [14, 2.2, -46], to: [-30, 2.2, -46], secs: 8 },
  { from: [-30, 2.2, -46], to: [-30, 2.2, 30], secs: 13 },
];
const TOTAL_SECS = PATH.reduce((a, s) => a + s.secs, 0);
function pathAt(t) {
  let acc = 0;
  for (const s of PATH) {
    if (t <= acc + s.secs) { const k = (t - acc) / s.secs; return s.from.map((v, i) => v + (s.to[i] - v) * k); }
    acc += s.secs;
  }
  return PATH[PATH.length - 1].to;
}
const race = (p, ms) => Promise.race([p.catch(() => null), new Promise((r) => setTimeout(() => r(null), ms))]);

// ---------- asset swap (dist is build output; git never sees this) ----------
const distAsset = path.join(DIST, "assets/world-city3.glb");
fs.copyFileSync(assetPath, distAsset);
state.assetBytes = fs.statSync(distAsset).size;
state.assetSha = crypto.createHash("sha256").update(fs.readFileSync(distAsset)).digest("hex");
console.log(`asset -> dist: ${state.assetBytes} bytes sha256 ${state.assetSha}`);

// ---------- static server (ground-truth request log) ----------
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ktx2": "application/octet-stream", ".bin": "application/octet-stream", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(DIST, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/" || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, "index.html");
  const size = fs.statSync(p).size;
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store", "Content-Length": size });
  fs.createReadStream(p).pipe(res);
  state.served.push({ path: url.pathname, bytes: size });
});
await new Promise((r) => server.listen(8901, "127.0.0.1", r));

// ---------- browser ----------
const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const ctx = await browser.newContext({ viewport: VIEWPORT, serviceWorkers: "block" });
const page = await ctx.newPage();
page.on("pageerror", (e) => state.pageErrors.push(String(e).slice(0, 200)));
const cdp = await ctx.newCDPSession(page);
cdp.on("Page.screencastFrame", async (e) => {
  const file = path.join(outDir, "frames", `f${String(state.frames.length).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(e.data, "base64"));
  state.frames.push({ file, ts: e.metadata.timestamp });
  try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch {}
});

const url = `http://127.0.0.1:8901/?tiles=0&streamDebug=1${lodMode ? "&lod=1" : ""}`;
console.log("goto", url);
await page.goto(url, { waitUntil: "load", timeout: 120000 });

// ---------- readiness: world presenting ----------
const t0 = Date.now();
while (Date.now() - t0 < 240000) {
  const s = await race(page.evaluate(() => {
    const w = window;
    if (!w.__city3Stream) return null;
    const snap = w.__city3Stream.snapshot();
    return { calls: snap.render.calls, tris: snap.render.triangles, lodCount: w.__bazaarLod ? w.__bazaarLod.count : null };
  }), 10000);
  if (s && s.tris > 50000) {
    state.readyMs = Date.now() - t0;
    state.lodCount = s.lodCount;
    console.log("world presenting:", JSON.stringify(s), "after", (state.readyMs / 1000).toFixed(1), "s");
    break;
  }
  await new Promise((r) => setTimeout(r, 1000));
}
if (state.readyMs === null) { console.error("world never presented"); finalize("never-presented"); process.exit(1); }
if (lodMode && state.lodCount === null) console.error("WARNING: LOD MODE but __bazaarLod missing!");
await new Promise((r) => setTimeout(r, 6000)); // settle, identical both runs

// ---------- pose sequence (the fixed camera path, sampled at rest) ----------
// Frames on this CPU-emulated GPU take 5-40 s and interior-streaming builds
// dominate any moving capture, so a moving-path fps/sample series is noise.
// The path's poses are instead held one by one until renderer.info is
// stable across consecutive reads (streaming settled): deterministic,
// exactly comparable counters per pose. The screencast still records the
// whole session as the run's film (fps reported as rig-bound, both runs).
await race(cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: VIEWPORT.width, maxHeight: VIEWPORT.height, everyNthFrame: 1 }), 10000);
const ALL_POSES = [
  { id: "P1", pos: [14, 2.2, 46] },
  { id: "P2", pos: [14, 2.2, 0] },
  { id: "P3", pos: [14, 2.2, -46] },
  { id: "P4", pos: [-30, 2.2, -46] },
  { id: "P5", pos: [-30, 2.2, 30] },
];
const POSES = process.env.RIG_POSES ? ALL_POSES.filter((p) => process.env.RIG_POSES.split(",").includes(p.id)) : ALL_POSES;
const readSnap = () => race(page.evaluate(() => {
  const w = window;
  const snap = w.__city3Stream.snapshot();
  return { calls: snap.render.calls, tris: snap.render.triangles, geometries: snap.memory.geometries, textures: snap.memory.textures, lodHist: w.__bazaarLod ? w.__bazaarLod.histogram() : null, census: w.__bazaarLod && w.__bazaarLod.census ? w.__bazaarLod.census() : null };
}), 15000);
const same = (a, b) => a && b && a.calls === b.calls && a.tris === b.tris;
// Dwell protocol: teleport once, then sample IN-PAGE for the whole dwell
// (one long-lived evaluate per 120 s batch — CDP round trips per read lose
// to this box's main-thread stalls; an in-page timer resumes in the same
// gaps a fresh evaluate would need, at 1/24th the CDP cost). Interiors
// stream in over minutes; the settled read is the plateau at the end of
// the dwell (last two reads equal => plateau flag).
const DWELL_MS = Number(process.env.RIG_DWELL_MS || 600000);
const readBatch = (batchSecs) => race(page.evaluate((secs) => new Promise((resolve) => {
  const w = window;
  const out = [];
  const t0 = performance.now();
  const tick = () => {
    try {
      const snap = w.__city3Stream.snapshot();
      out.push({ calls: snap.render.calls, tris: snap.render.triangles, geometries: snap.memory.geometries, textures: snap.memory.textures, lodHist: w.__bazaarLod ? w.__bazaarLod.histogram() : null, census: w.__bazaarLod && w.__bazaarLod.census ? w.__bazaarLod.census() : null });
    } catch {}
    if ((performance.now() - t0) / 1000 < secs) setTimeout(tick, 5000);
    else resolve(out);
  };
  tick();
}), batchSecs * 1000 + 60000);
for (const pose of POSES) {
  await race(page.evaluate(([px, py, pz]) => { window.__city3Stream.teleport(px, py, pz); }, pose.pos), 5000);
  const reads = [];
  const dwellStart = Date.now();
  while (Date.now() - dwellStart < DWELL_MS) {
    const batch = await readBatch(120);
    if (batch && batch.length) {
      for (const s of batch) { reads.push({ dtS: Math.round((Date.now() - dwellStart) / 1000), ...s }); }
      console.log("pose", pose.id, "batch reads:", batch.length, "last:", JSON.stringify(batch[batch.length - 1]));
    } else console.log("pose", pose.id, "batch produced nothing");
  }
  const last = reads[reads.length - 1] || null;
  const plateau = reads.length >= 2 && same(reads[reads.length - 1], reads[reads.length - 2]);
  fs.writeFileSync(path.join(outDir, `reads-${pose.id}.json`), JSON.stringify(reads, null, 1));
  if (last) {
    state.samples.push({ pose: pose.id, pos: pose.pos, reads: reads.length, plateau, ...last });
    console.log("pose", pose.id, "FINAL", JSON.stringify(last), "plateau:", plateau);
  } else console.error("pose", pose.id, "produced no read");
}
await race(cdp.send("Page.stopScreencast"), 5000);
finalize("complete");
await race(browser.close(), 10000);
server.close();
process.exit(0);
