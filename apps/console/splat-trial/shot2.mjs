// shot2.mjs — probe-scene screencast stills: collect CDP screencast
// frames for a window and keep the last ones (post-load frames show
// the splat). Usage: node shot2.mjs <file> <outPrefix> [holdSec] [port]
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(path.join(process.cwd(), "package.json"));
const { chromium } = require("playwright-core");
const EXE = process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell";

const file = process.argv[2] || "bazaar-stall-262k.ply";
const outPrefix = process.argv[3] || "probe-cast";
const holdSec = Number(process.argv[4] || 150);
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
await page.goto(`http://127.0.0.1:${port}/probe.html?f=${encodeURIComponent(file)}`, { waitUntil: "commit", timeout: 60000 });
const cdp = await ctx.newCDPSession(page);
const frames = [];
cdp.on("Page.screencastFrame", async (e) => {
  frames.push({ data: e.data, ts: e.metadata.timestamp });
  try { await cdp.send("Page.screencastFrameAck", { sessionId: e.sessionId }); } catch {}
});
await cdp.send("Page.startScreencast", { format: "jpeg", quality: 75, maxWidth: 640, maxHeight: 360, everyNthFrame: 1 });
console.log("screencast running", holdSec, "s");
await new Promise((s) => setTimeout(s, holdSec * 1000));
try { await cdp.send("Page.stopScreencast"); } catch {}
console.log("frames captured:", frames.length);
frames.forEach((f, i) => {
  if (i >= frames.length - 3 || i === 0) {
    const p = `${outPrefix}-${String(i).padStart(3, "0")}.jpg`;
    fs.writeFileSync(p, Buffer.from(f.data, "base64"));
    console.log("saved", p, "ts", f.ts);
  }
});
const p = await Promise.race([
  page.evaluate(() => window.__probe ? { loadMs: window.__probe.loadMs, numSplats: window.__probe.numSplats, frames: window.__probe.frames.length } : null),
  new Promise((res) => setTimeout(() => res("evaluate-timeout"), 30000)),
]);
console.log("probe state:", JSON.stringify(p));
await Promise.race([browser.close(), new Promise((s) => setTimeout(s, 10000))]);
server.close();
process.exit(0);
