#!/usr/bin/env python3
"""Locomotion probe: is the body actually walking under act go_to/run_to?
Steps of increasing distance with full outcome + pose diagnostics."""
import json, time, urllib.request

SVC = "http://127.0.0.1:5317"

def post(path, body, timeout=720):
    req = urllib.request.Request(SVC + path, data=json.dumps(body).encode(), method="POST")
    req.add_header("Content-Type", "application/json")
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return json.loads(r.read())

def show(tag, mv):
    p = mv["pose"]
    print(f"{tag}: outcomes={mv.get('outcomes')} poseMs={mv['poseMs']}", flush=True)
    print(f"   pos={p['pos']} busy={p['busy']} action={p['currentAction']} "
          f"speed={p['speed']} clip={p['clip']} routeLen={p['routeLen']} "
          f"posture={p['posture']}", flush=True)

show("start", post("/move", {"agentId": "probe"}))
show("walk12m", post("/move", {"agentId": "probe", "position": [5.68, 22.57], "mode": "walk"}))
show("run-mid", post("/move", {"agentId": "probe", "position": [-10.0, -20.0], "mode": "run"}))
show("run-tea", post("/move", {"agentId": "probe", "position": [-25.0, -72.5], "mode": "run"}))
print("PROBE DONE", flush=True)
