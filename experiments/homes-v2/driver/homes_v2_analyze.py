#!/usr/bin/env python3
"""HOMES V2 analyzer: staged measures for the Invitation Test.
Usage: homes_v2_analyze.py <tag> [owner_key]
Reads <root>/<tag>/logs/*.jsonl + tracks/*.jsonl; prints JSON.
Stages: claim -> invitation says -> acceptance -> follow ->
door refusals -> key copies -> entries -> both seated (pair) ->
facing -> seated talk -> seated-together duration.
"""
import glob
import json
import math
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
tag = sys.argv[1]
RUNDIR = os.path.join(ROOT, tag)

INVITE_RE = re.compile(
    r"(come|visit|join|over|my (home|cabin|place)|sit with|follow me|"
    r"invit|guest|tea at|at my)", re.I)


def load(kind_dir, key=None):
    out = {}
    for p in glob.glob(os.path.join(RUNDIR, kind_dir, "*.jsonl")):
        k = os.path.basename(p)[:-6]
        if key and k != key:
            continue
        out[k] = [json.loads(l) for l in open(p) if l.strip()]
    return out


logs = load("logs")
tracks = load("tracks")
res = {"tag": tag}

# claim + keys
claim = None
copies = []
refusals = []
entries = []
for k, evs in logs.items():
    for e in evs:
        if e.get("kind") == "home_claim" and e.get("result") == "claimed":
            claim = {"agent": k, "cabin": e.get("cabin"), "ts": e.get("ts")}
        if e.get("kind") == "key_copy_granted":
            copies.append({"agent": k, "ts": e.get("ts"),
                           "owner": e.get("owner")})
        if e.get("kind") == "door_refused":
            refusals.append({"agent": k, "ts": e.get("ts")})
        if e.get("kind") == "guest_enter":
            entries.append({"agent": k, "ts": e.get("ts")})
res["claim"] = claim
res["key_copies"] = copies
res["door_refusals"] = refusals
res["guest_entries"] = entries
owner = claim["agent"] if claim else None
res["owner"] = owner

# says: invitations + all says per agent
says = {}
for k, evs in logs.items():
    says[k] = [{"ts": e.get("ts"), "text": e.get("text")}
               for e in evs if e.get("kind") == "say_sent"
               and e.get("text")]
res["says_total"] = {k: len(v) for k, v in says.items()}
invites = []
if owner:
    for s in says.get(owner, []):
        if INVITE_RE.search(s["text"] or ""):
            invites.append(s)
res["invitation_says_by_owner"] = invites

# seated intervals per agent from tracks (pose samples)
def seated_intervals(key):
    ivs = []
    cur = None
    for e in tracks.get(key, []):
        pose = e.get("self") or {}
        sit = bool(pose.get("seatedOn")) or pose.get("posture") in ("sitting", "seated")
        t = e.get("t")
        if sit and cur is None:
            cur = {"start": t, "seat": pose.get("seatedOn"),
                   "x": pose.get("x"), "z": pose.get("z"),
                   "heading": pose.get("heading")}
        elif not sit and cur is not None:
            cur["end"] = t
            ivs.append(cur)
            cur = None
    if cur:
        cur["end"] = None
        ivs.append(cur)
    return ivs


res["seated"] = {k: seated_intervals(k) for k in tracks}

# both-seated overlap + facing + seated talk
overlap_s = 0
facing = None
seated_talk = []
if owner:
    guests = [k for k in tracks if k != owner]
    own_iv = seated_intervals(owner)
    for g in guests:
        g_iv = seated_intervals(g)
        for a in own_iv:
            for b in g_iv:
                lo = max(a["start"], b["start"])
                hi = min(a["end"] or 1e18, b["end"] or 1e18)
                if hi > lo:
                    overlap_s += hi - lo
                    # facing at overlap start: headings vs direction
                    dx = (b["x"] or 0) - (a["x"] or 0)
                    dz = (b["z"] or 0) - (a["z"] or 0)
                    n = math.hypot(dx, dz) or 1
                    dx, dz = dx / n, dz / n
                    vm = (math.sin(a["heading"] or 0),
                          math.cos(a["heading"] or 0))
                    vg = (math.sin(b["heading"] or 0),
                          math.cos(b["heading"] or 0))
                    facing = {
                        "guest": g,
                        "owner_dot": round(vm[0] * dx + vm[1] * dz, 2),
                        "guest_dot": round(vg[0] * -dx + vg[1] * -dz, 2),
                        "dist_m": round(n, 2),
                        "owner_seat": a["seat"], "guest_seat": b["seat"]}
                    # says by either while both seated in this overlap
                    for k in (owner, g):
                        for e in logs.get(k, []):
                            if e.get("kind") == "say_sent" and e.get("t"):
                                if lo <= e["t"] <= hi:
                                    seated_talk.append(
                                        {"agent": k, "ts": e.get("ts"),
                                         "text": e.get("text")})
res["both_seated_overlap_s"] = round(overlap_s, 1)
res["facing"] = facing
res["seated_talk"] = seated_talk

# follow quality: for each guest, distance to owner over time after
# the owner's claim (did the guest travel with/alongside?)
def pose_series(key):
    return [(e["t"], (e.get("self") or {}).get("x"),
             (e.get("self") or {}).get("z"))
            for e in tracks.get(key, []) if e.get("self")]

follow = {}
if owner and claim:
    os_ = pose_series(owner)
    for g in [k for k in tracks if k != owner]:
        gs = pose_series(g)
        near = sum(1 for (t, x, z) in gs if x is not None
                   and any(abs(t - t2) < 6 and x2 is not None
                           and math.hypot(x - x2, z - z2) <= 5
                           for (t2, x2, z2) in os_))
        follow[g] = {"samples": len(gs), "samples_within_5m_of_owner":
                     near}
res["follow"] = follow
print(json.dumps(res, indent=1))
