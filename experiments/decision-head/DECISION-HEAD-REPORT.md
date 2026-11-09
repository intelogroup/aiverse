# Decision-Head Experiment — Report

*Run 2026-11-09. Question: can a small local Jev/Laya-class decision model —
or the real hosted Jev — beat LLM deliberation on the narrow, candidate-bounded
decisions verse agents make? Verdicts first; every number carries its n.*

---

## HEADLINE — The 15-minute A/B: Luna alone vs Luna + Jev (Jim's order, 10:09–10:15 ET)

Ran 10:44:46–10:49:44 ET (298 s of the 15-min box); **Arm B re-fired
11:04–11:07 ET** after Jim cleared the blocker below (see Arm B — resolved).
Items: **120 held-out
decision items** from the type-(a) staged set — the **test split** of
`data/dataset_a.jsonl`, disjoint from every Laya training/val split.
Composition (enriched, NOT natural prevalence): all 4 test-split eggs + all 8
Agnes-judged items + the 56 highest-ovoid (hardest) negatives + seeded random
negatives → **4 egg / 116 not-egg**. Both arms received the *identical*
serialized candidate report text per item. Full per-item results:
`results/ab_luna.jsonl`, `results/ab_jev.jsonl`, manifest `results/ab_items.jsonl`.

### ARM A — Luna alone (control): COMPLETE, 120/120 items

`openai/gpt-6-luna` via OpenRouter chat completions (the exact id resolved
from the live catalog; the rig's Luna, reachable on OpenRouter — no fallback
route needed), temperature 0, asked directly for a JSON `p_egg` probability.

| Metric | Value (n=120 unless stated) |
|---|---|
| Accuracy @0.5 | **0.850** |
| Majority baseline (always not-egg) | 0.967 |
| Balanced accuracy | 0.681 |
| ROC-AUC | 0.805 |
| PR-AUC | 0.150 |
| Calibration (ECE, 10 bins) | **0.068 — well calibrated** |
| Eggs found (p ≥ 0.5) | 2/4 (egg p values: 0.68, 0.68, 0.32, 0.18) |
| Confident-wrong (not-egg at p ≥ 0.9) | **0** |
| Abstention τ=0.7 | 93.3% acc on 75% coverage (n=90 answered) |
| Abstention τ=0.8 | 98.6% acc on 62% coverage (n=74) |
| Abstention τ=0.9 | 100% acc on 40% coverage (n=48) |
| Latency | mean 14.7 s, p50 15.8 s per call (6-way concurrent, via this VM's egress proxy) |
| Cost | **$0.0108 total** ($0.000090/call, from responses' own `usage.cost`) |

Head-to-head on the Agnes-judged subset (n=8, same items): **Agnes 0.625,
Luna 0.500**, majority 0.500. Tiny n — directional only.

**Reading:** Luna-alone is a mediocre *ranker* here (AUC 0.805, PR-AUC 0.150)
and its raw accuracy sits below the trivial baseline because the batch is
enriched with the hardest negatives (it false-positives on lookalikes, the
same failure the census found for Agnes). But it is *honestly calibrated*
(ECE 0.068, zero confident-wrong) — with an abstention threshold it becomes a
safe triage: answer at τ≥0.8 and it is right 98.6% of the time on 62% of
candidates, escalating the rest. Latency is the ugly number: ~15 s/call on
this network path (the model itself answers in one short completion; the
figure is proxy + concurrency, measured, not estimated).

### ARM B — Luna + Jev (treatment): COMPLETE, 120/120 (re-fired 11:04–11:07 ET)

**Blocker history, resolved.** The first firing (10:44 ET) failed 120/120
with HTTP 404 — *"No allowed providers are available for the selected model…
your account's allowed-providers setting permits only: xai, groq, meta,
seed, z-ai, azure, cohere, liquid, nvidia, openai, alibaba, minimax, …"*
(full log preserved in `results/ab_jev_blocked.jsonl`). **Resolution: Jim
added `typesafe` to his OpenRouter account allowed-providers at 11:03 ET.**
A one-call smoke then returned 200 (no second gate — the feared workspace
Guardrail allowlist did not also block), and the arm re-fired unchanged:
same manifest (`results/ab_items.jsonl`), same payload as
`scripts/ab_batch.py` — pinned `typesafe/jev-1.14` via
`POST https://openrouter.ai/api/alpha/decisions`, state = the same context
text, one **Noul** question ("Is this candidate an egg?", true/false
criteria). All 120 responses carry the dated snapshot
`typesafe/jev-1.14-20261014`. Full results: `results/ab_jev.jsonl`.

| Metric | Value (n=120 unless stated) |
|---|---|
| Accuracy @0.5 | **0.617** |
| Majority baseline (always not-egg) | 0.967 |
| Balanced accuracy | 0.560 |
| ROC-AUC | **0.374 — below chance (0.5)** |
| PR-AUC | 0.033 (≈ the 0.033 base rate — no ranking signal) |
| Calibration (ECE, 10 bins) | 0.141 |
| Eggs found (p ≥ 0.5) | 2/4 (egg p values: 0.51, 0.50, 0.35, 0.34) |
| Confident-wrong (either direction) | 0 — but see reading: it is never confident at all |
| Abstention τ=0.7 / 0.8 / 0.9 | **0 items answered at any τ ≥ 0.7** (coverage 0%) |
| Latency | mean 6.9 s, p50 6.7 s per call (6-way concurrent, via this VM's egress proxy) |
| Cost | **$0.0021 total** ($0.000017/call, from responses' own `usage.cost`) |

**Reading:** Jev's probabilities hug 0.5 on every item — no answer in either
direction ever reached 0.7 confidence, and two of the four eggs sit at
0.51/0.50, exactly on the decision line. As a ranker on this input it is
worse than random (AUC 0.374 means its ordering is *anti*-correlated with
truth here: the text-digest features it keys on mislead it systematically).
Zero confident-wrong is therefore not a virtue in this run — it never
staked anything. In an abstention pipeline it escalates 100% of candidates,
which annihilates its cost/latency edge: Luna at τ=0.8 *answers* 62% of
candidates at 98.6% accuracy; Jev answers 0%.

### HEAD-TO-HEAD VERDICT — Arm A vs Arm B (identical 120 items)

| | Luna alone | Luna + Jev | Winner |
|---|---|---|---|
| Accuracy @0.5 | 0.850 | 0.617 | **Luna** |
| Balanced accuracy | 0.681 | 0.560 | **Luna** |
| ROC-AUC | 0.805 | 0.374 | **Luna** |
| PR-AUC | 0.150 | 0.033 | **Luna** |
| ECE (lower = better calibrated) | 0.068 | 0.141 | **Luna** |
| Eggs found | 2/4 (at p 0.68, 0.68) | 2/4 (at p 0.51, 0.50) | tie on count, Luna on margin |
| Abstention τ=0.8 | 98.6% acc on 62% coverage | answers nothing | **Luna** |
| Latency / call (same proxy path) | 14.7 s mean | 6.9 s mean | **Jev** (~2× faster here; neither is near Jev's ~250 ms class figure off this network path) |
| Cost / call | $0.000090 | $0.000017 | **Jev** (~5× cheaper) |
| Paired items | luna-only-right 34 | jev-only-right 6 | **Luna** (both-right 68, both-wrong 12) |
| Agnes-judged subset (n=8) | Luna 0.500 | Jev 0.500 | tie (Agnes 0.625; tiny n, directional only) |

**Verdict:** on serialized CV-feature text digests, zero-shot Jev **loses**
to Luna-alone on every discrimination and calibration metric, decisively on
the paired items (34 vs 6). It wins only on price and speed — which do not
cash out, because a judge that abstains on everything is not a triage. For
this decision type in this modality, **Luna-alone with an abstention
threshold remains the better judge, and Jev is not a drop-in replacement.**
Scope of the loss, stated plainly: Jev was fed the same *text* digest as
Luna (the experiment's identical-context rule); image-state Jev and richer
question designs are untested, and the fine-tuned local head (Laya) is a
different claim entirely — zero-shot was always the weak form (cf. raw Laya
at 36% in the explainer). But what was tested, Jev lost.

**Spend tally (whole A/B incl. smoke + Luna-verify calls): Jev $0.0021
(cap $2.00) · Luna $0.0108 + $0.0001 verify (cap — combined $0.0130 of the
$5.00 combined cap). Window (ends tonight 23:59 ET) respected.**

### Modality caveat (applies to the whole experiment)

Both A/B arms — and the local head below — read the *serialized CV-feature
report* (bbox geometry, ovoid score, proposer ranks, staged distance). Agnes's
logged verdicts in the census were made on crop **images**. So "Luna vs
Agnes" here compares decision quality given a text digest, not raw senses;
the production-relevant framing is cost/latency triage: a ~ms local head or a
~250 ms-class hosted decision call vs ~5.3 s (Agnes logged) / ~15 s (Luna via
this proxy) per deliberation.

---

## The local track — Laya (real artifact) + fine-tune: QUEUED, not yet baked off

Jim's steering (09:34) made the **real Laya** the primary local path. Status:

- **Weights: DOWNLOAD COMPLETE.** Source: Hugging Face repo
  **`convaiinnovations/laya`**, pinned revision
  `55cf4c4ebb4ebe31b2550e8bdf3bd21b99753851` (the `laya` Python package's own
  pinned revision). **License: Apache-2.0** (stated in the repo README;
  covers weights + code — local research use, fine-tuning, and redistribution
  are permitted). English checkpoint `model.safetensors`:
  **842,609,210 bytes** (ModernBERT-large, ~421M params, fp16). Zero partial
  files remain; the artifact is intact in the local HF cache.
- **Loaded / run: NOT YET.** Zero-shot inference (`scripts/laya_infer.py`,
  Router API, same Noul question over the same contexts) is written and
  queued. It did not run before this report because (1) Jim reprioritized
  the A/B batch ahead of it at 10:09, and (2) before that, the heavy-lane
  gate: the gauntlet lane owns this box's CPU/memory, and Laya inference +
  fine-tuning are heavy.
- **Fine-tune status (the fallback-class arm — a ModernBERT-base + marker
  head reimplementation of the Laya architecture, `scripts/train_head.py`):**
  attempt 1 was **OOM-killed at 225 s** by running concurrently with the
  gauntlet's Chromium (my scheduling error — the gate check's output went
  unseen into a backgrounded session); the implementation was rewritten to
  padded batch forwards with the protocol unchanged (same data/split/seed/
  oversampling ×12 / lr 1e-5 / 4 epochs / batch 16 / val-fitted temperature),
  reached 5.1 GB RSS in per-item mode before the rewrite, and its v2 run was
  **stopped by Jim's 10:09 reprioritization** before completing. Queued
  behind the gauntlet gate.
- **So, exactly which local model was baked off so far: NONE.** The only
  completed bake-off arms to date are the A/B above plus the census baselines
  below. The report will be updated in place when the Laya zero-shot and
  fine-tune arms complete; no verdict is claimed for them yet.

## Census (Phase 1 — full detail in `data/CENSUS.md`)

| Type | Labels found | Verdict |
|---|---|---|
| (a) Sighting confirm/reject | **847** candidates (11 egg / 836 not-egg), 14 staged frames; Agnes verdicts on 26 (acc **53.8%**, below the 57.7% majority on that subset; mean latency 5.34 s) | **Bake-off type** (above) |
| (b) Next-target pick | 87 deliberation rows, but candidate sets never logged | **Dropped** — not reconstructable; needs ≥150 train / ≥75 test decisions with enumerated options (gauntlet now mints these) |
| (c) Claim/abstain | ~12 staged sightings — the same points the incumbent σ rule was fitted on | **Dropped** from training (contaminated); rule scored descriptively below; fair retest needs ≥120 train / ≥60 test fresh sightings |
| (d) Decoy vs real | 0 dedicated labels (decoys staged, never run) | **Dropped**; the lookalike class lives inside (a)'s 836 negatives; gauntlet S4 will mint these |

Split discipline: viewpoint-group-disjoint (a viewpoint appearing in several
trial batches is never split across train/val/test): train 427 (6 egg) /
val 117 (1 egg) / test 303 (4 egg). The A/B batch drew only from test.

## (c) Descriptive scoring of the incumbent claim rule (in-sample, no training)

Rule (`percept_uncertainty.make_sighting`, VLM source): claim licensed iff
σ₂d = 0.32·r ≤ 0.75 m, i.e. **r ≤ 2.34 m**. Applied to the 10 staged hits it
was fitted on (Luna 8, Agnes 2; ranges 4–15 m): **licenses 0/10 claims,
makes 0 errors** — and 7/10 refused hits *would* have succeeded if claimed at
range (error ≤ 1.5 m). The rule is an approach-trigger, not a claim trigger:
it trades those 7 for a forced close-and-relook. Consistent with its design;
not a held-out result. Detail: `results/claim_rule_descriptive.json`.

## What happens next (in order)

1. ~~**Jim (1 min, account-side):** add `typesafe` to OpenRouter allowed
   providers → Arm B re-fires unchanged~~ — **DONE 2026-11-09 11:03 ET;
   Arm B completed 120/120 (see verdict above).**
2. When the gauntlet lane releases the box: Laya zero-shot inference over all
   847 candidates, then the fine-tune v2 run, then the full local bake-off
   (`scripts/eval_arms.py`: majority / ovoid heuristic / logistic regression /
   head raw+calibrated / Laya zero-shot / Agnes logged) — this report updated
   in place with per-type verdicts (take over / not yet / never).
