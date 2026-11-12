# Jim visual check — VERDICT: OK ✅

Jim's question: does the new Jim body (Meshy-generated from his own
reference photos, this PR) look right in the verse?
**Yes. Jim renders as a coherent, correctly proportioned adult — black
tee, black pants, black-and-white sneakers, short curly hair, goatee —
at the registry's scale, feet on the floor, textures clean, Idle and
Walk rigs sound.**

Method: checkout of this PR's branch; the consolidated proof runner
(`experiments/body-proofs/runner/`) — headless Chromium + SwiftShader
driving the real `CastFigure` with the real production GLB
`cast-jim.glb`, body def taken untouched from
`packages/world-sim/src/bodies.ts` — no hand-tuned scale. Stage shots
only: the component rig cannot mount the full Bazaar scene, so no
in-Bazaar frame — stated plainly rather than faked.

## Frames

- `jim-front-idle.png` — full body, Idle, front. Whole figure in frame.
- `jim-side-idle.png` — profile. Hair, tee drape, sneaker profile all read correctly.
- `jim-walk-stride.png` — Walk mid-stride (burst frame 2 of 8 across one
  cycle; the forward leg is planted and the rear foot is in toe-off —
  the cycle genuinely plays).

## Proportions — measured in scene units (posed skinned bounds, in-page)

| Fact | Registry intent | Measured |
| --- | --- | --- |
| Standing height | 1.300 m GLB × scale 1.3077 = 1.70 m nominal | **1.640 m** |
| Ground contact (min Y) | 0 | **+0.0029 m** idle, −0.0001 m mid-walk |
| Hips height | 0.9549 m (0.7302 × 1.3077) | 0.909 m (mid-sway bone) |
| Hips / height ratio | — | 0.554 (normal human band) |

The 6 cm under nominal height is pose, not scale: the bind-bounds
figure (1.3000 m, exact at bake) is a bind-pose measure, and IdleLong's
hip/knee flexion costs more height on this longer-legged Meshy template
(hips ratio 0.562) than on the Mixamo roster (Cipher −3 cm, Eve −2.5 cm,
same signature). A display-scale miss would read as a child (~1.3 m) or
a giant; 1.64 m posed is an adult standing at the designed 1.70 m class.
Feet stay on the plane throughout — no hover, no sinking.

## Textures / materials

All present and correctly mapped: face with goatee, short curly hair,
plain black tee, black pants, and the black-and-white sneakers with
their white soles and stripes — front, side and mid-stride. No
magenta/missing materials, no UV smearing.

## Rig

Idle: feet planted together, natural sway, arms hanging true. Walk
(driven through the normal crowd-frame path at the registered walkSpeed
1.1129 m/s display): clean stride cycle, planted foot tracks the ground
line, rear foot rolls into toe-off, arms counter-swing naturally, no
inverted joints, no limb explosions, no ground penetration.

## On the speed constants

Like the Elf's, Jim's registry speeds were measured on the shipped GLB
by FK stance sampling (see the `bodies.ts` comment), not estimated:
Walk 0.851 m/s raw (1.1129 display), Run 2.106 raw (2.754 display — the
hunt `body_constants` seed value). The stance method reproduces
Skeleton Warrior's registry Walk exactly; on Remy it reads +15% Walk /
−15% Run against the zero-slip sweep, so Run carries a ±15% tolerance.
The render above proves the scale itself is right.

## Not applicable at this level

Nameplate anchor and foot contact-shadow marks are RemoteCast/world-layer
concerns; `CastFigure` alone renders neither, so they are not judged here.
Nothing else visibly wrong.

Harness: `experiments/body-proofs/runner/` (run 2026-11-11 from this
PR's checkout; the scratch copies in `apps/console/` were not committed,
the runner's own copies are the ones in `runner/`).
