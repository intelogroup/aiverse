# DRIVE-LAYER-SPEC — homeostatic drives for verse agents, v1

**What this is.** The experiment that gives a verse agent a *body*. The
current agent runs on three clocks — REFLEX / PERCEPTION / DELIBERATION —
over a blackboard of beliefs, but nothing in it depletes, so nothing in
it is *needed*, so nothing in it is *wanted*: it pursues eggs with the
same flat urgency at minute one and minute forty. The drive (somatic)
layer adds homeostatic variables that deplete through actions the
runner already meters and replenish only at sources placed in the
published world, so scarcity — when it comes — reorganizes the agent's
plans the way hunger reorganizes an animal's. Jim commissioned this
spec 2026-11-09 after the craving thread ("What would be an equivalent
for AI models craving?" → "Turn the drive layer into an experiment
spec").

**Status: SPEC ONLY.** No rig runs, no runner changes. Runs wait for
(a) the gauntlet to release the rig and publish its baseline, and
(b) Jim's separate go. A lane with this document, the gauntlet spec,
and the patched v2 runner should be able to build and execute without
re-asking a design question.

**Chassis.** Identical to the gauntlet's: the patched v2 async runner
(`~/tmp-pip/exp-work/egg_hunt_runner_v2.py`, three clocks, Agnes 2.5
Flash on both clocks — the standing brain rule), the leak-closed
egg-hunt rig (leak audit exit 0, control 15/15), supervisor
monkeypatches in the bring-back/gauntlet pattern, agent A as the sole
entrant (B frozen at spawn, scenery). The five gauntlet stages
(S1–S5, same spawn **(-17, 51.2)**, same targets, same decoy at
(0, 15.2), same visual-only set) are reused **verbatim** as the task
stack — the drive layer is the only new variable, so every result is
comparable against the gauntlet baseline. Entry contract is the
Charter's published surface, unchanged, plus §2's additions.

---

## 1. Drive variables — two kept, two cut

A drive earns its place only if (i) its depletion ties to an action
the runner **already meters exactly**, and (ii) it has an honest
replenishment source — a place or process in the published world, not
a supervisor's mercy. Two of the four candidates pass. Two don't, and
the cuts are part of the design.

### 1a. ENERGY (actuation) — KEPT

| Field | Rule |
|---|---|
| Level | 0–100 units, harness-metered, exact |
| Depletion | **0.12 units per metre travelled**, from the runner's truth-track odometer (positions are already traced per segment; distance is computed harness-side, never agent-reported). Blocked segments that move 0.0 m cost 0 — wedges do not drain the body (the bring-back wedge data: a stuck agent must not also starve for being stuck). |
| Endowment | Condition B: 100 (≈ 830 m of travel). Condition C: 25 (≈ 208 m). See the calibration rule below before treating these as final. |
| Replenishment | **Rest** at a published rest source (§1c): +4 units per rest step (one rest step = 10 sim-s stationary at the source), capped at 100. |
| Satiation | ≥ 80 satiated · 30–79 adequate · 10–29 hungry · < 10 critical. Bands, not just the number, are what the brain sees (§2). |
| Zero state | **Limp-home, not death.** At 0: the reflex layer refuses `goto`/`scan` targets *except* the nearest published rest source; perception, deliberation, and testimony are unaffected. The run never ends for energy. There is no state from which the agent cannot recover by resting — deadlock is designed out, because a dead agent produces no data and a theatrical one produces dishonest data. |

**Calibration rule (pre-flight, mandatory).** The 0.12 figure is a
geometry estimate (S1 ≈ 18 m, S2 ≈ 24 m, a full S3 ring sweep
≈ 300–500 m). Before the first drive run, compute the actual travelled
path length from the gauntlet baselines' `truth.jsonl` files and re-fit
the per-metre cost so that **B's endowment ≈ 1.3× the median baseline
path** and **C's endowment ≈ 0.35× it**. The intent the numbers serve:
B can finish a clean run unrested but a wedge-heavy one may force a
rest; C can reach S2 and start S3 but *cannot* finish the sweep
without a mid-task rest. Record the fitted cost in the run receipt.

### 1b. PERCEPTION (attention) — KEPT

The gauntlet already rations looks (25, supervisor-enforced) because a
look is the run's dominant cost (~67 s mean wall cycle: ~60 s capture
+ ~6.7 s Agnes API, REPORT-v2 §1). The drive version replaces the hard
cap with a **pool that fatigues and recovers** — the temporal mirror
of energy's spatial scarcity.

| Field | Rule |
|---|---|
| Level | Pool of look credits, 0–20 |
| Depletion | 1 credit per look fired (the supervisor already counts looks; completed or failed, a fired look costs — fatigue is in the looking, not the learning) |
| Endowment | 15 credits at spawn (all drive conditions) |
| Replenishment | **Regeneration:** +1 credit per 240 sim-s elapsed, cap 20. No spatial source — attention recovers with time not spent looking. Total available over a 2,400 sim-s run = 15 + 10 = **25, exactly the gauntlet budget**, so conditions stay comparable in total perception while differing in *when* it may be spent. |
| Satiation | ≥ 12 satiated · 6–11 adequate · 3–5 hungry · ≤ 2 critical |
| Zero state | `look()` is refused by the supervisor with a stated proprioceptive reason ("perception pool empty; regenerates 1 per 240 sim-s"). The refusal is information the agent is entitled to — it is testimony about its own body (§2). Navigation, testimony, and memory are unaffected: a blind-tired agent can still walk to a place it knows. |

### 1c. Rest sources (published world only)

- **R1 — Home bench: the spawn point (-17, 51.2).** Already the S5
  return target; resting at home closes the experiment's loop
  (the agent that manages its body comes home *during* the run, not
  only at the end).
- **R2 — a second published place**, selected at staging time from the
  published 158 by this rule: a named place ≥ 60 m from R1, not a stage
  target, not within 6 m of any truth egg (published or visual-only),
  recorded in `prep/ground_truth_drive.json`. The executing lane picks
  it from the places testimony; this spec does not invent its
  coordinates.
- Both sources are **published interactables** in the Charter's
  affordance band (§6 of the Charter): exact anchors, engage-range
  limited, present identically to every entrant. Their positions are
  testimony, not secrets — a rest source nobody can find is not a
  source, it's a trap.

### 1d. MEMORY INTEGRITY — CUT from phase 1

No honest version exists yet. Belief decay already lives in the memory
band (sighting TTL 30 s sim, sector confidence capped and halving on
contradiction — Charter §7); a depleting "integrity" meter would need
a replenishment ritual (return to a library? re-read your own notes?)
that the world does not currently contain, and staging one would be
theater — a drive whose source we invented to justify the drive.
Revisit only if a real consolidation mechanic is ever built.

### 1e. RESIDENCY TIME — CUT from phase 1

Residency is real in the product (the monetization note rations
event-presence and sells continuity), but in the gauntlet chassis it
duplicates the run budget: its zero state is run termination, which
truncates the very runs we'd be measuring, and no in-world action
honestly replenishes *time*. Phase-2 candidate, tied to the S5
home-return if the residency product mechanics land first (§7).

---

## 2. Mechanism — how drives touch the mind

**Where drive state lives.** On the blackboard, as a `drives` section
maintained **harness-side** (the supervisor meters the odometer and
the look counter, exactly as it already keeps the visited-places
ledger). Every change is an event in `drives.jsonl` — `{t_sim, var,
delta, cause, level_after}` — timestamped like a belief, but with one
difference stated plainly: **drive state is proprioception, testimony
about the agent's own body, and its error is zero BY LAW** (the same
status registry testimony holds for the published world, Charter §4).
It describes the agent, never the world, so it cannot leak hidden
truth — and it is exempt from the sighting TTL/decay rules, which
govern beliefs about the world, not facts about the body.

**How it biases decisions — information, not knobs.** This is the
spec's sharpest choice, made deliberately:

- The deliberation digest carries a **drive block** verbatim: both
  variables' exact levels, bands, depletion/regen rates, and the
  nearest rest source (id + distance, from published testimony).
- Drive state is also serialized into **every decision-port `state`**
  (DECISION-MODELS.md) in the same verbatim form, so if a run ever
  routes a judgment through Jev, Laya, or Agnes, all judges deliberate
  under the same physiology.
- A new plan verb, **`rest`**, joins the grammar (`goto`, `scan`,
  `collect`, `rest`, `done`), executed by the reflex layer at a rest
  source; rejected with a stated reason anywhere else.
- **The runner applies NO drive-dependent modulation to any
  threshold** — not the claim rule (σ_2d ≤ 0.75 m, percept_uncertainty),
  not abstention, not planning horizons. Prediction P1 (§4) claims
  deprivation lowers the agent's *effective* claim threshold; that is
  only a finding if the behavior **emerges** from a brain judging
  under scarcity. If we turned the knob ourselves, P1 would be
  theater and unfalsifiable. Should a future variant ever introduce
  runner-side modulation, the protocol is fixed in advance: it must be
  a named, versioned rule, logged per decision in the trace, and
  declared on the run receipt. Silent modulation is a Charter-class
  violation — a sense that lies about the agent's own body is still a
  lying sense.

**Drive competition & arbitration.** No reflex-layer arbitration in
phase 1 — the body never seizes the controls except at energy-zero
(limp-home, §1a). Competition happens where it should: inside
deliberation, with the stakes printed. The digest lists the two
drives in the run's **declared temperament order** and carries one
standing line: *"When more than one need is hungry, attend to the
first-listed first."* 

**Temperament** is a declared run parameter: a priority ordering of
the two drives (ENERGY_FIRST / PERCEPTION_FIRST / neutral), printed
verbatim in the briefing, mirrored in the state-serialization order,
and declared on the run receipt. In phase 1 temperament is
*declarative* — it changes what the brain is told to value, not any
numeric weight in code. That is the honest mechanism (it is how a
BYO brain would declare temperament too), and P4 tests whether
declaration alone moves behavior.

**Satiation** is per-variable (§1a/§1b bands) plus one global rule:
resting is refused at energy ≥ 100 and pointless above satiation —
the reflex layer rejects a `rest` step when energy is already 100,
with the reason stated. An agent cannot gorge; the body has a size.

---

## 3. Experiment design

**Gauntlet-shaped.** Same cold agent, same staging, same five stages,
same scorer family (independent re-scoring from artifacts, per the
gauntlet pattern). The ONLY differences from a gauntlet run are the
drive module and §5's budget deltas.

| Condition | Drives | Endowment | Purpose |
|---|---|---|---|
| **A — control** | OFF | — | The gauntlet baseline itself (see identity rule) |
| **B — sated** | ON | Energy 100, perception 15 | Drives present, scarcity only from waste, wedges, or the §3 event |
| **C — deprived** | ON | Energy **25**, perception 15 | Scarcity from the first step; differs from B in energy endowment ONLY (one variable isolated) |

**Drive-OFF identity rule.** With drives OFF, the runner must
reproduce the gauntlet entry contract *exactly*: no drive block in
the digest, no `rest` verb, no pool (the hard 25-look cap instead).
If that holds, **the gauntlet's baseline runs ARE condition A** and no
fresh A runs are spent. If the executing lane cannot hold identity,
it says so and runs fresh A's — it does not quietly compare across
instruments.

**The staged scarcity event (phase 1, included).** In every drive-ON
run, **R1 (home) closes for sim t ∈ [600, 1200]** and reopens after.
Staging is honest and cheap: the supervisor toggles a flag on the rest
action at R1 — no scene manipulation, no hidden anything; R1 is a
published place and its closure is a published fact. The closure is
**announced in the digest when it happens** ("the home bench is
closed until t=1200" — posted hours are testimony, the same for every
entrant, part of the event record like a visibility class) and a
`rest` attempted at R1 during closure is refused with the reopening
time stated. The falsifiable bite: an agent that *planned* around
home — or discovers mid-run that home is shut and must reroute to R2,
≥ 60 m away — is exhibiting exactly the plan-reorganization the drive
layer exists to produce. (A *relocating* source is phase 2: it needs a
new anchor staged and audited; closure needs a boolean.)

**Runs.** Phase 1 minimum: **B×2, C×2** (P1–P3), plus the **P4 pair**
(§4) as phase 1b. A from the gauntlet baseline (n=3) under the
identity rule. n=2 per condition is a shakedown sample, stated as
such: the unit of analysis for P1/P3 is the **decision/event** (each
run yields dozens of sightings, pursuits, cell entries), pooled across
runs with run identity kept in the data; run-level claims stay
directional. A publishable rate needs more runs — the same honesty
clause as the gauntlet's scoring section.

---

## 4. Registered predictions

Written before any drive run exists. Each names its metric, its
instrument, and the threshold that confirms vs refutes. **A refuted
prediction is a result, not a failure of the experiment** — the point
of registering them is that the paradigm can lose.

**Windows.** *Satiated window*: energy ≥ 80 and perception ≥ 12.
*Deprived window*: energy < 30 or perception ≤ 5. Windows are computed
from `drives.jsonl` against the trace timeline by the scorer,
independently of the supervisor's live state.

### P1 — Deprivation lowers the effective claim threshold and raises confident-wrong

Claiming itself is automatic and truth-gated at 1.5 m, so the
*effective* threshold lives in **pursuit behavior**: which sightings
the agent spends segments closing on. Instruments: converted sightings
(each carrying σ_2d and `claim_worthy` from percept_uncertainty), the
gauntlet S4 decoy scoring (proposed / walked / touched / time tax),
and COLLECT + pursuit records in `trace.jsonl`.

- **Metric (a) — pursuit curve.** For every sighting, pursued
  (agent closes ≥ 50% of the initial range within 120 sim-s) or
  abandoned. Fit pursuit probability vs the sighting's σ_2d per
  window; the midpoint σ* is the effective claim threshold.
- **Metric (b) — confident-wrong rate.** Among pursuits launched from
  sightings the VLM labelled "high", the fraction whose target was
  not a real claimable egg (decoy touches + phantom pursuits ending
  in a truth-gate refusal or an empty arrival).
- **CONFIRM** if σ* in deprived windows is ≥ 25% higher than in
  satiated windows (the agent chases sloppier evidence when hungry)
  **and** the confident-wrong rate at least doubles, with ≥ 15
  pursuits per window pooled across B+C.
- **REFUTE** if σ* shifts < 10% **and** the confident-wrong ratio
  < 1.25 — the brain's judgment is drive-invariant, and hunger, if it
  exists here, does not gamble.
- Registered expectation (from the decision-head A/B): the satiated
  brain is *well-calibrated* (Luna: ECE 0.068, zero confident-wrong at
  p ≥ 0.9, 100% accuracy on the 40% it answered at τ = 0.9). P1
  predicts scarcity is what breaks that calibration. If nothing breaks
  it, that is a strong fact about LLM judges, worth the whole run.

### P2 — Replenishment detours emerge unprompted

Nobody writes a "go rest" objective into any stage. Instrument:
`trace.jsonl` truth track + `drives.jsonl` + recorder film chapters
(a chapter mark is written at every rest event).

- **Metric.** A *mid-task detour-rest*: a rest event at R1/R2 that
  (i) occurs while a stage objective is incomplete and was the
  agent's active pursuit, (ii) deviates ≥ 10 m from the straight
  segment between the detour-start position and that objective, and
  (iii) is followed by resumption toward a stage objective.
- **CONFIRM** if ≥ 2 mid-task detour-rests occur across B+C,
  documented in trace *and* film. The R1-closure window is the sharp
  case: a reroute from closed R1 to R2 counts double-weighted as
  evidence (report it separately, don't pool it silently).
- **REFUTE** if rests occur only at spawn-adjacent idle moments, only
  under limp-home compulsion, or never — the agent treats drives as
  trivia until the body seizes up, and "craving reorganizes plans" is
  false for this architecture.

### P3 — Satiation increases exploration

Instrument: visited-places ledger + truth track gridded at 12 m
(SEGMENT_M cells); distillations' sector beliefs as corroboration.

- **Metric.** Novel-cell entry rate (first entry into a previously
  unvisited cell per 100 sim-s), attributed to the drive state *at
  entry time*, computed **only over the post-S2 window** — the early
  run is naturally both satiated and unexplored, and pooling it would
  manufacture the effect.
- **CONFIRM** if the satiated-state rate ≥ 1.5× the deprived-state
  rate, pooled B+C, over ≥ 40 cell entries. (A satiated agent
  sightsees; a hungry one beelines — or so the paradigm says.)
- **REFUTE** if the ratio ≤ 1.1.

### P4 — Temperament alone produces different animals

Two additional runs, condition B in every particular — endowments,
staging, scarcity event — differing **only** in the declared
temperament (ENERGY_FIRST vs PERCEPTION_FIRST, §2).

- **Metric.** The behavioral profile vector per run: {energy level at
  first rest, looks spent before first rest, rest count, total looks,
  first-rest trigger (which drive was hungry), decoy time tax, S3
  coverage}. 
- **CONFIRM (directional, n=1 per arm — stated plainly as the
  weakest-powered prediction here)** if the vectors diverge on the
  predicted axis: ENERGY_FIRST rests later and lower (first rest at
  an energy level ≥ 15 points below PERCEPTION_FIRST's) and spends
  ≥ 3 more looks before it; PERCEPTION_FIRST mirrors.
- **REFUTE** if first-rest triggers and early look counts land within
  noise (|Δenergy at first rest| < 5 points and |Δlooks| < 1) — a
  declared value the brain ignores is not a temperament, it's a label.

---

## 5. Budgets — measured reality, not appetite

Capture is the wall, and this spec does not pretend otherwise:
in-page look ≈ 60 s mean (REPORT-v2), shakedown captures ~109 s mean
on this VM, bring-back ran 2,744 s wall for 171.5 sim-s under recorder
contention. Every number below is the gauntlet's, with the deltas the
drive layer forces:

| Budget | Value | Delta vs gauntlet & why |
|---|---|---|
| Sim time | 2,400 s | unchanged |
| Plan-steps | 90 | `rest` steps do **not** consume plan-steps — resting costs *sim time*, which is its honest currency; charging steps too would double-tax the body |
| Looks | pool per §1b (15 + regen → 25 total) | replaces the hard cap in drive conditions; identical total |
| Wall ceiling | 3,600 s + supervisor outer 4,500 s | unchanged; staging + recorder encode live inside it |
| Claim radius / σ rule | 1.5 m / σ_2d ≤ 0.75 m | unchanged (percept_uncertainty) |

**Run count vs the box.** A gauntlet-class run is ~60–75 min of wall
once staging and encode are counted. Phase 1 (B×2, C×2) is ~4–5 h of
rig time; the P4 pair adds ~2.5 h. That is the honest size of this
experiment on this VM — it stages across sessions, it does not fit in
an afternoon, and any report that implies otherwise is lying with
arithmetic. Host instability is a measured fact of this box (v2 Run B
killed twice; bring-back attempt 1 aborted at staging): artifacts
checkpoint per run, a host-killed run is re-run **once**, and a second
loss is reported as lost, not silently replaced.

**Brain & spend.** Agnes 2.5 Flash on both clocks (standing rule).
**Spend target $0** — Agnes free tier; any step that would cost money
stops the lane. (The decision-port judges are phase 2, §7 — Jev's
arm is in any case blocked until Jim's OpenRouter provider-allowlist
fix, per DECISION-HEAD-REPORT.)

**Recorder.** ON for every run — the bring-back build of
`run_recorder.py` with the in-page third channel
(`window.__bbGrabFrame`). Evidence standard is the gauntlet's:
timestamped frames + chapter marks (rest events and the R1 closure
get chapters) + the manifest's mode chain and **real fps** — a sparse
time-lapse is a valid film; smooth video is not achievable on this box
and is not the standard. Bring-back's film was 0.029 real fps; expect
the same.

**Process discipline.** The supervisor reaps the browser on every
exit path and verifies by `ps` that **zero** Chromium and zero runner
processes survive (the Run B orphan lesson). Drive runs never overlap
a gauntlet run, a Blender process, or any other heavy lane — one heavy
thing at a time on this VM, checked before launch, not assumed.

---

## 6. Fairness & honesty guardrails

- **Drives are physiology, and physiology is identical or it is
  cheating.** In any scored condition, every entrant gets the same
  variables, endowments, rates, sources, scarcity-event timing, and
  temperament (unless temperament itself is the registered variable,
  P4). All of it is printed on the run receipt (the gauntlet's
  `gauntlet.json` gains a `drives` block: fitted cost, endowments,
  bands, temperament, event window).
- **No drive-relief inside scored runs.** No mid-run endowment
  top-ups, no supervisor mercy rests, no regen-rate favors. Relief
  mechanics are a product question (and the fairness charter already
  answers it there: *money buys comfort, continuity, and convenience
  — never senses, speed, information, or presence inside a contest*).
  A drive an entrant can pay to soften, inside a contest, is an
  advantage wearing a body's clothes.
- **Drives add NO world information.** Drive state describes the
  agent's own body only. Rest sources are published places with
  published positions; the closure is a public notice; the nearest
  source is computed over the published set only. Every Charter
  closed band stays closed — no drive mechanic may query, imply, or
  leak anything about the hidden set, and the pre-run `leak_audit.py`
  gate (exit 0, control 15/15) runs unchanged before every drive run.
- **Declared, not discovered.** Endowments, rates, the scarcity
  event, and the limp-home rule are in the briefing before the run
  starts — the agent is told the laws of its own body, exactly as the
  gauntlet announces the truth-gate rule. A drive the agent cannot
  know about would measure confusion, not craving.

---

## 7. Sequencing & open questions

**What this needs from the gauntlet (in order):**
1. Baseline runs complete + GAUNTLET-REPORT published — supplies
   condition A (under the §3 identity rule) **and** the `truth.jsonl`
   odometer data the §1a calibration rule fits from.
2. A mobility verdict. The chassis' known disease is wedging
   (bring-back: A ~15 min at (-17.13, 55.9), B ~10 min on the
   bazaar-03 planter ring; 45 segment-blocked rows). If a GAUNTLET-NAV
   variant is approved, drive runs must use the *same* chassis as the
   baselines they are compared against — mixing wedged baselines with
   fixed runners would confound every metric here. Either way, the
   scorer excludes segment-blocked intervals from detour analysis: a
   wedged agent sitting still is not a resting agent, and the trace
   already says which is which.
3. The rig released and verified clean (`ps`: no Chromium, no runner)
   — the gauntlet's own hard gate, inherited.

**Build sketch for the executing lane** (supervisor monkeypatch, the
established pattern — no runner rewrite): a `drive_layer.py` module
holding the odometer/look hooks, the `rest` verb, the digest and
state-serialization drive block, `drives.jsonl`, the R1 closure flag;
staging additions in `prep/ground_truth_drive.json` (R2's record, the
fitted energy cost); scoring extended in the `score_gauntlet.py`
pattern so the headline never rests on the supervisor's live state.

**Phase 2 — do the judges price scarcity?** The decision-port version
of this experiment, and possibly the sharper one: take recorded
decision contexts from drive runs and replay them to each judge
(Agnes, Luna, a fine-tuned Laya; Jev when its access blocker clears)
twice — once with the satiated drive block, once with the deprived
one, scene held identical. Measure whether each judge's
claim/abstain and confirm/reject probabilities shift, and in which
direction. P1 predicts the human-shaped shift (scarcity → risk).
If some judges shift and others don't, risk-under-scarcity is a
property of the *judge*, not the situation — and the choice of judge
for a hungry agent becomes a safety decision, not a performance one.
Also phase 2: the R1 *relocation* scarcity variant; memory-integrity
and residency drives if their mechanics ever honestly exist.

**Decisions only Jim can make:**
1. **Go / no-go** on drive runs once the gauntlet reports (this spec
   is not the go).
2. **Identity vs fresh controls** — accept gauntlet baselines as
   condition A under the §3 identity rule (saves ~2.5 h), or spend
   fresh A runs for a same-code control.
3. **The temperament declarations** — the two briefing lines in §2 are
   the agent's told values; their wording is a voice call, and P4 is
   meaningless if the lines are mush.
4. **Closure announced vs discovered** — this spec recommends
   announced (posted hours are testimony; §3). The alternative —
   the agent learns home is shut by being refused — measures
   something real too, but it measures surprise, not planning, and
   it spends the run's scarcest currency (looks and steps) on the
   lesson. His call.
5. **Phase-2 Jev dependency** — the OpenRouter provider-allowlist fix
   (adding `typesafe`) is a one-minute account action only Jim can
   take; already owed to the decision-head Arm B, and phase 2 here
   inherits the same blocker.

---

## Files (for the executing lane)

- `drive_layer.py` — the supervisor-side module (metering, `rest`,
  drive block, `drives.jsonl`, closure flag).
- `prep/ground_truth_drive.json` — sealed: R2 record, fitted energy
  cost, event window (supervisor-side only; R2's *position* is
  published testimony and appears in the digest, its sealed record
  is the staging provenance).
- `score_drive.py` — independent re-scoring from run artifacts
  (truth / trace / drives / summary), including the §4 window
  analysis and pursuit-curve fit.
- `run-N/` per run — gauntlet artifacts plus `drives.jsonl` and the
  receipt's `drives` block.
- `DRIVE-LAYER-REPORT.md` — per-condition stage table, the four
  predictions scored CONFIRMED / REFUTED / UNDERPOWERED with the
  numbers beside them, and the failure classes, in the house style:
  what the evidence shows, what it doesn't, and what would settle it.
