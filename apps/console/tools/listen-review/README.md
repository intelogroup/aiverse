# Listen-review — ears for the verse's sound stack

A spec-driven QA harness that lets an agent *listen* to the console's
sound layer numerically and get a verdict it can iterate against,
instead of a human having to audition every build.

## The procedure, and where it comes from

This is the review loop from **earshot** (Leon Lin, MIT —
github.com/Leonxlnx/earshot), adapted from offline video edits to a
live world. Earshot itself is not vendored: it analyzes rendered
files, and a world has no render to hand it. What was taken, from
`earshot/critique.py`:

- **A scorecard of named checks**, each declared with a *weight*
  (critical 3 / major 2 / minor 1), an *expected range* (earshot
  calls these practice windows when they don't come from a
  reference profile), the *sides* checked, and a *why it matters*
  string. Here the scorecard lives in `spec.json`, and the ranges
  are the values the shipped stack was proven at (PR #36 / PR #35
  proof numbers and the `soundLogic.ts` constants behind them).
- **Per-measurement status**: `ok`, `low`, `high` — plus `miss` for
  predicate measurements (presence/equality), `skipped` when a
  check's subject is absent from the tree under test (earshot's
  n.a.-with-a-reason), and `error` when a scene could not be
  performed at all.
- **The verdict maths**: weighted share of in-range scored checks;
  *launch-grade* ≥ 90% with no critical issue, *close* ≥ 75% with
  no critical issue, *needs work* ≥ 50%, else *not launch-grade*.
  The headline is earshot's format: `verdict — X of Y scored checks
  in range (weighted NN%), C critical and M major issues.`
- **FIX FIRST**: out-of-range checks are listed most-important
  first, each with its measured-vs-range detail and a fix hint —
  earshot emits "actions"; ours are spec-declared because a live
  scene's remedy is code, not an edit decision.

What changed in the adaptation: earshot segments a *file* and
measures each segment offline. A world is measured *in place* —
each check performs a scene (teleports, announcements, a real
consent click) in a headless production build and samples the
sound director's per-bus analysers through the `?soundDebug=1`
hook (`window.__sound.snapshot()`), poll-until-converged because
the headless frame feed lags seconds behind teleports.

## Checks (v1 scorecard)

| id | weight | what it proves |
|---|---|---|
| `permission-gate` | critical | No audio reaches the destination before permission is asked and given (context not created / suspended, destination analysers at zero even with an announcement registered); after consent, the context runs and a PA clip measurably reaches the master analyser. Runs in a browser *without* the autoplay-policy bypass. The scene gives consent the way the tree under test asks for it: the labelled **Enable sound** control on consent-gated trees (PR #37+), a raw walk-mode gesture on older gesture-arming trees — the run log records which path fired. (On the pre-gate trees that fallback *was* the gap this check exists to expose: arming used to be any first gesture, with no explicit ask.) |
| `pa-in-district` | critical | In-scope PA: banner + playing + paLevel peak in 0.10–0.16 (measured 0.125/0.129 on PR #36). |
| `wind-bazaar` | major | Wind bed at WIND_GAIN 0.055 in the Bazaar. |
| `wind-outside-bazaar` | major | Wind silent in the Glass Quarter (scope geography). |
| `pa-out-of-district` | major | Out-of-scope PA registers (+1 announcement) but is unheard: no banner, no playback, no energy. |
| `tea-house-music` | major | Zone music 0.17 inside the tea room rect, 0 outside. |
| `mage-stall-emitter` | major | Positional emitter curve 0 / 0.0597 / 0.17 at 16 / 8 / 2 m. **Skips itself** when the emitter (PR #35) is absent from the tree under test. |

## Running

```sh
cd apps/console
bun run build                      # or pass --build to the harness
python3 tools/listen-review/listen_review.py            # boots vite preview itself
python3 tools/listen-review/listen_review.py --url http://127.0.0.1:5190/
python3 tools/listen-review/listen_review.py --only pa-in-district,permission-gate
```

Requirements: python3 with `playwright` (+ its chromium), bun.
Exit code: 0 = every scored check in range, 1 = any out-of-range,
2 = harness error. The JSON report lands next to the spec
(`listen-review-report.json`) or at `--out`.

A full run takes a while: SwiftShader renders the world slowly,
and scenes poll for convergence rather than assuming timings.

## Extending the scorecard

Add a check object to `spec.json`: steps perform the scene
(`put`, `announce`, `poll`, `sample`, `arm`, `realClick`,
`realKey`, `clickWalkButton`, `sleep`, `snapshot`), measures read
snapshot fields (`gains.wind`, `paLevel`, `masterLevel`,
`ctxState`, `banner`, …) from named sampling buckets with an
aggregation (`peak`, `mean`, `min`, `last`, `delta`, `present`,
`absent`, `equals`, `in`) and an expected range. Ranges must come
from measurements or constants, with the source named in the
check's `why` — never widen a range to turn a red check green
without recording the evidence.
