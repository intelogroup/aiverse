// Loft interior light-port A/B: fixed spawns, screenshots + walker state + console errors.
// node loftshots.cjs <port> <outdir> <tag>   (tag: before|after -> ?interiorlook=0|1)
const { chromium } = require("playwright");
const [port, outDir, tag] = process.argv.slice(2);
const flag = tag === "after" ? "1" : "0";
const SPAWNS = [
  ["entry",  "-24.2,-112.3,-24.3,-115.2"],
  ["living", "-23.9,-114.3,-22.9,-112.9"],
  ["dining", "-22.5,-111.9,-23.5,-113.9"],
  ["street", "-24.2,-110.2,-24.2,-113.0"],
].filter(([n]) => !process.env.SPAWNS || process.env.SPAWNS.split(',').includes(n));
const fs = require("fs");
fs.mkdirSync(outDir, { recursive: true });
(async () => {
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 960, height: 540 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push("pageerror " + e.message.slice(0, 160)));
  page.on("console", (m) => { const t = m.text(); if (m.type() === "error") errors.push(t.slice(0, 160)); if (t.indexOf("interior-rig") >= 0) console.log("RIG", t.slice(0, 200)); });
  for (const [name, spawn] of SPAWNS) {
    await page.goto(`http://localhost:${port}/?world=city3&walk=1&walkDebug=1&interiorlook=${flag}&spawn=${spawn}`, { timeout: 180000 });
    await page.waitForFunction(() => window.__walk && window.__walk.state(), null, { timeout: 240000, polling: 2000 });
    await page.evaluate(() => { window.__rigLog = true; });
    await page.waitForTimeout(9000);
    const p = `${outDir}/${tag}-${name}.png`;
    await page.screenshot({ path: p, timeout: 180000 });
    const st = await page.evaluate(() => { const s = window.__walk.state(); return { x: +s.x.toFixed(2), z: +s.z.toFixed(2), y: +s.y.toFixed(3) }; });
    console.log(name, JSON.stringify(st));
  }
  console.log("console-errors:", errors.length, errors.slice(0, 4).join(" | "));
  await browser.close();
})().catch((e) => { console.error("HARNESS FAIL", e.message); process.exit(1); });
