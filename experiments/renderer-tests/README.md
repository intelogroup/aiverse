# Renderer tests — WebGPU verification path + native static shots

**Status:** INSTRUCTIONS / RESULTS PARTIAL — **the test was shortened at
Jim's word (2026-11-12, 10:21 ET)**. What was measured is recorded below;
unfilled cells are marked "not run" and are gaps, not pending promises. This
PR is the test brief first and the results record second. It exists so the
test can move between hosts (this VM → Jim's MacBook) with its full context
intact: anyone picking it up from this PR alone has the whole picture.

## Why this test exists

Agent screenshots (`POST /world/see`, PR #136) are rendered by a look service
holding the production world in a headless Chromium page. On the current VM
there is **no GPU**: WebGL runs on SwiftShader (software), and a warm capture
takes **~55 s** (minutes in a fresh area). A screenshot is a decision-fired
event, never a reflex — but at 55 s it is too slow even for that. Two candidate
renderer paths are being tested to fix it.

## Jim's ruling (2026-11-12) — the scope law for everything below

- **Verifying the verse — anything live or moving — uses Chromium WebGL or
  WebGPU ONLY.** An agent's screenshot must show what a human would see; only
  the real console scene code guarantees that.
- **A native renderer is a candidate ONLY for static close-object
  screenshots** (a single prop or body, framed close, nothing moving). Never
  for verification of live state.
- Most "looking" should not produce pixels at all: `observe` (structured
  evidence) and the sim's synthetic look (depth + class) stay the primary
  senses. The screenshot is the confirmation, not the sense.

## Experiment A — WebGPU look (the verification-path candidate)

Same experiment page, same world, same fixed framing and pose (Tea House
viewpoint used by the look-service record):

1. **Baseline:** current WebGL path, warm page. Warm capture time = median of
   3. Record the WebGL renderer string.
2. **WebGPU:** the same page on three.js' WebGPU backend (the three version
   the console ships). Warm capture time = median of 3. Record
   `navigator.gpu` adapter info — prove which backend actually ran.
3. **Parity:** one PNG per path, same framing. Report a rough pixel-diff stat
   and keep both PNGs in this directory (`a-webgl.png`, `a-webgpu.png`).

A WebGPU result counts only if the adapter string shows the intended backend;
a silent fallback to software is recorded as a fallback, not as a result.

## Experiment B — native renderer (the static-close-object candidate) — LIGHT

Jim's cap: **a quick test, ~15 minutes wall, not a long one.**

- Subject: ONE production body GLB (`cast-jim.glb` or `cast-elf.glb`), static
  close-up on a plain background.
- Reference: the same GLB in a minimal Chromium/three.js viewer, fixed camera
  (`b-chromium.png`).
- Native: smallest viable wgpu/rend3-class offscreen render (`b-native.png`),
  attempted ONLY if a Rust toolchain and a Vulkan/Metal adapter are already
  present. Order of evidence: (1) `cargo --version`, (2) adapter listing,
  (3) render only if both pass. A long dependency compile is NOT authorized —
  if the path needs one, the documented blocker (with command output) IS the
  result.
- Record: load time, first-render time, and a plain parity note — are
  materials/textures present or flattened?

## Environments

### This VM (where the test starts)

No GPU (`/dev/dri` absent). WebGPU runs on Dawn's software Vulkan
(SwiftShader); wgpu runs on lavapipe/llvmpipe if present. Numbers here prove
**correctness, parity, and pipeline viability** — and relative WebGL-vs-WebGPU
speed on an identical software rasterizer. They are NOT GPU numbers; the
renderer/adapter strings in the results table are what keep that honest.

### Jim's MacBook Air (the follow-on host)

Apple Silicon: Chrome's WebGL and WebGPU both run on Metal — the same APIs on
real hardware, and the cheapest true-GPU measurement available. wgpu's Metal
backend is first-class, so Experiment B also becomes meaningful there.

- Run headless Chrome under the `jett` SSH user with a **throwaway profile** —
  never Jim's browsing session.
- Reuse THIS experiment page and the same framings/poses, so VM and Mac shots
  compare one-to-one.
- Record the same fields: adapter/renderer strings, warm capture medians.
- Caveat to keep in the record: a fanless Air GPU is indicative, not a cloud
  server GPU benchmark. Right order of magnitude is enough for the decision:
  does a real GPU kill the look-latency problem?

## Results (fill in as runs complete)

| Host | Path | Renderer / adapter string | Warm capture (median of 3) | Parity | Notes |
|---|---|---|---|---|---|
| VM | WebGL (baseline) | `ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)`, WebGL 2.0 | **3,308 ms** via render-target readback (render call alone 21.5 ms; the rest is readback + PNG encode). Canvas-readback variant: 7,690 ms | `a-webgl.png` produced and verified visually (Tea House framing, textures present). Parity vs WebGPU **not established** — see verdicts | World GLB load 8.6 s; 512×288; three 0.170.0; framing = Tea House pose pos [-26.19, 0.2, -63.96], heading 155°, eye 1.55 m. RT frame renders without output color-space conversion (more saturated than the canvas frame, `a-webgl-canvas.png`) — same pipeline for both backends, so the pair would have compared cleanly |
| VM | WebGPU | `navigator.gpu` adapter: vendor `google`, architecture `swiftshader`, `isFallbackAdapter: true` (Dawn software Vulkan; flags `--enable-unsafe-webgpu --use-vulkan=swiftshader --enable-features=Vulkan --disable-vulkan-surface`) | **Not achieved** — render call 24–80 ms, but no capture completed | **Not established** — `a-webgpu.png` in this directory is the actual WebGPU readback: a black frame (evidence, not a render bug in the scene) | World loads (7.4 s) and draws execute (3,028,452 triangles counted ≈ 2× the WebGL count for the same scene — a renderer.info counting difference). All three readback avenues failed on this headless host: canvas `toBlob` → black; CDP `page.screenshot` → black; RT `readRenderTargetPixelsAsync` → `AbortError: Failed to execute 'mapAsync' on 'GPUBuffer': A valid external Instance reference no longer exists` (that attempt used the pre-fix RT class; the corrected-RT rerun was stopped by the shorten order) |
| VM | Native (Exp. B) | n/a | not run — test shortened at Jim's word | n/a | **Environment facts only.** Rust toolchain **present**: cargo 1.99.1 / rustc 1.99.1 at `~/.cargo/bin` (not on the default PATH). **No system Vulkan adapter**: no `/usr/share/vulkan/icd.d`, no lavapipe, no `vulkaninfo`, no `/dev/dri`; loader `libvulkan.so.1` present. The only Vulkan device on the box is Chromium's bundled SwiftShader ICD (`libvk_swiftshader.so`). Native render not attempted; no `b-native.png`, and the Chromium reference `b-chromium.png` was also not captured before the shorten order. Full command evidence: `results/expB-toolchain-evidence.txt` |
| Mac (Apple M4) | WebGL | `ANGLE (Apple, ANGLE Metal Renderer: Apple M4, Unspecified Version)` | **1.5–14 ms** render+finish (cast-jim, 768×768, 3 warm frames; first frame 31–41 ms). Whole page incl. GLB load: 164 ms | Reference for all rows below (`results/b-chromium-webgl.png`) | **Single body GLB, not the full world** (the console has no WebGPU path, so the Tea House world page could not be run). three 0.170.0, `cast-jim.glb` 31,092 tris, headless Chrome 157 via Playwright, throwaway profile (not the `jett` SSH user) |
| Mac (Apple M4) | WebGPU | `navigator.gpu` adapter `apple / metal-3`; three `WebGPURenderer` backend = `WebGPUBackend`, `isWebGPUBackend: true` (real Metal, no fallback) | **0.8–8 ms** (cast-jim 1.6–2.1 ms; first frame 35–206 ms). Whole page 1,677 ms | **Matches WebGL**: mean abs pixel diff 0.11 (jim) / 0.27 (elf) on 0–255; <0.2% of pixels differ visibly (`results/pair-*`, `a-webgpu-*.png`) | Gotcha that cost an hour: lights must come from the `three/webgpu` classes, not `three` — mixing the two bundles gives a black silhouette (lights silently ignored) |
| Mac (Apple M4) | Native wgpu 24 (own ~150-line renderer, Exp. B) | `Apple M4 / Metal` | **1.4–2.8 ms** (first 7–9 ms); load 17–25 ms; process 43 ms warm (425 ms first start) | Geometry/pose/framing/textures match; **darker (body mean lum 28.4 vs 41.3) and harsher normal-map detail** — no specular/roughness response in my shader | `results/b-native-wgpu.png`; sources in `harness/native-wgpu/`. CPU-skinned at rest pose |
| Mac (Apple M4) | Native Bevy 0.20.1 (Exp. B) | wgpu/Metal via Bevy | first render 55 ms (110 ms cold); scene ready 206 ms from launch (1.6 s cold); process 761 ms incl. 30-frame wait | **Best native parity**: silhouette IoU 0.999 with Chromium; body slightly brighter (49 vs 41 mean lum); textures, normal map, skinning all correct | Dependency compile **5 min 32 s**. Opens a real window briefly (not truly headless). `results/b-native-bevy.png`, `harness/native-bevy/` |
| Mac (Apple M4) | Native rend3 0.3.0 (Exp. B) | wgpu 0.12 / Metal | first render 26–28 ms; warm 3.5–7.4 ms; load 75–80 ms; process ~150 ms | Renders, but **framing differs** (model smaller and lower than Chromium; cause not found) and background is black; textures/normal map/skinning work | **Only runs after two local patches**: wgpu-hal 0.12 Metal asserts on nil labels / debug-group strings on current macOS (vendored and disabled), plus `image` 0.23 needs the `jpeg` feature. Unmaintained — not recommended. `harness/native-rend3/` (patch described there, vendored crate not committed) |

**Verdicts:**

- **Experiment A — baseline established; WebGPU inconclusive (shortened).**
  WebGL works end-to-end on this VM: warm capture median **3,308 ms** at
  512×288 via RT readback (vs ~55 s for the full console look-service frame —
  different scene load, so treat this rig's number as the renderer floor, not
  a service measurement). The WebGPU pipeline genuinely runs — real adapter
  (SwiftShader fallback), world loads, draws execute, render calls are fast —
  but on this headless host **no pixel readback path succeeded**, so WebGPU
  parity and capture cost are undecided here. The decision moves to the
  MacBook run, where the canvas actually presents on Metal.
- **Experiment B — not run (shortened).** Environment facts recorded in the
  table: toolchain present off-PATH; no system Vulkan adapter. No native
  frame exists.

### Mac (Apple M4) follow-on run — added 2026-11-12

Run on a local Apple M4 (Metal), headless Chrome 157 with a throwaway
Playwright profile, **one production body GLB at close range**
(`cast-jim.glb`, `cast-elf.glb` for the WebGL/WebGPU pair), same camera for
every renderer (`results/cam-cast-jim.json`, taken from the Chromium page).
Harness sources are in `harness/` (the VM rig in `rig/` is untouched).

- **Experiment A (WebGPU), scoped down:** a single-body page, not the full
  world — the console ships no WebGPU path, so the Tea House world page can't
  run on WebGPU without a console change. On real Metal both backends are
  single-digit ms per frame and the images match (mean diff 0.1–0.3/255).
  WebGPU is viable as a look-service mode; the open item is a WebGPU path in
  the console scene code, then a full-world capture to get the
  service-level number (this run does not measure the 55 s world load/encode).
- **Experiment B (native), done for three engines, one body, one run each:**
  Bevy 0.20 is the only one that matches Chromium closely out of the box
  (IoU 0.999); my raw wgpu renderer starts fastest (43 ms process) but needs a
  full PBR shader to match; rend3 0.3 is dead on current macOS without patches
  and did not match framing. Warm frame cost is a few ms for all of them, so
  the decision is startup cost and effort-to-match, not speed. Consistent with
  the scope law: statics/close-up cards only, never live verification.
- **Not measured:** the GPU-less VM numbers for native (no Vulkan adapter
  there), the full-world WebGPU capture, a truly headless Bevy path. Mac
  timings are a fanless/real-GPU indication, not a server GPU benchmark.

**Rig notes for whoever runs this next** (all three cost real time here):
the rig lives in `rig/` (shared scene code `rig/rig.js`; per-backend pages
`rig/page-webgl.html` / `rig/page-webgpu.html`; driver `rig/capture.py`).

1. three r170's `three.webgpu.js` bundle exports `WebGPURenderer` but **not**
   `WebGLRenderer` — the two backends need separate importmaps (hence the
   two pages).
2. `WebGLRenderer.readRenderTargetPixels` rejects a plain
   `THREE.RenderTarget` ("renderTarget is not THREE.WebGLRenderTarget") and
   silently leaves the buffer zeroed — WebGL readback needs
   `THREE.WebGLRenderTarget`.
3. `RenderTarget` defaults to `HalfFloatType` (r152+) — pin
   `UnsignedByteType` for `Uint8Array` readback.
4. Raw capture JSONs for every run above are in `results/`.

## What happens with the answer

- WebGPU wins → the look service gains a WebGPU mode behind its existing env
  config (PR #135 shape), still Chromium, still the real scene.
- Native passes for statics → a small static-shot service for close object
  portraits (e.g. prop/body inspection cards) — scoped by the ruling above,
  never wired into live verification.
- Neither → the GPU pool design (rented Chromium pages on a GPU host) stands
  as the production shape, with this VM's SwiftShader numbers as the floor.
