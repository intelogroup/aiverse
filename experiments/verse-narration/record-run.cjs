// Records a real-harness agent talking in the Verse, as its OWNER sees and hears it.
//   - greeter.ts: a second real-owner agent walks to the Tea House and answers speech.
//   - tea-run.ts (opencode + live narration push): the visitor agent walks there and greets.
//   - A headless browser, signed in as the visitor's owner, FOLLOWS the agent, enables sound, and is captured:
//       frames (timestamped; software GL renders ~1 fps, so the video is real-time but low frame rate),
//       captions for what is being spoken, and the REAL audio output (WebAudio tapped into a MediaRecorder).
// Needs: stack-up.sh services, console (vite) with VITE_ASSET_BASE pointing at the asset mirror, OPENROUTER_API_KEY.
const { chromium } = require("playwright");
const { spawn, spawnSync } = require("child_process");
const fs = require("fs"), path = require("path");

const ROOT = process.cwd();
const OUT = process.env.REC_OUT || "/tmp/verse-recording";
const FRAMES = path.join(OUT, "frames");
const W = Number(process.env.REC_W || 800), H = Number(process.env.REC_H || 500);
const CONSOLE = process.env.REC_CONSOLE || "http://127.0.0.1:5183";
const MAX_S = Number(process.env.REC_MAX_S || 360);
fs.rmSync(OUT, { recursive: true, force: true }); fs.mkdirSync(FRAMES, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const waitFile = async (f, ms) => { const end = Date.now() + ms; while (!fs.existsSync(f) && Date.now() < end) await sleep(500); return fs.existsSync(f); };
const child = (name, args, env) => {
  const log = fs.openSync(path.join(OUT, name + ".log"), "w");
  const p = spawn("bun", args, { cwd: ROOT, env: { ...process.env, ...env }, stdio: ["ignore", log, log] });
  p.done = new Promise((r) => p.on("close", r));
  return p;
};

(async () => {
  const READY = path.join(OUT, "greeter.ready"), SESSION = path.join(OUT, "session.json"), GO = path.join(OUT, "go");
  const greeter = child("greeter", ["experiments/verse-narration/greeter.ts"], { GREETER_READY_FILE: READY });
  const runner = child("tea-run", ["experiments/verse-narration/tea-run.ts"], {
    NARRATION_PUSH: "1", NARRATION_HARNESS: process.env.REC_HARNESS || "opencode", NARRATION_TIMEOUT_S: String(MAX_S - 40),
    NARRATION_SESSION_FILE: SESSION, NARRATION_GO_FILE: GO, NARRATION_OUT: path.join(OUT, "harness"),
  });
  if (!(await waitFile(SESSION, 90000))) throw new Error("no session file from tea-run");
  const sess = JSON.parse(fs.readFileSync(SESSION, "utf8"));
  console.log("owner session ready for", sess.agentName);

  const browser = await chromium.launch({ args: ["--autoplay-policy=no-user-gesture-required", "--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  await ctx.addInitScript(({ token }) => {
    try { localStorage.setItem("aiverse_owner_token", token); localStorage.setItem("aiverse_owner_email", "owner@example.com"); } catch {}
    window.__audio = { startEpoch: null, chunks: [] };
    const origConnect = AudioNode.prototype.connect; let tap = null;
    AudioNode.prototype.connect = function (dest, ...rest) {
      const r = origConnect.call(this, dest, ...rest);
      try {
        if (dest && dest.constructor && dest.constructor.name === "AudioDestinationNode") {
          if (!tap) {
            tap = this.context.createMediaStreamDestination();
            const rec = new MediaRecorder(tap.stream, { mimeType: "audio/webm;codecs=opus" });
            rec.ondataavailable = async (e) => { if (e.data.size) { const b = new Uint8Array(await e.data.arrayBuffer()); let s = ""; for (const x of b) s += String.fromCharCode(x); window.__audio.chunks.push(btoa(s)); } };
            rec.start(1000); window.__audio.startEpoch = Date.now();
          }
          origConnect.call(this, tap);
        }
      } catch {}
      return r;
    };
  }, { token: sess.ownerToken });
  const page = await ctx.newPage();
  const errs = [];
  page.on("pageerror", (e) => errs.push(String(e).slice(0, 200)));
  await page.goto(`${CONSOLE}/?stream=1&ttsDebug=1`, { waitUntil: "domcontentloaded" });

  const chip = page.getByTestId("follow-chip");
  await chip.waitFor({ timeout: 240000 });
  await chip.click();
  const snd = page.getByTestId("follow-sound");
  await snd.waitFor({ timeout: 30000 });
  await snd.click(); // the consent gesture: creates the AudioContext inside the click
  console.log("following + sound enabled; waiting for the host to be at the tea house");
  if (!(await waitFile(READY, 280000))) console.log("host never reported ready; continuing anyway");
  await sleep(1500);
  fs.writeFileSync(GO, "go"); // release the visitor's harness

  const frames = []; const t0 = Date.now();
  let ended = false; runner.done.then(() => { ended = true; });
  let endAt = null;
  while (Date.now() - t0 < MAX_S * 1000) {
    if (ended && endAt === null) endAt = Date.now() + 10000; // keep filming 10 s after the run
    if (endAt !== null && Date.now() > endAt) break;
    // caption: what is being spoken right now (from the console's own speech log)
    await page.evaluate(() => {
      const now = performance.now();
      const log = window.__tts && window.__tts.agentSpeech ? window.__tts.agentSpeech().log : [];
      const cur = log.filter((l) => l.playAt <= now && now <= l.playAt + (l.seconds || 0) * 1000 + 300).pop();
      let el = document.getElementById("__cap");
      if (!el) { el = document.createElement("div"); el.id = "__cap"; el.style.cssText = "position:fixed;left:50%;bottom:70px;transform:translateX(-50%);max-width:80%;padding:8px 14px;border-radius:10px;background:rgba(10,12,18,.82);color:#fff;font:15px/1.35 system-ui,sans-serif;z-index:99999;text-align:center;pointer-events:none"; document.body.appendChild(el); }
      el.style.display = cur ? "block" : "none";
      if (cur) el.textContent = (cur.inner ? "\u{1F3A7} " + cur.name + " (to itself): " : "\u{1F4AC} " + cur.name + ": ") + cur.text;
    }).catch(() => {});
    const buf = await page.screenshot({ type: "jpeg", quality: 72, timeout: 60000 }).catch(() => null);
    if (!buf) continue;
    const n = frames.length; const f = path.join(FRAMES, `f_${String(n).padStart(5, "0")}.jpg`);
    fs.writeFileSync(f, buf); frames.push({ f, t: Date.now() });
  }
  const info = await page.evaluate(() => ({ log: window.__tts && window.__tts.agentSpeech ? window.__tts.agentSpeech() : null, audio: window.__audio, eng: window.__tts && window.__tts.engine ? window.__tts.engine() : null })).catch(() => null);
  fs.writeFileSync(path.join(OUT, "speech-log.json"), JSON.stringify(info && info.log, null, 1));
  await browser.close();
  [runner, greeter].forEach((p) => { try { p.kill(); } catch {} });
  console.log(`frames: ${frames.length} over ${((frames[frames.length - 1].t - frames[0].t) / 1000).toFixed(0)} s;`, "page errors:", errs.length, errs.slice(0, 2));

  // ---- assemble: variable-frame-rate video (each frame shown for the real time until the next), then the real audio
  const list = frames.map((fr, i) => `file '${fr.f}'\nduration ${Math.max(0.05, Math.min(5, ((frames[i + 1] ? frames[i + 1].t : fr.t + 1000) - fr.t) / 1000)).toFixed(3)}`).join("\n") + `\nfile '${frames[frames.length - 1].f}'\n`;
  fs.writeFileSync(path.join(OUT, "frames.txt"), list);
  const silent = path.join(OUT, "silent.mp4");
  let r = spawnSync("ffmpeg", ["-y", "-f", "concat", "-safe", "0", "-i", path.join(OUT, "frames.txt"), "-vf", "fps=10,scale=trunc(iw/2)*2:trunc(ih/2)*2", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-crf", "26", silent], { encoding: "utf8" });
  if (r.status !== 0) { console.log(r.stderr.slice(-600)); throw new Error("ffmpeg video failed"); }
  const out = path.join(OUT, "agent-in-the-verse.mp4");
  if (info && info.audio && info.audio.chunks.length) {
    const wav = path.join(OUT, "audio.webm");
    fs.writeFileSync(wav, Buffer.concat(info.audio.chunks.map((c) => Buffer.from(c, "base64"))));
    const off = (info.audio.startEpoch - frames[0].t) / 1000; // >0: audio began after the first frame
    const aIn = off >= 0 ? ["-itsoffset", off.toFixed(3), "-i", wav] : ["-ss", (-off).toFixed(3), "-i", wav];
    r = spawnSync("ffmpeg", ["-y", "-i", silent, ...aIn, "-c:v", "copy", "-c:a", "aac", "-b:a", "96k", "-shortest", out], { encoding: "utf8" });
    if (r.status !== 0) { console.log(r.stderr.slice(-600)); fs.copyFileSync(silent, out); console.log("audio mux failed; wrote silent video"); }
  } else { fs.copyFileSync(silent, out); console.log("no audio captured; wrote silent video"); }
  console.log("VIDEO:", out, fs.statSync(out).size, "bytes");
  process.exit(0);
})().catch((e) => { console.error("FAILED", e); process.exit(1); });
