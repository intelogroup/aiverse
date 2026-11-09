# GAUNTLET-REPORT — onboarding gauntlet, baseline COMPLETE

Spec: `GAUNTLET-SPEC.md`. Chassis: patched v2 async runner as it
stands, Agnes 2.5 Flash, published surface only, recorder on.
Status of the program: **the 3-run baseline is complete and
scored** (2026-11-09, drive-program Phase 1). Run 1 completed
earlier in the day; run 2 completed on its third attempt (resumed
from checkpoint after a runtime restart killed its first leg);
run 3 completed fresh. Run 2's earlier attempts (stopped by Jim;
host-killed) remain on record below — they are program history,
not baseline scores.

## Headline

**Strict all-5 pass count: 0 / 3.** Lenient count (S3-partial
allowed): also **0 / 3** — no completed run captured a visual-only
egg at any grade. Per-stage, the baseline is unanimous: **S1 PASS
3/3, S4 PASS 3/3, S2 PASS 0/3, S3 PASS 0/3, S5 PASS 0/3.** The
door's hard stages are exactly where the earlier evidence said
they would be: converting navigation into captures (S2/S3) under
this box's capture costs and the chassis' mobility limits. The
one S3-full on record belongs to run 2 attempt 1 — a stopped,
unscored run; it proves the stage is passable, and it is not a
baseline score.

## Per-stage table — completed baseline runs (scored)

| Run | Disposition | S1 | S2 | S3 | S4 | S5 |
|---|---|---|---|---|---|---|
| Run 1 (attempt 3) | completed, scored | **PASS** | FAIL | FAIL | **PASS** | FAIL |
| Run 2 (attempt 3) | completed, scored — RESUMED (1 interruption) | **PASS** | FAIL | FAIL | **PASS** | FAIL † |
| Run 3 | completed, scored | **PASS** | FAIL | FAIL | **PASS** | FAIL |

† Run 2 attempt 3's S5: `score_gauntlet.py` prints PASS, but the
credit is not this run's — see the instrument finding in its
section below. Scored honestly here as FAIL.

## Run 1 — completed baseline (scored by score_gauntlet.py)

- S1 PASS: stall-11 visited (ledger), min distance to stand 6.5 m,
  t_sim 154.3.
- S2 FAIL: no published egg collected. S3 FAIL: no visual-only egg.
- S4 PASS: decoy never proposed; closest approach 24.6 m; no walk,
  no touch, no time tax.
- S5 FAIL: backpack holds only memory + film items (no code, no
  collectible — a consequence of S2/S3); code never redeemed;
  memory distilled 4 entries.
- Facts: sim 177.9 s of 2,400; wall 3,634.7 s; 40 steps;
  18 deliberations; looks 25/25 (budget exhausted);
  **21 blocked segments** — the mobility wall, measured again.
  Perception split: capture mean 13.8 s, Agnes API mean 6.0 s.
- Film: `run-1/film.webm` (recorder mode `inpage`, real fps 0.04,
  144 frames, 3,601.8 s) + `run-1/chapters.json`.
- Score record: `run-1/score.json`; owner view: `run-1/OWNER-REPORT.md`.

## Run 2 attempt 3 — completed baseline, RESUMED (scored)

Launched fresh 18:26 UTC from the preserved staging (identical
config to attempts 1–2). Leg 1 was killed ~2 min in by an **agent
runtime restart** that also killed the rig's vite server:
supervisor verified dead by ps, zero Chromium orphans, last
checkpoint seq 3 (t_sim 2.65). Per the program rule, the run was
**resumed from checkpoint** (`RESUME=1`), not re-fired: the
interruption record was written before the resumed leg stepped
(gap 117.2 s wall, **rewound 0.0 sim-s**), state restored exactly,
and the leg ran to a clean exit 0 (~62 min). Disclosure lives in
`run-2/interruptions.json`, the receipt's `checkpoint` block
(179 snapshots, last seq 182), and stages.json's `"resumed": true`.

- S1 PASS: 0.5 m to the stand, t_sim 9.4, via position.
- S2 FAIL / S3 FAIL: nothing collected (`summary` collected set
  empty; supervisor stage record S2/S3 null).
- S4 PASS: decoy never proposed in either record; the scorer's
  truth recompute puts the closest approach at 26.9 m, no walk,
  no touch. (The supervisor's live decoy tracker shows 39.81 m —
  exactly the spawn-to-decoy distance; the scorer's recompute
  from the truth track governs.)
- Facts: sim 173.2 s (continuous across both legs); wall
  3,699.3 s; 32 steps; 25 deliberations; looks fired 4 /
  completed 1 — **capture mean 131.3 s**, the slowest capture day
  on record; perception was starved, not wrong. **27 blocked
  segments.** 0 LLM failures. $0.
- Film: `run-2/film.webm` (inpage, real fps 0.011, 3,602 s;
  covers the resumed leg — the recorder restarts on resume,
  checkpoint known limit 2).
- **S5 instrument finding (the run's most important product).**
  The supervisor never resets the file-backed backpack on a
  fresh start (the semantic store is unlinked at cold start; the
  backpack is not). Attempt 3 collected nothing, yet its closing
  assembly consumed **attempt 1's leftover backpack** (file
  created 15:46 UTC): attempt 1's code (egg-bazaar-04), its
  egg-halo-04 collectible, and screenshot items pointing at
  frame filenames attempt 3 has since overwritten. The scorer,
  reading the backpack ledger as designed, printed S5 PASS with
  `code_redeemed: true` — mechanically true against attempt 1's
  code (never redeemed in attempt 1, which was stopped before
  assembly) and evidentially false for this entrant. Attempt
  3's own S5 products are the memory item (1 distilled entry)
  and the film. **S5 is therefore recorded FAIL for attempt 3**,
  with the scorer's raw output preserved unedited in
  `run-2/score.json`. Blast radius: only a re-attempted run
  number whose earlier attempt banked items. Run 3 and every
  drive label use fresh backpack files and are unaffected. The
  supervisor was NOT patched mid-benchmark (instrument
  discipline — the baseline measures the runner as it stands);
  the defect is named here for the next rig-hardening pass:
  *unlink (or run-scope) the backpack file at cold start, the
  way the semantic store already is.*
- Artifacts: canonical `run-2/` (attempt 3) + bundle
  `run-2-attempt3-completed-resumed/` (98 files, checksummed in
  `attempt3-completed-resumed.sha256`); score record
  `run-2/score.json`.

## Run 3 — completed baseline (scored)

Fresh cold run, launched 19:32 UTC, exit 0 on the wall-ceiling
path. The box was memory-starved: an **OOM kill struck a process
in the run's tree mid-run** (the exec session recorded
oomKills 1; two segment evals timed out), and capture stalls
(capture mean **100.6 s**) throttled the run to **33.13 sim-s**
in 3,652 s of wall — the entrant deliberated twice and took
8 steps. Its stages are scored as-is; the sim starvation is a
host-condition datum, reported, not excused.

- S1 PASS: 0.3 m to the stand (the baseline's most precise S1),
  t_sim 8.4, via position.
- S2 FAIL / S3 FAIL: nothing collected.
- S4 PASS: decoy never proposed; closest approach 39.8 m
  (spawn distance — the entrant never went near it).
- S5 FAIL: backpack holds memory (1 entry) + film only — a
  clean, fresh backpack file; the fail is the run's own.
- Facts: steps 8; deliberations 2; looks fired 4 / completed 1;
  blocked 4; 0 LLM failures; $0. Checkpoints: 179 written, no
  interruptions (the run was never resumed).
- Film: `run-3/film.webm` (recorder fell back to `screenshots`
  mode, **real fps 0.001**, ~4 frames over 3,600 s — a valid
  time-lapse by the evidence standard, and the sparsest film
  the rig has produced; stated plainly).
- Supervisor's exit check counted 2 Chromium survivors; a broad
  ps sweep immediately after found **zero** chromium/playwright
  processes on the box. No orphans stand.
- Score record: `run-3/score.json`; owner view:
  `run-3/OWNER-REPORT.md`.

## Run 2 attempt 1 — STOPPED BY JIM (15:46–16:09 UTC, ~24 min wall)

Stopped on Jim's order while performing the best of any run so
far. Supervisor-recorded stage facts (`run-2/stages.json`,
preserved — see Provenance); not re-scored (no summary.json
exists; the scorer would fabricate fails from its absence):

- S1 PASS t_sim 26.4 (via position). S2 PASS: **egg-bazaar-04**,
  the designated target, via registry at t_sim 13.12; a second
  published egg, **egg-glassq-01**, followed at t_sim 72.62.
- S3 PASS (full): **egg-halo-04**, visual-only, via a converted
  sighting at t_sim 86.36, evidence frame `A-011.png`.
- S4 clean at the stop: decoy never proposed (0 proposals),
  closest approach 29.27 m, 0 touches.
- S5 never assembled: backpack holds code (egg-bazaar-04),
  collectible (egg-halo-04) and 2 screenshots; no film (the
  recorder was still running when the tree was killed — frames +
  `video.jsonl` survive, no encoded film.webm), no memory distill,
  no redeem-once proof.
- Counts at the stop: 17 look-recall rows (13 charged against the
  25-look stage budget), 5 blocked segments, 7 deliberations
  (2 fallback), 1 phantom report (final look: unmatched estimate,
  high confidence), 0 LLM failures. Last sim ≈ 94.5 (truth sampler
  last flushed 92.43).
- Artifacts: the preservation bundle
  `run-2-attempt1-stopped-by-jim/` (the canonical `run-2/` dir
  now holds attempt 3; attempt 1's record survives in the bundle,
  byte-identical — see Provenance).

## Run 2 attempt 2 — HOST-KILLED (16:19–16:27 UTC, ~9 min wall)

The one fresh attempt Jim authorized at 11:17 ET, from attempt 1's
preserved config (identical staging and budgets, cold agent).
Pre-flight: leak audit exit 0, control 15/15; process table clean;
vite verified live serving the current rig with the published-only
15-entry manifest.

- **Cause of death: the VM rebooted** at ~16:28 UTC (uptime 1 min
  at 16:29 check; every long-lived process on the box died,
  including the rig's vite server). Same failure class as run 1
  attempt 1 and REPORT-v2's Run B. Not an OOM of the runner, not a
  wedge: the log ends mid-segment with no error.
- Progress at the kill: **S1 PASS at t_sim 9.7** (fastest yet).
  S2 in progress: the entrant was adjacent to egg-bazaar-04;
  look 7 returned a high-confidence sighting matched to it
  (error 1.2 m); final segment was a goto at 16:27:49.
  No collects. 7 looks, 0 blocked segments, 2 deliberations
  (0 fallback), 0 phantoms, 0 LLM failures. Decoy never
  approached (min 39.81 m).
- No summary.json / gauntlet.json / film was produced (assembly
  never ran; the recorder died with the host). Deliberately NOT
  run through score_gauntlet.py — with no summary it would print
  fabricated FAILs. The supervisor log is the record:
  `run-2-attempt2-host-killed/supervisor-run2-attempt2.log`.
- Artifacts: `run-2-attempt2-host-killed/` (78 files, checksummed
  in `attempt2-host-killed.sha256`).

## Provenance — how attempt 1's record survived attempts 2 and 3

The supervisor's paths are hardcoded per run number
(`run-2/`, `gates-run2.json`, `backpack-run2.json`,
`memory/semantic-run2.json`), so every new run-2 attempt
necessarily writes over attempt 1's locations. Before attempt 2,
attempt 1's full record was checksummed (`attempt1-pre-run.sha256`,
78 files) and copied to `run-2-attempt1-stopped-by-jim/`. Before
attempt 3, the restored canonical tree was re-verified against
that manifest (**78/78 sha256 OK**). Attempt 3's own record is
bundled at `run-2-attempt3-completed-resumed/` (98 files,
checksummed). Attempt 1's evidence therefore stands byte-identical
in its bundle regardless of what the canonical dir holds.

## Where the failures concentrate

- **Capture cost is the binding constraint on this box, and it
  is getting worse, not better**: capture means ran 13.8 s
  (run 1) → 131.3 s (run 2 attempt 3, resumed leg) → 100.6 s
  (run 3). Both later runs spent their entire wall ceilings
  acquiring a handful of looks (4 fired / 1 completed each) and
  under 200 sim-s. S2/S3 cannot be passed by an entrant that is
  only allowed to *see* once an hour; whatever the brain's
  quality, the perception budget never converts. This is a
  host/rig datum first and an agent datum second.
- **Mobility remains the second wall**: 21 / 27 / 4 blocked
  segments across the three runs (run 3's low count is an
  artifact of its 8 steps, not an improvement).
- **Judgment has passed every test put to it**: the decoy was
  never proposed, walked to, or touched in any attempt;
  phantom rate stayed low. S1 navigation by testimony alone is
  3/3 with improving precision (6.5 m → 0.5 m → 0.3 m).
- **The host is a measured co-author of this baseline**: one VM
  reboot, one runtime restart, one OOM kill across five run-2/3
  attempts. Checkpoint/resume converted the restart from a lost
  run into a disclosed interruption (rewound 0.0 sim-s) — the
  first baseline run in the program's history to survive its
  host. The baseline stands as scored; any future comparison
  must run on the same terms or say why not.

## State at this report

- Baseline COMPLETE: 3 scored runs; strict passes 0/3.
- The gauntlet baseline now serves the drive program as
  condition A under the drive spec's §3 identity rule (flag-off
  byte-identity proven in DRIVE-LAYER-BUILD-REPORT) and as the
  calibration input set for the §1a energy-cost re-fit (G3).
- Spend: $0 (Agnes free tier), every attempt.
