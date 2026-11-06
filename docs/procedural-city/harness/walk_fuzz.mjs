// walk_fuzz.mjs — browser fuzz for the City 3 capsule walker (apps/console/src/features/world/capsuleWorld.ts).
//
// Drives the REAL walker.step + capsule world inside the page (window.__walk.script, fixed dt, no rendering, so the
// ~3 fps software GL does not matter) from several spawns: random walks and head-on runs at building faces. The oracle
// is tools/city3/plan.json (buildings/halls/towers/stalls, z flipped to three): the bot must never be inside a solid (except inside a hero room it
// entered through its door), feet y within 5 cm of the ground under it (unless airborne), and never below -0.5.
//
//   NODE_PATH=/opt/node22/lib/node_modules node docs/procedural-city/harness/walk_fuzz.mjs
// env: SECS=90 (sim seconds per walk) SPAWNS=14 SEED=1 DT=0.0333 (also runs one pass at 0.1) PORT=0 (free port) BASE=<url of a running vite>
//      SHOTS=1 -> also take the screenshots listed in SHOT_LIST into OUT (slow: software GL ~90 s/frame)
//      OUT=/tmp/walk_fuzz  EXIT=1 -> non-zero exit code on violations
import { createRequire } from "module";
import { spawn } from "child_process";
import fs from "fs";
import net from "net";
import path from "path";
import { fileURLToPath } from "url";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "../../..");
const SECS = Number(process.env.SECS || 90);
const SPAWNS = Number(process.env.SPAWNS || 14);
const DT = Number(process.env.DT || 1 / 30);
const OUT = process.env.OUT || "/tmp/walk_fuzz";
fs.mkdirSync(OUT, { recursive: true });

const nav = JSON.parse(fs.readFileSync(path.join(repo, "tools/city3/out/city3-nav.json"), "utf8"));
const plan = JSON.parse(fs.readFileSync(path.join(repo, "tools/city3/plan.json"), "utf8"));
const rooms = JSON.parse(fs.readFileSync(path.join(repo, "apps/console/public/assets/interiors/index.json"), "utf8"));
// Oracle = the SOLIDS the plan builds (plan.json is Blender frame: three z = -y). The nav "footprints" are LOTS (4 m yard/sidewalk
// margin around each building, stall lots larger than the stall), so walking in the margin is legal and they are not an oracle.
const flip = ([x0, y0, x1, y1]) => [x0, -y1, x1, -y0];
const stallInset = 0.05;
const fps = [
  ...plan.buildings.map((b) => flip(b.rect)),
  ...plan.halls.map((h) => flip(h.rect)),
  ...plan.towers.map((t) => flip(t.rect)),
  // stalls: the collision box is size[0] x size[1] turned by facing; the square of the smaller half-size lies inside either way
  ...plan.stalls.map((s) => { const h = Math.min(...s.size) / 2 - stallInset; return flip([s.c[0] - h, s.c[1] - h, s.c[0] + h, s.c[1] + h]); }),
];
const inRect = (x, z, r, m = 0) => x > r[0] + m && x < r[2] - m && z > r[1] + m && z < r[3] - m;
const fountain = { c: [0, 0], r: plan.fountain.r_out }; // solid cylinders: outer ring + platform
void nav;

let seed = Number(process.env.SEED || 1);
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

function freePort() {
  return new Promise((res) => { const s = net.createServer(); s.listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
}
async function waitUp(url, ms = 60000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { try { const r = await fetch(url); if (r.ok) return; } catch { /* not yet */ } await new Promise((r) => setTimeout(r, 400)); }
  throw new Error("vite did not come up");
}

let vite = null;
let base = process.env.BASE;
if (!base) {
  const port = Number(process.env.PORT) || (await freePort());
  vite = spawn("bunx", ["vite", "--port", String(port), "--strictPort", "--host", "127.0.0.1"], { cwd: path.join(repo, "apps/console"), stdio: "ignore" });
  base = `http://127.0.0.1:${port}`;
  await waitUp(base);
}
console.log("base", base);

const browser = await chromium.launch({ args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const page = await browser.newPage({ viewport: { width: 640, height: 400 } });
const errs = [];
page.on("pageerror", (e) => errs.push("PAGEERR " + e.message));
page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 160)); });
await page.goto(`${base}/?world=city3&walk=1&walkDebug=1&districtDebug=1`);
await page.waitForFunction("window.__walk && window.__walk.state() && window.__walk.worldKind() === 'capsule'", null, { timeout: 240000 }).catch(async () => {
  console.log("WARN walker not on the capsule world:", await page.evaluate("window.__walk && window.__walk.worldKind()"));
});
console.log("world kind:", await page.evaluate("window.__walk.worldKind()"));
console.log("collision:", JSON.stringify(await page.evaluate("window.__districts && window.__districts.stats().collision")));

const put = (x, y, z, h) => page.evaluate(([x, y, z, h]) => window.__walk.put(x, y, z, h), [x, y, z, h]);
const ground = (x, z, fromY) => page.evaluate(([x, z, f]) => window.__walk.ground(x, z, f), [x, z, fromY]);
const script = (inputs) => page.evaluate((i) => window.__walk.script(i), inputs);

/** Which hero room (if any) contains the point. */
const roomAt = (x, z) => rooms.find((r) => inRect(x, z, r.rect));
function violationsOf(label, trace, extra = {}) {
  const v = [];
  let inRoom = null;
  for (let i = 0; i < trace.length; i += 6) {
    const [x, y, z, , g, grounded] = trace.slice(i, i + 6);
    const step = i / 6;
    const room = roomAt(x, z);
    if (room && !inRoom) {
      // Entering a room: must be through its door (within 1.3 m of the door point).
      const dd = Math.hypot(x - room.door[0], z - room.door[1]);
      if (dd > 1.3) v.push({ kind: "entered room not by door", room: room.id, step, x, z, doorDist: +dd.toFixed(2) });
    }
    inRoom = room || null;
    if (!room) {
      const f = fps.find((r) => inRect(x, z, r, 0.03));
      if (f) v.push({ kind: "inside footprint", fp: f, step, x, z, y });
    }
    if (Math.hypot(x - fountain.c[0], z - fountain.c[1]) < fountain.r - 0.5) v.push({ kind: "inside fountain circle", step, x, z, y });
    if (y < -0.5) v.push({ kind: "below -0.5", step, x, z, y });
    if (grounded && g !== null && g > -1e8 && Math.abs(y - g) > 0.05) v.push({ kind: "y off ground", step, x, z, y, ground: g });
  }
  // first violation per kind per run is what matters; the rest is the same event repeating
  const seen = new Set();
  return v.filter((o) => !seen.has(o.kind) && seen.add(o.kind)).map((o) => ({ label, ...extra, ...o }));
}

// Spawns: random outdoor points on level ground (plaza height band), outside every footprint.
async function pickSpawns(n) {
  const out = [];
  let guard = 0;
  while (out.length < n && guard++ < 4000) {
    const x = (rnd() * 2 - 1) * 170;
    const z = (rnd() * 2 - 1) * 170;
    if (fps.some((r) => inRect(x, z, r, -1.2))) continue;
    if (Math.hypot(x - fountain.c[0], z - fountain.c[1]) < fountain.r + 2) continue;
    const g = await ground(x, z, 1.0);
    if (g === null || g < 0.1 || g > 0.35) continue;
    out.push({ x, y: g, z, h: rnd() * Math.PI * 2 - Math.PI });
  }
  return out;
}

const report = { violations: [], runs: 0, simSeconds: 0 };
const record = (label, trace, extra) => {
  report.runs++;
  report.simSeconds += trace.length / 6 * DT;
  report.violations.push(...violationsOf(label, trace, extra));
};

function randomInputs(secs, dt) {
  const n = Math.round(secs / dt);
  const inputs = [];
  let f = 1, r = 0, t = 0, run = 0, hold = 0;
  for (let i = 0; i < n; i++) {
    if (hold-- <= 0) {
      hold = Math.round((0.4 + rnd() * 1.6) / dt);
      f = rnd() < 0.1 ? -1 : rnd() < 0.85 ? 1 : 0;
      r = rnd() < 0.25 ? (rnd() < 0.5 ? -1 : 1) : 0;
      t = rnd() < 0.6 ? (rnd() - 0.5) * 2 : 0;
      run = rnd() < 0.5 ? 1 : 0;
    }
    inputs.push([f, r, t, run, dt]);
  }
  return inputs;
}
// the trace the page returns is [x,y,z,speed] x n; widen to [x,y,z,speed,g,grounded] by asking the page for ground per step
// (done in-page below through __walk.script2 if present, else y-vs-ground is checked on a 1-in-5 subsample from node).
async function runScript(inputs) {
  const t4 = await script(inputs);
  const out = [];
  const stride = 5;
  const gs = [];
  for (let i = 0; i < t4.length / 4; i += 1) {
    const x = t4[i * 4], y = t4[i * 4 + 1], z = t4[i * 4 + 2];
    gs.push(i % stride === 0 ? [x, y, z] : null);
  }
  const gv = await page.evaluate((pts) => pts.map((p) => (p ? window.__walk.ground(p[0], p[2], p[1] + 0.45) : -1e9)), gs);
  for (let i = 0; i < t4.length / 4; i++) {
    out.push(t4[i * 4], t4[i * 4 + 1], t4[i * 4 + 2], t4[i * 4 + 3], gv[i], gv[i] === -1e9 ? 0 : 1);
  }
  return out;
}

const spawns = await pickSpawns(SPAWNS);
console.log("spawns", spawns.length);
const t0 = Date.now();
for (const [si, sp] of spawns.entries()) {
  // random walk
  await put(sp.x, sp.y, sp.z, sp.h);
  record(`random#${si}`, await runScript(randomInputs(SECS, DT)), { spawn: sp });
  // head-on at the nearest footprint, run, at 3 dts
  const near = [...fps].sort((a, b) => Math.hypot(sp.x - (a[0] + a[2]) / 2, sp.z - (a[1] + a[3]) / 2) - Math.hypot(sp.x - (b[0] + b[2]) / 2, sp.z - (b[1] + b[3]) / 2))[0];
  const cx = (near[0] + near[2]) / 2, cz = (near[1] + near[3]) / 2;
  for (const dt of [DT, 0.1]) {
    await put(sp.x, sp.y, sp.z, Math.atan2(cx - sp.x, cz - sp.z));
    const n = Math.round(25 / dt);
    record(`headon#${si}@${dt.toFixed(3)}`, await runScript(Array.from({ length: n }, () => [1, 0, 0, 1, dt])), { spawn: sp, target: near });
  }
}
// head-on at EVERY footprint from 6 m out on its nearest side (the bot starts wherever ground exists), heading at the centre
let fi = 0;
for (const f of fps) {
  const cx = (f[0] + f[2]) / 2, cz = (f[1] + f[3]) / 2;
  const sides = [[f[0] - 6, cz], [f[2] + 6, cz], [cx, f[1] - 6], [cx, f[3] + 6]];
  for (const [x, z] of sides) {
    const g = await ground(x, z, 1.0);
    if (g === null || g < 0.1 || g > 0.35 || fps.some((r) => inRect(x, z, r, -0.5)) || Math.hypot(x - fountain.c[0], z - fountain.c[1]) < fountain.r + 1) continue;
    await put(x, g, z, Math.atan2(cx - x, cz - z));
    record(`face#${fi}`, await runScript(Array.from({ length: 450 }, () => [1, 0, 0, 1, 0.05])), { from: [x, z], target: f });
  }
  fi++;
}
console.log(`ran ${report.runs} scripts, ${report.simSeconds.toFixed(0)} sim seconds in ${((Date.now() - t0) / 1000).toFixed(0)} s wall`);
const byKind = {};
for (const v of report.violations) byKind[v.kind] = (byKind[v.kind] || 0) + 1;
console.log("violations by kind:", JSON.stringify(byKind));
for (const v of report.violations.slice(0, 25)) console.log(" ", JSON.stringify(v));
fs.writeFileSync(path.join(OUT, "report.json"), JSON.stringify(report, null, 1));

// ---- screenshots (SHOTS=1): scenarios the plan asks to LOOK at ----
if (process.env.SHOTS) {
  const tea = rooms.find((r) => r.name && /Tea/i.test(r.name)) || rooms[0];
  const shot = async (name, wait = 3000) => {
    await page.waitForTimeout(wait);
    await page.screenshot({ path: path.join(OUT, name + ".png"), timeout: 240000 });
    console.log("shot", name, JSON.stringify(await page.evaluate("window.__walk.state()")).slice(0, 160));
  };
  const SHOT_SCENARIOS = JSON.parse(process.env.SHOT_LIST || "[]");
  for (const sc of SHOT_SCENARIOS) {
    await put(sc.x, sc.y ?? (await ground(sc.x, sc.z, sc.fromY ?? 1.0)), sc.z, sc.h);
    if (sc.forward) await script(Array.from({ length: Math.round(sc.forward / 0.05) }, () => [1, 0, 0, sc.run ? 1 : 0, 0.05]));
    if (sc.pitch !== undefined) await page.evaluate((p) => window.__walk.pitch(p), sc.pitch);
    if (sc.mode) await page.keyboard.press("KeyV");
    await shot(sc.name);
  }
  void tea;
}
console.log(errs.filter((e) => !/api|ECONNREFUSED|WebSocket|Failed to load resource|proxy/i.test(e)).join("\n") || "no non-network errors");
await browser.close();
if (vite) vite.kill();
if (process.env.EXIT && report.violations.length) process.exit(1);
