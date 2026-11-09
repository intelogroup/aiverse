#!/usr/bin/env python3
"""Flag-off identity probe (run as a subprocess by test_drive_layer.py).

Usage: identity_probe.py <pristine|off|on> <out_dir>

Imports the UNMODIFIED v2 runner fresh, builds one agent with a fixed,
seeded internal state and a fixed snapshot, then:
- pristine: touches nothing.
- off: calls drive_layer.install(V2, state, enabled=False) — must
  install nothing.
- on: calls install(..., enabled=True) with condition B at spawn.

Writes into <out_dir>:
- digest.txt — Agent.digest(snap) bytes (the deliberation user
  message = the decision-port `state` surface on this chassis).
- plan.json — validate_plan() output for a fixed raw plan exercising
  goto/scan/collect/rest/done/garbage.
- seams.json — whether each patchable seam is still the identical
  function object captured before install.

Determinism: no wall clock, no randomness — MEM_MODE=cold (semantic
recall skipped), the blackboard is empty, the snapshot is a literal.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

MODE = sys.argv[1]
OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)

os.environ["RUN_DIR"] = tempfile.mkdtemp(prefix="drive-probe-")
os.environ["PREP_DIR"] = str(Path.home() / "workspace/.build-tmp"
                             / "experiments/egg-hunt/prep")
os.environ["MEM_MODE"] = "cold"

sys.path.insert(0, str(Path.home() / "tmp-pip/exp-work"))
sys.path.insert(0, str(Path(__file__).parent))
import egg_hunt_runner_v2 as V2  # noqa: E402
import drive_layer as DL  # noqa: E402

SEAMS = ("sample_sector", "_perception_job", "validate_plan",
         "run_segments", "do_scan", "digest")
before = {name: getattr(V2.Agent, name) for name in SEAMS}

state = DL.DriveState(
    condition="B", energy_cost_per_m=0.9843,
    rest_sources=[{"id": "home-bench", "pos": [-17.0, 51.2],
                   "home": True},
                  {"id": "stall-55", "pos": [44.0, 51.2],
                   "home": False}])

if MODE == "off":
    installed = DL.install(V2, state, enabled=False)
    assert installed == {}, "enabled=False must install nothing"
elif MODE == "on":
    DL.install(V2, state, enabled=True)
elif MODE != "pristine":
    raise SystemExit(f"unknown mode {MODE}")

(OUT / "seams.json").write_text(json.dumps(
    {name: getattr(V2.Agent, name) is before[name] for name in SEAMS}))

V2.PLACES["stall-11"] = [-35.0, 51.2]
ag = V2.Agent("A", "__scout", None)
ag.visited = {"stall-11": {"count": 2, "last_t": 40.0}}
ag.sectors = {"-32,48": {"visits": 3, "path_m": 41.2, "objects": 5,
                         "looks": 2, "last": 88.0}}

snap = {"pos": [-20.0, 1.62, 44.0], "heading": 0.5, "speed": 0.0,
        "t": 100.0, "near": [], "objects": []}

digest_text = ag.digest(snap)
if MODE == "on":
    # the supervisor's composition: header + drive block + digest —
    # the block is the ONLY addition, appended after the header
    digest_text = (state.block_text(100.0, [-20.0, 44.0])
                   + "\n\n" + digest_text)
(OUT / "digest.txt").write_text(digest_text)

raw_plan = {"plan": [
    {"type": "goto", "point": [1.234, -2.345]},
    {"type": "goto", "place": "stall-11"},
    {"type": "scan"},
    {"type": "collect", "egg": "egg-bazaar-04"},
    {"type": "rest"},
    {"type": "teleport", "point": [0, 0]},
    {"type": "done", "summary": "probe"},
]}
(OUT / "plan.json").write_text(
    json.dumps(ag.validate_plan(raw_plan), indent=1, sort_keys=True))
print(f"probe {MODE}: digest {len(digest_text)} B, seams "
      f"{json.loads((OUT / 'seams.json').read_text())}")
