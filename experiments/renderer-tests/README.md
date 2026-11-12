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
| MacBook | WebGL | | not run — test shortened at Jim's word | | |
| MacBook | WebGPU | | not run — test shortened at Jim's word | | |
| MacBook | Native (Exp. B) | | not run — test shortened at Jim's word | | |

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
