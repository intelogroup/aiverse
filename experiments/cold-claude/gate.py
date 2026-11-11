#!/usr/bin/env python3
"""Body-API gate metrics for one cold-agent run dir (claude-* agents). Usage: gate.py <run_dir> [<run_dir> ...]

Measured from the agents' own transcripts (their curl commands and the tool results) and the 10 s observe samples:
  attach_2min   agents whose body answered observe 200 within 2 min of the first sample
  hall_blocked  tool results that pair hall-0 with "no safe route"
  polls_per_act GET /world/act/<id> calls / POST /world/act calls
  waitms_users  agents that used ?waitMs
  inside_shop   agents that stood inside a room rect >= 2 m past its door
  enter_ok      settled act records (read back by the agent) for an enter that arrived
  sat_agents    agents with a settled sit ("seated" in a result to a sit command)
  gesture_agents agents with a settled play ("done" after a play command)
  invalid_play  results where a play command was refused as invalid_action
  occupied      sit refusals as occupied (the claim works)
  see_agents    agents whose observe sample ever listed a body in sight
  mutual_pairs  agent pairs within 15 m at the same 10 s sample where BOTH listed a body
  handle_acts   face/go_to {body} commands the agents issued
P4 (speech):
  say_agents    agents with a settled say act record (done)
  say_acts      say commands issued
  heard_agents  agents whose observe sample ever listed a line in heard[]
  replies       agents that answered a speaker: a say with {to: handle} where the handle is a `from` they had heard, <= 60 sim s after it
  say_invalid   say results refused as invalid_action
P5 (look):
  look_agents   agents that called POST /world/look
  look_cited    look agents whose decisions.jsonl "why" mentions what they saw (depth/class/png/look/image) after their first look
  look_ms       gateway round trip for POST /world/look from the gateway log (p95, n); an upper bound of the sim time
"""
import glob, json, math, os, re, sys

GW_LOG = os.environ.get("GW_LOG", "/tmp/cc-test/stack/gw.log")

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

ACT_REC = re.compile(r'"action":\{"type":"(\w+)"[^{}]*\}[^{}]*?"outcome":\{"ok":(?:true|false),"status":"(\w+)"(?:,"target":"[^"]*")?(?:,"detail":"([^"]*)")?')


def act_records(res):
    """(action type, outcome status, detail) for every settled act record in a tool result (JSON text, escaped or not)."""
    t = res.replace('\\"', '"')
    return [(m.group(1), m.group(2) or "", m.group(3) or "") for m in ACT_REC.finditer(t) if m.group(2)]


def is_act_cmd(cmd): return "/world/act" in cmd and "POST" in cmd

def gate(run):
    samples = {}
    m = dict(agents=0, attach_2min=0, hall_blocked=0, posts=0, polls=0, waitms_users=0, inside_shop=0, enter_ok=0, sat_agents=0, gesture_agents=0, invalid_play=0, occupied=0, see_agents=0, mutual_pairs=0, handle_acts=0, say_agents=0, say_acts=0, heard_agents=0, replies=0, say_invalid=0, look_agents=0, look_cited=0)
    for d in sorted(glob.glob(os.path.join(run, "claude-*/"))):
        m["agents"] += 1
        tr = [json.loads(l) for l in open(d + "trajectory.jsonl")]
        t0 = tr[0]["t"] if tr else 0
        if any(x["status"] == 200 and x["t"] - t0 <= 120 for x in tr): m["attach_2min"] += 1
        bodies = [x["obs"]["observation"]["body"] for x in tr if x["status"] == 200]
        saw = False
        for x in tr:
            if x["status"] != 200: continue
            o = x["obs"]["observation"]
            has = any(e.get("kind") == "body" for e in o.get("scene", []))
            saw |= has
            samples.setdefault(round(x["t"] / 10), {})[d] = (o["body"]["x"], o["body"]["z"], has)
        m["see_agents"] += saw
        heard_from, replied = {}, False  # handle -> sim time it was first heard
        for x in tr:
            if x["status"] != 200: continue
            o = x["obs"]["observation"]
            for h in o.get("heard", []): heard_from.setdefault(h["from"], h["t"])
            la = o.get("lastAct") or {}
            a = la.get("action") or {}
            if a.get("type") == "say" and a.get("to") in heard_from and la.get("settledAt") is not None and 0 <= la["settledAt"] - heard_from[a["to"]] <= 60: replied = True
        m["heard_agents"] += bool(heard_from)
        m["replies"] += replied
        if any(deep_inside(b["x"], b["z"]) for b in bodies): m["inside_shop"] += 1
        used_wait = sat = gest = said = looked = False
        for cmd, res in tool_events(d + "transcript.jsonl"):
            m["posts"] += len(re.findall(r"-X\s*POST[^|]*?/world/act\b(?!/)", cmd))
            m["polls"] += len(re.findall(r"/world/act/[A-Za-z0-9-]+", cmd))
            used_wait |= "waitMs" in cmd
            recs = act_records(res)
            sat |= any(t == "sit" and st == "seated" for t, st, _ in recs)
            gest |= any(t == "play" and st == "done" for t, st, _ in recs)
            said |= any(t == "say" and st == "done" for t, st, _ in recs)
            m["say_acts"] += bool(re.search(r'\\*"type\\*"\s*:\s*\\*"say\\*"', cmd)) and is_act_cmd(cmd)
            m["say_invalid"] += ("invalid_action" in res and bool(re.search(r'\\*"say\\*"', cmd)))
            looked |= "/world/look" in cmd
            m["occupied"] += sum(t == "sit" and "occupied" in d for t, _, d in recs)
            m["invalid_play"] += ("invalid_action" in res and "clip" in cmd and "play" in cmd)
            m["enter_ok"] += sum(t == "enter" and st == "arrived" for t, st, _ in recs)
            m["handle_acts"] += bool(re.search(r'(face|go_to|run_to)\\*"[^}]*\\*"body\\*"\s*:\s*\\*"b-', cmd)) and is_act_cmd(cmd)
            if "hall-0" in cmd and "no safe route" in res: m["hall_blocked"] += 1
        m["waitms_users"] += used_wait
        m["sat_agents"] += sat
        m["gesture_agents"] += gest
        m["say_agents"] += said
        m["look_agents"] += looked
        if looked and os.path.exists(d + "decisions.jsonl"):
            why = " ".join(json.loads(l).get("why", "") for l in open(d + "decisions.jsonl", errors="ignore") if l.strip().startswith("{"))
            m["look_cited"] += bool(re.search(r"depth|class map|classPng|depthPng|png|look(ed|ing)? (at|around)|/look|raycast|image", why, re.I))
    pairs = set()
    for t, per in samples.items():
        ids = sorted(per)
        for i, a in enumerate(ids):
            for b in ids[i + 1:]:
                (ax, az, ah), (bx, bz, bh) = per[a], per[b]
                if ah and bh and math.dist((ax, az), (bx, bz)) <= 15: pairs.add((a, b, t))
    m["mutual_pairs"] = len({(a, b) for a, b, _ in pairs})
    ms = sorted(int(x) for x in re.findall(r'"path":"/world/look","status":200,"ms":(\d+)', open(GW_LOG, errors="ignore").read())) if os.path.exists(GW_LOG) else []
    m["look_ms"] = {"p95": ms[min(len(ms) - 1, int(len(ms) * 0.95))], "n": len(ms)} if ms else None
    m["polls_per_act"] = round(m["polls"] / max(1, m["posts"]), 2)
    return m

if __name__ == "__main__":
    for run in sys.argv[1:]: print(os.path.basename(run.rstrip("/")), json.dumps(gate(run)))
