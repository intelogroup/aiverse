# Skeleton Warrior visual proof — VERDICT: OK ✅

Jim's roster-clearing pass, third body (after Cipher and Eve this morning):
does the Skeleton Warrior — one of the original KayKit cast, in service a
long time but never given this measured proof — look right?
**Yes. It renders as exactly the character the registry describes: the
KayKit chibi skeleton warrior at its intended 1.70 m display size, horned
helmet and all. No scale defect, no texture damage, no rig breakage in
Idle or Walk.**

Method: identical to the Cipher/Eve proofs — fresh checkout of current
main `7c9d1ec4` (verified against origin at run time); the dissolve
build's component rig pattern reused (headless Chromium + SwiftShader
driving the real `CastFigure` with the real production GLB
`cast-skeleton-warrior.glb`, body def taken untouched from
`packages/world-sim/src/bodies.ts` — no hand-tuned scale). Stage shots
only: the component rig cannot mount the full Bazaar scene (that needs
the whole WorldView + stream), so no in-Bazaar frame — stated plainly
rather than faked, same caveat as Cipher's and Eve's reports.

## Frames (frames/)

- `skeleton-front-idle.png` — full body, Idle, front. Whole figure incl. horn tips in frame.
- `skeleton-side-idle.png` — profile. Helmet dome + horn, bowed skull, exposed spine/ribs under the scarf, armoured boot all read correctly.
- `skeleton-walk-stride.png` — Walk mid-stride (from `frames/burst/walk-0..7.png`,
  one full cycle; consecutive-frame pixel diffs 0.97–3.69 mean-abs throughout =
  the cycle is genuinely playing, no frozen frames; the picked frame shows
  the lifted swing boot with its sole turned to camera — a phase Idle never
  produces — and walk-6 confirms the opposite arm/leg counter-swing).

## Proportions — measured in scene units (posed skinned bounds, in-page)

This body's registry nominal is split by design: the scale rule in
`bodies.ts` sizes the FIGURE (head-mesh top, helmet horns excluded) to
1.30 m in GLB space, shown at display scale 1.308 → 1.70 m nominal, with
the horn silhouette riding above it (1.5547 m GLB space). So the honest
comparison separates skull top from horn tip — the harness records
per-mesh bounds for exactly this reason.

| Fact | Registry intent | Measured |
| --- | --- | --- |
| Body height (skull top, horns excluded) | 1.30 × 1.308 = 1.700 m | **1.695 m** (Head mesh maxY) |
| Horn silhouette (whole-figure top) | 1.5547 × 1.308 = 2.034 m | **2.038 m** |
| Hips — upperleg joints (the registry's hipsY basis) | 0.3116 × 1.308 = 0.4076 m | **0.402 / 0.413 m** (L/R) |
| Ground contact (min Y) | 0 | **+0.0105 m** idle, **+0.0015 m** mid-walk |
| Skull share of body height | chibi design ("a head that is half the figure") | 0.707 m ≈ 42% |

Skull top lands 5 mm under nominal and the horn tip 4 mm over its
registry figure — both pose-level noise on a uniform scale, the same
signature as Cipher (3 cm pose bend) and Eve (2.5 cm). A display-scale
miss would read as a ~1.30 m child or a giant; this is the intended
1.70 m adult-chibi standing at the KayKit wave's target height. The
proportions are the character's own: an oversized skull (42% of body
height), short legs (upperleg joints at 0.41 m on a 1.70 m figure — the
registry's own note accepts the consequence: seated, the feet dangle
~0.31 m), a compact torso. Judged against its design, nothing is
squashed or stretched; every per-mesh extent is consistent with the
uniform 1.308 of the bind-audited GLB (registry bind audit: all major
segments 0.00% off the scaled source, weights sum 1.0).

One measurement trap, named so nobody re-trips it: the bone literally
named `hips` in this Rig_Medium reads 0.318 m posed — but the registry's
hipsY is defined on the UPPERLEG joints, which read 0.402/0.413 m,
matching the registered 0.4076 m. The `hips` bone sits below its own
upperlegs in this rig; it is not the registry quantity.

## Grounding

Mid-walk the planted boot comes down to +0.0015 m — on the plane. The
idle sample's lowest skinned vertex rides +0.0105 m: IdleLong's
upturned-toe boot pose (toe bones read 0.040–0.049 m while the walk
plants the sole flat). That idle number is larger than Cipher's
(+0.0003 m) or Eve's (−0.0007 m) — those are flat-soled anatomical rigs;
this is a chibi armoured boot — and in both idle stills the boots read
planted on the disc, not floating: 1 cm on a 1.70 m figure is not
visible as hover. Stated as a measured fact, judged not a defect.

## Textures / materials — this is the intended character

All present and correctly mapped, front, side and mid-stride: warm ivory
bone, the skull with teeth and jaw, **glowing yellow eyes** (a dedicated
Eyes mesh), steel-grey horned helmet with a brown dome, centre crest and
a red wrap band on the right horn, red scarf/cloak, grey torso armour
and belt with a brown strap and buckle, orange-brown trim, armoured
boots with upturned spiked toes. No magenta/missing materials, no UV
smearing or atlas mix-ups on any limb. The figure carries **no weapon**
in this component state — the rig has hand-slot bones, but nothing is
parented into them in the body GLB as rendered; hands wear plain
gauntlets (no individual fingers/claws exist on this KayKit mesh to
deform).

## Rig

Idle: feet planted together, head bowed in the character's hunched
stance, arms hanging true, skull seated on the neck with the jaw closed.
Walk (driven through the normal crowd-frame path at the registered
walkSpeed 0.5194 m/s): a genuine alternating gait — lifted knee-bent
swing leg, planted foot tracking the ground in both phases, arms
counter-swinging, cloak and scarf stable. The classic skeletal failure
modes were checked explicitly: **no skull detachment** (head/jaw/helmet
move as one unit, no gap at the neck in any burst frame), **no
ribcage/spine collapse** under stride (the exposed vertebrae between
scarf and belt stay stacked in the side view and through the burst),
no inverted joints, no limb explosions, no ground penetration.

## On its speed constant (1.2612 in the hunt seed)

Same consistent pattern as Cipher and Eve, confirmed exactly: 1.2612 =
the body's registered run speed 0.9642 m/s × display scale 1.308 =
1.26117 — already display-scaled via `bodyAtScale`, no mismatch. It
only *looks* like an outlier among the original bodies because the seed
mixes quantities per body (e.g. the Mage's 0.3996 is its display-scaled
WALK speed; this body's entry is its display-scaled RUN speed — the
same mixed-quantity seed note from this morning, a data question for
the hunt lane, not a defect in this body). And unlike Eve's (and
Cipher's) values, which the registry flags as estimates, the Skeleton
Warrior's walk/run constants are **measured**: the registry records
them FK-measured on the shipped GLB by the stance method — Walk from
the ankle pair (0.3826 / 0.4115 over the 1.1667 s cycle), Run from all
four stance joints (ankles 0.694 / 0.688, toes 1.236 / 1.239).

## Not applicable at this level

Nameplate anchor and foot contact-shadow marks are RemoteCast/world-layer
concerns; `CastFigure` alone renders neither, so they are not judged here
(the dissolve build already proved this component's contact-shadow path
on Knight/Remy). Nothing else visibly wrong.

Harness (scratch checkout only, never committed): `apps/console/skeleton-proof.html`,
`apps/console/src/proof/skeletonProof.tsx` in `.build-tmp/skeleton-check/work`
(the harness adds per-mesh bounds and a bone dump to the Cipher/Eve pattern —
needed to separate horn tip from skull top, and to catch the hips-bone
naming trap above); drivers `shoot.py` / `measure.py` in
`.build-tmp/skeleton-check/`.
