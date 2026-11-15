# NormSeed-1 — experiment record

**Question:** can fresh agents infer and adopt an arbitrary, unstated
community norm — greet **place-first, name-second** — purely from
residents modeling it plus social feedback? Arms: A (name-only
control), B (modeling only), C (modeling + feedback + a 5-minute
persistence phase after the residents depart). 3 scripted residents +
3 fresh newcomers per arm, 25-minute sessions, Agnes 2.5 Flash.

**Verdict: the treatment never fired — adoption is undefined, not
zero.** The social machinery worked, the smoke gate passed live 5/5,
and all three arms ran their full length, but across Arms A and B no
newcomer ever came within greeting range of a resident: total resident
speech heard by newcomers was **zero**, so exposures were 0 for every
newcomer. The binding constraint is the **encounter rate**, not norm
inference — newcomers socialised richly with each other around the
plaza/hall circuit and almost never entered the three anchor interiors
where the residents sat. The one near-miss: Emil (Arm B) entered both
the Tea House and the Library and passed 6.2 m from each resident —
1.2 m outside greeting range — without speaking once. Full analysis:
[`ANALYSIS.md`](ANALYSIS.md).

## Contents

- `DESIGN.md` — commission, arm design, session protocol, scorecard.
- `STATUS.md` — build/run log, including the gate history (gate1
  FAIL → look-service diagnosis → gate2 PASS).
- `ANALYSIS.md` — results computed from the run logs by
  `driver/scorer.py`, per arm.
- `driver/` — the harness: `onboard_ns.py` (cast registration),
  `session_ns.py` (session driver), `norm.py` (greeting classifier),
  `scorer.py`, `gate_check.py`, `cast.py`, `rereg_claim.py`,
  `test_norm.py`.
- `runs/` — per-run records: `gate1/`, `gate2/` (smoke gate),
  `armA1/`, `armB1/`, `armC1/` (the arms), `armC-partial-2153Z/` (an
  aborted Arm C attempt, kept as evidence), `_selftest/` (offline
  stub). Each carries manifests, per-agent logs, pose tracks,
  summaries and scores.
- `owners.json` — the cast record (disposable test owners/agents;
  no credentials — see below).
- `probe_see.py` + `probe-see.png` — the look-service probe from the
  gate1 diagnosis.
- `films/` — the three follow-cam films (H.264 854×480 @10 fps,
  1,350 frames each): `armA1-a-theo.mp4`, `armB1-b-emil.mp4`,
  `armC1-c-hugo.mp4`, plus `film-results.json` and `data/` (film
  timing data). The pose tracks in `runs/` are the durable source
  they were rendered from.

## Re-run it

Prereqs: a checkout of this repo (the gateway to run against), Python
3, and fresh disposable owner/agent registrations. Credentials are
**not** in this PR: the original `secrets.json` was excluded by the
credential sweep. `driver/onboard_ns.py` + `rereg_claim.py` generate
and keep a fresh one locally, the same way the original run did.

The session protocol (from `DESIGN.md` §5), run from `driver/`:

```bash
python3 onboard_ns.py sync            # owners flip verified in records
python3 onboard_ns.py claim-all       # paced claims, 65 s pause per 5
python3 onboard_ns.py visits          # fresh 45-min / 250-action visits

# smoke gate (must pass before any arm):
NS_GATE_SABOTAGE=1 python3 session_ns.py --arm gate --duration 420 --tag gate1
python3 gate_check.py gate1           # exit 0 = G1..G5 all PASS

# arms (one at a time):
python3 session_ns.py --arm A --duration 1500 --tag armA1
python3 session_ns.py --arm B --duration 1500 --tag armB1
python3 session_ns.py --arm C --duration 1500 --tag armC1
python3 scorer.py armA1 && python3 scorer.py armB1 && python3 scorer.py armC1
```

## Not included

- `secrets.json` (+ `.bak` rotations) — live credentials for the
  disposable cast; excluded by the sweep, regenerated on re-run.
- `films/assets/` + `films/addons/` — local copies of the cast/city
  GLBs and the renderer's JS addons (repo/R2 assets, not experiment
  content).
