# Splat-in-verse load test — trial notes

**Question (Jim's brief, 2026-11-15):** Blender 5.3 renders Gaussian
splats but has no splat export, so that road never reaches the verse.
Can a splat file go straight into the console's Three.js via Spark —
loaded as a verse prop at 262k and ~1M Gaussians — and what does it
cost? Zero spend; procedural sources; production untouched except a
flag-gated module.

**Branch:** `tmp/splat-in-verse` on main
`05c119e87eba4936f7c6854aafa9b54be778b942` (Merge PR #181). Local
only — no push, no PR, no merge (a later sweep packages this).

## Verdict

**DON'T SHIP — yet.** Not a failure verdict: everything this
environment can measure about the pipeline passed (loads are fast and
exact, the wire format is small, the render is correct, the draw-call
cost is one). The one measurement that decides shipping — **frame
time on a GPU** — cannot be taken here: this sandbox renders through
SwiftShader (software GL), where Spark's splat pass costs tens of
seconds per frame in an *empty* scene and the first splat-bearing
frame inside the full city never completed at all. Shipping or
killing the pipeline on software-renderer numbers would be deciding
on an artifact. The deciding test is small and specified at the end.

## Splat sources (procedural, zero spend)

`generate_splats.py` (numpy, fixed seed 20261115) authors a bazaar
stall in three.js Y-up space — rug, posts, counter, back shelf,
striped canopy + fringe, goods (fruit mounds, spice bowls, cloth
bolts, pottery, crates, lantern) — and writes standard 3DGS PLY in
the exact byte layout of the verified Blender 5.3 probe file
(17 float properties, SH DC colors, log scales, opacity logits,
w-first quaternions; verified: unit quaternions, 0 NaNs, body bytes
== n × 68 exactly).

| file | Gaussians | bytes | bytes/Gaussian |
|---|---|---|---|
| `bazaar-stall-262k.ply` | 262,144 | 17,826,208 | 68.0 |
| `bazaar-stall-1m.ply` | 1,000,000 | 68,000,417 | 68.0 |
| `bazaar-stall-262k.spz` | 262,144 | 2,587,677 | 9.87 (−85.5%) |

The SPZ was produced from the PLY with Spark's own `transcodeSpz`
(Node probe, `spz.mjs`, 2.6 s) — SPZ is the obvious wire format:
~7× smaller, and it loads ~2–4× faster (below).

## Loader

`src/features/world/SplatTrial.tsx`, mounted from `GlbWorld.tsx`
(one import + one mount line). Behavior:

- No flag → the component returns null **and Spark is never
  imported**. Spark ships as its own lazy chunk
  (`spark.module-*.js`, 482,818 B) behind a dynamic `import()` that
  only runs when the flag is present.
- `?splat=1` / `?splat=262k` → 262k PLY; `?splat=1m` → 1M PLY;
  `?splat=spz` → 262k SPZ. One stall at (14, 0, 33) in the bazaar,
  object-level transform only (position; no per-splat edits).
- Exposes `window.__splatTrial = { mode, state, t0, loadMs,
  numSplats, error }` for the rigs — registered in the sensorium
  window-globals allowlist with its justification, per repo rule.
- PLY/SPZ files live in this trial dir; the rigs stage them into
  `dist/splat-trial/` for local serving. A production ship would
  serve them from `public/` or R2 like the other world assets.

**Spark version: `@sparkjsdev/spark@0.1.10`, pinned exact.** The
current Spark line (2.4.0) declares a peer of three ≥ 0.180; the
console pins three 0.170, and running two threes would break the
scene graph. 0.1.10 is the last pre-2.0 release; it declares no
three dependency and uses the host's. Two consequences:

- **Spark 0.1.10 is WebGL2-only** — its bundle contains no WebGPU
  code paths at all. A WebGPU splat path requires Spark 2.x, which
  requires a three upgrade. Out of scope here.
- Spark's docs prefer the WebGLRenderer created with
  `antialias: false`; the console uses `antialias: true`. Noted as a
  quirk — loads and renders were correct regardless.

## Environment (what was actually measured)

Playwright headless Chromium (headless-shell build 1200),
SwiftShader WebGL2, 640×360 unless noted, static-served production
build (`VITE_ASSET_BASE=""` so assets resolve locally). **WebGPU:
`navigator.gpu` present but `requestAdapter()` returns null** in
this browser — and per above, Spark 0.1.10 couldn't use WebGPU
anyway. Every frame-time number below is software rendering and is
**not production-representative**; deltas and load behavior are the
signal, per the brief.

## Load results (per backend)

Backend exercised: **WebGL2 fallback (SwiftShader)**. WebGPU: not
exercisable here (no adapter; Spark 0.1.10 has no WebGPU path).

Loads measured in an isolated probe scene (`probe.html` /
`probe.mjs`: empty three scene + SparkRenderer + the one file), so
the numbers are Spark's, uncontaminated by the city. All loads
succeeded with the exact Gaussian count and zero errors, across
repeated runs (ranges are run-to-run under varying box contention):

| source | loadMs (initialized) | numSplats |
|---|---|---|
| PLY 262k | 2,174–3,177 ms | 262,144 |
| PLY 1M | 4,166–5,411 ms | 1,000,000 |
| SPZ 262k | 760–1,677 ms | 262,144 |

Load scales sub-linearly with count (fetch + parse dominate) and
SPZ's smaller wire size wins twice: fewer bytes, faster load.

## Draw calls

Measured directly from `renderer.info` in the probe: the splat mesh
renders as **+1 draw call, +524,288 triangles at 262k** (2
triangles per Gaussian quad; +2,000,000 tris at 1M by the same
construction). Against the city's 18,274-call baseline, one splat
prop is noise in call count — the cost lives entirely in the
per-frame splat pass, not in call overhead.

## Frame time

Probe scene (empty world, same splat, 640×360, SwiftShader):

| scene | frame behavior |
|---|---|
| empty | ≥400 frames in <20 s (full rAF rate) |
| + 262k splat | ~60–145 fast pre-load frames, then ~1 frame per 10–40 s |
| + 1M splat | ~210–230 early frames, then no completed frame in 30+ s |

In the city (branch build, `?splat=1`): the scene presents normally
until the splat's first frame, which **never completed** in three
attempts — 10+ min at 640×360, 6.5+ min at 320×180; renderer main
thread blocked throughout, GPU process at ~120–126% CPU. In the
film run the picture froze the same way and the page later closed
during the hold. Context: the stock city alone is already at
seconds-per-frame under SwiftShader (≈9.7 s orbit frame in the
batching trial's session; 69 s median in this session's contended
baseline run) — the splat pass multiplies a frame that is already
barely producible here. In-view vs out-of-view and 262k-vs-1M
in-city frame deltas are therefore **not measurable in this
environment**; the probe gradient (empty ≫ 262k > 1M, all under
software GL) is the honest form of that measurement.

## Memory

JS heap via `performance.memory` (coarse buckets in this browser;
GPU-side buffers not visible to it): probe scene empty 10 MB;
+262k PLY 32 MB; +1M PLY 32 MB (same coarse bucket); +262k SPZ
20 MB. City baseline at orbit: 539.6 MB used JS heap (main,
flag-off run). Read: a splat prop's JS-side footprint is tens of MB
at most; the real memory lives in GPU buffers this instrument
can't see — on real hardware that's the packed textures, roughly
proportional to the SPZ size class, not the PLY size.

## Flag-off parity (the no-flag promise)

Same settled-plateau protocol as the LOD/batching trials. Branch
with no flag, ORBIT plateau (two identical consecutive reads):
**18,274 calls / 7,779,994 tris / 4,306 geometries / 356 textures**.
Pristine main `05c119e8`, built and measured fresh in the same
session: reads 18,262 → 18,264 → **18,274 / 7,779,994 / 4,306 /
356** (the confirming second plateau read was starved by box
contention timeouts; the plateau value itself was read and is
identical). Also identical to the batching trial's main baseline.
With no flag, the branch is byte-for-byte the same scene.

## Film

`runs/film-262k/film.mp4` — H.264, 640×360, ffprobe-verified
(357 frames in file, 568.7 s). Screencast started before load per
protocol; 361 frames captured over 637.6 s = **0.566 fps actual**.
Content: the verse loading in and the orbit view, then the freeze
as splat-bearing frames stop completing; the in-page orbit driver
never installed (its evaluate raced the wedge, and the page closed
during the hold). **The ≥10 fps bar is not met** — it is not
reachable in this environment for the stock city even without a
splat; the film is kept as the truthful record of that, not as a
showcase. Sample frames in `runs/film-262k/sample-frames/`.

The visual proof that the splat itself renders correctly is the
probe still `runs/probe-cast-262k-055.jpg`: the stall is
unmistakably a bazaar stall — striped canopy with fringe, posts,
counter with fruit mounds and goods, hanging lantern, side crates,
rug — from the procedural PLY through Spark, nothing else in the
scene.

## Gates

- `tsc -b` + `vite build`: clean on the final tree (exit 0).
- Console vitest (859 tests): run 1 — 858 passed, 1 failed:
  sensorium window-globals guard on the then-unregistered
  `__splatTrial`; fixed by registering it in the guard's allowlist
  with its justification (the repo's own mechanism), suite then
  6/6. Run 2 — 858 passed, 1 failed: `world-look` p95 timing-ratio
  (0.63 under heavy box contention vs 0.46 in run 1); standalone it
  passes 9/9 on this branch and 9/9 on pristine main. Net: **no
  worse than baseline.**

## Honest limits

- **Splats are visual props only.** No collision geometry, no
  navmesh — agents can't walk to, around, or use a splat prop; the
  world sim would need a mesh proxy for any of that.
- **No GPU number exists.** All frame costs are SwiftShader.
  Spark is a production library (the dev.to write-up that prompted
  this trial runs a million-point file in a browser), so GPU reality
  is likely fine — but "likely" is not a measurement.
- The in-city stall placement (14, 0, 33) was chosen to sit in the
  P1 view; its in-city grounding was never screenshot-verified
  (no splat-bearing city frame ever completed here). In the probe
  scene the same file sits correctly on y=0.
- Spark is pinned to a legacy line by the console's three version;
  the WebGPU road needs Spark 2.x + three ≥ 0.180.

## The deciding test (what would flip the verdict)

Serve this branch's build to any GPU browser (Jim's Mac is enough):
open `/?splat=1` and `/?splat=1m`, read frame times at the orbit
and stall views, in/out of view, via the same `__splatTrial` +
`renderer.info` handles. If 1M holds a few-ms frame cost on GPU —
the expected result — the pipeline ships as: SPZ on R2, Spark
behind the flag until a three upgrade unblocks Spark 2.x/WebGPU.
If GPU frame cost is ugly, splats stay a Blender-side rendering
tool and the verse keeps mesh props.

## Deviations from the brief's letter

- Poses: P1/IN/OUT settled reads with the splat were attempted
  (three runs, two viewports) and are physically unobtainable in
  this environment — the first splat-bearing city frame does not
  complete. ORBIT parity, probe-scene isolation runs, and the film
  carry the evidence instead; the plateau protocol itself was not
  changed.
- Film fps: 0.566 actual vs the ≥10 asked — reported, not padded.
- Rig driver is Playwright (headless-shell 1200), matching the
  batching trial's protocol; an earlier puppeteer attempt starved
  evaluates and was discarded.
- One VM restart mid-task (2026-11-16 ~02:06 ET) killed the first
  build; all work was in the durable worktree and resumed.
