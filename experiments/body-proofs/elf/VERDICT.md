# Elf visual check — VERDICT: OK ✅

Jim's question: does the new Elf body (Meshy-generated, this PR) look right in the verse?
**Yes. The Elf renders as a coherent, correctly proportioned adult fantasy
warrior — silver armour, long silver hair, two sheathed blades — at the
registry's scale, feet on the floor, textures clean, Idle and Walk rigs
sound.**

Method: checkout of this PR's branch; the consolidated proof runner
(`experiments/body-proofs/runner/`) — headless Chromium + SwiftShader
driving the real `CastFigure` with the real production GLB
`cast-elf.glb`, body def taken untouched from
`packages/world-sim/src/bodies.ts` — no hand-tuned scale. Stage shots
only: the component rig cannot mount the full Bazaar scene, so no
in-Bazaar frame — stated plainly rather than faked.

## Frames

- `elf-front-idle.png` — full body, Idle, front. Whole figure in frame.
- `elf-side-idle.png` — profile. Hair fall, armour bulk, sheathed blade all read correctly.
- `elf-walk-stride.png` — Walk mid-stride (burst frame 2 of 8 across one
  cycle; the cycle genuinely plays — the swing leg is lifted and
  knee-bent, a pose Idle never produces).

## Proportions — measured in scene units (posed skinned bounds, in-page)

| Fact | Registry intent | Measured |
| --- | --- | --- |
| Standing height | 1.300 m GLB × scale 1.3077 = 1.70 m nominal | **1.649 m** |
| Ground contact (min Y) | 0 | **+0.0024 m** idle, +0.0039 m mid-walk |
| Hips height | 0.9549 m (0.7302 × 1.3077) | 0.917 m (mid-sway bone) |
| Hips / height ratio | — | 0.556 (normal human band) |

The 5 cm under nominal height is pose, not scale: the bind-bounds
figure (1.3000 m, exact at bake) is a bind-pose measure, and IdleLong's
hip/knee flexion costs more height on this longer-legged Meshy template
(hips ratio 0.562) than on the Mixamo roster (Cipher −3 cm, Eve −2.5 cm,
same signature). A display-scale miss would read as a child (~1.3 m) or
a giant; 1.65 m posed is an adult. Feet stay on the plane throughout —
no hover, no sinking.

## Textures / materials

All present and correctly mapped: face and pointed ears, long silver
hair, ornate silver chest armour with engraved detail, dark leather
under-layer, bracers, belt, dark trousers, armoured boots, and the two
sheathed blades riding at the hips in both Idle and Walk. No
magenta/missing materials, no UV smearing.

## Rig

Idle: feet planted together, natural sway, arms hanging true, blades
static at the hips. Walk (driven through the normal crowd-frame path at
the registered walkSpeed 1.2397 m/s display): clean stride cycle,
planted foot tracks the ground line, swing leg lifts and bends
normally, hair and blades follow without detachment, no inverted
joints, no limb explosions, no ground penetration.

## On the speed constants

Unlike Cipher/Eve, whose registry speeds are estimates, the Elf's were
measured on the shipped GLB by FK stance sampling (see the `bodies.ts`
comment): Walk 0.948 m/s raw (1.2397 display), Run 2.199 raw (2.8756
display — the hunt `body_constants` seed value). The stance method
reproduces Skeleton Warrior's registry Walk exactly; on Remy it reads
+15% Walk / −15% Run against the zero-slip sweep, so Run carries a
±15% tolerance. The render above proves the scale itself is right.

## Not applicable at this level

Nameplate anchor and foot contact-shadow marks are RemoteCast/world-layer
concerns; `CastFigure` alone renders neither, so they are not judged here.
Nothing else visibly wrong.

Harness: `experiments/body-proofs/runner/` (run 2026-11-11 from this
PR's checkout; the scratch copies in `apps/console/` were not committed,
the runner's own copies are the ones in `runner/`).
