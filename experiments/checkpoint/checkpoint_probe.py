#!/usr/bin/env python3
"""Checkpoint roundtrip probe (run as a subprocess by
test_checkpoint.py, the identity_probe.py pattern).

Imports the UNMODIFIED v2 runner fresh in a temp RUN_DIR, seeds an
agent + blackboard + call stats + a DriveState with real history,
builds a payload with checkpoint.build_payload, persists it through
CheckpointManager, then applies it into FRESH objects and asserts
the restored state matches — including the drives.jsonl seam rows
apply_drive_state appends. Prints a JSON verdict line.
"""
import json
import os
import sys
import tempfile
from pathlib import Path

TMP = tempfile.mkdtemp(prefix="ckpt-probe-")
os.environ["RUN_DIR"] = TMP
os.environ["PREP_DIR"] = str(Path.home() / "workspace/.build-tmp"
                             / "experiments/egg-hunt/prep")
os.environ["MEM_MODE"] = "cold"

EXP = Path.home() / "workspace/.build-tmp/experiments"
sys.path.insert(0, str(Path.home() / "tmp-pip/exp-work"))
sys.path.insert(0, str(EXP))
sys.path.insert(0, str(EXP / "drive-layer"))
import egg_hunt_runner_v2 as V2  # noqa: E402
import checkpoint as CK  # noqa: E402
import drive_layer as DL  # noqa: E402

verdict = {}

# --- seed the "killed" leg's state -----------------------------------
V2.SIM["t"] = 321.5
V2.POS["A"] = [-31.0, 1.62, 66.0]
V2.POS["B"] = [-17.0, 1.62, -51.2]
V2.BB.add_sighting({"est": (-30.0, 70.0), "matched": "egg-bazaar-04",
                    "egg_class": "published", "t_sim_capture": 300.0,
                    "by": "A", "frame": "A-007.png"})
V2.BB.intentions["A"] = {"text": "probe intention", "t_sim": 310.0}
V2.CALL_STATS["count"] = 9
V2.CALL_STATS["failures"] = 1

ag = V2.Agent("A", "__scout", None)
ag.plan = [{"type": "goto", "point": [-30.2, 70.9]},
           {"type": "scan"}]
ag.intention = "probe intention"
ag.steps = 17
ag.deliberations = 4
ag.delib_prompt_tokens = [100, 120]
ag.looks_fired = 7
ag.looks_completed = 6
ag.look_seq = 7
ag.capture_ms_list = [5000, 6100]
ag.api_ms_list = [900]
ag.collected = {"egg-bazaar-04": {"t_sim": 200.0, "via": "registry",
                                  "pos": [-30.0, 70.0]}}
ag.visited = {"stall-11": 42.0}
ag.sectors = {"S3,7": {"first_t": 10.0, "last_t": 300.0, "visits": 2,
                       "looks": 3, "path_m": 55.0, "finds": []}}
ag.sightings_history = [dict(V2.BB.sightings[0])]
ag.blocked_count = 2
ag.trigger = "plan-exhausted"

stage = {"staging": {"decoy_dispatched": True},
         "S1": {"t_sim": 42.0, "via": "position"}, "S2": None,
         "S3": None,
         "decoy": {"proposals": [], "min_dist_m": 24.6,
                   "walked_t": None, "touched_t": None,
                   "touch_count": 0, "_in_touch": False,
                   "first_proposal_t": None, "last_near_t": None},
         "return": None, "looks_used": 7}

logp = Path(TMP) / "drives.jsonl"
sources = [{"id": "home-bench", "pos": [-17.0, 51.2], "home": True},
           {"id": "stall-55", "pos": [44.0, 51.2], "home": False}]
drv = DL.DriveState(condition="C", energy_cost_per_m=0.9843,
                    rest_sources=sources, log_path=logp)
drv.on_sample(1.0, [-17.0, 51.2])
drv.on_sample(2.5, [-20.0, 55.0])
drv.try_fire_look(3.0)
drv.try_fire_look(4.0)
n_events_before = len(drv.events)


class FakeBP:
    path = Path(TMP) / "backpack-fake.json"
    data = {"items": [{"id": "item-0001", "kind": "code"}]}


FakeBP.path.write_text(json.dumps(FakeBP.data))

mgr = CK.CheckpointManager(TMP, "drive-b9")
payload = CK.build_payload(V2, ag, stage, drv, FakeBP(), TMP, [])
seq = mgr.save(payload, V2.SIM["t"])
verdict["saved_seq"] = seq
verdict["payload_sim_t"] = payload["sim_t"]
verdict["artifacts_trace"] = payload["artifacts"]["trace.jsonl"]
verdict["drive_events_len"] = payload["drive"]["events_len"]

env, source, problems = mgr.load_latest()
assert env is not None and source == "checkpoint.json", problems
p2 = env["payload"]
verdict["loaded_seq"] = env["seq"]

# --- apply into fresh objects ------------------------------------------
ag2 = V2.Agent("A", "__scout", None)
CK.apply_agent_state(ag2, p2["agent_a"])
assert ag2.steps == 17 and ag2.look_seq == 7, ag2.steps
assert ag2.plan == ag.plan, ag2.plan
assert ag2.collected == ag.collected
assert ag2.visited == {"stall-11": 42.0}
assert ag2.capture_inflight is False and ag2.done is False
verdict["agent_restored"] = True

V2.BB.sightings = []
V2.BB.intentions = {}
V2.BB.claims = {}
V2.CALL_STATS["count"] = 0
CK.apply_shared_state(V2, p2)
assert len(V2.BB.sightings) == 1
assert V2.BB.intentions["A"]["text"] == "probe intention"
assert V2.CALL_STATS["count"] == 9
verdict["shared_restored"] = True

drv2 = DL.DriveState(condition="C", energy_cost_per_m=0.9843,
                     rest_sources=sources, log_path=logp)
CK.apply_drive_state(drv2, p2["drive"], p2["sim_t"], log_path=logp)
assert drv2.energy == drv.energy, (drv2.energy, drv.energy)
assert drv2.perception == drv.perception
assert drv2.looks_fired == drv.looks_fired == 2
assert drv2._next_regen_t == drv._next_regen_t
assert len(drv2.events) == n_events_before + 2
seam = [e for e in drv2.events if e["cause"] == "checkpoint-restore"]
assert len(seam) == 2 and {e["var"] for e in seam} == {
    "energy", "perception"}
verdict["drive_restored"] = True
verdict["drive_energy"] = drv2.energy
verdict["drive_perception"] = drv2.perception

print("PROBE-OK " + json.dumps(verdict))
