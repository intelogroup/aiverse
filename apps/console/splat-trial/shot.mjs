// shot.mjs — probe-scene screenshot: empty three scene + one splat
// file (probe.html), wait for load + some rendered frames, then
// capture the canvas. Usage: node shot.mjs <file> <out.jpg> [waitSec] [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { chromium } = require("playwright-core");
const EXE = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";

const file = process.argv[2] || "bazaar-stall-262k.ply";
const out = process.argv[3] || "probe-shot.jpg";
const waitSec = Number(process.argv[4] || 90);
const port = Number(process.argv[5] || 8913);
const trialDir = process.cwd();
const nmRoot = path.join(trialDir, "..", "node_modules");

const MIME = { ".html": "text/html", ".js": "text/javascript", ".ply": "application/octet-stream", ".spz": "application/octet-stream", ".map": "application/json" };
const server = http.createServer((req, res) => {
  const url = decodeURIComponent((req.url || "/").split("?")[0]);
  let filePath = null;
  if (url === "/" || url === "/probe.html") filePath = path.join(trialDir, "probe.html");
  else if (url.startsWith("/nm/")) filePath = path.join(nmRoot, url.slice(4));
  else if (url.startsWith("/files/")) filePath = path.join(trialDir, url.slice(7));
  if (!filePath || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) { res.writeHead(404); res.end("nf"); return; }
  res.writeHead(200, { "content-type": MIME[path.extname(filePath)] || "application/octet-stream", "cache-control": "no-store" });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((r) => server.listen(port, "127.0.0.1", r));

const browser = await chromium.launch({
  executablePath: EXE,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox",
    "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const ctx = await browser.newContext({ viewport: { width: 640, height: 360 }, serviceWorkers: "block" });
const page = await ctx.newPage();
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 160)));
await page.goto(`http://127.0.0.1:${port}/probe.html?f=${encodeURIComponent(file)}`, { waitUntil: "commit", timeout: 60000 });
console.log("waiting", waitSec, "s for load + frames");
await new Promise((s) => setTimeout(s, waitSec * 1000));
const p = await Promise.race([
  page.evaluate(() => window.__probe ? { loadMs: window.__probe.loadMs, numSplats: window.__probe.numSplats, frames: window.__probe.frames.length, deltasTail: window.__probe.frames.slice(-6) } : null),
  new Promise((res) => setTimeout(() => res("evaluate-timeout"), 60000)),
]);
console.log("probe state:", JSON.stringify(p));
try {
  const buf = await page.screenshot({ type: "jpeg", quality: 80, timeout: 180000 });
  fs.writeFileSync(out, buf);
  console.log("screenshot saved:", out, buf.length, "bytes");
} catch (e) { console.log("screenshot failed:", String(e).slice(0, 160)); }
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
