// film.mjs — INSTANCING trial film pass, adapted from the batching trial's
// film.mjs v2 (same capture discipline; repointed modules/chromium; port 8916;
// modes: none | both | both-inst | inst). Original header follows:
// film.mjs — film + frame-time pass for one variant, v2.
// What the probes established on current main (0636bcc):
//   - At a static pose the renderer emits no frames (screencast
//     0/210 s at P1; captureScreenshot x3 120 s timeouts; rAF 0).
//   - Frames DO flow while state changes (load-in, streaming,
//     teleport): the baseline measure run's rAF sampler collected
//     samples at spawn (median ~9.7 s/frame under SwiftShader).
//   - A screencast started AFTER settling never starts (CDP call
//     itself times out); started immediately after goto it returns
//     OK at once — but its encode load then starves page.evaluate,
//     so this pass issues almost no evaluates: presenting poll
//     (long races), ONE teleport, then a pure wait.
// The film is therefore the load-in + spawn hold + teleport flight
// to P1 + P1 hold, exactly as the page produces frames; frame
// timestamps are the screencast metadata (real per-frame times).
// Usage: node film.mjs <name> <none|census|merge|cells|both> <assetGlbPath>
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(HERE, "../dist");
const WC = "/home/hatch/workspace/businto/node_modules";
const { chromium } = createRequire(WC + "/package.json")("playwright-core");
const [name, mode, assetPath] = process.argv.slice(2);
const outDir = path.join(HERE, "runs", name);
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });
for (const f of fs.readdirSync(path.join(outDir, "frames"))) fs.rmSync(path.join(outDir, "frames", f));

fs.mkdirSync(path.join(DIST, "assets"), { recursive: true });
const distAsset = path.join(DIST, "assets/world-city3.glb");
fs.copyFileSync(assetPath, distAsset);
const assetBytes = fs.statSync(distAsset).size;
const assetSha = crypto.createHash("sha256").update(fs.readFileSync(distAsset)).digest("hex");
console.log(`asset -> dist: ${assetBytes} bytes sha256 ${assetSha}`);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ktx2": "application/octet-stream", ".bin": "application/octet-stream", ".woff2": "font/woff2", ".ico": "image/x-icon" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(DIST, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/" || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store", "Content-Length": fs.statSync(p).size });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(8916, "127.0.0.1", r));

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

const QUERIES = { none: "", both: "&batch=both", "both-inst": "&batch=both&instance=1", inst: "&instance=1" };
const batchQuery = QUERIES[mode];
if (batchQuery === undefined) { console.error("bad mode", mode); process.exit(2); }
await page.goto(`http://127.0.0.1:8916/?tiles=0&streamDebug=1${batchQuery}`, { waitUntil: "load", timeout: 120000 });

const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async (e) => {
  const file = path.join(outDir, "frames", `f${String(frames.length).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(e.data, "base64"));
  frames.push({ file, ts: e.metadata.timestamp });
  try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch {}
});
const castStart = await timed(cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 360, everyNthFrame: 1 }), 90000);
console.log("screencast start (early):", castStart.ok ? "ok" : castStart.err, "frames so far:", frames.length);

let presenting = null;
for (let i = 0; i < 25 && !presenting; i++) {
  const r = await timed(page.evaluate(() => window.__city3Stream ? window.__city3Stream.snapshot().render : null), 90000);
  if (r.ok && r.v && r.v.triangles > 50000) presenting = r.v;
  else await new Promise((s) => setTimeout(s, 2000));
  if (i % 5 === 4) console.log(`presenting poll ${i}: frames so far ${frames.length}`);
}
console.log("presenting:", JSON.stringify(presenting), "frames so far:", frames.length);

let teleported = false;
if (presenting) {
  const tp = await timed(page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp"; }), 90000);
  teleported = tp.ok;
  console.log("teleport:", teleported ? "ok" : tp.err, "frames so far:", frames.length);
  await page.mouse.move(320, 180).catch(() => {});
}
// Pure capture wait: no evaluates (they starve under screencast).
const HOLD_MS = 240000;
await new Promise((s) => setTimeout(s, HOLD_MS));
console.log("after hold: frames:", frames.length);
await timed(cdp.send("Page.stopScreencast"), 15000);

frames.sort((a, b) => a.ts - b.ts);
const duration = frames.length > 1 ? frames[frames.length - 1].ts - frames[0].ts : 0;
const intervals = [];
for (let i = 1; i < frames.length; i++) intervals.push(Math.round((frames[i].ts - frames[i - 1].ts) * 1000));
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
let probe = null;
try {
  if (frames.length) {
    let concat = "";
    for (let i = 0; i < frames.length; i++) {
      const d = i + 1 < frames.length ? frames[i + 1].ts - frames[i].ts : (duration / Math.max(1, frames.length - 1)) || 0.1;
      concat += `file '${frames[i].file}'\nduration ${Math.max(0.01, d).toFixed(4)}\n`;
    }
    concat += `file '${frames[frames.length - 1].file}'\n`;
    fs.writeFileSync(path.join(outDir, "concat.txt"), concat);
    execFileSync("ffmpeg", ["-y", "-v", "error", "-f", "concat", "-safe", "0", "-i", path.join(outDir, "concat.txt"), "-vsync", "vfr", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", path.join(outDir, "film.mp4")], { stdio: "inherit", timeout: 120000 });
    probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-count_frames", "-select_streams", "v:0", "-show_entries", "stream=codec_name,width,height,nb_read_frames,duration", "-of", "json", path.join(outDir, "film.mp4")], { encoding: "utf8" }));
  }
} catch (e) { console.error("encode failed", String(e).slice(0, 150)); }

const film = {
  run: name, mode, asset: { bytes: assetBytes, sha256: assetSha },
  presenting, teleported,
  capturedFrames: frames.length,
  durationS: +duration.toFixed(2),
  capturedFps: duration > 0 ? +(frames.length / duration).toFixed(3) : 0,
  medianFrameIntervalMs: median(intervals),
  frameIntervalsMs: intervals,
  probe, pageErrors: pageErrors.slice(0, 5),
};
fs.writeFileSync(path.join(outDir, "film.json"), JSON.stringify(film, null, 1));
console.log("FILM", JSON.stringify({ frames: frames.length, medianMs: film.medianFrameIntervalMs, durationS: film.durationS }));
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
