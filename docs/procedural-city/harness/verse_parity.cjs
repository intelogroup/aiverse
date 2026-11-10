// Drive the BUILT console's scout through the shared scenario list (apps/console/tests/fixtures/verse-sim-scenarios.json) and write what it did.
// usage: node verse_parity.cjs <base-url> <scenarios.json> <out.json>
const { chromium } = require("playwright");
const fs = require("fs");
const [,, BASE, SCEN, OUT] = process.argv;
const steps = JSON.parse(fs.readFileSync(SCEN, "utf8"));
(async () => {
  const browser = await chromium.launch({ args: ["--no-sandbox", "--ignore-gpu-blocklist", "--enable-unsafe-swiftshader"] });
  const page = await browser.newPage({ viewport: { width: 640, height: 360 } });
  await page.goto(`${BASE}/?world=city3&agent=1`, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__scout?.ready?.(), undefined, { timeout: 300000 });
  const snap = () => page.evaluate(() => { const s = window.__scout.snapshot(); return s; });
  const s0 = await snap();
  console.log("snapshot keys:", Object.keys(s0).join(","));
  const result = { spawn: s0, steps: [] };
  for (const st of steps) {
    const t0 = await snap(); const w0 = Date.now();
    const out = await Promise.race([
      page.evaluate((a) => window.__scout.act(a), st.action),
      new Promise((r) => setTimeout(() => r({ status: "HARNESS_TIMEOUT" }), 540000)),
    ]);
    const s = await snap();
    const row = { name: st.name, action: st.action, status: out?.status, detail: out?.detail ?? null, wallS: +((Date.now() - w0) / 1000).toFixed(0), t0: t0.t ?? null, t1: s.t ?? null, snapshot: s };
    result.steps.push(row);
    console.log(st.name.padEnd(10), row.status, row.detail ?? "", "wall", row.wallS, "s");
    fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
  }
  await browser.close();
})().catch((e) => { console.error("FAIL", e.message); process.exit(1); });
