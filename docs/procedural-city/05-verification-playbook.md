# Verification playbook

## Visual (do this for every geometry/material change)
1. Export the GLB; load it in a **plain three.js page** driven by Playwright (`harness/city.html` + `city.mjs`): AgX tone mapping, hemisphere + sun with
   `shadow.bias −0.0004 / normalBias 0.8`, `FogExp2`, sky colour. Views are passed as JSON in the query (`v={"name":[[camera],[target]]}`),
   screenshots are written as PNGs. Read them with the image Read tool.
2. Check at three scales: overview (iso), street (eye level ~5 m), close-up of one facade (3–6 m), and any interior (cutaway from above + eye level).
3. Then confirm in the **real console** (`vite` + Playwright, `?world=city3`): buttons, clipping, streaming. Software GL needs ~25 s to load.
4. Blender EEVEE renders (`tools/city3/preview.py`) are for layout sanity only; they use a different tone curve and hid the three-only bugs.

Bugs only a render exposed: backwards hip-roof faces (holes), z-fighting signs (2 mm gap), shadow-acne rings, dithered neighbour wall at a clip plane,
empty "built" interiors, stretched sign texture, floating balconies (slab at the wrong height), turn clip twisting the body by 62°.

## Numbers/logic (vitest, headless)
- Pure modules (`cutaway.ts`, `interiors.ts`, `bodyController.ts`, `city3.ts`) are three-free where possible so they test without WebGL.
- Real Recast crowd headless: `// @vitest-environment node`, `createPlatformCrowd(9.7, n, {seed, keepOutRadius: 2.2})`. See `bodyCrowd.test.ts`.
- Closed-loop sims with a stub crowd (8 m/s² like Detour) give before/after numbers for controllers.
- Generated data checkers belong in the generator (`check_anchors.py`: props inside building, stand points on open floor, no shared stand points,
  facing/approach consistency). They found 63 real layout conflicts.

## Memory/leak tests (real console)
`harness/stream_rooms.mjs`: N random teleports; after each, read `window.__city3Stream.snapshot()`:
resident ≤ cap, **scene instanced meshes == handle claim**, geometries/textures flat after warm-up, JS heap flat (CDP `HeapProfiler.collectGarbage` x2
then `Performance.getMetrics` JSHeapUsedSize), loads == evictions after leaving, each layout/library fetched once. 100 cycles ≈ 6 min in software GL; run it in
the background.

## Animation correctness
`harness/tv4.html`: the controller's world-space foot positions vs the original clip's, best rigid yaw fit (should equal the clip's start offset, error in
mm). `harness/turn_verify.html`: pelvis yaw vs heading. Measure clip properties in **three space** (Blender axes flip signs).

## What NOT to trust
- Handle/bookkeeping counters (use scene/renderer truth).
- Height-threshold "foot contact" slide metrics (a stepping foot has fewer low frames, flattering the result). Use the rigid-fit test.
- Blender-side "bone axis" yaw (a hip bone's local Y is not horizontal mid-clip: produced a fake 250% overshoot). Use two joints (left/right upper leg).
- Any live sim number from software GL beyond ~2 s of sim time.
- A passing test whose assertion I wrote from my own wrong expectation (three of mine were wrong, not the code): when a test fails, decide which side is wrong.
