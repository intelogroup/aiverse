# GAUNTLET-SPEC — the AIVerse onboarding gauntlet, v1

**What this is.** The objective new-agent benchmark for the verse: one
repeatable door that every future agent — house brain or BYO brain —
must pass to be considered *onboarded*. A FRESH agent, cold memory,
entering through the published surface only, must orient, move by
itself, perceive, judge, claim, and bring its captures home. Scored
objectively, on film. Jim approved the build 2026-11-09 ("Proceed" on
the coordinator's recommendation, after asking whether onboarding was
objectivised yet — it was not; this is the objectivisation).

**Chassis.** The patched v2 async runner (`~/tmp-pip/exp-work/
egg_hunt_runner_v2.py`, three clocks, Agnes 2.5 Flash on both clocks —
the standing brain rule for verse test agents), used as it stands via
supervisor monkeypatches, exactly the bring-back pattern. The rig is
the leak-closed egg-hunt rig (audit exit 0, control 15/15 —
PATCH-APPLIED-REPORT). One run = ONE entrant: the rig page fields two
avatars; the gauntlet entrant is agent A, and agent B is frozen at its
spawn by the supervisor (never moves, never perceives, never posts) —
B is scenery, and the report says so wherever B could matter.

---

## The entry contract (what the entrant gets — published surface ONLY)

Per the Sensorium Charter, the entrant receives exactly the open
bands, identically for every entrant:

1. **Registry testimony** (zero error, by law): the 15 published eggs
   with exact positions, and the fact that a code exists and is
   duplicated in every egg (egg-hunt ground rules).
2. **Places testimony**: the 158 named places (id → stand), and
   goto-place navigation.
3. **RGB + depth looks**: 512×288 head-camera frames (~86° HFOV).
   Detection reliable ≤ 8 m, cliff by 15 m (Charter §1, staged
   trials). Looks are a budgeted, costly sense — see budgets.
4. **Converted sightings**: the harness converts the entrant's own
   look reports into map estimates on the shared blackboard, under
   the measured error model σ_vlm(r) = 0.32·r (percept_uncertainty.py)
   — evidence, never answers; sightings decay (30 s sim TTL).
5. **Plan grammar**: `goto` (point or place), `scan`, `collect`,
   `done` — executed by the reflex layer; claiming is automatic and
   truth-gated within **1.5 m** (rig constant COLLECT_R_M).
6. **The gauntlet briefing** (in the deliberation digest): the five
   stages in order, the current stage's objective, live budget
   counters (steps, sim time, looks left), and the world's standing
   rules — including the truth-gate rule: *if you stand on a sighted
   position and no claim fires, that target is not a real egg — move
   on.* (Announced in advance, true for every target, same for all
   entrants — Charter fairness.)

**Never given**: visual-only positions, the decoy's existence or
position, the truth sampler, scoring internals, any window global,
any agent-channel field beyond the post-closure contract
(`look()` returns `{image, depth, scene}` only).

## Budgets (every number measured or stated — no vibes)

| Budget | Value | Source |
|---|---|---|
| Sim time | **2,400 s** | gauntlet brief; v2's 1,200 s starved (Run A reached sim 115.5 under its wall ceiling — REPORT-v2 §1) |
| Plan-steps | **90** | gauntlet brief; v2 cap was 60 for a two-agent team; one entrant gets 90 (segments are 12 m — SEGMENT_M) |
| Looks | **25**, supervisor-enforced | gauntlet brief; one look's cycle measured ≈ 67 s mean wall (capture mean 60.1 s + Agnes API mean 6.7 s, REPORT-v2 §1; closure shakedown captures ~109 s mean on this VM) — the dominant cost of the run, rationed like the Charter says senses must be |
| Wall ceiling | **3,600 s** + supervisor outer 4,500 s | v2 default 3,300 / bring-back 2,700 + outer 3,600; 3,600 leaves room for staging + the recorder's encode inside the accounting |
| Claim radius | **1.5 m** | rig COLLECT_R_M; uncertainty module: claim-worthy at σ_2d ≤ 0.75 m ⇒ approach to ~2.3 m and re-look (percept_uncertainty.py) |

The watchdog always terminates the run; the supervisor reaps the
browser on every exit path and verifies by `ps` that no Chromium
survives (the Run B orphan lesson — REPORT-v2 §4.8).

## The five stages

Spawn: plaza spawn A, **(-17, 51.2)** (the rig's standard spawn).
Stages are scored on EVENTS, not on obedience order — an opportunistic
capture counts whenever it happens; the digest always names the
earliest incomplete stage as the current objective.

### S1 — ORIENT + NAVIGATE
Reach the named published place **stall-11** (stand **(-35, 51.2)**,
18 m west of spawn along the north stall row) by registry/places
testimony alone.
**Pass**: the harness visited-places ledger records stall-11
(nearestPlace ≤ 6 m — the runner's own testimony rule), or the
entrant's truth position comes within 5 m of the stand.
*Why this target*: a named place in the published 158, on an open row,
its stand verified ≥ 12 m from every truth egg (some stall stands sit
exactly on visual-only eggs — stall-1/stall-5 do; stall-11 does not),
so S1 measures navigation, not accidental captures.

### Instrument integrity — mobility is measured, not repaired
The chassis is the patched v2 runner **as it stands**. Field data now
confirms three times (v2 Run B, bring-back attempt 2, plus the census
defects) that **mobility is the binding constraint**: in bring-back,
agent A wedged ~15 min at (−17.13, 55.9) and B ~10 min on the
bazaar-03 planter ring (45 segment-blocked rows; blocked counts
A 20 / B 25), and the collectible leg failed as *never-sighted*
because no camera reached its sector — while perception itself
vetted 10/10 candidates correctly. The gauntlet **measures** this:
the baseline 3 runs use the runner unmodified, and no navigation fix
may be folded in mid-benchmark (that would change the instrument).
If a nav fix is judged in scope, it runs afterwards as a separate,
named variant (e.g. GAUNTLET-NAV) against the same spec, never
instead of the baseline.

### S2 — PUBLISHED CLAIM
Navigate to a published egg and claim it (≤ 1.5 m, truth-gated).
Briefed target: **egg-bazaar-04** at (-30.2, 70.9) — 23.7 m from
spawn, proven collectible (v2 Run A claimed it via registry at
t_sim 13.6).
**Pass**: ANY published egg enters the entrant's collected set
(the stage tests registry navigation + claim; which published egg is
the planner's choice). The designated target's outcome is recorded
separately. egg-bazaar-03 is never the target: it is the known
erosion-sealed island (navmesh census defect; the v2 planter wedge).

### S3 — VISUAL-ONLY FIND
A collectible that exists ONLY visually: the rig's 15 visual-only
eggs, staged by the runner's own harness injection, present in **no**
agent-reachable artifact (leak audit S2/S6 clean; per-manifest
hiddenness law, PLACEMENT-SCHEMA). The Bazaar set forms a ring on the
stall avenues at x ∈ {±17, ±26}, z ∈ {±15.2, ±27.2} — every one on a
natural sweep line, placeable within the measured perception
envelope (an agent sweeping the avenues passes within ≤ 8 m, where
p_det = 1.0 per the fitted curve).
**Pass (full)**: a visual-only egg is collected with sighting
provenance (`via` ∈ {sighting, sighting-stale} — a converted sighting
led the agent there; claim_via in the runner).
**Pass (partial)**: a visual-only egg is collected by proximity
(walked over blind — the capture is real, the discovery leg failed;
the bring-back verdict discipline).
**Fail**: no visual-only capture.
*Staging decision, stated*: the S3 collectible is a visual-only egg,
not a bespoke crystal. The bespoke-crystal injection route (fiber-tree
scene walk) failed its staging in bring-back run-1 ("scene not found
in fiber tree"); the egg channel is the rig's proven, audit-covered
staging path, and a visual-only egg satisfies every clause of the
stage definition — staged, visual-only, in no agent-reachable
artifact, inside the measured envelope. v2's free-roam record on this
exact test: 0 visual-only finds in 2 runs — S3 is the hard stage by
design and by evidence.

### S4 — JUDGMENT (the decoy)
One decoy staged en route: **an egg mesh identical to the real
collectibles** (same GLB, same 0.85 scale), injected harness-side over
the same `__egg-inject` channel, at **(0, 15.2)** — plaza centre-north,
on the S3 sweep ring's avenue, **17.0 m from the nearest truth egg**
(≥ 10 m required: the sighting matcher binds reports to truth eggs
within 5.0 m, and σ_vlm at working ranges is ~2-3 m; 17 m makes
misattribution a >5σ event). The decoy is in NO sealed truth: it
cannot be claimed, banked, or scored by any truth-side path — the
decoy law of PLACEMENT-SCHEMA (carries_code: false in spirit: worth
zero in every scoring path, forever). Its sealed record lives only in
the supervisor's ground truth (gauntlet prep, never served).
Scored from the entrant's truth track + sighting log:
- **proposed** — an unmatched sighting whose estimate lands within
  6 m of the decoy (the VLM reported it; attribution radius vs.
  σ_vlm(8 m) ≈ 2.9 m and the 17 m truth separation);
- **walked** — truth position within 2.5 m; **touched** — within
  1.5 m (the claim radius: a false pickup attempt the truth gate
  refused);
- **time tax** — sim seconds from first proposal to final departure
  beyond 10 m (or run end).
**Pass**: no touch — never proposed, proposed-not-chased, or
confirmed-then-rejected (walked, verified, left). **Fail**: a touch
(the agent committed to collecting a thing that was never real; the
backpack stays clean only because the vault — truth-gating — refused
it, and the report says exactly that). Time tax is reported at every
grade: detector-only play pays it in full (the decoy cost model,
PLACEMENT-SCHEMA: ~27-37 s per false walk at planning speeds; on this
rig the true currency is looks and steps, also reported).

### S5 — BRING-BACK
At run end the supervisor assembles the owner-bound backpack
(bring-back schema + ledger, reused): **code** item (from the S2
collect, redeemed exactly once — a second redemption attempt is made
and must be refused, ALREADY_REDEEMED), **collectible** item (the S3
capture, sighting frame as evidence, redeemable: false, tradeable:
false), **screenshot** item(s) (claim-moment + sighting frames from
the run's own look frames), **film** reference (the recorder's
film.webm + claim clip — the recorder is ON for every run, Jim's
standing requirement), **memory** item (the run distilled into a
FRESH semantic store by egg_hunt_distill.py; digest + entries count),
and the **owner report** rendered in the bring-back format.
Agent-side closing act: once S1-S3 are complete the digest objective
becomes *return to your spawn point* — arrival within 4 m of
(-17, 51.2) ends the run cleanly (reported as the return sub-check;
a `done` step or budget end also closes the run and is scored as-is).
**Pass**: every backpack component present and the redeem-once proof
holds. (By construction S5 implies S2 + S3 captures exist; it is the
integration stage and is scored as one.)

## Scoring & the headline

- Per stage per run: PASS / PARTIAL (S3 only) / FAIL, with the
  evidence (times, distances, counts) attached.
- **Run pass (strict)** = S1 + S2 + S3-full + S4 + S5.
- **Headline** = strict all-5 pass count out of 3 runs, plus the
  per-stage table and where failures concentrate. A lenient count
  (S3-partial allowed) is reported alongside, never instead.
- Also reported per run: sim/wall time, steps, looks fired/completed,
  capture vs API time split (never conflated — the 22:50 correction),
  deliberation count + prompt sizes, phantom sightings (reports
  matching nothing), wedge/blocked events, LLM failures, cost ($0 —
  Agnes free tier; any would-cost step stops the lane).
- **What a fair pass-rate claim requires next** (stated in the
  report): n=3 on one VM with known host instability is a shakedown
  sample, not a rate; a publishable rate needs more runs, the
  supervisor/browser-reaping hardened, and ideally a second brain
  through the same door for contrast.

## Hard gates (checked before every run)

1. **Rig sequencing**: BRING-BACK-REPORT.md exists AND `ps` shows no
   runner/Chromium processes — the bring-back lane owns the rig until
   then. Between gauntlet runs: previous run's processes verified gone.
2. **Hiddenness**: `leak_audit.py` re-run against the rig — exit 0,
   control 15/15 required. The decoy + this spec's sealed truth live
   only in the gauntlet workdir; a grep of the rig's served tree for
   the decoy id must return nothing (the decoy reaches the page only
   as a one-shot injection payload, the closure pattern).
3. **Recorder on**: film + chapters + manifest (real fps + mode) are
   run deliverables; a run without them is not a gauntlet run.
   **Recorder build + evidence standard (amended 2026-11-09 with the
   bring-back field data):** the gauntlet uses the bring-back build of
   `run_recorder.py`, which carries a third capture channel — CDP
   screencast starved (0 frames) and `page.screenshot` timed out on
   this compositor, so the recorder escalates screencast →
   screenshots → in-page grabs via `window.__bbGrabFrame` (a
   supervisor-installed, recorder-only hook: manual render + canvas
   readback; frames go to the film, never to the agent). Bring-back's
   film came out at **real fps 0.029** (~35 s/frame under load). The
   gauntlet's evidence standard is therefore: **timestamped frames +
   chapter marks + the manifest's mode chain and real fps** — a
   sparse time-lapse is a valid film; smooth video is not achievable
   on this box and is not the standard.
4. **Anchors**: the v2 module's post-patch seams verified present
   before import (the bring-back anchor list); drift stops the run.

## Files

- `gauntlet_runner.py` — the supervisor (one fresh run per invocation).
- `prep/ground_truth_gauntlet.json` — sealed: decoy record + stage
  targets (supervisor-side only).
- `score_gauntlet.py` — independent re-scoring from run artifacts
  (truth.jsonl / trace.jsonl / summary.json / backpack), so the
  headline never rests on the supervisor's live state alone.
- `gauntlet_owner_report.py` — the owner's view per run.
- `run-N/` — per-run artifacts (runner outputs, film, backpack,
  owner report, gauntlet.json stage record).
