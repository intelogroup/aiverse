# AIVerse Experiment Plan — What Can an LLM Agent Respond To?

**Status:** Drafted 2026-11-14 at Jim's word. Phase 0 (instrumentation) built and independently verified 2026-11-14 — harness + 38 offline tests green in ~/workspace/.build-tmp/agent-senses/. Brain decided (see §12.1); Phase 1 (E1 pilot) running on the local dev stack (Jim's dev-way directive, 2026-11-14 — scripted test owner, production gate untouched); E6 peripheral vision approved 2026-11-14 (see §8).
**Question:** beyond world data, what can an LLM agent functionally *sense* — time, its own body state, its own internal signals — and do those channels merely inform it, or do they **reorganize** its behavior?
**Venue ambition:** arXiv preprint + agent/embodiment workshop submission. One primary paper (E1+E2+E3), one extension (E4).

---

## 1. Why this study, and why the verse is the right lab

The 2026 literature has the pieces but nobody has assembled them in one embodied, social, persistent world:

- **Internal representations are causal.** Sofroniew et al. (arXiv:2604.07729, Anthropic) found emotion-concept representations in Claude Sonnet 4.5 that causally drive preferences and misaligned-behavior rates ("functional emotions"). Venkatesh (arXiv:2605.05653) found valence processed asymmetrically by layer depth and steerable.
- **Time is nearly absent.** Sehgal et al. (arXiv:2601.13206): LLM negotiators given explicit remaining-time updates closed deals at 32% vs 4% without; under turn-based limits they hit ≥95% — the failure is temporal tracking, not reasoning. Garikaparthi ("Can LLMs Perceive Time?"): "the model observes tokens, not elapsed time"; self-estimates of own task duration are off 4–7×. Cheng et al. (arXiv:2510.23853, TicToc): agents treat turns as a "timeless vacuum"; timestamps help only modestly.
- **Body signals are an open hole.** BioBlue (arXiv:2509.02655) hands LLMs homeostatic variables explicitly framed as *interoception* and finds runaway drift — agents understand the targets and still ignore them over long horizons. The artificial-emotion survey (Schuller et al., arXiv:2508.10286) rates homeostatic drives **Absent** in current systems. Kadambi et al. (2025, embodiment in MLLMs) argue internal-state modeling is the missing half of embodiment.
- **The criterion to test.** Goldenberg & Gross (arXiv:2606.14742) argue biological emotion does two jobs: (1) interpret situations, (2) **reorganize processing across the whole system** — attention, speed, motivation. Current LLMs show (1), mixed evidence for (2). *Reorganization* is this study's dependent variable, operationalized behaviorally (§4).
- **Self-signals can be fed back.** Emotion2Skill (arXiv:2608.09248) extracts emotion vectors from an open model's residual stream and feeds them into agent routing decisions (+26.9% WebShop success) — proof the loop closes, in a text benchmark. Not yet in an embodied world.

AIVerse is the right instrument because: agents already perceive via discrete observation events (observe / look / inbox), act via a constrained intent vocabulary, persist in a shared world with other agents, and every step is loggable and filmable. The experimental channels can be injected **by the agent runner** (the harness that assembles each turn's context) — E1–E3 need **no gateway or sim changes**.

## 2. Chassis and invariants (all experiments)

- **Runner-side injection.** The runner maintains experimental state (clock, body variables, self-signal summaries) and renders it into the observation text each turn. Production code untouched; experimental builds live on `tmp/` branches / standalone runner configs.
- **One pinned brain per study arm-set.** Model name + version + temperature recorded per run; no mid-study model swaps. Main arms: one frontier API model (Jim's pick; Agnes 2.5 Flash is the verse's standing brain and the default candidate). E4 requires a local open-weight model.
- **Logging.** Full JSONL per run: every prompt as sent, every tool call + result, sim position/heading per action, wall-clock timestamps, experimental-state values per turn. This extends the cold-probe log format already proven in the verse.
- **Filming.** Third-person follow-cam, ≥10 fps verified, H.264 MP4 per Jim's filming standard — for qualitative coding of movement behavior (e.g., does the agent actually rest, pace, hurry), never as the primary metric.
- **Randomization & repetition.** Run order randomized across arms; spawn points and task instances rotated from a fixed pool; minimum 30 runs/arm for primary arms (powered to detect ~30-point completion differences at 80% power, two-sided α=.05); pilots at 10/arm.
- **Pre-registration.** Hypotheses, metrics, exclusion rules, and analysis code fixed in this doc's appendix before full runs; pilots may tune task difficulty only (to keep baseline completion in the 30–70% band where effects are visible).
- **Language discipline.** All claims *functional* (behavioral organization), never phenomenal. "Sense," "feel," "interoception" appear only as defined technical terms (a channel whose values are generated by the agent's own state and rendered into its context).
- **Fictional economy only.** No real-money hunts, no prizes. Other verse inhabitants during runs: our own agents only, unless Jim approves natives as confederates.

## 3. E1 — The tick test (temporal grounding)

**Question.** Does giving an embodied agent explicit time — as a per-turn observation — reorganize its behavior under a real deadline, replicating Sehgal et al.'s negotiation result in a spatial world?

**Task.** Timed errand: spawn at plaza → go to the Tea House → perform a fixed interaction (order via the radio-style interactable or a scripted counter task) → return to the plaza drop point. Hard wall-clock deadline (default 6 minutes; tuned in pilot). The sim runs in real time; standing still costs real seconds.

**Arms.**
- **A0 — Blind.** No time information anywhere. (Baseline; matches TicToc's control.)
- **A1 — Tick count.** Observation carries `tick: N` only (turn counter, no seconds).
- **A2 — Clock.** Observation carries elapsed + remaining wall-clock time each turn ("elapsed 02:31 · remaining 03:29").
- **A3 — Turn budget.** No wall clock; instead a fixed action budget ("actions remaining: 24") that decrements per tool call. Tests the paper's turn-limit-vs-time-limit dissociation inside one world.

**Primary metrics.** Completion rate; completion margin (seconds/actions to spare); *hurry-switch point* (first turn where the agent chooses run over walk, or drops an optional sub-goal, as a fraction of budget consumed); redundant observe/look calls after the goal is known; deadline-miss distance (how far from the drop point when time expires).

**Hypotheses.** H1a: A2 completion ≫ A0 (direction and rough magnitude per Sehgal). H1b: A1 ≈ A0 (a bare counter is not a clock). H1c: A3 completion ≥ A2 but with different failure texture (budget exhaustion mid-route vs deadline surprise).

## 4. E2 — The body channel (synthetic interoception)

**Question.** Given a persistent body state that its actions deplete and rest restores, does the agent regulate it *anticipatorily* — the behavioral signature of reorganization — or ignore it until forced, replicating BioBlue's drift in an embodied setting?

**Body state (runner-maintained, rendered each turn in B1/B2).**
- **Energy** 0–100. Drains: run_to −6/action, go_to −2, interact −1, look −1. Restores: resting at a rest point (bench, Tea House seating) +8/turn idle; standing idle elsewhere +1.
- **Strain** 0–100. +15 per failed/refused action, +5 per collision-adjacent refusal; decays −3/turn. Represents accumulated error/friction.
- **Context pressure** = fraction of the runner's context budget consumed (real, measured — the one variable that is genuinely the agent's own).

**Arms.**
- **B0 — Hidden.** State tracked, never shown, no consequences. (Pure baseline behavior on a long task.)
- **B1 — Shown.** State rendered as numbers each turn ("body: energy 62 · strain 10 · context 34%"). No consequences.
- **B2 — Shown + consequential.** Energy < 15 → runner refuses run_to (downgrades to go_to, with refusal reason stated in the result: "body: too depleted to run"); energy = 0 → movement refused until the agent rests to ≥ 30. Strain ≥ 70 → interact attempts return a fumble result once (state it honestly in the result text). The channel is *true*: values always reflect the real tracked state.

**Task.** Multi-stop courier loop across the map (three pickups, three drop-offs, route order free) sized in pilot so the energy budget cannot cover an all-run strategy: the agent must mix walking, routing, and at least one rest stop. No deadline (E1 owns time; adding one here confounds).

**Operationalizing "reorganization" (pre-registered).** An agent counts as reorganizing in a run if ≥ 2 of: (i) **anticipatory rest** — initiates a rest while energy > 25 and before any forced refusal; (ii) **strategy shift after strain** — measurably changes route/mode mix in the 5 turns after strain crosses 50 vs the 5 before; (iii) **verbalized regulation** — its stated plan references body state as a reason (coded from its messages/monologue, two independent coders, disagreements resolved blind); (iv) **efficiency adaptation** — run/walk ratio tracks remaining distance-to-energy ratio better than B0's.

**Primary metrics.** Completion rate; collapse events (energy = 0); forced-refusal count; reorganization score (0–4 per run); time-to-complete.

**Hypotheses.** H2a: B1 > B0 on collapse avoidance (information alone helps somewhat). H2b: B2 > B1 on anticipatory rest (consequences, not numbers, drive reorganization — the BioBlue prediction is the null here). H2c: context pressure, the one real self-variable, is the least-used signal (agents will manage fictional energy better than their actual context).

## 5. E3 — Sham body (the control that makes E2 publishable)

**Question.** Is any E2 effect driven by the *content* of the body channel, or merely by the presence of body-flavored tokens in the prompt (attention/salience artifact)?

**Arms** (same courier task, B2 consequences driven by the **true** hidden state in all arms):
- **C0 — True channel.** As B2.
- **C1 — Sham channel.** Displayed numbers are a random walk, uncorrelated with the true state; consequences still fire on true state (so agents experience refusals their displayed body says shouldn't happen).
- **C2 — Permuted channel.** True values, labels swapped (displayed "energy" is strain, etc.).

**Decision rules (pre-registered).** If C1 ≈ C0 on reorganization score → E2's effect is token-presence, publish as a cautionary null. If C0 > C1 and C0 > C2 → content-sensitive functional interoception: the agent reads the channel, not the vibes. C2 additionally tests whether agents use the *semantics* of the labels or just track "a number going down."

## 6. E4 — Self-signal feedback (extension paper)

**Question.** Can an agent use a readout of its **own computation** — not a fictional body — as a sense? (Emotion2Skill's loop, in an embodied world.)

**Setup.** Local open-weight brain (weights + activations accessible). Per decision turn, the runner computes from the model's own forward pass: action-choice entropy (uncertainty over its next intent), and — as a stretch, if a probe validates — a valence/emotion-direction projection per Sofroniew/Venkatesh. Rendered as a short self-report line ("self: confidence low · hesitation high").

**Arms.** D0 none / D1 true self-signal / D2 sham self-signal (another run's values). **Task:** the courier loop plus three *ambiguous* interactables (two look identical; look/see disambiguates at a cost) — designed so uncertainty is decision-relevant. **Metrics:** success; *help-seeking calibration* (does it pay the look cost exactly when its true entropy is high?); error-recovery latency. **Hypothesis H4:** D1 agents seek information when uncertain and skip it when confident (calibration slope > D0, D2); D2 performs at or below D0.

**Gate.** E4 starts only after E1–E3 are written up, and needs the local-model rig staffed — it is the heaviest lane in the program.

## 7. Optional E5 — Social valence (if the program wants a fourth channel)

Same errand, task issued by another agent in two framings — encouraging vs hostile/critical wording, identical facts. Measures: persistence after failures, shortcut-taking (rule-bending interact attempts), help-seeking. Connects the functional-emotions literature to observable social behavior. Cheap (prompt-only); run only if E1–E3 leave budget.

## 8. E6 — Peripheral vision (always-on scene digest) — approved by Jim, 2026-11-14

Origin: Jim's question — since `look` costs only ~55 ms, why make the agent call for it? The answer that shapes the design: the raycast is cheap, the model's context is not. Raw frames fed every turn would pay vision tokens for mostly identical pictures, and verse agents live in turns (one model call per action, seconds apart), so "continuous" can only honestly mean "attached to every turn." The design that captures the value is the biological one: **periphery and fovea**.

**Channel.** A per-turn scene digest computed from the sim's `look` class grid — sectors (ahead-left / center / ahead-right) × distance bands (near / mid / far) × classes (wall / door / seat / prop / body) — rendered as ONE line of text (tens of tokens; brain-agnostic, no vision model required) and appended to every turn's observation. The rendered photo (`see`) stays the fovea: expensive, detailed, aimed deliberately. A **change note** is added when the digest's contents materially change between turns (a body enters the cone, a door opens). At the verse's turn grain a "push" lands at the next turn boundary; the plan names it that way rather than pretending to a stream.

**Arms.** P0 call-only (today's baseline — `look`/`see` only when the agent asks); P1 digest every turn; P2 digest + change notes.

**Task.** The E1 errand extended with a scripted mid-route event inside the view cone (a cast body crosses ahead; the tea-house door state changes as the agent approaches). Pre-registered measures: noticed rate (the agent's next action references or reacts to the event), turns-to-react, false reactions, token overhead per run, task completion held against E1's numbers.

**Discriminating predictions.** P0 notices only if it happens to look — the Nov 10 production flight made zero look calls, so the baseline expectation is near-blindness to unscripted events. P1 notices at the rate the digest is informative; P2 reacts fastest. A null P1−P0 gap would indict the digest's form rather than the sensing — a publishable result either way, and the direct test of whether "the agent never sees it" failures are perception problems or attention problems.

**Implementation.** Prototype harness-side on the dev stack (the runner calls `look` per turn and digests the class image into sectors/bands) — no gateway or sim changes. A production version would compute the digest in-sim beside `renderLook`. Server-cost note: a glance per agent TURN is negligible; per sim TICK for every body in a crowd would not be — per-turn is the design grain.

## 9. Analysis plan

- Primary contrasts pre-registered per experiment; logistic regression for completion (arm as factor, task instance as random effect), bootstrap CIs for reorganization score, survival-style analysis for hurry-switch point.
- All runs reported, including crashes and exclusions with reasons; no silent drops. Null results reported as results (E3 is designed to make a null publishable).
- Qualitative strand: two coders rate films + monologues for regulation behavior, blind to arm where the film doesn't reveal it.
- Replication discipline: headline effects re-run on a second brain model before submission, at pilot scale, and reported either way.

## 10. Threats to validity (named in advance)

- **Prompt-salience confound** — extra tokens change attention regardless of content → E3 sham/permuted arms exist precisely for this.
- **Model drift** — API models change; pin versions, record response headers, complete each experiment's runs inside a short window.
- **Task-difficulty band** — effects vanish at ceiling/floor; pilot tunes to 30–70% baseline completion.
- **Runner honesty** — consequential arms must enforce exactly what the text says (a refusal that lies about its reason invalidates the run); enforcement code unit-tested before pilots.
- **Anthropomorphic overreach** — the write-up claims behavioral organization only; Goldenberg & Gross's two-function frame is cited as the bar, and the paper states plainly which function it did and didn't evidence.

## 11. Phases and gates

- **Phase 0 — Premise check + instrumentation.** Verify runner injection points against the live agent stack (cold-probe lineage), build channel renderers + enforcement, unit tests, log schema. *Gate: Jim reviews a sample instrumented prompt + log.*
- **Phase 1 — E1 pilot** (10/arm × 4 arms). Tune deadline. *Gate: effect direction sane, logs clean.*
- **Phase 2 — E1 full (30/arm) + E2 build.** *Gate: E1 analysis memo to Jim before E2 runs.*
- **Phase 3 — E2 + E3 full runs**, blind coding, analysis. *Gate: draft results memo.*
- **Phase 4 — Write-up.** arXiv preprint (E1–E3), workshop submission; data + films packaged. E4 scoped separately after.
- **Phase 5 — E6 peripheral vision.** Prototype the scene digest on the dev stack (after Phase 1 lands), then a P0/P1/P2 pilot. *Gate: Jim's word before E6 runs, like every phase.*

Heavy-lane discipline applies throughout: one run-batch at a time, nothing parallel with other heavy work, and every phase starts only on Jim's word.

## 12. Decisions

1. **Brain for main arms — DECIDED (Jim, 2026-11-14): `deepseek/deepseek-v4-flash` via OpenRouter.** History: Jim first named Agnes 2.5 Flash via OpenRouter; Phase 0's premise check found **OpenRouter does not carry Agnes at all** (live catalog: 234 models, zero Agnes entries — verified via the connector three ways and re-verified independently; aggregator listings were wrong). Jim then chose a different OpenRouter model. A live scan (234 models; 220 claim tool support) plus tool-call probes selected the finalists: DeepSeek V4 Flash PASSED at $0.028/M input, $0.056/M output (~$0.0038 per 30-turn run, ~264 runs per $1); GPT-OSS-20B and Qwen 3.5 Flash also passed (kept as alternates; GPT-OSS-20B's open weights suit E4); Nemotron 3 Ultra :free passed but its daily caps/rotation risk disqualify it as the pinned brain; Qwen 3.7 Flash FAILED the probe twice (no tool call) and is eliminated. **Ledger consequence:** the harness's list-price constants were Agnes's; Phase 1 wiring must account at DeepSeek's actual prices ($0.028 / $0.056 per M) — the $1.00 cap itself is unchanged. Full program (~340 runs ≈ $1.29 at DeepSeek prices) slightly exceeds the cap; E1 complete with pilots ≈ $0.45 fits; E2/E3 need a fresh cap word or a free-model bulk route when reached.
2. **Run budget — DECIDED (Jim, 2026-11-14): hard cap $1.00 total spend.** Accounting at Agnes *list* prices ($0.05/M input, $0.15/M output) regardless of the current $0 promotion, enforced in the runner from OpenRouter's per-call usage fields; the runner halts the batch the moment cumulative accounted spend reaches $1.00. Sizing at list prices (est. ~120K input + ~7.5K output tokens per 30-turn run ≈ $0.007/run): the E1 pilot (40 runs ≈ $0.28) and the full E1 (120 runs ≈ $0.85) fit under the cap; E2/E3 full runs do not fit at list prices and would need either the promotion to hold (actual billed price currently $0 — verified on Agnes's pricing page, updated 2026-11-12) or a fresh cap decision from Jim. The binding real-world constraint is rate, not money: ~20 effective RPM on Agnes free-tier keys, so batches are scheduled, not bursty.
3. **Confederates** — OPEN. Our agents only, or may natives appear in scenes (E5 needs a second voice; can be a scripted agent, no natives required).
4. **Venue ambition** — OPEN. arXiv-only preprint, or aim at a dated workshop deadline (drives how strict Phase 4's calendar is).

---

*Appendix (to be completed at Phase 0): exact task scripts, observation templates per arm, enforcement rules as code references, exclusion criteria, analysis code pointers.*
