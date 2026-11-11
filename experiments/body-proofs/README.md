# Body proofs — measured visual checks for cast bodies

On 2026-11-11 Jim cleared the agent-body roster body by body. Three of
those clearances were *measured proofs*, not eyeball-only: the real
`CastFigure` component wearing the real production GLB, at the body's
untouched registry registration, rendered on a stage rig and measured in
scene units. This directory is the durable record of those proofs plus
the consolidated runner that produced them, so any future body can be
put through the identical check.

## Contents

| Path | What |
| --- | --- |
| `cipher/VERDICT.md` + 3 frames | Cipher (Mixamo, PR #108) — **OK**. Posed height 1.750 m vs 1.78 m nominal (pose bend), feet at +0.0003 m idle. |
| `eve/VERDICT.md` + 3 frames | Eve (Mixamo "Space Pirate", PR #108) — **OK**. Posed height 1.625 m vs 1.65 m nominal, feet at −0.0007 m idle. |
| `skeleton-warrior/VERDICT.md` + 3 frames | Skeleton Warrior (KayKit original cast) — **OK**. Skull top 1.695 m vs 1.700 m nominal, horn silhouette 2.038 m vs 2.034 m, planted mid-walk at +0.0015 m. |
| `runner/bodyProof.tsx` | The stage: one parametrized proof page (see below). |
| `runner/body-proof.html` | Page shell for the stage. |
| `runner/run_proof.py` | The driver: body id in → frames + measurements out. |

The VERDICT.md files are the original lane reports, copied byte-for-byte;
their findings are the record. (They describe the harness as "scratch,
never committed" — that was true when written; this directory is the
later landing Jim ordered, and the per-body harness copies they mention
were consolidated into `runner/`.)

## Method

Same rig for every body, no per-body tuning:

- Headless Chromium + SwiftShader drives the console's real `CastFigure`
  with the production GLB; the body definition (display scale, clips,
  walkSpeed) is taken untouched from `packages/world-sim/src/bodies.ts`
  via the registry's `BODIES` record — the runner looks the body up by
  registry id and cannot hand-tune a scale.
- Views: Idle from the front (+Z) and side (+X), then the Walk clip
  driven through the normal crowd-frame path at the registered
  walkSpeed, shot as an 8-frame burst across one cycle; burst frame 2
  is the mid-stride hero frame (the pick all three verdicts used).
- While rendering, the stage measures the *posed* figure in-page:
  skinned-mesh bounds (whole figure and per mesh), bone heights, ground
  contact (min Y), and the registered facts it was rendered with.
  Measurements print as JSON and land in `measurements.json`.

Stage shots only: the component rig cannot mount the full Bazaar scene
(that needs the whole WorldView + stream), so there are no in-Bazaar
frames, and nameplate anchor / contact-shadow — RemoteCast-layer
concerns — are not judged here. All three verdicts state this caveat
themselves.

## What a pass means

A human verdict (Jim's) over the runner's evidence, against the
registry's own numbers:

- **Proportions** — measured posed height lands on the registry nominal
  within pose tolerance (an Idle pose bend of ~2–3 cm is the known
  signature across all three bodies; a display-scale miss would read as
  a child-sized or giant figure, not a few cm).
- **Grounding** — feet on the plane: min Y ≈ 0 at idle and mid-walk
  (millimetre-level bob is normal; visible hover or sinking is not).
- **Materials** — every texture present and correctly mapped; no
  magenta/missing material, no UV smearing.
- **Rig** — Idle and Walk clean: no inverted joints, no limb
  explosions, no detachment, no ground penetration; the clip cycle
  genuinely plays (burst frames differ).
- The speed constant is cross-checked against the registry
  (`bodyAtScale`): each verdict records whether it is consistent and
  whether the registry marks the value measured or estimated.

## How to run

Needs a checkout of this repo with console dependencies installed, plus
Python 3 with Playwright + Chromium (the sandbox lanes used the
`playwright` pip package with its bundled Chromium).

```sh
# 1. In a SCRATCH checkout (never commit these two copies):
cp experiments/body-proofs/runner/body-proof.html  apps/console/
cp experiments/body-proofs/runner/bodyProof.tsx    apps/console/src/proof/

# 2. Serve the console:
cd apps/console && bunx vite --port 5199 --host 127.0.0.1 &

# 3. Drive it (from experiments/body-proofs/runner/):
python3 run_proof.py skeleton-warrior --out ./frames
# -> frames/skeleton-warrior-front-idle.png, ...-side-idle.png,
#    frames/burst/walk-0..7.png, frames/skeleton-warrior-walk-stride.png,
#    frames/measurements.json
```

Any registered body id works (`cipher`, `eve`, `remy`, …); an unknown
id fails loudly with the known-id list.

## Evidence notes

- The committed frames are the original 2026-11-11 captures at full
  size (56–113 KB each) — no downsizing was needed.
- The 8-frame walk bursts are *not* committed (24 frames of near-dupes);
  each verdict describes its burst, and re-running the runner
  regenerates them. The originals remain in the sandbox lane records
  (`~/workspace/.build-tmp/{cipher,eve,skeleton}-check/`).
- Frame filenames in `skeleton-warrior/` keep their original
  `skeleton-*` names; the runner writes `<body-id>-*` names.
