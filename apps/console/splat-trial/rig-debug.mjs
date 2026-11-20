// rig-debug.mjs — one-off: what does the built console actually show?
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import puppeteer from "puppeteer-core";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIST = path.resolve(process.argv[2] || path.join(HERE, "../dist"));
const ROUTE = process.argv[3] || "/";
const PORT = 8915;
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".glb": "model/gltf-binary", ".wasm": "application/wasm", ".png": "image/png", ".jpg": "image/jpeg", ".svg": "image/svg+xml", ".ktx2": "application/octet-stream", ".bin": "application/octet-stream", ".woff2": "font/woff2", ".ico": "image/x-icon", ".ply": "application/octet-stream" };
const server = http.createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  let p = path.join(DIST, decodeURIComponent(url.pathname));
  if (!p.startsWith(DIST)) { res.writeHead(403); return res.end(); }
  if (url.pathname === "/" || !fs.existsSync(p) || fs.statSync(p).isDirectory()) p = path.join(DIST, "index.html");
  res.writeHead(200, { "Content-Type": MIME[path.extname(p)] || "application/octet-stream", "Cache-Control": "no-store", "Content-Length": fs.statSync(p).size });
  fs.createReadStream(p).pipe(res);
});
await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
const browser = await puppeteer.launch({
  executablePath: process.env.HOME + "/.cache/ms-playwright/chromium_headless_shell-1200/chrome-headless-shell-linux64/chrome-headless-shell",
  headless: true,
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--no-sandbox", "--disable-background-timer-throttling", "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding"],
});
const page = await browser.newPage();
await page.setViewport({ width: 640, height: 360 });
page.on("pageerror", (e) => console.log("PAGEERROR:", String(e).slice(0, 250)));
page.on("console", (m) => { if (m.type() === "error" || m.type() === "warning") console.log("CONSOLE", m.type() + ":", m.text().slice(0, 200)); });
page.on("requestfailed", (r) => console.log("REQFAIL:", r.url().slice(-80), r.failure()?.errorText));
await page.goto(`http://127.0.0.1:${PORT}${ROUTE}?tiles=0&streamDebug=1&districtDebug=1`, { waitUntil: "load", timeout: 120000 });
for (let i = 0; i < 6; i++) {
  await new Promise((s) => setTimeout(s, 10000));
  const state = await page.evaluate(() => ({
    title: document.title,
    path: location.pathname,
    hasStream: !!window.__city3Stream,
    hasDistricts: !!window.__districts,
    canvases: document.querySelectorAll("canvas").length,
    bodyText: document.body.innerText.slice(0, 200),
    snap: window.__city3Stream ? window.__city3Stream.snapshot().render : null,
  })).catch((e) => ({ evalError: String(e).slice(0, 100) }));
  console.log(`t=${(i + 1) * 10}s`, JSON.stringify(state));
  if (state.snap && state.snap.triangles > 50000) break;
}
await browser.close();
server.close();
process.exit(0);
