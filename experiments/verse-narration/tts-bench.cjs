const { chromium } = require("playwright");
(async () => {
  const b = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required"] });
  const p = await b.newPage();
  await p.addInitScript(() => { window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push(Math.round(e.duration)); }).observe({ entryTypes: ["longtask"] }); } catch {} });
  p.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));
  await p.goto("http://127.0.0.1:5183/dev/tts-bench.html");
  await p.waitForFunction(() => window.__out && window.__out.done, null, { timeout: 280000 });
  const o = await p.evaluate(() => ({ ...window.__out, longtasksMainThread: window.__long }));
  console.log(JSON.stringify(o, null, 1));
  await b.close();
})();
