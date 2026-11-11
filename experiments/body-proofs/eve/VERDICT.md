# Eve visual proof — VERDICT: OK ✅

Jim's word: "Proof Eve the same way" (as Cipher, this morning).
**She passes. Eve renders as a coherent, correctly proportioned adult at
exactly the scale the registry intends — the Mixamo "Space Pirate," eyepatch
and all. No scale defect, no texture damage, no rig breakage in Idle or
Walk. She is cleared as the 8th pickable body.**

Method: identical to the Cipher proof — fresh checkout of current main
`7c9d1ec4` (verified against origin at run time); the dissolve build's
component rig pattern reused (headless Chromium + SwiftShader driving the
real `CastFigure` with the real production GLB `cast-eve.glb`, body def
taken untouched from `packages/world-sim/src/bodies.ts` — no hand-tuned
scale). Stage shots only: the component rig cannot mount the full Bazaar
scene (that needs the whole WorldView + stream), so no in-Bazaar frame —
stated plainly rather than faked, same caveat as Cipher's report.

## Frames (frames/)

- `eve-front-idle.png` — full body, Idle, front. Whole figure in frame.
- `eve-side-idle.png` — profile. Coat, pauldron emblem, prosthetic forearm, heeled boot all read correctly.
- `eve-walk-stride.png` — Walk mid-stride (from `frames/burst/walk-0..7.png`,
  one full cycle; consecutive-frame pixel diffs a uniform 0.67–0.83
  mean-abs throughout = the cycle is genuinely playing, no frozen frames;
  the picked frame shows the lifted, knee-bent swing leg and the opposite
  phase in walk-5 confirms a true alternating gait).

## Proportions — measured in scene units (posed skinned bounds, in-page)

| Fact | Registry intent | Measured |
| --- | --- | --- |
| Standing height | 1.300 m GLB × scale 1.269 = 1.65 m nominal | **1.625 m** |
| Ground contact (min Y) | 0 | **−0.0007 m** idle, −0.003 m mid-walk |
| Hips height | 0.9681 m (0.7629 × 1.269) | 0.938 m (mid-sway bone) |
| Hips / height ratio | — | 0.577 (long-legged, by design) |

The ~2.5 cm under nominal height is pose, not scale — the same IdleLong
knee-bend/head-set effect measured on Cipher this morning (his: 3 cm).
A display-scale miss would read as a child (~1.30 m) or a giant; 1.62 m
posed is the intended 1.65 m adult, shorter than Cipher's 1.78 m exactly
as designed. The higher hips ratio is the registry's own fact: Eve's rig
is longer-legged (raw hips 0.7629 m vs Cipher 0.7045 m).

## Textures / materials — this is the intended character

All present and correctly mapped, front and side: skin and face, dark
hair in a topknot, **eyepatch over her right eye**, black captain's coat
with brass/gold piping and pocket trim, red collar lining, emblem
pauldrons on both shoulders, **both forearms prosthetic** (grey mechanical
— a character feature, not a material failure: the hands and fingers are
modelled and articulate in the walk swing), waist belt with a hip device,
dark leggings, gold knee armour, tall boots with heeled soles. No magenta/
missing materials, no UV smearing or atlas mix-ups on any limb.

## Rig

Idle: feet planted flat (heels included), natural sway, arms hanging true,
prosthetic forearms aligned with the upper arms.
Walk (driven through the normal crowd-frame path at the registered
walkSpeed 1.0406 m/s): clean alternating stride, planted foot tracks the
ground line in both gait phases, swing leg lifts and bends normally, coat
and arms counter-swing, no inverted joints, no limb explosions, no ground
penetration beyond a 3 mm transient inside CastFigure's normal bob
tolerance (Cipher's was 6 mm).

## On her speed constant (3.5913 m/s in the hunt seed)

Same consistent pattern as Cipher, confirmed exactly: 3.5913 = Eve's
registered run speed 2.83 m/s × display scale 1.269 = 3.59127 — already
display-scaled via `bodyAtScale`, no mismatch. One honest asterisk,
inherited from the registry itself: `bodies.ts` marks Eve's walkSpeed/run
values as ESTIMATES (Remy's zero-slip values × her 1.063 hips ratio,
"Re-measure before trusting them"), where Cipher's were measured. So the
seed constant is internally consistent, but the quantity it holds is an
estimate by the registry's own admission — a provenance note for whoever
re-measures her stride, not a defect in how she looks, stands, or walks
on stage: at the registered walkSpeed her feet track the ground cleanly
in both phases of the burst.

## Not applicable at this level

Nameplate anchor and foot contact-shadow marks are RemoteCast/world-layer
concerns; `CastFigure` alone renders neither, so they are not judged here
(the dissolve build already proved this component's contact-shadow path
on Knight/Remy). Nothing else visibly wrong.

Harness (scratch checkout only, never committed): `apps/console/eve-proof.html`,
`apps/console/src/proof/eveProof.tsx` in `.build-tmp/eve-check/work`;
drivers `shoot.py` / `measure.py` in `.build-tmp/eve-check/`.
Run note: the second full tree exhausted the inotify watcher limit; vite
was run with `CHOKIDAR_USEPOLLING=1` — server behaviour otherwise identical.
