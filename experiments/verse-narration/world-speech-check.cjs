const { chromium } = require("playwright");
const { spawn } = require("child_process");
(async () => {
  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 700 } })).newPage();
  const logs = [];
  page.on("console", (m) => { const t = m.text(); if (/tts|phonon|speech|say|error|warn|fail|wasm/i.test(t)) logs.push(`[${m.type()}] ${t.slice(0, 200)}`); });
  page.on("pageerror", (e) => logs.push("[pageerror] " + String(e).slice(0, 200)));
  await page.addInitScript(() => { window.__long = []; try { new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__long.push([Math.round(e.startTime), Math.round(e.duration)]); }).observe({ entryTypes: ["longtask"] }); } catch {} });
  await page.goto("http://127.0.0.1:5183/?walk=1&stream=1&ttsDebug=1&soundDebug=1", { waitUntil: "domcontentloaded" });
  const btn = page.locator(".w-sound-enable");
  await btn.waitFor({ timeout: 90000 }).catch(() => logs.push("no .w-sound-enable within 90s"));
  if (await btn.count()) { await btn.click(); console.log("sound consent clicked"); }
  const hasTts = await page.waitForFunction(() => !!window.__tts, null, { timeout: 30000 }).then(() => true).catch(() => false);
  console.log("window.__tts present:", hasTts);
  let listener = null;
  for (let i = 0; i < 40 && !listener; i++) {
    await page.waitForTimeout(5000);
    listener = await page.evaluate(() => (window.__tts && window.__tts.listener ? window.__tts.listener() : null)).catch(() => null);
    if (i % 6 === 0) console.log(`t+${(i + 1) * 5}s listener:`, JSON.stringify(listener));
  }
  console.log("walker listener ready:", JSON.stringify(listener));
  await page.screenshot({ path: process.env.SHOT.replace(".png", "-ready.png") }).catch(() => {});
  // start the two agents now; they speak after the engine has had time to load
  const probe = spawn("bun", ["experiments/verse-narration/say-probe.ts"], { cwd: process.cwd(), env: { ...process.env, PROBE_DELAY_S: process.env.PROBE_DELAY_S || "60", PROBE_GAP_S: "6" } });
  probe.stdout.on("data", (d) => process.stdout.write("[probe] " + d)); probe.stderr.on("data", (d) => process.stdout.write("[probe-err] " + d));
  await new Promise((r) => probe.on("close", r));
  let last = -1;
  for (let i = 0; i < 60; i++) {
    await page.waitForTimeout(2000);
    const vs = await page.evaluate(() => (window.__sound ? window.__sound.snapshot().voice : null)).catch(() => null);
    if (vs && vs.playing) console.log('VOICE PLAYING:', JSON.stringify(vs));
    const st = await page.evaluate(() => window.__tts && window.__tts.agentSpeech ? { l: window.__tts.agentSpeech().log.length, d: window.__tts.agentSpeech().drops.length } : null).catch(() => null);
    if (i % 10 === 0) console.log(`poll ${i * 2}s:`, JSON.stringify(st));
    if (st && st.l + st.d >= 6 && !(vs && vs.playing)) break;
  }
  const keys = await page.evaluate(() => Object.keys(window).filter((k) => k.startsWith("__")));
  console.log("window __ keys:", JSON.stringify(keys), "url:", page.url());
  const out = await page.evaluate(() => (window.__tts && window.__tts.agentSpeech) ? window.__tts.agentSpeech() : null).catch((e) => String(e));
  const eng = await page.evaluate(() => (window.__tts && window.__tts.engine ? window.__tts.engine() : null)).catch(() => null);
  console.log("engine:", JSON.stringify(eng));
  const lt = await page.evaluate(() => window.__long || []).catch(() => []);
  console.log("longtasks>50ms:", lt.length, "max:", lt.reduce((m, x) => Math.max(m, x[1]), 0), "ms; last 5:", JSON.stringify(lt.slice(-5)));
  console.log("agentSpeech:", JSON.stringify(out, null, 1).slice(0, 2500));
  await page.screenshot({ path: process.env.SHOT, deviceScaleFactor: 1 }).catch(() => {});
  console.log("console logs:", logs.slice(0, 12).join("\n"));
  await browser.close();
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
