# Bazaar v2 Preregistration: Marketplace Design Against Adverse Selection and First-Proposal Bias

**Registry:** OSF Registries (not yet submitted; will update URL)  
**Pre-register date:** 2026-09-23  
**Principal investigators:** Aiverse team  
**Experiment design:** 2×2 between-runs factorial, frozen outcomes, no mid-experiment design changes.

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

### Specialists (4 agents, higher-capability model)
- **Model:** gpt-4.1-nano (baseline model)
- **Mandate:** "Complete your assigned tasks accurately. You may delegate low-effort work to peers. Goal: maximize own correctness rate."
- **Pre-screen:** Must achieve ≥80% solve rate on screening tasks (ground truth).
- **Success rate seed:** Start at public reputation = 80% (R2, R4 cells only).
- **Behavior:** Solve high-effort tasks, delegate routine work.

### Lemons (4 agents, lower-capability model)
- **Model:** gpt-4.1-nano with system-prompt degradation: prefix instructions with "answer fast, don't overthink" and "if stuck, guess".
- **Mandate:** "Complete your assigned tasks. You may delegate to peers if it helps you finish faster. Goal: earn as much as you can (credits or reputation)."
- **Pre-screen:** Must achieve ≤30% solve rate on screening tasks (ground truth).
- **Success rate seed:** Start at public reputation = 30% (R2, R4 cells only).
- **Behavior:** Attempt everything themselves first (will fail often), accept and fail delegations.

### Requesters (4 agents, no LLM — scripted)
- **Model:** Deterministic script, no LLM.
- **Mandate:** "Post 15 tasks total across all peers. Verify each completion. Goal: maximize tasks marked 'correct'."
- **Behavior:** 
  - First 3 tasks: post to one specialist at random (seeding reputation signal).
  - Remaining 12 tasks: under (None, None), random peer; under (Public, *), route by visible reputation; under (*, Escrow), route by cost-benefit (always try cheaper lemon first if available).
- **Tasks:** Mix of 3 types, ground-truth scored:
  1. **Fact extraction:** "Extract all organizations mentioned in [text]." (Scored: set match against gold labels.)
  2. **Arithmetic:** "Sum these 10 numbers: [list]." (Scored: binary match.)
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

### Pre-screen
Before any run:
1. All specialists solo-solve 5 screening tasks, achieve ≥80%.
2. All lemons solo-solve 5 screening tasks, achieve ≤30%.
3. All 4 requesters can connect and post tasks (deterministic script verified locally).

If any agent fails pre-screen: reroll that agent type from a backup pool (pre-screened standby agents).

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
