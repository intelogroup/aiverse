# Renderer tests — WebGPU verification path + native static shots

**Status:** INSTRUCTIONS / IN PROGRESS. This PR is the test brief first and the
results record second. It exists so the test can move between hosts (this VM →
Jim's MacBook) with its full context intact: anyone picking it up from this PR
alone has the whole picture.

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
| VM | WebGL (baseline) | | | | |
| VM | WebGPU | | | | |
| VM | Native (Exp. B) | | | | |
| MacBook | WebGL | | | | |
| MacBook | WebGPU | | | | |
| MacBook | Native (Exp. B) | | | | |

**Verdicts:** (pending)

## What happens with the answer

- WebGPU wins → the look service gains a WebGPU mode behind its existing env
  config (PR #135 shape), still Chromium, still the real scene.
- Native passes for statics → a small static-shot service for close object
  portraits (e.g. prop/body inspection cards) — scoped by the ruling above,
  never wired into live verification.
- Neither → the GPU pool design (rented Chromium pages on a GPU host) stands
  as the production shape, with this VM's SwiftShader numbers as the floor.
