#!/usr/bin/env python3
"""OFFLINE REPLAY — recorded gauntlet trajectories through the drive
accounting. EVIDENCE, NOT A RUN: no browser, no LLM, no world. The
recorded body trajectory (truth.jsonl) and fired looks (trace.jsonl)
of two real gauntlet runs are replayed through drive_layer.DriveState
to answer, for conditions B and C:

- where would energy / perception have stood at each stage boundary?
- would limp-home have triggered, when, and where was the body then?
- which historical looks would the perception pool have refused?
- what path length did each baseline actually travel (the §1a
  calibration input)?

Accounting rules, stated once and applied uniformly:
- Distance: consecutive A samples, the chassis' own glitch guard
  (steps >= 10 m between samples meter nothing — mirrors
  Agent.sample_sector). Blocked/wedged samples move 0 m and cost 0.
- A FIRED look = one terminal perception row for agent A in
  trace.jsonl (look-recall | look-failed | perception-failed). This
  equals supervisor gate charges in both baselines: every started job
  terminated with exactly one such row, and run-1's g-look-budget
  refusals begin only after the 25th charge. (stages.json's
  looks_used is NOT used: the supervisor persists it only at stage
  events, so it is a stale snapshot — run-1's file says 17 against a
  trace-proven 25.)
- A look the pool cannot pay for is recorded as would-be-refused and
  NOT debited; the recorded trajectory itself is history and does not
  change. This is an accounting replay over a fixed trajectory, not a
  simulated counterfactual run — later positions were caused in part
  by looks the pool would have refused, and no trace can undo that.

Usage: replay_drives.py [run_dir ...]   (defaults: the two baselines)
Writes replay/replay_results.json and prints a summary.
"""
import json
import math
import sys
from pathlib import Path

HERE = Path(__file__).parent
sys.path.insert(0, str(HERE))
import drive_layer as DL  # noqa: E402

GAUNTLET = Path.home() / "workspace/.build-tmp/experiments/gauntlet"
DEFAULT_RUNS = [GAUNTLET / "run-1",
                GAUNTLET / "run-2-attempt1-stopped-by-jim"]
FIRED_LOOK_KINDS = ("look-recall", "look-failed", "perception-failed")


# ---------------------------------------------------------------------------
# Trace readers (shared with prep_drive.py)

def read_truth_track(run_dir):
    """[(t_sim, [x, z]), ...] for agent A, in file order."""
    rows = []
    for line in open(Path(run_dir) / "truth.jsonl"):
        r = json.loads(line)
        a = r["a"]
        rows.append((float(r["t_sim"]), [float(a[0]), float(a[2])]))
    return rows


def path_length_m(track):
    """Guarded odometer total over a [(t, [x, z])] track."""
    total, prev = 0.0, None
    for _t, pos in track:
        if prev is not None:
            d = math.hypot(pos[0] - prev[0], pos[1] - prev[1])
            if d < DL.GLITCH_GUARD_M:
                total += d
        prev = pos
    return total


def read_fired_looks(run_dir):
    """[(t_sim, kind), ...] for agent A, in file order."""
    out = []
    for line in open(Path(run_dir) / "trace.jsonl"):
        r = json.loads(line)
        if r.get("kind") in FIRED_LOOK_KINDS and r.get("agent") == "A":
            t = r.get("t_sim")
            if t is None:
                continue
            out.append((float(t), r["kind"]))
    return out


def read_stage_boundaries(run_dir):
    """{stage: t_sim} from stages.json + COLLECT rows as cross-check."""
    p = Path(run_dir) / "stages.json"
    stages = {}
    if p.exists():
        s = json.loads(p.read_text())
        for k in ("S1", "S2", "S3"):
            if s.get(k):
                stages[k] = float(s[k]["t_sim"])
        if s.get("return"):
            stages["return"] = float(s["return"]["t_sim"])
    return stages


# ---------------------------------------------------------------------------
# Replay

def replay_run(run_dir, sealed, cost):
    track = read_truth_track(run_dir)
    looks = read_fired_looks(run_dir)
    stages = read_stage_boundaries(run_dir)
    total_path = path_length_m(track)
    sources = [sealed["r1"], sealed["r2"]]
    result = {"run_dir": str(run_dir), "path_m": round(total_path, 1),
              "t_span": [track[0][0], track[-1][0]],
              "n_samples": len(track), "n_fired_looks": len(looks),
              "stage_boundaries": stages, "conditions": {}}
    # merged event stream: samples and looks, time-ordered (samples
    # first at equal t — the body was somewhere when the look fired)
    events = [(t, 0, pos) for t, pos in track]
    events += [(t, 1, kind) for t, kind in looks]
    events.sort(key=lambda e: (e[0], e[1]))
    for cond in ("B", "C"):
        st = DL.DriveState(condition=cond, energy_cost_per_m=cost,
                           rest_sources=sources)
        curve = []
        refused_looks = []
        limp_at = None
        for t, kind_flag, payload in events:
            if kind_flag == 0:
                st.on_sample(t, payload)
                curve.append({"t": round(t, 2),
                              "energy": round(st.energy, 2),
                              "perception": st.perception_available(t),
                              "pos": [round(payload[0], 1),
                                      round(payload[1], 1)]})
                if limp_at is None and st.limp_home():
                    src, d = st.nearest_source(payload)
                    limp_at = {"t_sim": round(t, 2),
                               "pos": [round(payload[0], 1),
                                       round(payload[1], 1)],
                               "nearest_source": src["id"],
                               "dist_to_source_m": round(d, 1)}
            else:
                if not st.try_fire_look(t):
                    refused_looks.append({"t_sim": round(t, 2),
                                          "kind": payload})
        at_boundary = {}
        for name, tb in sorted(stages.items(), key=lambda kv: kv[1]):
            snap = min(curve, key=lambda c: abs(c["t"] - tb))
            at_boundary[name] = {"t_sim": tb,
                                 "energy": snap["energy"],
                                 "perception": snap["perception"]}
        end = curve[-1] if curve else None
        result["conditions"][cond] = {
            "endowment_energy": st.energy_endowment,
            "final": end,
            "at_stage_boundaries": at_boundary,
            "limp_home_at": limp_at,
            "would_be_refused_looks": refused_looks,
            "n_would_be_refused": len(refused_looks),
            "min_energy": min((c["energy"] for c in curve), default=None),
            "total_distance_m": round(st.total_distance_m, 1),
            "curve": curve,
        }
    return result


def main():
    run_dirs = [Path(a) for a in sys.argv[1:]] or DEFAULT_RUNS
    sealed = json.loads((HERE / "prep" / "ground_truth_drive.json")
                        .read_text())
    cost = sealed["energy_cost_per_m_fitted"]
    out = {"fitted_cost_per_m": cost,
           "rest_sources": [sealed["r1"], sealed["r2"]],
           "runs": [replay_run(d, sealed, cost) for d in run_dirs]}
    dest = HERE / "replay"
    dest.mkdir(exist_ok=True)
    (dest / "replay_results.json").write_text(json.dumps(out, indent=1))
    for r in out["runs"]:
        print(f"== {Path(r['run_dir']).name}: path {r['path_m']} m, "
              f"t {r['t_span'][0]}->{r['t_span'][1]}, "
              f"{r['n_fired_looks']} fired looks")
        for cond, c in r["conditions"].items():
            limp = c["limp_home_at"]
            print(f"   [{cond}] end energy {c['final']['energy']} "
                  f"(min {c['min_energy']}), end perception "
                  f"{c['final']['perception']}, refused looks "
                  f"{c['n_would_be_refused']}, limp-home: "
                  + (f"t={limp['t_sim']} at {limp['pos']}, "
                     f"{limp['dist_to_source_m']} m from "
                     f"{limp['nearest_source']}" if limp else "never"))
            for name, b in c["at_stage_boundaries"].items():
                print(f"        {name} @t={b['t_sim']}: energy "
                      f"{b['energy']}, perception {b['perception']}")
    print(f"wrote {dest / 'replay_results.json'}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
