const { chromium } = require("playwright"); const body = process.argv[2] || "cipher";
(async () => { const b = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] }); const p = await b.newPage({ viewport: { width: 900, height: 700 } });
  await p.goto(`http://localhost:5199/idle_probe.html?body=${body}`); await p.waitForFunction(() => window.__ready, null, { timeout: 120000 });
  await p.evaluate(() => { for (let i = 0; i < 300; i++) window.__step(1 / 30); }); const tr = await p.evaluate(() => window.__trace);
  for (const k of ["A", "B"]) { const rows = tr[k].slice(30); const n = rows[0].length / 3; const out = [];
    for (let f = 0; f < n; f++) { const xs = rows.map((r) => r[f * 3]), zs = rows.map((r) => r[f * 3 + 2]), ys = rows.map((r) => r[f * 3 + 1]); let step = 0; for (let i = 1; i < rows.length; i++) step = Math.max(step, Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1])); out.push(`foot${f}: range ${(100 * Math.max(Math.max(...xs) - Math.min(...xs), Math.max(...zs) - Math.min(...zs))).toFixed(1)} cm, max per-frame step ${(100 * step).toFixed(2)} cm, y range ${(100 * (Math.max(...ys) - Math.min(...ys))).toFixed(1)} cm`); }
    console.log(body, k === "A" ? "NO lock " : "LOCK    ", out.join(" | ")); }
  await b.close(); })();
