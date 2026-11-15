// measure.mjs — single-pose A/B measurement (the protocol the diagnostic
// proved works on this box): load the real console, teleport to P1
// (14, 2.2, 46) — segment A's start pose on the trial camera path — then
// take snapshot reads in the first responsive window after the teleport
// (the main thread wedges minutes later under interior-streaming builds;
// the settled P1 counters appear in the first successful reads and were
// reproduced twice within 0.25% on the baseline side).
// Usage: node measure.mjs <baseline|lod> <assetGlbPath>
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
const lodMode = name === "lod";
const outDir = path.join(HERE, "runs", name + "-p1");
fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(path.join(outDir, "frames"), { recursive: true });

// asset swap (dist is build output only)
const distAsset = path.join(DIST, "assets/world-city3.glb");
fs.copyFileSync(assetPath, distAsset);
const assetBytes = fs.statSync(distAsset).size;
const assetSha = crypto.createHash("sha256").update(fs.readFileSync(distAsset)).digest("hex");

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
await new Promise((r) => server.listen(8901, "127.0.0.1", r));

const exe = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1243/chrome-headless-shell-linux64/chrome-headless-shell";
const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"] });
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: "block" });
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => pageErrors.push(String(e).slice(0, 160)));
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async (e) => {
  const file = path.join(outDir, "frames", `f${String(frames.length).padStart(5, "0")}.jpg`);
  fs.writeFileSync(file, Buffer.from(e.data, "base64"));
  frames.push({ file, ts: e.metadata.timestamp });
  try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch {}
});
const timed = async (p, ms) => {
  const r = await Promise.race([p.then((v) => ({ ok: true, v })).catch((e) => ({ ok: false, err: String(e).slice(0, 120) })), new Promise((res) => setTimeout(() => res({ ok: false, err: "race-timeout" }), ms))]);
  return r;
};

const url = `http://127.0.0.1:8901/?tiles=0&streamDebug=1${lodMode ? "&lod=1" : ""}`;
await page.goto(url, { waitUntil: "load", timeout: 120000 });
let presenting = null;
for (let i = 0; i < 40 && !presenting; i++) {
  const r = await timed(page.evaluate(() => window.__city3Stream ? window.__city3Stream.snapshot().render : null), 20000);
  if (r.ok && r.v && r.v.triangles > 50000) presenting = r.v;
  else await new Promise((s) => setTimeout(s, 2000));
}
console.log("presenting:", JSON.stringify(presenting));
if (!presenting) { console.error("never presented"); process.exit(1); }
await timed(cdp.send("Page.startScreencast", { format: "jpeg", quality: 60, maxWidth: 640, maxHeight: 360, everyNthFrame: 1 }), 10000);

const tp = await timed(page.evaluate(() => { window.__city3Stream.teleport(14, 2.2, 46); return "tp-ok"; }), 30000);
console.log("teleport:", JSON.stringify(tp));
const reads = [];
let lodCount = null;
let timeouts = 0;
// Diagnostic-proved pattern: a trivial evaluate first (it lands in the
// responsive window's gaps); the snapshot evaluate follows immediately.
for (let i = 0; i < 10 && timeouts < 4; i++) {
  await new Promise((s) => setTimeout(s, 6000));
  const warm = await timed(page.evaluate(() => 1 + 1), 45000);
  if (!warm.ok) { timeouts++; console.log("warm timeout", timeouts); continue; }
  const r = await timed(page.evaluate(() => {
    const w = window;
    const snap = w.__city3Stream.snapshot();
    return { calls: snap.render.calls, tris: snap.render.triangles, geometries: snap.memory.geometries, textures: snap.memory.textures, lodCount: w.__bazaarLod ? w.__bazaarLod.count : null, lodHist: w.__bazaarLod ? w.__bazaarLod.histogram() : null, census: w.__bazaarLod && w.__bazaarLod.census ? w.__bazaarLod.census() : null };
  }), 45000);
  if (r.ok && r.v) { reads.push(r.v); lodCount = r.v.lodCount; timeouts = 0; console.log("read", reads.length, JSON.stringify(r.v)); }
  else { timeouts++; console.log("read timeout", timeouts); }
}
await timed(cdp.send("Page.stopScreencast"), 5000);

// film encode (1:1 frames, VFR)
frames.sort((a, b) => a.ts - b.ts);
const duration = frames.length > 1 ? frames[frames.length - 1].ts - frames[0].ts : 0;
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

const glbServed = served.filter((s) => s.path.endsWith(".glb"));
const meta = {
  run: name, lodMode, pose: { id: "P1", pos: [14, 2.2, 46] },
  asset: { path: assetPath, bytes: assetBytes, sha256: assetSha },
  viewport: { width: 640, height: 360 },
  presenting, reads, lodCount,
  glbServedBytes: glbServed, glbServedTotal: glbServed.reduce((a, g) => a + g.bytes, 0),
  film: { capturedFrames: frames.length, captureDurationS: +duration.toFixed(2), capturedFps: duration > 0 ? +(frames.length / duration).toFixed(2) : 0, probe },
  pageErrors: pageErrors.slice(0, 5),
};
fs.writeFileSync(path.join(outDir, "meta.json"), JSON.stringify(meta, null, 1));
console.log("META", JSON.stringify({ reads: reads.length, lodCount, glbTotal: meta.glbServedTotal, film: meta.film.capturedFrames }));
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
