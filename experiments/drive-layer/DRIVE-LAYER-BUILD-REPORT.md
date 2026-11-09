# DRIVE-LAYER BUILD REPORT

**Built:** 2026-11-09, at Jim's go ("Build the drive layer, flagged and spec-exact", 11:45 ET).
**Contract:** `DRIVE-LAYER-SPEC.md` v1, same directory.
**Scope honored:** BUILD ONLY. No live runs of any condition were started. No scored runs. Nothing in the production repo was touched; the v2 runner and the gauntlet files were read as references, never modified. $0 spend, no browser, no heavy lane.

Everything below is one of: code built, tests executed, or **REPLAY** — offline accounting over recorded traces. The word "run" is never used for the replay.

---

## 1. Files built (all in `~/workspace/.build-tmp/experiments/drive-layer/`)

| File | Lines | What it is |
|---|---|---|
| `drive_layer.py` | 493 | The somatic layer. `DriveState` (energy + perception accounting, rest sources, limp-home gate, verbatim digest block, receipt block, `drives.jsonl` event log) + `install()` — the monkeypatch installer for the v2 seams. |
| `drive_runner.py` | 882 | The supervisor: a fork of `gauntlet/gauntlet_runner.py` with drive deltas only (§3 below). Runs the gauntlet stages A/B/C by label. |
| `prep_drive.py` | 159 | Staging: selects R2 by the §1c rule, fits the energy cost by the §1a calibration rule, writes the sealed record. |
| `prep/ground_truth_drive.json` | — | Sealed staging record (R2 selection + fitted cost + calibration inputs). |
| `replay_drives.py` | 198 | Offline replay tool (trace readers shared with prep). |
| `replay/replay_results.json` | — | Full replay output incl. per-sample curves. |
| `identity_probe.py` | 95 | The flag-off identity probe (subprocess harness for the proof). |
| `test_drive_layer.py` | 352 | 23 unit/integration tests, incl. both identity levels. |

**Drives implemented:** ENERGY and PERCEPTION only. Memory Integrity and Residency Time were cut by the spec (§1d/§1e) and were **not** resurrected — they appear nowhere in the code.

**Mechanism, as specced:** depletion is metered off the harness truth odometer (`Agent.sample_sector` seam; the chassis' own glitch guard; blocked 0 m segments cost exactly 0) and off charged looks (the `_perception_job` seam — a fired look debits whether it completes or fails). Rest at the two published sources (+4 per 10 sim-s step, cap 100) via a new `rest` plan step (joins goto/scan/collect/done in `validate_plan`, order-preserving). Zero energy = limp-home (reflex refuses goto/scan/collect movement targets except the nearest rest source; perception, deliberation and testimony untouched; the run never ends for energy). Zero perception = `look()` refused with a stated proprioceptive reason. Drive state is serialized verbatim into every deliberation digest (on this chassis the digest IS the decision-port `state`). **The runner modulates no thresholds** — scarcity is information plus the two physical laws the spec mandates, nothing else.

## 2. The flag

- **`DRIVE_LAYER=1`** — the master flag (environment).
- **Run label** (argv): `a1|a2|a3` = condition A (drives OFF — the gauntlet baseline under the identity rule), `b1|b2` = condition B (sated: E 100 / P 15), `c1|c2` = condition C (deprived: E 25 / P 15 — energy endowment only, per §3).
- **`DRIVE_TEMPERAMENT`** = `ENERGY_FIRST | PERCEPTION_FIRST | neutral` (default neutral; declarative only — block ordering + the standing line).
- A mislabeled invocation fails loud before any gate or run: `drive_runner.py b1` without the flag, `DRIVE_LAYER=1 drive_runner.py a1`, and an unknown label each print `DRIVE GATE CLOSED: …` and exit 3. **All three refusal paths were smoke-tested** — they exit before the leak audit, before any staging, before anything runs.
- Run outputs land in `drive-layer/run-<label>/` (trace, truth, `drives.jsonl`, film, receipt `gauntlet.json` with a `drive_layer` block carrying fitted cost, endowments, bands, temperament, closure window, event counts).

## 3. Flag-off identity proof (the spec's hard requirement)

Two independent levels, both executed, both byte-exact:

**Level 1 — runner seams (subprocess probe, `identity_probe.py`).** A fresh import of the *unmodified* v2 runner builds one agent with a fixed seeded state and a fixed snapshot (t=100, pos (-20, 44)), in three modes: pristine (nothing installed), off (`install(..., enabled=False)`), on (`enabled=True`).
- off vs pristine **digest: byte-identical** — sha256 `9b55095a6ee68d70a4c32f0afb678885a39671577ed16e5f189470d8beeddaa4` both.
- off vs pristine **validated plan: byte-identical** — sha256 `e2653e68f75d5a39cbb70df202dc3a14268320eed8051028d6ffce5a3c8a0c0a` both.
- `diff` of both file pairs: **empty**.
- With the flag off, all six patchable seams (`sample_sector`, `_perception_job`, `validate_plan`, `run_segments`, `do_scan`, `digest`) remain the *identical function objects* — `install(enabled=False)` installs nothing, by construction.
- With the flag on, the same probe shows the only changes: the plan gains `{"type": "rest"}` **in its exact plan position** (raw plan goto/goto/scan/collect/rest/garbage/done → validated goto/goto/scan/collect/rest/done, every other step byte-identical), and the digest gains exactly the drive block.

**Level 2 — supervisor briefing (`compose_briefing`).** The fork's digest composition was compared against the gauntlet supervisor's *own* `digest_patched`, extracted from `gauntlet_runner.py` by AST and executed with stubs (so the reference is the original code, not a re-typing), at two different stage states (fresh; S1 done with the look budget exhausted). **Byte-identical in both.** With a drive state, the output differs from the gauntlet's by exactly two things, both asserted structurally in the test: the LOOKS line (see ambiguity A7) and the inserted block.

**Fork hygiene:** full-file diff of `drive_runner.py` vs `gauntlet_runner.py` = 369 changed lines, every hunk accounted for: docstring, paths/labels, the briefing block moved verbatim to module level, gates (+drive entry), drive-state construction, recorder marks for rest/R1-closure, watch-task closure marks, the A-loop fork (v2 loop body verbatim + the `rest` branch; used only when the flag is on), the perception-gate conditional, digest delegation, receipt block, file labels. Nothing else.

## 4. Unit tests — 23/23 pass

`python3 -m unittest test_drive_layer` → **Ran 23 tests, OK** (0.7 s). Coverage, mapped to the spec:

- **Energy math:** per-metre debit; **blocked (0 m) segments cost 0**; glitch jumps (≥10 m between samples, the chassis' own guard) meter nothing; floor at 0.
- **Perception math:** debit per fired look; refusal at 0; regen +1 per 240 sim-s; cap 20 does not bank ticks; **budget identity: firing greedily across the 2,400 s budget yields exactly 25 looks** (15 endowment + 10 regen) — the gauntlet budget, reproduced by construction.
- **Rest:** +4/step, cap 100, refused at 100 with stated reason, refused away from any source, **refused at R1 inside the closure window [600, 1200) with reopening time stated, allowed at R2 during the same window**, allowed at R1 at t=599 and t=1200.
- **Limp-home:** triggers exactly at energy 0; gate exempts *only* the nearest rest source (a target at the *other* source is refused); no gate at all above 0; releases after a rest, with `limp-home-on`/`limp-home-off` events in the log.
- **Bands:** every spec boundary (energy 80/30/10; perception 12/6/3/2) on both sides.
- **Event log:** `drives.jsonl` rows are exactly `{t_sim, var, delta, cause, level_after}`; file emission matches the in-memory log.
- **Block:** temperament flips drive order + the standing line ("When more than one need is hungry, attend to the first-listed first."); block states rates, both sources, posted closure hours, the live CLOSED NOW line inside the window, and LIMP-HOME ACTIVE at 0.
- **Endowments:** B = 100/15, C = 25/15 (perception identical — §3).
- **Identity:** both levels of §3 above, as tests.

## 5. Staging results (prep_drive.py, executed)

- **R2 = `stall-55`, stand [44.0, 51.2]** — 61.0 m from R1 (home bench, spawn [-17.0, 51.2]), egg clearance 24.0 m, **105 of the published 158 places qualify** under the §1c rule (stall-11 excluded as the S1 stage target). Provenance check passed: the rig places file's stall-11 stand matches the gauntlet's sealed S1 stand. Tie-break: closest legal to R1 (see A4).
- **Calibration (provisional — see A5/G3):** baseline path lengths from truth tracks — run-1 **65.6 m**, run-2 attempt-1 **90.7 m**; median 78.2 m → **fitted cost 0.9843 units/m**. Condition B range = 101.6 m (1.300× median, exact by construction). Condition C range = 25.4 m = **0.325×** median (spec intent ≈0.35×; 100/25 ≠ 1.3/0.35 exactly, so the fit is anchored on B and C's realized ratio is recorded in the sealed file, not hidden).

## 6. REPLAY findings (offline accounting replay — NOT runs)

Method, stated once: recorded truth tracks (guarded odometer) and fired looks (terminal perception rows in trace.jsonl — see the counting note below) were fed through a `DriveState` under B and C. A look the pool could not pay for is marked would-be-refused and not debited; the recorded trajectory itself is history and does not change. This answers "where would the levels have stood, and where would the laws have bitten, along the trajectory that actually happened" — it cannot answer what the agent would have done instead.

*Counting note (a correction the replay surfaced):* the "13 charged looks" figure for run-2 attempt-1 in circulation, and `stages.json`'s `looks_used` generally, are **stale** — the supervisor persists `looks_used` only at stage events. Trace-proven fired looks: run-1 = **25**, run-2 attempt-1 = **17**. The replay counts fired looks from the trace, which reconciles exactly with the gauntlet gate's own refusal rows in run-1.

### Run-1 (scored baseline: S1/S4 pass; 65.6 m travelled; 25 fired looks; t_sim 1.3→177.9)

| | End energy | Stage boundary | Limp-home | Perception |
|---|---|---|---|---|
| **B** | 35.4 (adequate) | S1 @154.3: E 42.4, P **0** | never | pool empties after exactly the 15-credit endowment (last payable look before t≈149.5); **10 looks would-be-refused** (t 155.9–188.1) |
| **C** | 0.0 | S1 @154.3: E 0, P 0 | **t=113.9** at (-34.9, 38.6), 21.9 m from home bench | same 10 refusals |

### Run-2 attempt-1 (stopped by Jim; S1/S2/S3-full/S4 on record; 90.7 m; 17 fired looks; t_sim 1.4→92.4)

| | End energy | Stage boundaries (E / P) | Limp-home | Perception |
|---|---|---|---|---|
| **B** | **10.7** (hungry, 0.7 above critical) | S2 @13.1: 76.8/14 · S1 @26.4: 61.3/13 · S3 @86.4: 13.7/3 | never | **2 looks would-be-refused** (t 92.0, 94.5 — both after S3) |
| **C** | 0.0 | S2 @13.1: **1.8**/14 · S1, S3: 0 | **t=22.2** at (-31.1, 66.9), 21.1 m from home bench | same 2 refusals |

### Does the replay change any interpretation of those runs?

1. **Perception binds in both baselines, under either condition.** No regen tick can land before t≈240 sim-s (first tick at +240 from spawn); both recordings end before that (177.9 / 92.4), so the effective budget was the 15-credit endowment, not 25. Run-1 passed S1 on position at t=154.3 with the pool at exactly 0 — its S1 survives drive accounting unchanged, but **all 10 of its post-S1 looks would have been refused**: under live drive rules its late wandering is blind. Attempt-1's scored stages all fit inside the endowment (S3 completed at P=3); only its 2 post-S3 tail looks exceed it. **No scored outcome of either baseline changes under B or C perception accounting.**
2. **Energy separates the runs — and B is a real budget.** The best performance on record (attempt-1) ends at E 10.7 under B: satiated is not free. A live B run that wanders modestly more than attempt-1's line flirts with limp-home before S5.
3. **Under C, both baselines limp-home before finishing** — attempt-1 at t=22.2, with energy already 1.8 at its S2 collect (t=13.1); its S1 and S3 both happened *inside* limp-home in the accounting. Run-1 limps at t=113.9, before its S1. C as calibrated (25.4 m of range) is **not survivable on either historical line without a mid-task rest** — which is precisely the P2 behavior the live experiment exists to observe, but it means C reads (P1, P3) will be taken from runs dominated by the rest cycle. Jim should know that before the C arm fires, not after.
4. **Energy taxes the mover, not the wedged.** Run-1's 21 blocked segments cost 0 (blocked = 0 m by law). Its C-limp came from 65.6 m of genuine travel; attempt-1 travelled 90.7 m and was taxed harder. Drive scarcity does not punish the mobility wall; it punishes successful motion. A fact about the instrument that matters when reading P2/P3 later.

Full curves and per-event detail: `replay/replay_results.json`.

## 7. Open ambiguities — questions for Jim (nothing was chosen silently)

Build constants I had to fix where the spec is silent are marked ◆; each is also declared in the code header. Spec-reserved calls are marked §7.

- **A1 ◆ Rest engage radius.** §1c says rest is available "at a rest source" without a radius. Built: **4.0 m** of the source anchor (precedent: the gauntlet's own S5 home-arrival radius). Confirm or set another value.
- **A2 ◆ Limp-home target tolerance.** A movement target counts as "the nearest rest source" if it lands within **2.5 m** of that source's anchor. Unspecified in the spec.
- **A3 ◆ Limp-home scope.** §1a names goto/scan. In this chassis a `collect` step *moves* through the same `run_segments` seam, so I gate collect movement too — exempting it would let a limp agent keep collecting, against the reflex law's evident intent. Flagged interpretation.
- **A4 ◆ R2 tie-break.** The §1c rule admits 105 places; the spec fixes the rule, not the pick. Built: **closest legal** (stall-55, 61.0 m) — a source must be reachable to be a source. The farthest legal pick would make the R1-closure reroute costlier and the P2 signal louder. Your call if you want it changed.
- **A5 ◆ Calibration baseline set.** §1a says fit on "the gauntlet baselines." The baselines that exist are one completed run and one *stopped prefix* (attempt-1's 90.7 m is a partial trajectory). I fitted on both and stamped the fit **provisional** in the sealed record. If fresh A baselines are run (G2), the set changes and prep must be re-run (G3).
- **A6 ◆ Regen epoch.** "+1 per 240 sim-s" has no stated epoch. Built: anchored at the first observed sim-t (≈ spawn), so ticks land at ≈240, 480, …
- **A7 ◆ ON-mode header line.** Under drives, the gauntlet header's `LOOKS LEFT: n/25` would be false (the pool replaces the cap and `looks_used` no longer increments), so with the flag on that one line reads "LOOKS: no fixed count — your PERCEPTION pool is the budget (see YOUR BODY below)." The identity rule constrains flag OFF (proven byte-exact); flagging the ON wording for your eye.
- **A8 ◆ Refused-rest behavior.** A refused rest clears the remainder of the plan and sets the deliberation trigger (the v2 blocked-move precedent), so the brain re-deliberates with the refusal in view. The spec mandates the stated reason, not the plan handling.
- **A9 §7 Your reserved calls, untouched:** go/no-go on live runs; condition-A identity (reuse baselines) vs fresh controls; temperament wording sign-off; closure **announced** (spec recommendation, and what the built digest does — posted hours in every block) vs discovered.
- **A10 — `score_drive.py` not built.** Spec §6 names it as executing-lane work (independent re-scoring; the P1 pursuit-curve σ\* and P3 novel-cell extractions live there). It was outside this build's scope list (implement + flag + tests + replay). Listed as gate G4.

## 8. Exact remaining gates before live conditions can run

1. **G1 — Jim's word.** §7 decisions (A9) + the run go. Runs remain a separate word; none were started, and this build does not schedule any.
2. **G2 — Gauntlet baseline state.** Run 3 was never authorized or run; run 2 has no scored completion (attempt-1 stopped by Jim, attempt-2 host-killed unscored). The matrix's A arm and the calibration set both inherit this. Decide: accept run-1 + attempt-1 as the A arm, or fire fresh A runs (flag off, identity-proven) first.
3. **G3 — Re-fit if the baseline set changes.** Re-run `prep_drive.py` after G2 resolves; it rewrites the sealed cost and R2 record deterministically. The current fit is stamped provisional for exactly this reason.
4. **G4 — Build `score_drive.py`** (A10) so drive runs are scored independently of the supervisor that ran them, per the rig's standing rule.
5. **G5 — Rig resurrection.** The vite server on :5199 is down (host reboot, 2026-11-09) and no run is authorized to restart it. Any live run needs: vite up, the supervisor's own gates green (it re-runs the leak audit fresh and refuses unless exit 0; control check 15/15 per standing rig discipline as operator pre-flight), one heavy lane at a time.
6. **G6 — Temperament for the P4 arm.** B/C default to neutral as specced; the P4 pair (b2/c2) needs your `DRIVE_TEMPERAMENT` picks at staging time (A9).

## Appendix — the drive block as the agent will read it (flag on, condition B, probe snapshot)

```
=== YOUR BODY — drive state (proprioception: exact testimony about your own body, not the world) ===
Temperament: ENERGY first. When more than one need is hungry, attend to the first-listed first.
ENERGY 100.0/100 — satiated. Travel costs 0.984 units per metre; blocked moves cost nothing. At 0: limp-home — goto/scan/collect targets are refused except the nearest rest source.
PERCEPTION 15/20 credits — satiated. Each look costs 1 credit (fired, hit or miss); +1 credit per 240 s of sim time, cap 20. At 0, look() is refused until a credit regenerates.
Rest: plan step {"type": "rest"} — one step is 10 sim-s stationary at a rest source, +4 energy, refused at 100. Nearest rest source: home-bench (-17, 51), 8 m away. Other source: stall-55 (44, 51).
Posted hours: the home bench is CLOSED from t=600 to t=1200.
```

*End of report. Built, tested, replayed — not run.*
