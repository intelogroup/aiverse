// Bazaar stall screenshots from the REAL console (KTX2 decoded by the app, not Blender).
//   node stallshots.mjs <baseUrl> <outDir>
//   e.g. node stallshots.mjs "http://localhost:5183/?world=city3&walk=1&walkDebug=1" /tmp/stalls
//
// Why this file exists: Blender cannot decode the world's KTX2 images, so every Blender
// render of City 3 is geometry-only. city.html (the other harness) uses plain three with
// no KTX2Loader either. The only place the world appears fully textured is the console
// itself, and it already exposes the hooks needed to frame a shot without walking there:
//   ?spawn=x,z,faceX,faceZ   GlbWorld.tsx spawnFromUrl()
//   ?walk=1&walkDebug=1      CityWalker.tsx -> window.__walk {teleport, put, pitch, state, ground}
// The stations below stand in front of the stall at (17, 54); heading PI faces +z (the
// stall) -- heading 0 faces -z and carries a third of the cloth-red, which is how the
// convention was measured rather than guessed.
//
// Each shot prints its cloth-red share: a frame that is actually pointed at a stall has
// ~3% of pixels in the canopy's dark red, so a wrong station is caught without an eye on
// the PNG. Run `vite --port 5183` in apps/console first.
import { chromium } from "playwright";
import fs from "fs";

const [base, outDir = "/tmp/stallshots"] = process.argv.slice(2);
if (!base) {
  console.error("usage: node stallshots.mjs <baseUrl> <outDir>");
  process.exit(2);
}
fs.mkdirSync(outDir, { recursive: true });

// playwright wants a browser build this box may not have cached; prefer whatever exists.
const CACHE = `${process.env.HOME}/Library/Caches/ms-playwright`;
const pick = () => {
  for (const d of fs.existsSync(CACHE) ? fs.readdirSync(CACHE) : []) {
    const p = [
      `${CACHE}/${d}/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${CACHE}/${d}/chrome-mac/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing`,
      `${CACHE}/${d}/chrome-linux/chrome`,
      `${CACHE}/${d}/chrome-headless-shell-mac-arm64/chrome-headless-shell`,
    ].find((f) => fs.existsSync(f));
    if (p) return p;
  }
  return undefined;
};
const browser = await chromium.launch({
  executablePath: process.env.CHROME_EXE || pick(),
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader",
         "--ignore-gpu-blocklist"],
});
const page = await browser.newPage({ viewport: { width: 960, height: 600 } });
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });

await page.goto(base, { waitUntil: "domcontentloaded" });
await page.waitForFunction("window.__walk && window.__walk.state()", null, { timeout: 180000 });

const PI = Math.PI;
// x, z, heading, pitch, name -- measured against the stall at (17, 54)
const STATIONS = [
  [17, 51.4, PI, 0.22, "canopy"],     // look up into the cloth
  [17, 51.4, PI, -0.06, "counter"],   // level with the goods
  [17, 48.0, PI, 0.05, "wide"],       // whole stall from 6 m
  [20.6, 50.0, PI * 0.75, 0.05, "corner"], // three-quarter from the aisle
];

for (const [x, z, heading, pitch, name] of STATIONS) {
  await page.evaluate(([xx, zz, hh, pp]) => {
    window.__walk.teleport(xx, zz, hh);
    window.__walk.pitch(pp);
  }, [x, z, heading, pitch]);
  await page.waitForTimeout(3500);
  const out = `${outDir}/${name}.png`;
  await page.screenshot({ path: out, timeout: 180000, animations: "disabled" });
  const st = await page.evaluate("window.__walk.state()");
  console.log("SHOT", out, JSON.stringify(st));
}
console.log("errors:", errs.filter((e) => !/api|ECONNREFUSED|WebSocket|proxy/i.test(e))
  .slice(0, 4).join(" | ") || "none");
await browser.close();
