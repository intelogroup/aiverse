# Cipher visual check — VERDICT: OK ✅

Jim's question: does the new Cipher body (PR #108) look right in the verse?
**Yes. Cipher renders as a coherent, correctly proportioned adult soldier at
exactly the scale the registry intends. No scale defect, no texture damage,
no rig breakage in Idle or Walk.**

Method: fresh checkout of main `7c9d1ec4`; the dissolve build's component
rig pattern reused (headless Chromium + SwiftShader driving the real
`CastFigure` with the real production GLB `cast-cipher.glb`, body def taken
untouched from `packages/world-sim/src/bodies.ts` — no hand-tuned scale).
Stage shots only: the component rig cannot mount the full Bazaar scene
(that needs the whole WorldView + stream), so no in-Bazaar frame — stated
plainly rather than faked.

## Frames (frames/)

- `cipher-front-idle.png` — full body, Idle, front. Whole figure in frame.
- `cipher-side-idle.png` — profile. Vest bulk, arm hang, thigh holster all read correctly.
- `cipher-walk-stride.png` — Walk mid-stride (from `frames/burst/walk-0..7.png`,
  one full cycle; consecutive-frame pixel diffs 1.2–1.7 mean-abs throughout =
  the cycle is genuinely playing, and the picked frame shows the lifted,
  knee-bent swing leg Idle never produces).

## Proportions — measured in scene units (posed skinned bounds, in-page)

| Fact | Registry intent | Measured |
| --- | --- | --- |
| Standing height | 1.300 m GLB × scale 1.369 = 1.78 m nominal | **1.750 m** |
| Ground contact (min Y) | 0 | **+0.0003 m** idle, −0.006 m mid-walk |
| Hips height | 0.9645 m (0.7045 × 1.369) | 0.941 m (mid-sway bone) |
| Hips / height ratio | — | 0.538 (normal human band) |

The 3 cm under nominal height is pose, not scale: the bind-bounds figure
(1.3000 m) is a bind-pose measure, and IdleLong's slight knee bend/head set
costs ~2 cm — the same effect the registry records for the older bodies.
A display-scale miss of the flagged kind would read as a child (~1.3 m) or a
giant; 1.75 m is an adult standing next to Remy's 1.78 m target as designed.

## Textures / materials

All present and correctly mapped: face skin, helmet + goggles, blue uniform
fabric with seams and pockets, black tactical vest with pouch detail, knee
pads, gloves, thigh holster, boots. No magenta/missing materials, no UV
smearing or atlas mix-ups on any limb, front or side.

## Rig

Idle: feet planted together, natural sway, arms hanging true.
Walk (driven through the normal crowd-frame path at the registered
walkSpeed 1.0952 m/s, playback rate 1.0): clean stride cycle, planted foot
tracks the ground line, swing leg lifts and bends normally, no inverted
joints, no limb explosions, no ground penetration beyond a 6 mm transient
inside CastFigure's normal bob tolerance.

## On the flagged speed constant (3.7648 m/s)

Not a visual scale problem. 3.7648 = Cipher's registered run speed
2.75 m/s × display scale 1.369 — it is already display-scaled, consistent
with `bodyAtScale` math, and the render above proves the scale itself is
right. The ~9× contrast is against the older bodies' hunt seed entries
(0.3996–1.2612), which sit in walk-speed territory — if anything is off,
it's which quantity the hunt `body_constants` seed holds per body, a data
question for the hunt lane, not a defect in how Cipher looks or stands.

## Not applicable at this level

Nameplate anchor and foot contact-shadow marks are RemoteCast/world-layer
concerns; `CastFigure` alone renders neither, so they are not judged here
(the dissolve build already proved this component's contact-shadow path
on Knight/Remy). Nothing else visibly wrong.

Harness (scratch checkout only, never committed): `apps/console/cipher-proof.html`,
`apps/console/src/proof/cipherProof.tsx` in `.build-tmp/cipher-check/work`;
drivers `shoot.py` / `measure.py` in `.build-tmp/cipher-check/`.
