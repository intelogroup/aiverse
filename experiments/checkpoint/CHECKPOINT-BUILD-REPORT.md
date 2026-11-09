# CHECKPOINT BUILD REPORT — checkpoint/resume + drive scorer

**Commissioned:** 2026-11-09, Jim's go ("Build checkpoint/resume + the drive scorer", 12:02 ET).
**Workdirs:** `~/workspace/.build-tmp/experiments/` — `checkpoint.py` (shared module,
experiments root), `gauntlet/gauntlet_runner.py`, `drive-layer/drive_runner.py`,
`drive-layer/drive_layer.py`, `drive-layer/score_drive.py`.
**Scope honored:** no scored runs of any condition; no production repo changes; $0 spend.
The only rig run is the labeled kill test (a verification exercise, NOT a gauntlet or
drive run — labeled as such everywhere it appears).

## Progress log (appended per stage, per long-lane discipline)

- **Stage 0 — recon COMPLETE.** Read GAUNTLET-SPEC.md, DRIVE-LAYER-SPEC.md,
  DRIVE-LAYER-BUILD-REPORT.md, `gauntlet_runner.py`, `drive_runner.py`,
  `drive_layer.py`, `score_gauntlet.py`, `test_drive_layer.py`,
  `identity_probe.py`, `replay_drives.py`, `backpack.py`,
  `visibility/percept_uncertainty.py`, and the full v2 runner
  (`~/tmp-pip/exp-work/egg_hunt_runner_v2.py`, read-only reference).
  Next: design + write `checkpoint.py`.

- **Stage 1 — `checkpoint.py` COMPLETE.** `checkpoint.py` (18.8 KB) +
  `checkpoint_probe.py` + `test_checkpoint.py`: **7/7 tests pass** —
  rotation, torn-newest fallback to prev, tamper rejection (checksum),
  wrong-run/garbage never loads, interruption record append semantics,
  time-offset wrapper (fake agent: page t 6.5 → continuous 321.5,
  offset 315.0), and the subprocess roundtrip against the real v2
  runner (agent + blackboard + CALL_STATS + DriveState restored
  exactly; drives.jsonl gains exactly the 2 `checkpoint-restore` seam
  rows). `drive_layer.py` gained only `metering_suspended` (default
  False; `on_sample` skips the energy debit while set — the restore
  walk never double-charges the body). Next: wire the supervisors.

- **Stage 2 — supervisors wired COMPLETE.** Both `gauntlet_runner.py`
  and `drive_runner.py` now: create a CheckpointManager per run;
  snapshot on stage boundaries (persist_stage sets a dirty flag) and
  every CKPT_INTERVAL_S (default 20 s) from a task gathered alongside
  the claims/watch tasks; on RESUME=1 load the newest valid snapshot
  (fail loud, exit 4, when none), write the interruption record
  BEFORE anything restarts, restore STAGE + blackboard + CALL_STATS,
  install the sim-time offset, restore drive state (drive fork,
  incl. the drives.jsonl seam rows), and — once agent A exists —
  transplant its state and walk it back to the saved pose (raw acts;
  metering suspended on drive runs). Receipts gain a `checkpoint`
  block (resumed / interruptions / snapshots written). Budgets are
  now env-overridable via setdefault (spec values remain defaults;
  the kill test uses this to clamp). **Re-verified after wiring:**
  py_compile clean; `test_drive_layer` **23/23** — both flag-off
  byte-identity levels still pass against the modified sources;
  `test_checkpoint` 7/7; mislabeled invocation still exits 3;
  RESUME with no snapshot exits 4 with reasons. Next: score_drive.py.

- **Stage 3 — `score_drive.py` (gate G4) COMPLETE.** `score_drive.py`
  (28.5 KB) in drive-layer/: independent re-scoring of P1–P4 from
  trace/truth/drives/summary/receipt, pooled across runs, file-order
  drive-state fold so resumed runs score on sim time with the
  `checkpoint-restore` seam resolving the rewound interval; missing
  core inputs fail loud (all verdicts INSUFFICIENT DATA, exit 2,
  report still written). `test_score_drive.py`: **8/8 pass** —
  P1 CONFIRMED on synthetic pursuit curves (σ* ratio + confident-wrong
  ratio both past registered thresholds), P2 CONFIRMED with the
  limp-home compulsion rest classified separately from the two
  detours, P2 resumed-twin scores byte-identically to its un-resumed
  twin, P3 CONFIRMED, P4 CONFIRMED (divergent pair) + REFUTED
  (identical pair), the real gauntlet run-1 dir fails loud as
  INSUFFICIENT DATA (no drives.jsonl — condition A by design), and a
  CLI end-to-end run exits 0. Next: the kill test.

- **Stage 4 — kill test COMPLETE (3 attempts, all reported).**
  Attempts 1–2 (17:14 / 17:19 ET) failed BEFORE staging: vite had
  been resurrected against `~/workspace/aiverse/apps/console` — the
  main repo checkout, currently parked on an unrelated branch with
  no scout rig (page probe: `window.__scout` undefined after
  425 s; both supervisors exited cleanly on the 240 s ready
  timeout, `chromium_survivors_at_exit: 0`; artifacts preserved in
  `drive-layer/run-b9-attempt1-vite-cold/` and
  `run-b9-attempt2-wrong-vite/`). Diagnosis: the rig console is
  `~/tmp-pip/aiverse-experiments/apps/console` (probe against it:
  `__scout` ready in 35.9 s, "[eggs] placed 15 eggs" — the
  published-only manifest). Attempt 3 ran against the correct rig:
  leg 1 (condition B staging, label b9, clamped budgets
  SIM 900 / steps 40 / wall 2400, snapshots every 10 s) reached
  seq 19, t_sim 15.11 — S1 passed, agent at (−33.04, 54.17),
  energy 78.797, perception 13, plan + intention live. Killed with
  `kill -9` on the whole process group at 17:44:46 UTC. **Finding:**
  Playwright's Chromium (PID 14652) survived the group kill — it
  runs in its OWN session (Playwright detaches it), so a
  supervisor-side kill cannot reap it; on a real host reboot it
  dies with the host, but a soft-killed lane must reap it
  explicitly (done by hand here; verified 0 chromium by ps).
  Resume leg (RESUME=1, budget clamped to snapshot+~150) loaded
  seq 19 and restored EXACTLY: `g-checkpoint-resume` row = energy
  78.8, perception 13, steps 4, snapshot_t_sim 15.11; interruption
  record written BEFORE restart (gap_wall_s 27.3, rewound_sim_s
  0.0); snapshot sequence continued monotonically (20, 21, … 198);
  sim time continued from 15.11 (offset wrapper); restore walk
  landed **0.47 m** from the saved pose with drive metering
  suspended (energy did not drain during the walk, then resumed
  draining on new ground). The resumed agent then completed its
  post-resume intention: **collected egg-bazaar-04 at t_sim 40.51**
  (the S2 designated target), banked code + screenshot + memory,
  and — perception pool exhausted — attempted a `rest`, refused
  by the reflex away from a rest source (drive layer behaving as
  spec'd, unscripted). Leg 2 terminated on the rig's own
  wall-ceiling path at 1,800 s (the clamped sim budget was not
  reachable inside the wall ceiling under the day's capture
  stalls); recorder stopped cleanly; summary.json written
  (sim_elapsed_s 107.1 CONTINUOUS across both legs; 30 LLM calls,
  0 failures, $0). Final ps: 0 chromium, 0 runners. Next: the
  receipt-gap fix + scorer consumption proof.

- **Stage 5 — receipt-gap fix + scorer consumption COMPLETE.**
  Leg 2's assembly crashed AFTER summary.json was written, at the
  receipt's clips mapping: the recorder manifest's `files["clips"]`
  is a LIST, and the receipt code did `RUN_DIR / v` per item —
  TypeError. **Pre-existing bug in BOTH supervisors** (identical
  line in `gauntlet_runner.py` and `drive_runner.py`); it fires on
  any run whose manifest lists a claim clip (any run with a
  collection — gauntlet run 1 escaped it only by collecting
  nothing). Consequences for run-b9, disclosed in
  `run-b9/RECEIPT-GAP.md`: no gauntlet.json receipt (the
  `checkpoint` disclosure block lives instead in
  interruptions.json + the `g-checkpoint-resume` trace row +
  stages.json's `"resumed": true`); the backpack code-redemption
  proof never ran for this run; `chromium_survivors_at_exit`
  unrecorded (verified externally: 0). No receipt was fabricated
  post-hoc. **Fix applied** (both files): clips mapping built from
  the manifest's clip list; verified against run-b9's real
  manifest (maps `clip-claim-1.webm` to its on-disk path; empty /
  missing shapes safe) and the full suites re-run green.
  **Scorer consumption:** `score_drive.py run-b9` read the resumed
  run without fabrication — resumed=true, interruptions=1,
  missing=[] (stages.json fallback worked), verdicts P1
  UNDERPOWERED, P2 REFUTED (spec §P2's "or never" clause: zero
  rest events in a scored run refutes), P3 UNDERPOWERED, P4
  INSUFFICIENT DATA (no pair), exit 2. b9 is a verification run;
  none of these verdicts score any condition or prediction.

## Design

One shared module, `~/workspace/.build-tmp/experiments/checkpoint.py`,
imported by both supervisors (checkpoints are supervisor business;
the v2 chassis is untouched). The supervisors keep their existing
shape — staging, stage checkers, assembly — and gain: a
CheckpointManager created before anything runs; a dirty flag set by
persist_stage (stage boundaries) plus an interval task gathered
with the claims/watch tasks; a RESUME path that runs AFTER the
hard gates and BEFORE the run starts; and a `checkpoint` block on
the receipt.

Three ideas carry the design:

1. **Sim time is the only clock that matters.** A resumed process
   starts a fresh page whose sim clock starts near zero. The
   manager installs a wrapper on the agent class (snapshot/act)
   that fixes an offset lazily at the first snapshot —
   `offset = snapshot_t_sim − page_t` — and shifts every later
   reading, so the resumed leg lives in the killed leg's
   continuous sim time. Trace, truth, drives, and scoring all read
   that one clock. (Proven live: leg 2's first snapshots read
   t_sim 15.5, 16.9 against a page clock of ~0.4–1.8.)
2. **The body is restored by WALKING, not teleporting.** The
   transplant puts the saved plan/intention/budgets into the fresh
   agent, then the supervisor walks it from spawn to the saved
   pose in ≤12 m raw segments. On drive runs the drive's metering
   is suspended for the walk (the body already paid for that
   ground once) and the walk is traced (`g-restore-walk`, final
   distance). Arrival tolerance in the kill test: 0.47 m.
3. **Disclosure is structural, not a label.** Before a resumed leg
   takes a single step, the manager appends the interruption
   record (snapshot seq + sim time, both wall timestamps, the
   wall gap, the killed leg's last sim time, the rewound sim
   seconds) to `interruptions.json` — so the record survives even
   if the resumed leg is itself killed. The receipt carries the
   same block; stages.json marks the re-run staging record
   `"resumed": true`; the trace carries `g-checkpoint-resume`
   with the restored values. The rewound interval (activity after
   the last snapshot) is genuinely lost and is DISCLOSED as lost:
   scorers resolve the overlap by file order, and the drive seam
   rows (below) make the fold deterministic.

Drive state rides inside the same snapshot: energy, perception,
odometer, the regen anchor and next-regen time, limp flag, and
counters restore exactly; the restored DriveState re-reads
drives.jsonl into its event list (torn tail rows skipped) and
appends exactly two seam rows with cause `checkpoint-restore`
(energy + perception), so any folder of the log sees the
restoration as an event, not a silent edit.

Non-interference: with RESUME unset and no snapshot, the only
behavioral change is additive — checkpoint files in the run dir
and `g-checkpoint` trace rows. Snapshot saving never blocks the
run: a failed save traces `g-checkpoint-failed` and the run
continues.

## Snapshot schema (schema 1)

Envelope: `{schema, run_id, seq, t_sim, written_wall_epoch,
written_wall_iso, payload, sha256}` — sha256 over the canonical
JSON of everything but itself. Writes are atomic (tmp + fsync +
rename) with one-deep rotation (`checkpoint.json` →
`checkpoint.prev.json`); load verifies run id + checksum, falls
back to the previous envelope on any defect, and never loads
garbage (kill-test stage 1 unit proofs).

Payload:
- `stage` — the supervisor's full STAGE dict (stage verdicts,
  staging record incl. decoy min-distance/proposals so far).
- `agent_a` — plan, intention, steps, deliberations, token lists,
  looks fired/completed, look_seq, capture/api timing lists,
  collected, visited ledger, sectors (with path meters),
  sightings history, no-progress + blocked counters, trigger,
  last sector, re-search radius, last sample position.
- `blackboard` — sightings, intentions, claims.
- `call_stats` — the shared CALL_STATS counters.
- `pos` — last truth positions of A and B.
- `sim_t` — sim elapsed at snapshot time.
- `drive` — full DriveState dict (drive runs only).
- `artifacts` — byte offsets of trace/truth/llm/drives at
  snapshot time (the record of how much of each append-only file
  the snapshot vouches for) + backpack reference (path, item
  count, sha256 — the backpack is file-backed and self-restoring;
  the snapshot pins WHICH backpack state it vouches for) +
  semantic-store reference.
- `interruptions` — the interruption records so far.

## Kill-test evidence (run-b9, 2026-11-09; verification only)

| Check | Result |
|---|---|
| Snapshot at kill | seq 19, t_sim 15.11, pose A (−33.04, 54.17), energy 78.797, perception 13, steps 4, S1 passed |
| Kill | `kill -9` process group 17:44:46 UTC; supervisor died instantly; Chromium survived in its own session (finding, below) and was reaped by hand → ps = 0 |
| Resume load | newest valid snapshot (seq 19; seq 17 copy preserved as `run-b9/kill-snapshot.json`) |
| Restored == snapshot | `g-checkpoint-resume`: energy 78.8, perception 13, steps 4, snapshot_t_sim 15.11 — exact |
| Interruption disclosed | interruptions.json: 1 record, gap_wall_s 27.3, rewound_sim_s 0.0, written before restart |
| Sequence continuity | snapshots continue 20 → 198 (no reset, no collision) |
| Sim-time continuity | leg 2 reads 15.5 → 105.7 continuous; summary sim_elapsed_s 107.1 across both legs |
| Restore walk | final_dist_m **0.47**; energy flat during walk (metering suspended), draining after |
| Run continues | post-resume deliberations (n continues from leg 1), egg-bazaar-04 collected t_sim 40.51, backpack banked code + screenshot + memory |
| Termination + summary | rig wall-ceiling path at 1,800 s; summary.json written; recorder stopped cleanly (inpage, real fps 0.043) |
| Orphans at end | ps: 0 chromium, 0 runner processes |
| Receipt | gauntlet.json NOT written — pre-existing clips bug (stage 5); gap disclosed in run-b9/RECEIPT-GAP.md, bug fixed in both supervisors |
| Spend | $0 (30 Agnes calls, 0 failures) |

Attempts 1–2 (wrong vite tree) are part of the evidence, not an
embarrassment to edit out: they re-proved that a dead rig fails
loud at the ready gate and that the supervisors reap their
browsers on clean exits — and they caught that the rig's vite had
been silently down/wrong since the morning reboot (gate G5).

## Identity re-proof (flag-off)

After ALL changes (checkpoint wiring + clips fix):
- `test_drive_layer` **23/23** — including both byte-identity
  levels: the flag-off digest AND plan hashes identical to the
  unmodified runner, and the AST-extracted briefing composer of
  the edited `gauntlet_runner.py` byte-identical to the drive
  fork's.
- `test_checkpoint` **7/7**; `test_score_drive` **8/8**.
- Mislabeled drive invocation still exits 3; RESUME with no valid
  snapshot exits 4 with named reasons; py_compile clean on all
  touched files.

## Scorer (score_drive.py) — what it does and its tests

Independent of the runner: reads a run dir's trace / truth /
drives / summary / receipt (stages.json fallback when the receipt
is missing — exercised for real by run-b9) and scores the drive
spec's registered predictions, pooled across any number of run
dirs, with the temperament pair passed explicitly (`--pair`):

- **P1** (deprivation bends the claim threshold): pursued
  sightings per drive-state window (satiated E≥80 ∧ P≥12;
  deprived E<30 ∨ P≤5), pursuit = closing ≥50% of initial range
  within 120 sim-s; effective threshold σ* per window from a
  logistic fit of pursuit on σ_2d = 0.32r; confident-wrong rate
  per window. CONFIRM needs σ* ratio ≥1.25 AND confident-wrong
  ratio ≥2.0 at registered sample floors; REFUTE below 1.10 /
  1.25; anything between is UNDERPOWERED with reasons.
- **P2** (unprompted replenishment detours): rest events grouped
  from drives.jsonl; each classified compulsion (limp-home) /
  spawn-adjacent / already-there / detour (≥10 m deviation from
  the leg-start→objective segment + resumption within 300 s),
  with R1-closure reroutes counted in the total but reported
  separately (spec: double-weighted evidence, never pooled
  silently). CONFIRM ≥2, REFUTE per spec incl. the "or never"
  clause, exactly 1 = UNDERPOWERED.
- **P3** (satiation explores): 12 m cells, post-S2 entries only
  (global-first-entry), time-in-state denominators; CONFIRM
  ratio ≥1.5 over ≥40 pooled entries, REFUTE ≤1.1, no S2
  anywhere = INSUFFICIENT DATA.
- **P4** (temperament pair): profile-vector deltas between one
  ENERGY_FIRST and one PERCEPTION_FIRST run; directional
  CONFIRM/REFUTE at the registered deltas, labeled n=1/arm.
- **Fail-loud contract:** any missing core input for any pooled
  run → every prediction INSUFFICIENT DATA with reasons, report
  still written, exit 2. A condition-A gauntlet dir scores
  exactly this (proven on the real run-1 dir). Resumed runs are
  first-class: drive state folds drives.jsonl in file order, so
  the `checkpoint-restore` seam rows resolve the rewound
  interval deterministically (proven by the resumed-twin test:
  identical P2 verdict + counts as the un-resumed twin).

Tests: `test_score_drive.py` **8/8** (fixtures above, stage 3).

## Known limits

1. **Soft-killed lanes orphan Chromium.** Playwright runs the
   browser in its own session; killing the supervisor's process
   group does not reap it. A real host reboot kills it; an
   operator killing a lane by hand must also reap
   `chromium_headless_shell` (or the next run's gates will count
   it as a foreign runner). A supervisor-side fix (launch the
   browser with a pidfile + a reaper in the resume path) is
   possible but was NOT built — out of this commission's scope;
   flagged for the next rig-hardening pass.
2. **The film does not survive a kill.** The recorder starts
   fresh on the resumed leg; run-b9's manifest/film cover the
   post-resume leg only (its mode flips and duration are leg-2
   numbers). Chapters/claims from the killed leg exist in the
   trace, not the film. A recorder-side stitch is possible;
   not built.
3. **Agent B has no verify-trip resume.** On a resumed leg B
   respawns at spawn and is not re-verified against the decoy —
   by design: spawn IS B's post-staging rest position, and the
   staging record (incl. decoy min-distance so far) carries over
   in the snapshot. If a future design parks B elsewhere, the
   restore walk must cover B too (the machinery is agent-generic;
   only A is wired today).
4. **The rewound interval is lost, by construction.** Activity
   after the last snapshot (≤ CKPT_INTERVAL_S of wall time, plus
   any in-flight look — its perception debit stands in the
   snapshot, its result never lands) is rolled back and
   disclosed via `rewound_sim_s`. In the kill test the rewind
   was 0.0 s; under capture stalls it can be one look.
5. **Intra-snapshot skew is possible.** Snapshot fields are read
   sequentially from live objects, not under a lock: the kill
   snapshot's perception (13) reflects one more fired look than
   its `looks_fired` (1 settled + 1 in flight). Each source is
   self-consistent; cross-field equality within a tick is not
   guaranteed. Bounded by one look / one segment.
6. **score_gauntlet.py S4 reads `row["event"]`; real trace rows
   use `"kind"`.** Observed during recon in the OLD scorer
   (decoy scoring) — noted, not fixed: it is outside this
   commission, and drive scoring does not reuse that code path.
   Flagged for whoever next touches the gauntlet scorer.
7. **The clips fix is verified at unit level, not by a second
   full run.** It was proven against run-b9's real manifest and
   the suites; the next real run with a collection (gauntlet
   run 3 or a drive arm) is its end-to-end proof. The fix is
   two identical lines; risk is minimal but the distinction is
   stated plainly.

## Updated gate list for drive runs

- **G1 — Jim's go + spec §7 calls** (incl. the condition-C
  calibration ruling: C as calibrated limps both historical
  baselines): **OPEN — Jim's.**
- **G2 — Gauntlet baseline state** (run 3 never run; run 2
  unscored — A-arm decision): **OPEN — Jim's.**
- **G3 — Re-run prep if the baseline set changes:** OPEN,
  mechanical, follows G2.
- **G4 — `score_drive.py` built:** **CLOSED by this build** —
  written, 8/8 unit tests, resumed-run consumption proven on
  run-b9, fail-loud proven on the real condition-A run dir.
- **G5 — Rig resurrection:** **CLOSED by this build** — vite is
  UP, serving the correct rig tree
  (`~/tmp-pip/aiverse-experiments/apps/console`, port 5199,
  HTTP 200; probe: `__scout` ready in 35.9 s, published-only
  15-egg manifest), and the kill test ran the full
  stage → run → kill → resume → terminate cycle against it.
  Note for the next operator: the main repo checkout
  (`~/workspace/aiverse`) is NOT the rig — it is parked on
  another lane's branch. Supervisors re-run the leak audit as
  their own gate on every launch regardless.
- **G6 — Temperament picks for the P4 pair:** OPEN — Jim's.

**Still no scored runs.** Everything above is build + one labeled
verification exercise. Drive arms B/C and gauntlet run 3 remain
exactly where Jim left them: awaiting his word.
