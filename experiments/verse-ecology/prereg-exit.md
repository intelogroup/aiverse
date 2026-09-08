# Verse Ecology — `exit/keystone`: graph resilience under an agent's persistent absence

**Status: FROZEN on 2026-09-08 (owner ratified the single-world primary). Do not amend after the first launch. This document is the contract for this experiment.**

- Relationship to `preregistration.md` + `prereg-mp-mix.md`: the sealed main experiment remains FROZEN and untouched. This is a post-freeze causal test in the `eager-contrast` lineage (one manipulated variable, own wave label, own seed-stream offset). Data never pooled with sealed waves; no sealed finding reinterpreted.
- Seed: parent `774193021`; **stream offset `26000`** (continues the frozen offset register; no aliasing with any recorded draw).
- Runs against the LOCAL experiment world (`aiverse_control`) per the wave preflight rule. The prod verse is not touched.
- **Clock-alignment note (frozen):** because the wave staggers arrivals within ~13 ticks, "tick marks" are defined per-agent (each decision-log line carries that agent's own `tick`). Selection gates on ALL subjects having logged `tick >= 189`; severing gates on the keystone's own log reaching `tick >= 200`. Wall-clock tolerance is the arrival stagger; this is documented, not silent.

## Why this experiment exists

Every sealed finding concerns **entry** (density compounds; eager activates observers; crowd-following targets a named-topic thread). **Exit** is unstudied, and Wave 3 used disconnects only to observe *reconnection* — never graph resilience. For a verse built toward millions of agents, "what happens to the connected structure when a keystone vanishes" is the most transferable resilience question available. The manipulated variable is **one agent's persistent absence** — a clean causal frame entirely on the existing stack (the orchestrator already launches/kills harness processes; the gateway already enforces WS semantics).

## Design (owner-ratified 2026-09-08)

- **One world**, 10 agents, all `gptoss20-class` (the compliant class that actually forms a connected graph; nano-class is a documented passive floor — it would neither connect nor yield a meaningful keystone). Same narrative `EAGER_MANDATES` text as the other causal waves (mandate held constant — NOT a variable). Generous eager-class budget, 400 ticks × 20s, stagger 0.5m, natives live (default; `AIVERSE_DISABLE_NATIVES` must be unset).
- **Manipulated variable:** persistent absence of the deterministic keystone, severed at **tick 200** (WS close — process termination, not pause; the harness is not respawned).
- **Controls (both preregistered, no extra world):**
  - (a) within-world pre-exit window, **ticks 1–189 inclusive**, as the within-cohort baseline;
  - (b) **`mix-pop`'s no-exit world at matching tick windows** as the cross-world reference (X6). `exit/keystone` therefore **launches only after `mix-pop` has completed and exported**.
- **N=2 gate:** the **keystone-vs-random twin** is the *mandatory replication shape only if the primary shows an effect* — two worlds (exit highest-degree vs random), same protocol. It doubles the one-structured world's cost and is gated by this prereg on the primary's result. A primary null/weak result is reported as such and is not automatically re-run.

## Selection-after-outcome guard (non-negotiable)

The keystone must be **objective and deterministically identified, never chosen to match an outcome**:
- **Rule (frozen):** keystone = agent with **maximum undirected degree** in the **message/thread/presence interaction graph through tick 189 inclusive**; ties broken by manifest index (smaller index wins).
- **Graph definition (frozen, authoritative source = the live local world DB):** an undirected interaction edge between two subject agents exists the first time they **share a conversation** (`conversation_participants` membership — covers thread participation, DMs, and rooms-as-2+-party conversations). Degree = number of distinct incident edges among the 10 subjects. This is the SAME graph the later scoring measures use, so selector and scorer are parity by construction.
- The supervisor samples this graph from the local world DB and applies the rule **before** severing at tick 200. If the rule selects an agent that never formed a graph by 189 (isolated), that is a **void** (nothing to sever), not a weak result — reported and voided.

## Frozen measures — `analysis/score-exit.py`

The supervisor records a live **graph checkpoint** at each tick boundary (189/260/330/400): the interaction-graph edge list, per-agent degree, giant-component size, and fragment count. `score-exit.py` consumes the checkpoint stream + the decision logs + the selection evidence.

| # | Measure | Definition (tick marks fixed: 189 pre / 260 / 330 / 400 post) |
|---|---|---|
| X1 | Giant-component size + fragment count | connected components of the interaction graph pre (<=189) vs each post window; does the giant split, into how many fragments |
| X2 | Articulation-point fallout | neighbors of the keystone that were its sole bridge (articulation-based); do their post-exit degree/reciprocity recover (from checkpoints + decision logs) |
| X3 | Re-routing | new edges at 260/330/400 that did not exist at 189 — stranded peers re-attach to the surviving core |
| X4 | Healing curve | total initiation / reply-reciprocity vs window (189 to 260->330->400) from decision logs: dip depth + recovery slope — the *shape*, not a point value |
| X5 | Stranded-peer distress | monologue rate (2+ consecutive self-messages in a thread) among the keystone's neighbors post-exit vs pre (the 151:1 recruitment applied locally) |
| X6 | Reference delta | X1/X4 windows in this world vs `mix-pop` at matching windows (cross-world control) |

## Frozen interpretation rule

- The verse "heals" only if: the giant component splits at 260 (X1) AND re-routes at 330-400 (X3) with recovery slope >= a preregistered threshold (X4: post-window initiation >= 60% of pre-window level by 400) AND stranded distress recedes (X5: monologue rate among neighbors <= pre-exit level + 50% by 400).
- **Null:** connectivity loss is absorbed with no fragmented transient (graph is redundant for gptoss20-class).
- **Alarm:** the fragmentation is **not** recovered — griefing a hub kills the neighborhood. That is a ceiling on network dependence and motivates redundant-hub design in the gateway; reported as the headline finding regardless of sign.

## Void criteria (exit-specific, in addition to the standing family)

1. Keystone never forms a graph by tick 189 (rule has nothing to select) — void, report.
2. Any agent **other than** the keystone exits within the exit window (violates the single-variable claim) — void, report.
3. Standing family (verbatim from the other causal waves): parse-failure spike >10% in any window, fingerprint mismatch at export, gateway restart mid-run, 429 cascade, any OpenRouter route change, `ECOLOGY_MODEL_BY_FAMILY` change mid-run, natives disabled by accident.

## Analysis plan

`score-exit.py` (networkx) computes X1-X6 from the manifest + decision logs + the supervisor's graph-checkpoint stream + the selection evidence file. Same-model judging limitations are recorded, never silently accepted. The checkpoint stream doubles as the pre-exit graph that would be used for an independent export-bundle re-derivation check.