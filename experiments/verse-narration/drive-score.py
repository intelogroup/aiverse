#!/usr/bin/env python3
"""Score a driving run from a scenario-log directory: drive-score.py <scenario_dir> <target_x> <target_z> [radius_m=6]
Arrival = a fleet car (body n >= 2000000) within <radius> of the target AND nearly stopped (< 1 m/s). Positions are the sim's own,
from the recorded public viewer stream, so it does not depend on what the agent claims."""
import sys, json, math, re, collections
scen, tx, tz = sys.argv[1], float(sys.argv[2]), float(sys.argv[3]); R = float(sys.argv[4]) if len(sys.argv) > 4 else 6.0
tap = [json.loads(l) for l in open(f"{scen}/tap.jsonl") if l.strip()]
meta = json.load(open(f"{scen}/meta.json")); go = meta["goAt"] / 1000.0
try: ev = [json.loads(l) for l in open(f"{scen}/events.jsonl") if l.strip()]
except FileNotFoundError: ev = []
names = {}
tracks = collections.defaultdict(list)
for r in tap:
    if r["kind"] == "roster":
        for b in r["bodies"]:
            if b["name"]: names[b["n"]] = b["name"]
    elif r["kind"] == "pose":
        for p in r["p"]: tracks[p["n"]].append((r["t"] / 1000.0 - go, p["x"], p["z"], p["s"]))
visitor = next((n for n, nm in names.items() if nm.startswith("Wren")), None)
fleet = {n: t for n, t in tracks.items() if n >= 2_000_000}
def path_len(t): return sum(math.hypot(t[i][1] - t[i - 1][1], t[i][2] - t[i - 1][2]) for i in range(1, len(t)))
disp = {n: math.hypot(t[-1][1] - t[0][1], t[-1][2] - t[0][2]) for n, t in fleet.items() if t}
out = {"target": [tx, tz], "radius_m": R, "scene_seconds": round(meta["endAt"] / 1000.0 - go, 1), "harness": meta.get("harness"), "model": meta.get("model")}
out["fleet_cars"] = {str(n): {"start": [round(t[0][1], 1), round(t[0][2], 1)], "end": [round(t[-1][1], 1), round(t[-1][2], 1)], "moved_m": round(path_len(t), 1)} for n, t in fleet.items() if t}
moved = [n for n, t in fleet.items() if path_len(t) > 3]
verdict = "NO_CAR_MOVED"
if moved:
    n = max(moved, key=lambda k: path_len(fleet[k])); t = fleet[n]
    d = [(a[0], math.hypot(a[1] - tx, a[2] - tz), a[3]) for a in t]
    mind = min(d, key=lambda x: x[1]); end = d[-1]
    arrived = [x for x in d if x[1] <= R and x[2] < 1.0]
    first_move = next((a[0] for a in t if a[3] > 0.5), None)
    out["car"] = {"n": n, "path_m": round(path_len(t), 1), "first_moved_at_s": None if first_move is None else round(first_move, 1),
                  "closest_m": round(mind[1], 1), "closest_at_s": round(mind[0], 1), "final_dist_m": round(end[1], 1), "final_speed": round(end[2], 1),
                  "max_speed": round(max(a[3] for a in t), 1), "arrived_at_s": round(arrived[0][0], 1) if arrived else None}
    verdict = "ARRIVED" if arrived else ("PASSED_NEARBY_NOT_STOPPED" if mind[1] <= R else "DID_NOT_REACH")
out["verdict"] = verdict
# tools + actions, and infractions parsed from tool results (observe.vehicle.infractions is cumulative: take the last list seen)
tools = collections.Counter(); acts = collections.Counter(); last_inf = None; errors = 0
for e in ev:
    if e["kind"] != "tool": continue
    tools[e["tool"].replace("verse_", "")] += 1
    inp = e.get("input") or {}
    a = inp.get("action") if isinstance(inp, dict) else None
    if isinstance(a, str):
        try: a = json.loads(a)
        except Exception: a = None
    if isinstance(a, dict) and a.get("type"): acts[a["type"]] += 1
    if e.get("status") == "error": errors += 1
    m = re.search(r'"infractions"\s*:\s*(\[[^\]]*\])', e.get("output") or "")
    if m:
        try: last_inf = json.loads(m.group(1))
        except Exception: pass
out["tool_calls"] = dict(tools); out["action_types"] = dict(acts); out["tool_errors"] = errors
out["infractions_last_seen"] = last_inf
out["narration_lines_received"] = sum(1 for e in ev if e["kind"] == "owner_received" or (e["kind"] in ("visible", "thinking") and e.get("agentName")))
print(json.dumps(out, indent=1))
