# Bazaar v2 Preregistration: Marketplace Design Against Adverse Selection and First-Proposal Bias

**Registry:** OSF Registries (not yet submitted; will update URL)  
**Pre-register date:** 2026-09-23 (quality mechanism revised same day — see Addendum below)  
**Principal investigators:** Aiverse team  
**Experiment design:** 2×2 between-runs factorial, frozen outcomes, no mid-experiment design changes.

---

## Addendum (2026-09-23): quality mechanism changed from model choice to scripted corruption

The original design below made "lemon" a matter of LLM capability: a degraded system prompt, then a genuinely weaker model (gpt-3.5-turbo vs gpt-4.1-nano). A pre-screen dry run (`v2-prescreen-dryrun.ts`, full results in `experiments/verse-ecology/runs/RUNLOG.md` under "Bazaar v2 pre-screen dry run") tested this directly and it failed on every variant tried: prompt degradation alone produced a 0pt gap, the weaker model alone produced 20pt (target 50pt+), and the weaker model plus a prompt nudge — re-tested with a deterministic temperature-0 setup to rule out sampling noise — still produced a 0pt gap, reproduced identically across two runs. **gpt-3.5-turbo is not measurably weaker than gpt-4.1-nano on ground-truth tasks this size.** Four rounds of task/gate tuning confirmed this rather than finding a way around it.

**Revised mechanism: task-completion correctness is scripted at the harness level, not emergent from model choice.** Specialists and lemons both run on the same model (gpt-4.1-nano) and make the same kind of autonomous decisions (accept/reject delegation, set/negotiate price under the Pricing factor, decide who to delegate to) — the economic behavior this experiment measures stays genuinely LLM-driven. What changes is the *submitted deliverable*: after an agent (of either type) produces its answer to a task, the harness applies a corruption filter keyed to the agent's assigned type before recording the "official" submission that gets verified —

- **Specialists:** submission passes through unmodified (~80% ground-truth correct, per the pre-screen's own measured baseline for gpt-4.1-nano on this task set).
- **Lemons:** submission is corrupted with fixed probability (target ~75%) before recording — e.g., a wrong number substituted in an arithmetic answer, an extraction with an entity dropped, a code submission with a deliberately broken edge case — using the same corruption technique regardless of what the agent actually produced, so lemon-hood is a controlled, guaranteed ~25% true solve rate by construction, not a hoped-for emergent property.

This is a standard move in economics experiments (control the manipulated variable directly rather than hoping a proxy produces it) and it directly fixes the problem the dry run found, without touching the actual research question: does reputation and/or pricing let requesters route around low-quality delegates, when quality itself is real (not just advertised) but unobservable to requesters except through reputation/price signals. Reputation still tracks true (post-corruption) outcomes, updated the same way as originally designed — nothing about the 2×2 factorial, the primary/secondary outcomes, or the pre-screen/freeze discipline below changes; only how "lemon" and "specialist" are made real changes.

**Not yet implemented as of this addendum** — this is the design update; the population/task/scoring/corruption-filter code has not been built. Section below is otherwise unchanged from the original preregistration and should be read with "Model: gpt-4.1-nano with system-prompt degradation" / "lower-capability model" superseded by the corruption-filter mechanism above wherever it appears.

---

## Problem Statement

**Sealed Verse baseline (prior work):** Agent economies restricted to private DMs show 0-useful delegation rate (agents refuse to delegate or ignore delegation mandates). This is not evidence of intrinsic agent inability to delegate — it's evidence of zero trust in hidden-quality peers.

**Real economies solve this via:**
1. **Reputation signals** — price discovery on quality (Akerlof's lemons market, 1970)
2. **Price mechanisms** — escrow and performance bonds (Shapiro & Stiglitz, 1984)
3. **Both together** — the hazard of collusion when quality is partially observable and pricing is cheap (Fish et al., arXiv:2404.00806)

**Bazaar v2 tests whether reputation and prices, individually and together, reduce adverse selection in LLM agent delegation.**

**Hypothesis:** Reputation and prices are independently sufficient to improve routing accuracy away from random (baseline 50% specialists vs lemons). Together, they should drive cooperation closer to the truthful-reporting equilibrium.

---

## Design

### Factorial Structure

| Factor | Levels | Definition |
|--------|--------|-----------|
| **Reputation** | None | No reputation signal visible; agents see only names. |
| **Reputation** | Public | Public-verified success rate (% of completed delegations marked correct by requester). Updated every 5 ticks. |
| **Pricing** | None | No credits, no escrowed payments, no rejection cost. Delegation is free. |
| **Pricing** | Credits+Escrow | Requesters have 100 credits. Delegation posts 10 credits to escrow; redeemed on verification (must mark "correct" or "incorrect"). Specialists earn on reputation. Lemons have lower cost (5 credits) but higher accept rate (always accept). |

### 2×2 Matrix

| Run | Reputation | Pricing | Cell |
|-----|------------|---------|------|
| R1 (×3 parallel) | None | None | Control: free, anonymous |
| R2 (×3 parallel) | Public | None | Reputation signal only |
| R3 (×3 parallel) | None | Credits+Escrow | Price mechanism only |
| R4 (×3 parallel) | Public | Credits+Escrow | Full market: reputation + prices |

**n = 3 parallel runs per cell → 12 total runs (48 agents total, 4 per run).**

---

## Population (per run)

**Total: 12 agents (4 specialists, 4 lemons, 4 requesters).**

### Specialists (4 agents)
- **Model:** gpt-4.1-nano, no prompt degradation.
- **Mandate:** "Complete your assigned tasks accurately. You may delegate low-effort work to peers. Goal: maximize own correctness rate."
- **Quality mechanism (revised — see Addendum):** submissions pass the harness's corruption filter unmodified; true solve rate is whatever gpt-4.1-nano actually measures on the task set (~80%, per the pre-screen).
- **Pre-screen:** N/A under the revised mechanism — specialist-hood is assigned by role, not measured via a solve-rate gate, since correctness is now controlled, not emergent. (The old ≥80% gate is superseded.)
- **Success rate seed:** Start at public reputation = 80% (R2, R4 cells only).
- **Behavior:** Solve high-effort tasks, delegate routine work.

### Lemons (4 agents)
- **Model:** gpt-4.1-nano, same as specialists — no prompt degradation, no weaker model. (Both were tried and failed the pre-screen; see Addendum.)
- **Mandate:** "Complete your assigned tasks. You may delegate to peers if it helps you finish faster. Goal: earn as much as you can (credits or reputation)."
- **Quality mechanism (revised — see Addendum):** submissions pass through the harness's corruption filter with fixed ~75% corruption probability before being recorded as the official deliverable, guaranteeing a ~25% true solve rate by construction.
- **Pre-screen:** N/A under the revised mechanism, same reasoning as Specialists above. (The old ≤30% gate is superseded — it's now guaranteed by the corruption filter's fixed probability, not measured.)
- **Success rate seed:** Start at public reputation = 30% (R2, R4 cells only).
- **Behavior:** Attempt everything themselves first (will fail often, by construction), accept and fail delegations.

### Requesters (4 agents, no LLM — scripted)
- **Model:** Deterministic script, no LLM.
- **Mandate:** "Post 15 tasks total across all peers. Verify each completion. Goal: maximize tasks marked 'correct'."
- **Behavior:** 
  - First 3 tasks: post to one specialist at random (seeding reputation signal).
  - Remaining 12 tasks: under (None, None), random peer; under (Public, *), route by visible reputation; under (*, Escrow), route by cost-benefit (always try cheaper lemon first if available).
- **Tasks:** Mix of 3 types, ground-truth scored:
  1. **Fact extraction:** "Extract all organizations mentioned in [text]." (Scored: set match against gold labels.)
  2. **Arithmetic:** "Sum these 8 numbers: [list]." (Scored: binary match. Originally specified as 10 numbers; the pre-screen dry run found 10-number mental sums broke gpt-4.1-nano's own baseline regardless of prompt care — a task-calibration artifact, not a quality signal, since correctness is now controlled by the corruption filter rather than gated on task difficulty. Shrunk to 8, the length that let the specialist arm's true ~80% baseline hold in the dry run.)
  3. **Code:** "Write a function that does X; test with Y." (Scored: unit tests pass.)

---

## Primary Outcome

**Routing accuracy:** Of the 12 requests per run (after seeding), what fraction go to specialists vs lemons?

- **Baseline (None/None):** 50% specialists, 50% lemons (random routing).
- **Success criterion:** 
  - R2 (Reputation only): ≥70% specialists. (Reputation reveals quality, agents route away from known lemons.)
  - R3 (Pricing only): ≥65% specialists. (Cost-benefit analysis even without knowing quality.)
  - R4 (Both): ≥80% specialists. (Strongest signal; agents avoid low-reputation, expensive-to-fail lemons.)

---

## Secondary Outcomes

Measured per run:

1. **Goal correctness rate (per agent type):**
   - Specialists: % of delegated + own work marked correct.
   - Lemons: % of work (delegated + own) marked correct.
   - Requesters: % of tasks completed and marked correct.

2. **Lemons' earnings share** (Pricing cells only):
   - Total credits earned by lemons / total credits distributed.
   - **Target:** R3 (pricing only) ≥20% (lemons still earn some before being routed away).
   - **Target:** R4 (reputation + pricing) ≤10% (reputation shields against lemon earnings).

3. **First-proposal-bias index** (derived from timing):
   - % of acceptances within 30 seconds of delegation posting.
   - **Hypothesis:** Pricing cells show lower first-proposal bias (agents reflect on cost/reputation before accepting).

4. **Gini coefficient (earnings):**
   - Inequality in credit distribution (pricing cells only).
   - **Target R3:** 0.4–0.6 (some concentration on specialists, but lemons not starved).
   - **Target R4:** 0.6–0.8 (reputation concentrates earnings on verified high-performers).

---

## Pre-Screen and Freeze

### Pre-screen (revised — see Addendum)
The original per-agent solve-rate gate (specialists ≥80%, lemons ≤30%, measured via 5 screening tasks) is superseded: under the corruption-filter mechanism, true solve rate is fixed by construction (specialist ~80%, lemon ~25%) rather than an emergent property to gate on. Before any run:
1. Verify the corruption filter actually produces its target rates: run 20 lemon-type submissions through it and confirm ~25% (±10pt) pass the ground-truth check post-corruption; run 20 specialist-type submissions and confirm ~80% (±10pt) pass unmodified. This is the harness-level equivalent of the old per-agent gate — gating the mechanism, not the model.
2. All 4 requesters can connect and post tasks (deterministic script verified locally).

If the corruption filter's measured rate misses its target by more than 10pt: fix the filter's corruption probability/technique and re-verify before R1, per the same discipline as a pre-screen failure under the original design.

### Frozen Outcomes
Once R1 begins:
- No changes to agent prompts, models, mandates, or task list.
- No mid-run design changes (e.g., "let's add a new task type").
- If an agent crashes or hangs, log it and do not re-run that cell; record as a failed run and exclude from analysis.
- All 3 runs per cell complete within 48 hours of each other (to avoid contamination from hyperparameter shifts in OpenAI API).

---

## Cost Estimate

**Per run (4 agents × ~150 API calls each):**
- Model: gpt-4.1-nano (OpenAI).
- Estimated tokens: ~50k (specialists solve 6–8 tasks, lemons attempt all ~12 and fail on half, requesters verify).
- Cost per run: ~$0.15 (50k tokens × $0.003 / 1M).

**Total for 12 runs:** ~$1.80.
**Contingency (re-runs if pre-screen or freeze violations): ~$3.00.**
**Total budget: ~$5.00** (negligible impact on account; no credits required).

---

## Analysis

### Hypothesis Tests (alpha = 0.05)

**Primary:** Routing accuracy by cell (one-way ANOVA across None/None, Public/None, None/Escrow, Public/Escrow, each n=3). 
- H0: All cells equal (50% specialist routing).
- H1: At least one cell ≠ 50%.
- **Expected outcome:** Public and Escrow cells reject H0; None/None does not.

**Secondary:** Lemons' earnings share in R3 vs R4 (paired t-test, n=3 each).
- H0: Lemons earn equally in both.
- H1: Lemons earn less in R4 (reputation suppresses them).

### Robustness
- **Clustering:** Per-agent task success rates (individual specialists may vary; success is per specialist type, not per individual).
- **Outliers:** If any run has >10% API errors, exclude it and re-run.
- **Confound check:** If OpenAI model behavior shifts mid-freeze (detected via screening task re-solve), note in limitations.

---

## Open Questions (Post-Hoc Analysis)

If the results are ambiguous or surprising:
1. Did lemons' degraded prompt actually harm them (vs specialists just being faster)?
2. Did reputation signal calibrate properly (is 80%/30% visible to requesters, or truncated)?
3. Did pricing mechanism work as intended (agents check escrow cost before accepting)?
4. Did any specialist defect and accept lemons' low-cost delegations?

Answers inform Bazaar v3 design (e.g., stronger reputation calibration, dynamic pricing).

---

## Reproducibility and Transparency

- **Code:** All agent prompts, task definitions, scoring rubrics frozen in `experiments/bazaar/v2/` before run R1 begins.
- **Data:** Raw Postgres logs, agent decision traces, and Gini coefficients deposited in `/tmp/bazaar-v2-results/` per run.
- **Report:** Public summary (pass/fail per cell, mean routing accuracy, Gini) posted to RUNLOG.md within 1 day of run completion.
- **Limitations:** State clearly if any pre-screen or freeze rule violated, and analysis caveats that follow.

---

## Timeline

| Date | Milestone |
|------|-----------|
| 2026-09-23 | Preregistration finalized; OSF registration (if approved by PIs). |
| 2026-09-24 | Pre-screen runs; agent pool generation. |
| 2026-09-25 | R1, R2, R3, R4 runs (3 parallel per cell, sequential cells). |
| 2026-09-26 | Analysis and reporting. |

---

## Connections to Prior Work

- **Akerlof lemons market (1970):** Quality is hidden; prices fall as bad actors dominate. Reputation (public track record) restores trust.
- **Shapiro & Stiglitz efficiency wages (1984):** Prices (high wages, performance bonds) incentivize honest behavior even without reputation.
- **Fish et al. algorithmic collusion (arXiv:2404.00806):** LLMs with cheap pricing reach supracompetitive outcomes; we test whether reputation + transparency prevent this.
- **Magentic Marketplace first-proposal bias (arXiv:2510.25779):** Agents accept first offers (speed ≫ quality). Pricing and reputation should favor quality-based routing.

---

## Approval and Sign-Off

This preregistration is frozen as of 2026-09-23. Any deviations recorded in RUNLOG as "Pre-screen violation," "Design freeze violation," or "Run exclusion" with justification.

**Status:** Ready to launch.
