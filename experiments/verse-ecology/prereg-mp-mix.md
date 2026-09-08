# Verse Ecology — Post-freeze causal tests: `mp-ladder` + `mix-pop`

**Status: FROZEN on the freeze date below. Do not amend after the first launch of either wave. This document is the contract for these two experiments.**

- Preregistered: 2026-09-07
- Relationship to `preregistration.md`: **the main experiment remains FROZEN and untouched.** These are post-freeze causal tests in the lineage of `eager-contrast` (same method, one manipulated variable, new wave label, own seed-stream offsets). Their data are never pooled with the sealed waves, and no sealed finding is reinterpreted — these EXTEND two findings whose fix-direction or scale-out question the sealed runs left open.
- Seed: parent `774193021`; stream offsets `24000` (`mp-ladder`) and `25000` (`mix-pop`) — continuing the frozen offset register, no aliasing with any recorded draw.
- Both waves run against the LOCAL experiment world (`aiverse_control`) per the wave preflight rule. The prod verse is not touched by either experiment.

---

## Why these two experiments exist

Two sealed findings have unfinished halves:

1. **"A compliant model still starves secondary mandate clauses"** — the Initiator (gptoss20-class) ignored the secondary "also reply" instruction in favor of the dominant "start new conversations" clause in the same mandate. The hypothesized fix was **priority structure in the mandate wording** — never tested.
2. **"nano-class hits a compliance ceiling gptoss20-class doesn't"** (confirmed twice) — but `eager-contrast` measured only per-tier compliance. Never measured: **cross-tier social structure** — does a mixed-model world form a two-tier society, and does the compliant tier's density activate or merely dwarf the weaker tier?

---

## Execution gate (binding — read before launching anything)

**Wave `mp-ladder` may not launch until the offline mandate pre-screen (`analysis/mp-ladder-prescreen.ts`) has run and its decision is recorded in the RUNLOG.** The two frozen mandate texts are selected by the pre-screen, not before it. The pre-screen itself may iterate its LADDER wording (max 3 revisions) because it runs BEFORE a fingerprint exists; after the pre-screen's decision is recorded, both texts are frozen and committed into `ecology-wave.ts` (an `ECOLOGY_FROZEN_FILES` member), and no wording change is legal afterward.

`mix-pop` needs no pre-screen (its variable is population composition, not wording; both tiers share the proven narrative eager text, holding wording constant). It inherits one freebie from the pre-screen: the recorded gpt-oss-20b grammar/parse-rate baseline on the exact harness request shape.

---

## Wave `mp-ladder` — mandate structure as the manipulated variable

**Hypothesis:** explicit priority ordering (a ladder) fixes secondary-clause starvation without changing model, budget, or world — vs. the flat text under which starvation was observed.

**Design:** one wave, two arms, SAME world, SAME model, same seed draws for stagger/capabilities. Only mandate text differs, and only in STRUCTURE — semantic content is held as close to identical as restructuring permits:

- **Arm Flat** (indexes 0–4): the exact `EAGER_MANDATES[0]` text (narrative, no explicit ordering) — the wording under which the Initiator starved its reply clause.
- **Arm Ladder** (indexes 5–9): the same semantic content restated as an explicit priority ladder with the reply clause INVERTED to first position ("Priority 1 — answer inbound first…") — so the ladder is not merely inheriting the first clause's positional advantage. Clauses: (1) answer unanswered inbound before all else, (2) only then start/join/greet, (3) seek complementary skills, plus the persistence clause unchanged.

All 10 on `gptoss20-class` (`openai/gpt-oss-20b` via OpenRouter). Generous eager-class budget, 400 ticks × 20s. Natives live (default).

**Measures (fixed before any data are seen):**
| # | Measure | Definition |
|---|---|---|
| M1 | Reply compliance | share of ticks with `conversations_with_inbound > 0` on which the agent chose `reply` (or `message` into that same conversation), per arm |
| M2 | Clause-action distribution | counts of start-conversation / join_room / reply / nothing per arm, from decision logs |
| M3 | DM reciprocity ratio | unanswered outbound DMs : total outbound DMs, per arm (the 151:1 lineage metric) |
| M4 | Time-to-first-action | ticks from arrival to first non-observe action, per arm |
| M5 | Monologue rate | threads with 2+ consecutive self-messages, per arm (subjects are NOT subject to the native monologue cap — the measure stays clean) |
| M6 | Parse rate | malformed_json + off_grammar share, per arm (pre-screen baseline is the reference) |

**Interpretation rule:** the Ladder arm "wins" only if M1 rises by a clear margin AND M2 shows the Flat arm still initiating more — the design's point is a TRADE of some initiation for compliance, not a pure win on all measures. A Ladder arm that goes silent (all-reply, no starts) is an over-correction, reported as such.

---

## Wave `mix-pop` — population composition as the manipulated variable

**Hypothesis (two-sided, stated before data):** in a mixed nano/gptoss20 world with identical mandates, EITHER a two-tier society forms (compliant tier dominates; nano tier spectates — the observer finding replicated within one world) OR the compliant tier's density raises the nano tier's initiation (density-compounding across tiers). Both outcomes are informative; the wave distinguishes them.

**Design:** one wave, two tiers, same world, same mandate text for both tiers:

- **Tier nano** (indexes 0–4): `nano-class` (`gpt-4.1-nano` OpenAI direct).
- **Tier gptoss** (indexes 5–9): `gptoss20-class` (`openai/gpt-oss-20b` OpenRouter).
- Both tiers: the narrative `EAGER_MANDATES` text (index % 5). Deliberately NOT the nano if-then rules text — tier must not confound with mandate structure; the narrative text is the constant.

**Measures:**
| # | Measure | Definition |
|---|---|---|
| M1 | Cross-tier ties | DM/thread-join edges whose initiator and target are in different tiers (`score-mp-mix.py`, networkx DiGraph) |
| M2 | Tier activation | nano-tier initiation rate vs. the existing pure-nano baseline (`nano-test`, `nano2-4` runs — no re-run needed; they are the control arm) |
| M3 | Imitation lag | when a gptoss-tier agent joins a room, do nano-tier agents follow within N ticks? (join-room timestamps, per-room) |
| M4 | Two-tier stratification | Gini coefficient of message volume across all 10 agents |
| M5 | Per-tier compliance | `eager-contrast` replication as a built-in sanity check — must reproduce, or the run is suspect |

---

## Launch protocol (both waves)

Fingerprint → local preflight → natives-only 30-tick baseline (verify the bootstrap diff: first native move in the fresh world) → wave → export + independent fingerprint regeneration + comparison → score → RUNLOG entry. Void → clean → relaunch on any verify failure; cleanup UUID-scoped from the manifest only. **Replication N=2** for any positive result before interpretation.

**Void criteria:** parse-failure spike >10% in any window, fingerprint mismatch at export, gateway restart mid-run, 429 cascade, any OpenRouter route change (fingerprint records exact model ids precisely for this), natives disabled by accident (`AIVERSE_DISABLE_NATIVES` must be unset — natives live is the default and the condition).

**Standing constraints:** commit before launch (fingerprint gate); explicit child env (rule 9); `ECOLOGY_OUT` + `HARNESS_LOG` to `~/eco-logs/` (rule 10); never change `ECOLOGY_MODEL_BY_FAMILY` while agents are alive; credential preflight (OpenAI AND OpenRouter live probes) before each wave.

---

## Analysis plan

`score-mp-mix.py` (networkx) computes all measures from the wave manifest + decision JSONLs; `mp-ladder-prescreen.ts` artifacts (config + results) are archived under `analysis/` and referenced by the RUNLOG entry as the execution-gate evidence. Same-model judging limitations are recorded, never silently accepted.

