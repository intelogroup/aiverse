// Playwright: City 3 walker locomotion screenshots in the follow cam (idle, walk, run, strafe, backward).
// NODE_PATH=/opt/node22/lib/node_modules node walkshots.cjs <port> <outdir> [phases]
const { chromium } = require("playwright");
const fs = require("fs");
const [port, outDir, only] = [process.argv[2], process.argv[3], process.argv[4]];
fs.mkdirSync(outDir, { recursive: true });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

(async () => {
  const browser = await chromium.launch({
    args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"],
  });
  const page = await browser.newPage({ viewport: { width: 480, height: 320 } });
  page.on("pageerror", (e) => log("pageerror", e.message));
  page.on("console", (m) => { if (m.type() === "error") log("console.error", m.text().slice(0, 200)); });
  await page.goto(`http://localhost:${port}/?world=city3&walk=1&walkDebug=1`, { timeout: 180000 });
  await page.waitForFunction(() => window.__walk && window.__walk.state(), null, { timeout: 400000, polling: 2000 });
  log("walker up", JSON.stringify(await page.evaluate(() => window.__walk.state())));
  await page.evaluate(() => { const s = window.__walk.state(); window.__spawn = [s.x, s.z]; });
  await page.keyboard.press("KeyV"); // follow cam
  await page.waitForTimeout(8000);
  const st = async () => page.evaluate(() => { const s = window.__walk.state(); return { x: +s.x.toFixed(2), y: +s.y.toFixed(3), z: +s.z.toFixed(2), view: +s.heading.toFixed(2), body: +s.body.toFixed(2), back: s.backward, speed: +s.speed.toFixed(2), mode: s.mode }; });
  const shot = async (name) => {
    const p = `${outDir}/${name}.png`;
    await page.screenshot({ path: p, timeout: 180000 });
    log(name, JSON.stringify(await st()));
  };
  const phases = [
    ["idle", [], 1, 0],
    ["walk", ["KeyW"], 3, 2500],
    ["run", ["ShiftLeft", "KeyW"], 3, 2500],
    ["strafeR", ["KeyD"], 3, 2500],
    ["strafeRrun", ["ShiftLeft", "KeyD"], 3, 2500],
    ["back", ["KeyS"], 3, 2500],
    ["backrun", ["ShiftLeft", "KeyS"], 2, 2500],
  ].filter((p) => !only || only.split(",").includes(p[0]));
  for (const [name, keys, n, warm] of phases) {
    // Re-centre in the open plaza before every phase so the bot never walks into a wall mid-sequence.
    await page.evaluate(() => window.__walk.teleport(window.__spawn[0], window.__spawn[1], 0, 3));
    await page.waitForTimeout(3000);
    for (const k of keys) await page.keyboard.down(k);
    await page.waitForTimeout(warm);
    for (let i = 0; i < n; i++) { await shot(`${name}-${i}`); }
    for (const k of keys.slice().reverse()) await page.keyboard.up(k);
    await page.waitForTimeout(3000);
  }
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
