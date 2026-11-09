# Jev Context Experiment — Report

*Run 2026-11-09, ~12:23–12:32 ET, on Jim's hypothesis and his go (12:18).
Question: this morning Jev lost to Luna on sighting-confirm (acc 0.617 vs
0.850, ROC-AUC 0.374) while fed a thin serialized CV-feature digest. Was Jev
starved — of context QUANTITY, or of context KIND? Same 120 held-out items,
same truth labels, same question as the A/B (batch composition inherited:
4 egg / 116 not-egg, enriched — majority baseline 0.967, so accuracy flatters
any reject-leaning judge; balanced accuracy and AUC are the honest reads).
Metric code is `ab_tally_b.py`'s `score()` verbatim for all five arms.*

---

## HEADLINE VERDICT — Jim's hypothesis: CONFIRMED on both causes, kind ≫ quantity

- **Quantity helped (B → C): decisiveness and raw accuracy, not discrimination.**
  Accuracy 0.617 → 0.958 (paired items: full-context-only-right **43** vs
  digest-only-right **2**), probabilities unstick from 0.5 (range 0.33–0.61 →
  0.05–0.52), abstention goes from answering nothing at any τ ≥ 0.7 to
  answering 85% of items at τ=0.7. But ranking barely moved (ROC-AUC
  0.374 → 0.513, still ~chance), PR-AUC 0.033 → 0.042, and at the 0.5 line
  Jev-full finds **0/4 eggs** — what the extra context mostly bought, in
  structured form, was a willingness to commit to "not-egg" on a
  96.7%-negative batch.
- **Kind helped (C → D): discrimination itself.** The *same facts* rendered
  as a natural-language situation: ROC-AUC 0.513 → **0.907**, PR-AUC
  0.042 → **0.182** — Jev-NL out-ranks Luna-on-digest (0.805 / 0.150). At
  the 0.5 threshold almost nothing changes (paired D vs C: 1 vs 0 items)
  because D's whole probability scale is compressed below 0.5 (range
  0.07–0.47): the four eggs sit at the *top* of its ordering (p 0.18–0.27)
  but under the line. The signal is in the ranking, not the threshold.
- **The control (A → E) says the digest was starving Luna too.** Luna on the
  identical full structured state: AUC 0.805 → **0.949**, PR-AUC
  0.150 → **0.317**, ECE 0.068 → **0.039**, accuracy 0.850 → 0.958 (paired
  15 vs 2), abstention τ=0.9 coverage 40% → 86% at 100% accuracy. Roughly a
  third of this morning's "Luna beats Jev" gap was the input, charged to
  both models. What survives equal feeding is a real but narrower model
  gap (below).

**Does Jev earn a seat? Yes — one specific seat, under its best feeding
(natural language), with conditions.** Detailed at the end.

## Five-arm comparison (n=120 per arm; Jev arms all on the pinned snapshot
`typesafe/jev-1.14-20261014` via the Decisions API; Luna arms
`openai/gpt-6-luna` via chat completions, Arm A's exact call pattern)

| Metric | A: Luna digest | B: Jev digest | C: Jev full, structured | D: Jev full, NL | E: Luna full, structured |
|---|---|---|---|---|---|
| Accuracy @0.5 | 0.850 | 0.617 | 0.958 | **0.967** | 0.958 |
| Balanced accuracy | 0.681 | 0.560 | 0.496 | 0.500 | **0.616** |
| ROC-AUC | 0.805 | 0.374 | 0.513 | 0.907 | **0.949** |
| PR-AUC | 0.150 | 0.033 | 0.042 | 0.182 | **0.317** |
| ECE (lower = better) | 0.068 | 0.141 | 0.187 | 0.107 | **0.039** |
| Eggs found @0.5 | 2/4 | 2/4 | 0/4 | 0/4 | 1/4 |
| Egg p values | 0.68, 0.68, 0.32, 0.18 | 0.51, 0.50, 0.35, 0.34 | 0.27, 0.24, 0.24, 0.20 | 0.27, 0.24, 0.19, 0.18 | 0.72, 0.28, 0.19, 0.12 |
| Confident-wrong (not-egg @ p≥0.9) | 0 | 0 | 0 | 0 | 0 |
| Confident-wrong (egg @ p≤0.1) | 0 | 0 | 0 | 0 | 0 |
| Abstain τ=0.7 | 93.3% @ 75% cov | answers 0 | 96.1% @ 85% cov | 96.6% @ 98% cov | 95.8% @ 99% cov |
| Abstain τ=0.8 | 98.6% @ 62% cov | answers 0 | 97.8% @ 38% cov | 98.1% @ 88% cov | 98.2% @ 93% cov |
| Abstain τ=0.9 | 100% @ 40% cov | answers 0 | 100% @ 15% cov | 100% @ 37% cov | 100% @ 86% cov |
| p range (all items) | 0.01–0.78 | 0.33–0.61 | 0.05–0.52 | 0.07–0.47 | 0.001–0.78 |
| Latency / call (mean, same proxy path, 6-way) | 14.7 s | 6.9 s | 8.1 s | 7.3 s | 9.8 s |
| Cost / call (receipts) | $0.000090 | $0.000017 | $0.000029 | $0.000030 | $0.000238 |
| State size (mean / max) | 213 B / 217 B | 213 B / 217 B | 1,176 B / 1,357 B | 1,488 B / 1,682 B | 1,176 B / 1,357 B |

All states are ≤5% of the ~32 KB Decisions-API long-context degradation
threshold — no arm paid that penalty; state size is not a confound.
Paired items: C vs B — both-right 72, both-wrong 3, **C-only 43, B-only 2**.
D vs C — both-right 115, both-wrong 4, D-only 1, C-only 0 (identical at the
0.5 line; the difference is ordering). E vs A — both-right 100, both-wrong
3, **E-only 15, A-only 2**. C vs E — both-right 113, both-wrong 3, 2 vs 2
(indistinguishable at 0.5 on this batch; separated by AUC/PR/ECE/eggs).
D vs E — both-right 114, both-wrong 3, D-only 2, E-only 1.
Agnes-judged subset (n=8): Agnes 0.625, **all five arms 0.500** — unchanged
from this morning, uninformative at this n.

**Threshold diagnostics (descriptive, IN-SAMPLE — not a fitted result;
`results/cde_thresholds.json`):** at the lowest line that catches all 4
eggs — A: t=0.18 with 55 FP · C: t=0.20 with 75 FP · **D: t=0.18 with
18 FP** · E: t=0.12 with 13 FP · (B: t=0.34 with 113 FP). I.e. Jev-NL's
ranking is triage-grade: a threshold near 0.18 would pass all four eggs
plus ~15% of negatives upward. That line was found *on the test batch
itself*; it is evidence about the shape of D's output, not a usable
production threshold (fitting protocol in the seat conditions).

## What "full" honestly was — reconstruction itemization

Arms C/D/E states were built from ONE fact dict per item
(`scripts/build_full_context.py`; per-item facts in
`results/cde_items.jsonl`). Arm C = the original digest **verbatim** + the
blocks below; Arm D = the same facts as prose; Arm E = Arm C's text
verbatim. Every stream is from the recorded logs:

**Reconstructed, per item:**
- The original digest (geometry, ranks, staged distance) — unchanged.
- **Candidate surface range from the recorded depth channel** — each frame
  ships a depth PNG (the app's own encoding, g = 255·(1 − d/45), per
  `percept_uncertainty.py`); decoded as the dominant (modal) surface inside
  the candidate's box, with patch coherence and 10–90th-percentile spread.
  99/120 items got a surface read; **21/120 are far-limit** (sky / no
  return — stated as such in the state, no number invented).
- **Image-plane bearing** — candidate centre offset from frame centre in
  pixels, with sector words. (Degrees were NOT reconstructed: camera FOV
  was never logged, and the two egg viewpoints imply inconsistent FOVs —
  49.9° vs 56.5° — so degrees would have been fabricated precision.)
- **Perception calibration at the staged range** — σ_vlm(r) = 0.32r,
  p_detect(r), and the claim-worthiness rule (σ_2d ≤ 0.75 m → approach to
  ~2.3 m) from the rig's fitted `percept_uncertainty.py` curves, plus
  σ_depth at the candidate's depth read (with the depth-blind flag past
  ~15 m). Frame-level (same for all candidates in a frame), as it was in
  the rig.
- **Candidate-field context** — from the full per-frame candidate lists in
  `cv_results_rgb.json`: how many rivals out-score this candidate on
  ovoid, and the strongest rival's ovoid/area/box. (The digest carried
  only this candidate's own ranks.)
- **Frame-level perception scan outcome** — the full-frame VLM scan of the
  same view reported an egg sighting in all 5 test frames (A-091's scan
  also carried a second report the module flagged as a likely phantom —
  stated in those items' states). This is the blackboard fact that makes
  sighting-confirm a real decision at all — the agent is confirming
  candidates *because* a sighting was reported. It is constant within a
  frame and cannot identify which candidate is the egg. Included in C and
  D identically; **flagged here as a design decision** — it is the one
  added stream that is another model's output (frame-level, not
  candidate-level).

**In the logs but EXCLUDED by design:**
- Agnes's own verdicts on 8 items — another judge's answer to the very
  question being asked; context for the head-to-head subset only.
- Fovea crop boxes / pipeline plumbing — not decision context.

**Never logged — NOT reconstructed, not faked:**
- Agent world pose / heading (only the staged distance to the target was
  recorded; world bearing of a candidate is unrecoverable).
- Look-budget state (these were staged single looks — no run, no budget
  existed to record).
- Episodic / blackboard entries (the confirm pipeline ran offline; no run
  trace exists for these frames — the census said the same of type (b)).
- Candidate world position.

**One honest disagreement in the evidence:** for the two 8 m egg items,
the depth patch's dominant surface reads **10.8 m** against the 8.0 m
staged distance (at 4 m they agree: 4.2 vs 4.0). The loose CV box around
the distant egg is filled by the surface behind it; the depth channel is
reported to the judges *as recorded*, alongside the staged distance in
the digest — the disagreement itself is genuine sensor evidence, but
"candidate range" in C/D/E means the depth read, not ground truth.

## The seat Jev earns — and its conditions

Under natural-language feeding, Jev's ranking (AUC 0.907, PR-AUC 0.182)
beats the input Luna actually ran on this morning and approaches
Luna-full, at **$0.000030/call vs Luna-full's $0.000238 (~8× cheaper)**
and comparable latency on this network path (7.3 s vs 9.8 s; both are
proxy-bound figures, neither is Jev's ~250 ms class number). Its defined
seat in the hybrid: **first-pass ranker / triage scorer in front of Luna**
— order the candidate field, pass a fitted-threshold slice upward, let
Luna adjudicate everything passed and everything near the line.

Conditions, all three load-bearing:
1. **Natural language or nothing.** The structured form does not earn the
   seat (AUC 0.513 — quantity without kind leaves ranking at chance).
2. **The threshold must be fitted out-of-sample** (the train split's 427
   items exist for exactly this) and re-verified on held-out items before
   any production use. The t≈0.18 figure above is in-sample description.
3. **Jev's raw probabilities never gate anything directly.** ECE 0.107,
   a scale compressed under 0.5, and 0/4 eggs at the stock line mean its
   p is a ranking score, not a probability to act on. Luna — abstention
   τ=0.9: 86% coverage at 100% accuracy on the full state — remains the
   confirm judge and the final say.

What did NOT change from this morning: as a like-for-like confirm judge at
a 0.5 threshold, Jev still loses to Luna on the same feeding (E: AUC
0.949, PR 0.317, ECE 0.039, the only full-context arm that put an egg
above 0.5 with margin, p=0.72). Context starvation explained Jev's
*hysterical* failure mode (below-chance ranking, zero decisiveness); it
did not make Jev Luna's equal.

## Caveats

- Enriched batch (4/116) inherited from the A/B by design — read balanced
  accuracy / AUC / the threshold diagnostics, not raw accuracy.
- 4 positives is 4 positives: every egg-side number carries that
  denominator. The AUC ordering (B < C ≪ D < E) rests on 116 negatives'
  worth of ranking evidence and is the robust signal; per-egg p's are
  anecdotes by comparison.
- Latencies are this VM's egress-proxy figures at 6-way concurrency —
  comparative within the experiment, not production numbers.
- Arm D's prose was generated programmatically from the same fact dict as
  Arm C (fact parity by construction, spot-verified by eye); a
  hand-written or model-written situation rendering might do better or
  worse — "kind" here means *this* faithful prose rendering.

## Spend

Batch C+D+E: **$0.0356** from response receipts (C $0.0035, D $0.0036,
E $0.0285), plus $0.0002 of pre-flight smokes — ≈ **$0.036 total against
the $0.25 hard cap**. 360/360 calls HTTP 200, all Jev receipts on
`typesafe/jev-1.14-20261014`.

## Artifacts

- `results/cd_jev_full.jsonl` (C), `results/cd_jev_nl.jsonl` (D),
  `results/cd_luna_full.jsonl` (E) — per-item p, latency, cost, model.
- `results/cde_items.jsonl` — the 120 items with digest, both state
  renderings, the full fact dict, and state byte sizes.
- `results/cde_summary.json` — the five-arm battery + paired counts +
  state sizes; `results/cde_thresholds.json` — the threshold sweep.
- `scripts/build_full_context.py`, `scripts/cde_batch.py`,
  `scripts/cde_tally.py`; batch log `results/cde_run.log`.
