// Minimal Spark isolation probe: empty three scene + ONE splat file.
// Usage: node probe.mjs <file.ply|file.spz> <waitSec> [port]
// Discriminates "Spark under SwiftShader" from "Spark x the city scene".
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { chromium } = require("playwright-core");
const EXE = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";

const file = process.argv[2] || "bazaar-stall-262k.ply";
const waitSec = Number(process.argv[3] || 120);
const port = Number(process.argv[4] || 8913);
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
page.on("pageerror", (e) => console.log("pageerror:", String(e).slice(0, 200)));
const t0 = Date.now();
const qs = file === "EMPTY" ? "empty=1" : `f=${encodeURIComponent(file)}`;
await page.goto(`http://127.0.0.1:${port}/probe.html?${qs}`, { waitUntil: "commit", timeout: 60000 });
console.log("goto committed; waiting", waitSec, "s (file:", file, ")");
for (let i = 0; i < waitSec / 10; i++) {
  await new Promise((s) => setTimeout(s, 10000));
  const p = await Promise.race([
    page.evaluate(() => window.__probe ? { loadMs: window.__probe.loadMs, numSplats: window.__probe.numSplats, error: window.__probe.error, frames: window.__probe.frames.length, heapMB: performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : null, lastInfos: window.__probe.infos.slice(-2) } : null),
    new Promise((res) => setTimeout(() => res("evaluate-timeout"), 30000)),
  ]);
  console.log(Math.round((Date.now() - t0) / 1000), "s probe:", JSON.stringify(p));
}
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
