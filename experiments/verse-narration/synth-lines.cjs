// node synth-lines.cjs <items.json> <out.json>  — items: [{key, name, text, inner}] in the order the console would hear them.
// Needs the console dev server (vite) with VITE_PHONON_MODEL_URL set (the headless browser has no outside network).
const { chromium } = require("playwright"); const fs = require("fs");
(async () => {
  const items = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
  const b = await chromium.launch(); const p = await b.newPage();
  p.on("pageerror", (e) => console.log("pageerror", String(e).slice(0, 200)));
  await p.goto((process.env.REC_CONSOLE || "http://127.0.0.1:5183") + "/dev/tts-synth.html");
  await p.waitForFunction(() => window.__ready, null, { timeout: 60000 });
  const out = await p.evaluate((it) => window.__synth(it), items);
  fs.writeFileSync(process.argv[3], JSON.stringify(out));
  console.log("synthesized", out.length, "lines;", out.map((o) => o.voice).filter((v, i, a) => a.indexOf(v) === i).join(", "));
  await b.close();
})();
