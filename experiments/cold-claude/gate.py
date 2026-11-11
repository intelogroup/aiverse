#!/usr/bin/env python3
"""Body-API gate metrics for one cold-agent run dir (claude-* agents). Usage: gate.py <run_dir> [<run_dir> ...]

Measured from the agents' own transcripts (their curl commands and the tool results) and the 10 s observe samples:
  attach_2min   agents whose body answered observe 200 within 2 min of the first sample
  hall_blocked  tool results that pair hall-0 with "no safe route"
  polls_per_act GET /world/act/<id> calls / POST /world/act calls
  waitms_users  agents that used ?waitMs
  inside_shop   agents that stood inside a room rect >= 2 m past its door
  enter_ok      tool results with an enter action that arrived
"""
import glob, json, math, os, re, sys

ROOMS = json.load(open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "../../apps/console/public/assets/interiors/index.json")))

def deep_inside(x, z):
    """Inside a room rect and >= 2 m past its door (a body at the doorway is already inside the rect)."""
    for r in ROOMS:
        x0, z0, x1, z1 = r["rect"]
        if min(x0, x1) <= x <= max(x0, x1) and min(z0, z1) <= z <= max(z0, z1) and math.dist((x, z), r["door"]) >= 2: return r["id"]
    return None

def tool_events(path):
    """(command, result_text) pairs from a claude stream-json transcript."""
    cmds, out = {}, []
    for line in open(path, errors="ignore"):
        try: o = json.loads(line)
        except ValueError: continue
        msg = o.get("message") if isinstance(o, dict) and isinstance(o.get("message"), dict) else {}
        content = msg.get("content") if isinstance(msg.get("content"), list) else []
        for c in content:
            if not isinstance(c, dict): continue
            if c.get("type") == "tool_use": cmds[c["id"]] = json.dumps(c.get("input", {}))
            elif c.get("type") == "tool_result":
                r = c.get("content"); r = r if isinstance(r, str) else json.dumps(r)
                out.append((cmds.get(c.get("tool_use_id"), ""), r))
    return out

def gate(run):
    m = dict(agents=0, attach_2min=0, hall_blocked=0, posts=0, polls=0, waitms_users=0, inside_shop=0, enter_ok=0)
    for d in sorted(glob.glob(os.path.join(run, "claude-*/"))):
        m["agents"] += 1
        tr = [json.loads(l) for l in open(d + "trajectory.jsonl")]
        t0 = tr[0]["t"] if tr else 0
        if any(x["status"] == 200 and x["t"] - t0 <= 120 for x in tr): m["attach_2min"] += 1
        bodies = [x["obs"]["observation"]["body"] for x in tr if x["status"] == 200]
        if any(deep_inside(b["x"], b["z"]) for b in bodies): m["inside_shop"] += 1
        used_wait = False
        for cmd, res in tool_events(d + "transcript.jsonl"):
            m["posts"] += len(re.findall(r"-X\s*POST[^|]*?/world/act\b(?!/)", cmd))
            m["polls"] += len(re.findall(r"/world/act/[A-Za-z0-9-]+", cmd))
            used_wait |= "waitMs" in cmd
            if "hall-0" in cmd and "no safe route" in res: m["hall_blocked"] += 1
            if '\\"enter\\"' in cmd and '"arrived"' in res: m["enter_ok"] += 1
        m["waitms_users"] += used_wait
    m["polls_per_act"] = round(m["polls"] / max(1, m["posts"]), 2)
    return m

if __name__ == "__main__":
    for run in sys.argv[1:]: print(os.path.basename(run.rstrip("/")), json.dumps(gate(run)))
